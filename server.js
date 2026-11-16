'use strict';

const crypto = require('crypto');
const express = require('express');
const bigInt = require('big-integer');
const { TelegramClient, Api, utils } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage, Raw } = require('telegram/events');

const env = process.env;
const {
  TG_API_ID = '',
  TG_API_HASH = '',
  API_KEY,
  N8N_WEBHOOK_URL = '',
  N8N_WEBHOOK_SECRET = '',
  SELF_URL = '', // URL n8n should use to reach this service, e.g. http://project_tg-gateway:3000
  MAX_DOWNLOAD_MB = '50',
  MSG_CACHE_SIZE = '5000', // tracked messages remembered for delete/edit reporting (all accounts)
  PREFILL_DIALOGS = '30',
  PREFILL_PER_CHAT = '10',
  PORT = '3000',
} = env;

if (!API_KEY) {
  console.error('Missing required env var: API_KEY');
  process.exit(1);
}

const NUMERIC_ID_RE = /^-?\d+$/;

/* ------------------------------ chat ID helpers ------------------------------ */

// Drops the minus sign and the -100 channel prefix, so "2343434343", "-2343434343"
// and "-1002343434343" all map to the same key.
function bareChatId(id) {
  const s = String(id).trim();
  if (s.startsWith('-100')) return s.slice(4);
  if (s.startsWith('-')) return s.slice(1);
  return s;
}

function parseTrackedIds(raw, label) {
  const ids = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!NUMERIC_ID_RE.test(id)) {
      throw new Error(`Invalid chat ID in tracked list for ${label}: ${id}`);
    }
  }
  return new Set(ids.map(bareChatId));
}

// Empty tracked set = track every chat for that account.
function isTracked(acct, chatId) {
  return !acct.tracked.size || acct.tracked.has(bareChatId(chatId));
}

/* ------------------------------ account setup ------------------------------ */

// Reads TG_SESSION_1, TG_SESSION_2, ... Plain TG_SESSION still works as a single account.
function readAccountConfigs() {
  const nums = Object.keys(env)
    .map((k) => /^TG_SESSION_(\d+)$/.exec(k))
    .filter(Boolean)
    .map((m) => m[1])
    .sort((a, b) => Number(a) - Number(b));

  const suffixes = nums.length ? nums.map((n) => `_${n}`) : env.TG_SESSION ? [''] : [];
  if (!suffixes.length) throw new Error('No accounts configured: set TG_SESSION_1 (or TG_SESSION)');

  return suffixes.map((sfx, i) => {
    const session = env[`TG_SESSION${sfx}`];
    const apiId = env[`TG_API_ID${sfx}`] || TG_API_ID;
    const apiHash = env[`TG_API_HASH${sfx}`] || TG_API_HASH;
    const label = env[`TG_LABEL${sfx}`] || `account${i + 1}`;

    if (!session) throw new Error(`Missing TG_SESSION${sfx}`);
    if (!apiId || !apiHash) {
      throw new Error(`Missing TG_API_ID${sfx} / TG_API_HASH${sfx} (or the shared TG_API_ID / TG_API_HASH)`);
    }
    if (!NUMERIC_ID_RE.test(String(apiId))) throw new Error(`TG_API_ID${sfx} must be numeric`);

    return {
      label,
      session,
      apiId: Number(apiId),
      apiHash,
      trackedRaw: sfx ? env[`TRACKED_CHAT_IDS${sfx}`] : env.TRACKED_CHAT_IDS,
    };
  });
}

function buildAccounts() {
  const seen = new Set();
  return readAccountConfigs().map((cfg, i) => {
    if (seen.has(cfg.label)) throw new Error(`Duplicate account label: ${cfg.label}`);
    seen.add(cfg.label);
    return {
      key: String(i + 1),
      label: cfg.label,
      id: null,         // Telegram user ID, filled in after login
      connected: false,
      tracked: parseTrackedIds(cfg.trackedRaw, cfg.label),
      dialogsWarmed: false,
      client: new TelegramClient(
        new StringSession(cfg.session),
        cfg.apiId,
        cfg.apiHash,
        { connectionRetries: 10, autoReconnect: true },
      ),
    };
  });
}

let accounts;
try {
  accounts = buildAccounts();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// Picks an account by label, Telegram ID, or internal key. Empty = first account.
function pickAccount(value) {
  if (value === undefined || value === null || value === '') return accounts[0];
  const v = String(value).trim();
  return accounts.find((a) => a.label === v || a.id === v || a.key === v) || null;
}

/* ------------------------------ helpers ------------------------------ */

const safeEq = (a, b) => {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

async function warmEntityCache(acct) {
  try {
    await acct.client.getDialogs({ limit: 300 });
    acct.dialogsWarmed = true;
  } catch (e) {
    console.error(`[${acct.label}] getDialogs failed:`, e.message);
  }
}

// Runs fn(peer); if Telegram doesn't know the peer yet, load dialogs and retry once.
async function withPeer(acct, chatId, fn) {
  const peer = bigInt(String(chatId));
  try {
    return await fn(peer);
  } catch (e) {
    if (!acct.dialogsWarmed || /Could not find the input entity/i.test(e.message)) {
      await warmEntityCache(acct);
      return fn(peer);
    }
    throw e;
  }
}

async function getMessage(acct, chatId, messageId) {
  const [msg] = await withPeer(acct, chatId, (peer) =>
    acct.client.getMessages(peer, { ids: [Number(messageId)] }),
  );
  return msg || null;
}

function mediaType(m) {
  if (m.photo) return 'photo';
  if (m.video) return 'video';
  if (m.voice) return 'voice';
  if (m.audio) return 'audio';
  if (m.sticker) return 'sticker';
  if (m.document) return 'document';
  return null;
}

// Nigeria uses West Africa Time (UTC+1) all year, with no daylight saving.
const WAT_OFFSET = '+01:00';

const watParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// Unix seconds -> "2026-11-14T10:32:05+01:00"
function toWATIso(unixSeconds) {
  if (!unixSeconds) return null;
  const p = Object.fromEntries(
    watParts.formatToParts(new Date(Number(unixSeconds) * 1000)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${WAT_OFFSET}`;
}

const nowWAT = () => toWATIso(Math.floor(Date.now() / 1000));

function summarize(acct, m, chatTitle) {
  const chatId = String(m.chatId);
  const type = mediaType(m);
  const fwd = m.fwdFrom;
  return {
    accountLabel: acct.label,   // which account received this event
    accountId: acct.id,         // that account's Telegram user ID
    messageId: m.id,
    chatId,
    chatTitle: chatTitle || null,
    senderId: m.senderId ? String(m.senderId) : null,
    out: !!m.out,
    date: m.date,               // Unix seconds (UTC), kept for sorting
    sentAt: toWATIso(m.date),   // Nigerian time, e.g. "2026-11-14T10:32:05+01:00"
    text: m.message || '',
    hasMedia: !!type,
    mediaType: type,
    fileName: m.file?.name || null,
    mimeType: m.file?.mimeType || (m.photo ? 'image/jpeg' : null),
    fileSize: m.file?.size ? Number(m.file.size) : null,
    replyToMessageId: m.replyTo?.replyToMsgId ?? null,
    forwardedFrom: fwd
      ? {
          channelId: fwd.fromId?.channelId ? String(fwd.fromId.channelId) : null,
          userId: fwd.fromId?.userId ? String(fwd.fromId.userId) : null,
          channelPost: fwd.channelPost ?? null,
          date: fwd.date ?? null,
        }
      : null,
    downloadUrl:
      type && SELF_URL
        ? `${SELF_URL.replace(/\/$/, '')}/download?chatId=${chatId}&messageId=${m.id}&account=${encodeURIComponent(acct.label)}`
        : null,
  };
}

async function chatTitleOf(m) {
  try {
    const chat = await m.getChat();
    return chat?.title || chat?.username || chat?.firstName || null;
  } catch (_) {
    return null;
  }
}

// Marked chat ID string (e.g. "-1001234567890") from a Telegram peer object, or null.
function peerIdOf(peer) {
  if (!peer) return null;
  try {
    return String(utils.getPeerId(peer));
  } catch (_) {
    return null;
  }
}

/* ------------------------------ message cache ------------------------------ */
// Telegram does not send the text of deleted messages, and edit events carry only the new text.
// This cache keeps recent messages from tracked chats, per account, so we can report what they said.
// Lives in memory and is lost on restart.

const MSG_CACHE_LIMIT = Number(MSG_CACHE_SIZE) || 5000;
const messageCache = new Map(); // "accountKey:chatId:messageId" -> summarized message

const cacheKey = (acctKey, chatId, messageId) => `${acctKey}:${chatId}:${messageId}`;

function remember(acct, summary) {
  if (!summary || !summary.chatId || !summary.messageId) return;
  if (!isTracked(acct, summary.chatId)) return;
  const key = cacheKey(acct.key, summary.chatId, summary.messageId);
  messageCache.delete(key); // re-insert so this entry counts as the newest
  messageCache.set(key, { ...summary, _acct: acct.key });
  while (messageCache.size > MSG_CACHE_LIMIT) {
    messageCache.delete(messageCache.keys().next().value); // evict the oldest
  }
}

// With a chatId: the one cached message, or null.
// Without a chatId: every cached message with that ID from this account, as an array.
function findCached(acct, chatId, messageId) {
  if (chatId) return messageCache.get(cacheKey(acct.key, chatId, messageId)) || null;
  const hits = [];
  for (const v of messageCache.values()) {
    if (v._acct === acct.key && String(v.messageId) === String(messageId)) hits.push(v);
  }
  return hits;
}

// Loads recent messages from tracked chats into the cache at startup, in the background.
async function prefillCache(acct) {
  try {
    const dialogs = await acct.client.getDialogs({
      limit: acct.tracked.size ? 300 : Number(PREFILL_DIALOGS) || 30,
    });
    const perChat = Number(PREFILL_PER_CHAT) || 10;
    for (const d of dialogs) {
      if (!d.inputEntity || !isTracked(acct, String(d.id))) continue;
      const title = d.title || d.name || null;
      try {
        for await (const m of acct.client.iterMessages(d.inputEntity, { limit: perChat })) {
          if (m?.id) remember(acct, summarize(acct, m, title));
        }
      } catch (_) {}
    }
    console.log(`[${acct.label}] message cache primed`);
  } catch (e) {
    console.error(`[${acct.label}] cache prefill failed:`, e.message);
  }
}

/* ------------------------------ history helpers ------------------------------ */

const MAX_HISTORY_LIMIT = 500; // max messages returned per request
const MAX_HISTORY_SCAN = 5000; // max messages examined per targeted chat
const MAX_DIALOGS = 50;        // chats searched when no filter is given
const MAX_NAME_LOOKUP = 300;   // dialogs loaded when matching chatNames
const MAX_SCAN_PER_CHAT = 500; // messages examined per chat in all-chats mode, when filtering by sender

// Accepts undefined, null, a single value, or an array. Always returns an array.
function toList(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

// [123, "456"] -> Set("123", "456"). Missing, null or empty -> null (no sender filter).
function parseSenderIds(input) {
  const ids = toList(input).map((v) => String(v).trim()).filter(Boolean);
  if (!ids.length) return null;
  const bad = ids.find((id) => !NUMERIC_ID_RE.test(id));
  if (bad) throw new Error(`invalid Telegram ID in senderIds: ${bad}`);
  return new Set(ids);
}

// Returns a de-duplicated array of numeric chat ID strings.
function parseChatIds(input) {
  const ids = toList(input).map((v) => String(v).trim()).filter(Boolean);
  const bad = ids.find((id) => !NUMERIC_ID_RE.test(id));
  if (bad) throw new Error(`invalid Telegram ID in chatIds: ${bad}`);
  return [...new Set(ids)];
}

// Returns an array of non-empty chat-name strings.
function parseChatNames(input) {
  return toList(input).map((v) => String(v).trim()).filter(Boolean);
}

function clampLimit(raw) {
  return Math.min(Math.max(parseInt(raw, 10) || 20, 1), MAX_HISTORY_LIMIT);
}

// Works out which chats to search for one account.
async function resolveTargets(acct, chatIds, chatNames) {
  if (!chatIds.length && !chatNames.length) {
    const dialogs = await acct.client.getDialogs({ limit: MAX_DIALOGS });
    const targets = [];
    for (const d of dialogs) {
      if (!d.inputEntity) continue;
      targets.push({ key: String(d.id), peer: d.inputEntity, title: d.title || d.name || null });
    }
    return { targets, targeted: false };
  }

  const targets = new Map();
  for (const id of chatIds) {
    targets.set(id, { key: id, peer: id, title: null });
  }

  if (chatNames.length) {
    const needles = chatNames.map((n) => n.toLowerCase());
    const dialogs = await acct.client.getDialogs({ limit: MAX_NAME_LOOKUP });
    for (const d of dialogs) {
      const title = d.title || d.name || '';
      if (!d.inputEntity || !title) continue;
      const lower = title.toLowerCase();
      if (needles.some((n) => lower.includes(n))) {
        const key = String(d.id);
        if (!targets.has(key)) targets.set(key, { key, peer: d.inputEntity, title });
      }
    }
  }

  return { targets: [...targets.values()], targeted: true };
}

// Scans one chat for one account and returns up to `limit` matching messages.
async function scanTarget(acct, target, limit, senders, scanLimit) {
  const run = async (peer) => {
    const matched = [];
    let examined = 0;
    for await (const m of acct.client.iterMessages(peer, { limit: scanLimit })) {
      examined++;
      if (!m || !m.id) continue;
      if (senders && !senders.has(String(m.senderId))) continue;
      matched.push(m);
      if (matched.length >= limit) break;
    }
    return { matched, examined };
  };

  const { matched, examined } =
    typeof target.peer === 'string'
      ? await withPeer(acct, target.peer, run)
      : await run(target.peer);

  let title = target.title;
  if (!title && matched.length) title = await chatTitleOf(matched[0]);

  const messages = matched.map((m) => summarize(acct, m, title));
  messages.forEach((s) => remember(acct, s));

  return { examined, chat: { chatId: target.key, title, accountLabel: acct.label }, messages };
}

// Searches the chats for one account.
async function searchAccount(acct, { chatIds, chatNames, limit, senders }) {
  const { targets, targeted } = await resolveTargets(acct, chatIds, chatNames);

  const scanLimit = senders ? (targeted ? MAX_HISTORY_SCAN : MAX_SCAN_PER_CHAT) : limit;

  const collected = [];
  const chats = [];
  const errors = [];
  let scanned = 0;

  for (const target of targets) {
    try {
      const r = await scanTarget(acct, target, limit, senders, scanLimit);
      scanned += r.examined;
      collected.push(...r.messages);
      chats.push(r.chat);
    } catch (e) {
      console.error(`[${acct.label}] history scan failed for ${target.title || target.key}:`, e.message);
      errors.push({ accountLabel: acct.label, chatId: target.key, title: target.title, error: e.message });
    }
  }

  return { scanned, messages: collected, chats, errors };
}

// Searches one account, or all of them, and merges the results.
// The same message seen by two accounts in one group is returned once.
async function searchHistory(which, opts) {
  const list = which === 'all' ? accounts : [which];
  const collected = [];
  const chats = [];
  const errors = [];
  let scanned = 0;

  for (const acct of list) {
    try {
      const r = await searchAccount(acct, opts);
      scanned += r.scanned;
      collected.push(...r.messages);
      chats.push(...r.chats);
      errors.push(...r.errors);
    } catch (e) {
      console.error(`[${acct.label}] history search failed:`, e.message);
      errors.push({ accountLabel: acct.label, error: e.message });
    }
  }

  const seen = new Set();
  const unique = collected.filter((m) => {
    const k = `${m.chatId}:${m.messageId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  unique.sort((a, b) => b.date - a.date);
  const messages = unique.slice(0, opts.limit);

  return { count: messages.length, scanned, messages, chats, errors };
}

/* ------------------------- incoming -> n8n webhook ------------------------- */

async function postToN8n(payload) {
  if (!N8N_WEBHOOK_URL) return;
  const headers = { 'Content-Type': 'application/json' };
  if (N8N_WEBHOOK_SECRET) headers['x-webhook-secret'] = N8N_WEBHOOK_SECRET;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      console.error(`n8n webhook responded ${res.status} (attempt ${attempt})`);
    } catch (e) {
      console.error(`n8n webhook error (attempt ${attempt}):`, e.message);
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

// New message -> { type: "text", accountLabel, accountId, ...message }
// Sent for every chat, so normal messages keep flowing even when tracking is limited.
async function onNewMessage(acct, event) {
  try {
    const m = event.message;
    const title = await chatTitleOf(m);
    const summary = summarize(acct, m, title);
    remember(acct, summary); // only stored if the chat is tracked
    await postToN8n({ type: 'text', ...summary });
  } catch (e) {
    console.error(`[${acct.label}] onNewMessage error:`, e);
  }
}

const snapshot = (s) => ({
  messageId: s.messageId,
  text: s.text,
  senderId: s.senderId,
  sentAt: s.sentAt,
  hasMedia: s.hasMedia,
  mediaType: s.mediaType,
});

// Edited message -> { type: "edited", accountLabel, accountId, before, after }
async function onRawEdit(acct, update) {
  try {
    const raw = update.message;
    if (!raw?.peerId) return;

    const peerId = peerIdOf(raw.peerId);
    if (!peerId || !isTracked(acct, peerId)) return;

    const [fresh] = await withPeer(acct, peerId, (peer) =>
      acct.client.getMessages(peer, { ids: [raw.id] }),
    );
    if (!fresh) return;

    const chatId = String(fresh.chatId);
    const before = messageCache.get(cacheKey(acct.key, chatId, fresh.id)) || null;
    const title = await chatTitleOf(fresh);
    const after = summarize(acct, fresh, title);
    remember(acct, after);

    await postToN8n({
      type: 'edited',
      accountLabel: acct.label,
      accountId: acct.id,
      chatId,
      chatTitle: title,
      detectedAt: nowWAT(),
      editedAt: toWATIso(fresh.editDate),
      sameMessageId: before ? String(before.messageId) === String(after.messageId) : null,
      before: before ? snapshot(before) : null,
      after: snapshot(after),
    });
  } catch (e) {
    console.error(`[${acct.label}] onRawEdit error:`, e);
  }
}

// Deleted messages -> { type: "deleted", accountLabel, accountId, ... }
async function onRawDelete(acct, update) {
  try {
    const peerId =
      update.className === 'UpdateDeleteChannelMessages'
        ? String(utils.getPeerId(new Api.PeerChannel({ channelId: update.channelId })))
        : null;
    await reportDeleted(acct, peerId, update.messages || []);
  } catch (e) {
    console.error(`[${acct.label}] onRawDelete error:`, e);
  }
}

async function reportDeleted(acct, peerId, rawIds) {
  if (peerId && !isTracked(acct, peerId)) return;

  const detectedAt = nowWAT();

  for (const rawId of rawIds) {
    const messageId = Number(rawId);
    const found = findCached(acct, peerId, messageId);

    let original = null;
    let candidates;
    if (Array.isArray(found)) {
      if (found.length === 1) original = found[0];
      else if (found.length > 1) {
        candidates = found.map((s) => ({
          chatId: s.chatId,
          chatTitle: s.chatTitle,
          senderId: s.senderId,
          sentAt: s.sentAt,
          text: s.text,
        }));
      }
    } else {
      original = found;
    }

    // Chat unknown, nothing cached, and tracking is on: can't confirm the chat is tracked, skip.
    if (!peerId && acct.tracked.size && !original && !candidates) continue;

    if (original) messageCache.delete(cacheKey(acct.key, original.chatId, original.messageId));

    await postToN8n({
      type: 'deleted',
      accountLabel: acct.label,
      accountId: acct.id,
      messageId,
      chatId: peerId || original?.chatId || null,
      chatTitle: original?.chatTitle ?? null,
      chatInferred: !peerId && !!original,
      detectedAt,
      cached: !!original,
      content: original
        ? {
            text: original.text,
            senderId: original.senderId,
            sentAt: original.sentAt,
            hasMedia: original.hasMedia,
            mediaType: original.mediaType,
          }
        : null,
      candidates,
    });
  }
}

/* --------------------------------- HTTP API --------------------------------- */

const app = express();
app.use(express.json({ limit: '2mb' }));

const unknownAccount = (res, value) =>
  res.status(400).json({
    error: `unknown account: ${value}`,
    accounts: accounts.map((a) => a.label),
  });

app.get('/health', (_req, res) => {
  const list = accounts.map((a) => ({
    label: a.label,
    id: a.id,
    connected: !!a.client.connected,
  }));
  const ok = list.every((a) => a.connected);
  res.status(ok ? 200 : 503).json({ ok, accounts: list });
});

app.use((req, res, next) => {
  const key = req.get('x-api-key') || '';
  if (!safeEq(key, API_KEY)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// GET /download?chatId=...&messageId=...[&account=label][&format=base64]
app.get('/download', async (req, res) => {
  try {
    const { chatId, messageId, format, account } = req.query;
    const acct = pickAccount(account);
    if (!acct) return unknownAccount(res, account);
    if (!chatId || !messageId) {
      return res.status(400).json({ error: 'chatId and messageId are required' });
    }

    const msg = await getMessage(acct, chatId, messageId);
    if (!msg) return res.status(404).json({ error: 'message not found' });
    if (!msg.media) return res.status(404).json({ error: 'message has no media' });

    const maxBytes = Number(MAX_DOWNLOAD_MB) * 1024 * 1024;
    if (msg.file?.size && Number(msg.file.size) > maxBytes) {
      return res.status(413).json({ error: `file larger than ${MAX_DOWNLOAD_MB} MB` });
    }

    const buffer = await acct.client.downloadMedia(msg, {});
    if (!buffer) return res.status(500).json({ error: 'download returned nothing' });

    const mime = msg.file?.mimeType || (msg.photo ? 'image/jpeg' : 'application/octet-stream');
    const ext = msg.file?.ext || (msg.photo ? '.jpg' : '');
    const name = msg.file?.name || `${msg.id}${ext}`;

    if (format === 'base64') {
      return res.json({ accountLabel: acct.label, fileName: name, mimeType: mime, base64: buffer.toString('base64') });
    }
    res.set({
      'Content-Type': mime,
      'Content-Length': buffer.length,
      'Content-Disposition': `inline; filename="${encodeURIComponent(name)}"`,
    });
    res.send(buffer);
  } catch (e) {
    console.error('/download error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /send  { chatId, text, replyTo?, account? }   (chatId can also be "me" or a @username)
app.post('/send', async (req, res) => {
  try {
    const { chatId, text, replyTo, account } = req.body || {};
    const acct = pickAccount(account);
    if (!acct) return unknownAccount(res, account);
    if (!chatId || !text) return res.status(400).json({ error: 'chatId and text are required' });

    const peerFn = (peer) => acct.client.sendMessage(peer, { message: text, replyTo });
    const sent = NUMERIC_ID_RE.test(String(chatId))
      ? await withPeer(acct, chatId, peerFn)
      : await peerFn(String(chatId));
    res.json({ ok: true, accountLabel: acct.label, messageId: sent.id });
  } catch (e) {
    console.error('/send error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /messages?chatId=...&limit=20[&account=label]
app.get('/messages', async (req, res) => {
  try {
    const { chatId, account } = req.query;
    const acct = pickAccount(account);
    if (!acct) return unknownAccount(res, account);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    if (!chatId) return res.status(400).json({ error: 'chatId is required' });

    const msgs = await withPeer(acct, chatId, (peer) => acct.client.getMessages(peer, { limit }));
    const out = msgs.map((m) => summarize(acct, m));
    out.forEach((s) => remember(acct, s));
    res.json(out);
  } catch (e) {
    console.error('/messages error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /history
// Body (all optional):
//   account:   label (or Telegram ID) of one account, or "all". Default: the first account.
//   chatId:    one numeric chat ID                       -> that chat only
//   chatIds:   array of numeric chat IDs                 -> only those chats
//   chatNames: array of strings, case-insensitive match  -> chats whose title contains any of them
//   senderIds: array of numeric Telegram user IDs        -> only messages from those users
//   limit:     number of messages to return (default 20, max 500)
app.post('/history', async (req, res) => {
  const body = req.body || {};

  let which;
  if (body.account === 'all') which = 'all';
  else {
    which = pickAccount(body.account);
    if (!which) return unknownAccount(res, body.account);
  }

  let chatIds;
  let chatNames;
  let senders;
  const hasSingleChat =
    body.chatId !== undefined && body.chatId !== null && String(body.chatId).trim() !== '';

  try {
    chatIds = parseChatIds([...toList(body.chatId), ...toList(body.chatIds)]);
    chatNames = parseChatNames(body.chatNames);
    senders = parseSenderIds(body.senderIds);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const limit = clampLimit(body.limit);

  let scope = 'all';
  if (chatIds.length || chatNames.length) {
    scope = hasSingleChat && chatIds.length === 1 && !chatNames.length ? 'chat' : 'filtered';
  }

  try {
    const result = await searchHistory(which, { chatIds, chatNames, limit, senders });

    if (scope === 'chat' && result.errors.length) {
      return res.status(500).json({ error: result.errors[0].error });
    }

    res.json({
      ok: true,
      scope,
      account: which === 'all' ? 'all' : which.label,
      ...result,
    });
  } catch (e) {
    console.error('/history error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------- boot ---------------------------------- */

(async () => {
  for (const acct of accounts) {
    await acct.client.connect();
    if (!(await acct.client.checkAuthorization())) {
      console.error(`[${acct.label}] session is not authorized. Re-run generate-session.js and update its TG_SESSION.`);
      process.exit(1);
    }

    const me = await acct.client.getMe();
    acct.id = String(me.id);
    acct.connected = true;
    console.log(`[${acct.label}] connected as ${me.username || me.firstName} (${me.id})`);
    console.log(
      acct.tracked.size
        ? `[${acct.label}] tracking edits/deletes for ${[...acct.tracked].join(', ')}`
        : `[${acct.label}] tracking edits/deletes for all chats`,
    );

    await warmEntityCache(acct);

    acct.client.addEventHandler((event) => onNewMessage(acct, event), new NewMessage({}));
    acct.client.addEventHandler(
      (update) => onRawEdit(acct, update),
      new Raw({ types: [Api.UpdateEditMessage, Api.UpdateEditChannelMessage] }),
    );
    acct.client.addEventHandler(
      (update) => onRawDelete(acct, update),
      new Raw({ types: [Api.UpdateDeleteMessages, Api.UpdateDeleteChannelMessages] }),
    );
  }

  // Fill the cache in the background so the server starts answering right away.
  for (const acct of accounts) prefillCache(acct);

  const server = app.listen(Number(PORT), () => console.log(`HTTP API listening on :${PORT}`));

  const shutdown = async () => {
    server.close();
    for (const acct of accounts) {
      try { await acct.client.disconnect(); } catch (_) {}
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
