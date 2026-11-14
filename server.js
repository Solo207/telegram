'use strict';

const crypto = require('crypto');
const express = require('express');
const bigInt = require('big-integer');
const { TelegramClient, utils } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage, EditedMessage, DeletedMessage } = require('telegram/events');

const {
  TG_API_ID,
  TG_API_HASH,
  TG_SESSION,
  API_KEY,
  N8N_WEBHOOK_URL = '',
  N8N_WEBHOOK_SECRET = '',
  SELF_URL = '', // URL n8n should use to reach this service, e.g. http://project_tg-gateway:3000
  MAX_DOWNLOAD_MB = '50',
  TRACKED_CHAT_IDS = '',   // comma-separated chat IDs. Caching and edit/delete reports only for these. Empty = all chats.
  MSG_CACHE_SIZE = '5000', // how many tracked messages to remember for delete/edit reporting
  PREFILL_DIALOGS = '30',  // chats to load into the cache at startup (when no TRACKED_CHAT_IDS)
  PREFILL_PER_CHAT = '10', // messages per chat to load into the cache at startup
  PORT = '3000',
} = process.env;

for (const [k, v] of Object.entries({ TG_API_ID, TG_API_HASH, TG_SESSION, API_KEY })) {
  if (!v) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

const client = new TelegramClient(
  new StringSession(TG_SESSION),
  Number(TG_API_ID),
  TG_API_HASH,
  { connectionRetries: 10, autoReconnect: true },
);

/* ------------------------------ chat tracking ------------------------------ */

const NUMERIC_ID_RE = /^-?\d+$/;

// Drops the minus sign and the -100 channel prefix, so "2343434343", "-2343434343"
// and "-1002343434343" all map to the same key.
function bareChatId(id) {
  const s = String(id).trim();
  if (s.startsWith('-100')) return s.slice(4);
  if (s.startsWith('-')) return s.slice(1);
  return s;
}

const TRACKED = new Set();
for (const raw of String(TRACKED_CHAT_IDS).split(',').map((s) => s.trim()).filter(Boolean)) {
  if (!NUMERIC_ID_RE.test(raw)) {
    console.error(`Invalid chat ID in TRACKED_CHAT_IDS: ${raw}`);
    process.exit(1);
  }
  TRACKED.add(bareChatId(raw));
}
const TRACKING_ON = TRACKED.size > 0;

const isTracked = (chatId) => !TRACKING_ON || TRACKED.has(bareChatId(chatId));

/* ------------------------------ helpers ------------------------------ */

const safeEq = (a, b) => {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

let dialogsWarmed = false;
async function warmEntityCache() {
  try {
    await client.getDialogs({ limit: 300 });
    dialogsWarmed = true;
  } catch (e) {
    console.error('getDialogs failed:', e.message);
  }
}

// Runs fn(peer); if Telegram doesn't know the peer yet, load dialogs and retry once.
async function withPeer(chatId, fn) {
  const peer = bigInt(String(chatId));
  try {
    return await fn(peer);
  } catch (e) {
    if (!dialogsWarmed || /Could not find the input entity/i.test(e.message)) {
      await warmEntityCache();
      return fn(peer);
    }
    throw e;
  }
}

async function getMessage(chatId, messageId) {
  const [msg] = await withPeer(chatId, (peer) =>
    client.getMessages(peer, { ids: [Number(messageId)] }),
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

function summarize(m, chatTitle) {
  const chatId = String(m.chatId);
  const type = mediaType(m);
  const fwd = m.fwdFrom;
  return {
    messageId: m.id,
    chatId,
    chatTitle: chatTitle || null,
    senderId: m.senderId ? String(m.senderId) : null,
    out: !!m.out,
    date: m.date,              // Unix seconds (UTC), kept for sorting
    sentAt: toWATIso(m.date),  // Nigerian time, e.g. "2026-11-14T10:32:05+01:00"
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
        ? `${SELF_URL.replace(/\/$/, '')}/download?chatId=${chatId}&messageId=${m.id}`
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
// This cache keeps recent messages from tracked chats so we can report what they said.
// It lives in memory and is lost on restart.

const MSG_CACHE_LIMIT = Number(MSG_CACHE_SIZE) || 5000;
const messageCache = new Map(); // "chatId:messageId" -> summarized message

const cacheKey = (chatId, messageId) => `${chatId}:${messageId}`;

function remember(summary) {
  if (!summary || !summary.chatId || !summary.messageId) return;
  if (!isTracked(summary.chatId)) return; // only tracked chats are cached
  const key = cacheKey(summary.chatId, summary.messageId);
  messageCache.delete(key); // re-insert so this entry counts as the newest
  messageCache.set(key, summary);
  while (messageCache.size > MSG_CACHE_LIMIT) {
    messageCache.delete(messageCache.keys().next().value); // evict the oldest
  }
}

// With a chatId: the one cached message, or null.
// Without a chatId: every cached message with that message ID (one per chat), as an array.
function findCached(chatId, messageId) {
  if (chatId) return messageCache.get(cacheKey(chatId, messageId)) || null;
  const hits = [];
  for (const v of messageCache.values()) {
    if (String(v.messageId) === String(messageId)) hits.push(v);
  }
  return hits;
}

// Loads recent messages from tracked chats into the cache at startup, in the background.
async function prefillCache() {
  try {
    const dialogs = await client.getDialogs({
      limit: TRACKING_ON ? 300 : Number(PREFILL_DIALOGS) || 30,
    });
    const perChat = Number(PREFILL_PER_CHAT) || 10;
    for (const d of dialogs) {
      if (!d.inputEntity) continue;
      if (!isTracked(String(d.id))) continue;
      const title = d.title || d.name || null;
      try {
        for await (const m of client.iterMessages(d.inputEntity, { limit: perChat })) {
          if (m?.id) remember(summarize(m, title));
        }
      } catch (_) {}
    }
    console.log(`Message cache primed with ${messageCache.size} messages`);
  } catch (e) {
    console.error('cache prefill failed:', e.message);
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

// Works out which chats to search.
// Returns { targets: [{ key, peer, title }], targeted: boolean }.
// peer is a numeric ID string (resolved via withPeer) or a GramJS input entity from a dialog.
async function resolveTargets(chatIds, chatNames) {
  // No filter: the most recent dialogs.
  if (!chatIds.length && !chatNames.length) {
    const dialogs = await client.getDialogs({ limit: MAX_DIALOGS });
    const targets = [];
    for (const d of dialogs) {
      if (!d.inputEntity) continue;
      targets.push({
        key: String(d.id),
        peer: d.inputEntity,
        title: d.title || d.name || null,
      });
    }
    return { targets, targeted: false };
  }

  const targets = new Map();

  for (const id of chatIds) {
    targets.set(id, { key: id, peer: id, title: null });
  }

  if (chatNames.length) {
    const needles = chatNames.map((n) => n.toLowerCase());
    const dialogs = await client.getDialogs({ limit: MAX_NAME_LOOKUP });
    for (const d of dialogs) {
      const title = d.title || d.name || '';
      if (!d.inputEntity || !title) continue;
      const lower = title.toLowerCase();
      if (needles.some((n) => lower.includes(n))) {
        const key = String(d.id);
        if (!targets.has(key)) {
          targets.set(key, { key, peer: d.inputEntity, title });
        }
      }
    }
  }

  return { targets: [...targets.values()], targeted: true };
}

// Scans one chat and returns up to `limit` matching messages, newest first.
async function scanTarget(target, limit, senders, scanLimit) {
  const run = async (peer) => {
    const matched = [];
    let examined = 0;
    for await (const m of client.iterMessages(peer, { limit: scanLimit })) {
      examined++;
      if (!m || !m.id) continue;
      if (senders && !senders.has(String(m.senderId))) continue;
      matched.push(m);
      if (matched.length >= limit) break;
    }
    return { matched, examined };
  };

  const { matched, examined } =
    typeof target.peer === 'string' ? await withPeer(target.peer, run) : await run(target.peer);

  let title = target.title;
  if (!title && matched.length) {
    title = await chatTitleOf(matched[0]);
  }

  const messages = matched.map((m) => summarize(m, title));
  messages.forEach(remember); // remember() ignores untracked chats

  return {
    examined,
    chat: { chatId: target.key, title },
    messages,
  };
}

// Searches the resolved chats and merges the results, newest first.
async function searchHistory({ chatIds, chatNames, limit, senders }) {
  const { targets, targeted } = await resolveTargets(chatIds, chatNames);

  const scanLimit = senders
    ? targeted
      ? MAX_HISTORY_SCAN
      : MAX_SCAN_PER_CHAT
    : limit;

  const collected = [];
  const chats = [];
  const errors = [];
  let scanned = 0;

  for (const target of targets) {
    try {
      const r = await scanTarget(target, limit, senders, scanLimit);
      scanned += r.examined;
      collected.push(...r.messages);
      chats.push(r.chat);
    } catch (e) {
      console.error(`history scan failed for ${target.title || target.key}:`, e.message);
      errors.push({ chatId: target.key, title: target.title, error: e.message });
    }
  }

  // Remove duplicates in case a chat matched by ID and by name.
  const seen = new Set();
  const unique = collected.filter((m) => {
    const k = `${m.chatId}:${m.messageId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  unique.sort((a, b) => b.date - a.date);
  const messages = unique.slice(0, limit);

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

// New message -> { type: "text", ...message }
// Sent for every chat, so normal messages keep flowing even when tracking is limited.
async function onNewMessage(event) {
  try {
    const m = event.message;
    const title = await chatTitleOf(m);
    const summary = summarize(m, title);
    remember(summary); // only stored if the chat is tracked
    await postToN8n({ type: 'text', ...summary });
  } catch (e) {
    console.error('onNewMessage error:', e);
  }
}

// Edited message -> { type: "edited", before, after }
// Only reported for tracked chats. before is null if the original was never cached.
async function onEditedMessage(event) {
  try {
    const m = event.message;
    const chatId = String(m.chatId);
    if (!isTracked(chatId)) return;

    const before = messageCache.get(cacheKey(chatId, m.id)) || null;
    const title = await chatTitleOf(m);
    const after = summarize(m, title);
    remember(after);

    const snapshot = (s) => ({
      messageId: s.messageId,
      text: s.text,
      senderId: s.senderId,
      sentAt: s.sentAt,
      hasMedia: s.hasMedia,
      mediaType: s.mediaType,
    });

    await postToN8n({
      type: 'edited',
      chatId,
      chatTitle: title,
      detectedAt: nowWAT(),
      editedAt: toWATIso(m.editDate),
      sameMessageId: before ? String(before.messageId) === String(after.messageId) : null,
      before: before ? snapshot(before) : null,
      after: snapshot(after),
    });
  } catch (e) {
    console.error('onEditedMessage error:', e);
  }
}

// Deleted message -> { type: "deleted", messageId, chatId, content, ... }
// Telegram sends only IDs. Content comes from the cache when the message was seen.
async function onDeletedMessage(event) {
  try {
    const peerId = peerIdOf(event.peer);

    // Known chat that is not tracked: ignore.
    if (peerId && !isTracked(peerId)) return;

    const detectedAt = nowWAT();

    for (const rawId of event.deletedIds || []) {
      const messageId = Number(rawId);
      const found = findCached(peerId, messageId);

      let original = null;
      let candidates;
      if (Array.isArray(found)) {
        if (found.length === 1) original = found[0];
        else if (found.length > 1) {
          // Chat unknown and several cached messages share this ID: report each candidate.
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

      // Chat unknown and nothing cached: with tracking on we can't tell if the
      // message was in a tracked chat, so skip it.
      if (!peerId && TRACKING_ON && !original && !candidates) continue;

      if (original) messageCache.delete(cacheKey(original.chatId, original.messageId));

      await postToN8n({
        type: 'deleted',
        messageId,
        chatId: peerId || original?.chatId || null,
        chatTitle: original?.chatTitle ?? null,
        chatInferred: !peerId && !!original, // true when the chat was matched by message ID only
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
  } catch (e) {
    console.error('onDeletedMessage error:', e);
  }
}

/* --------------------------------- HTTP API --------------------------------- */

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.status(client.connected ? 200 : 503).json({ ok: !!client.connected });
});

app.use((req, res, next) => {
  const key = req.get('x-api-key') || '';
  if (!safeEq(key, API_KEY)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// GET /download?chatId=...&messageId=...[&format=base64]
// Returns the file bytes (photo/video/document). With format=base64 returns JSON.
app.get('/download', async (req, res) => {
  try {
    const { chatId, messageId, format } = req.query;
    if (!chatId || !messageId) {
      return res.status(400).json({ error: 'chatId and messageId are required' });
    }
    const msg = await getMessage(chatId, messageId);
    if (!msg) return res.status(404).json({ error: 'message not found' });
    if (!msg.media) return res.status(404).json({ error: 'message has no media' });

    const maxBytes = Number(MAX_DOWNLOAD_MB) * 1024 * 1024;
    if (msg.file?.size && Number(msg.file.size) > maxBytes) {
      return res.status(413).json({ error: `file larger than ${MAX_DOWNLOAD_MB} MB` });
    }

    const buffer = await client.downloadMedia(msg, {});
    if (!buffer) return res.status(500).json({ error: 'download returned nothing' });

    const mime = msg.file?.mimeType || (msg.photo ? 'image/jpeg' : 'application/octet-stream');
    const ext = msg.file?.ext || (msg.photo ? '.jpg' : '');
    const name = msg.file?.name || `${msg.id}${ext}`;

    if (format === 'base64') {
      return res.json({ fileName: name, mimeType: mime, base64: buffer.toString('base64') });
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

// POST /send  { chatId, text, replyTo? }   (chatId can also be "me" or a @username)
app.post('/send', async (req, res) => {
  try {
    const { chatId, text, replyTo } = req.body || {};
    if (!chatId || !text) return res.status(400).json({ error: 'chatId and text are required' });
    const peerFn = (peer) => client.sendMessage(peer, { message: text, replyTo });
    const sent = NUMERIC_ID_RE.test(String(chatId))
      ? await withPeer(chatId, peerFn)
      : await peerFn(String(chatId));
    res.json({ ok: true, messageId: sent.id });
  } catch (e) {
    console.error('/send error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /messages?chatId=...&limit=20
app.get('/messages', async (req, res) => {
  try {
    const { chatId } = req.query;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    if (!chatId) return res.status(400).json({ error: 'chatId is required' });
    const msgs = await withPeer(chatId, (peer) => client.getMessages(peer, { limit }));
    const out = msgs.map((m) => summarize(m));
    out.forEach(remember);
    res.json(out);
  } catch (e) {
    console.error('/messages error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /history
// Body (all optional):
//   chatId:    one numeric chat ID                       -> that chat only
//   chatIds:   array of numeric chat IDs                 -> only those chats
//   chatNames: array of strings, case-insensitive match  -> chats whose title contains any of them
//   senderIds: array of numeric Telegram user IDs        -> only messages from those users
//   limit:     number of messages to return (default 20, max 500)
//
// With no chat filter, the search covers your most recent chats.
// chatIds and chatNames can be combined; the result is the union of matching chats.
app.post('/history', async (req, res) => {
  const body = req.body || {};

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
    const result = await searchHistory({ chatIds, chatNames, limit, senders });

    if (scope === 'chat' && result.errors.length) {
      return res.status(500).json({ error: result.errors[0].error });
    }

    res.json({ ok: true, scope, ...result });
  } catch (e) {
    console.error('/history error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------- boot ---------------------------------- */

(async () => {
  await client.connect();
  if (!(await client.checkAuthorization())) {
    console.error('Session is not authorized. Re-run generate-session.js and update TG_SESSION.');
    process.exit(1);
  }
  const me = await client.getMe();
  console.log(`Telegram connected as ${me.username || me.firstName} (${me.id})`);

  console.log(
    TRACKING_ON
      ? `Tracking edits/deletes for ${TRACKED.size} chat(s): ${[...TRACKED].join(', ')}`
      : 'Tracking edits/deletes for all chats',
  );

  await warmEntityCache();

  client.addEventHandler(onNewMessage, new NewMessage({}));
  client.addEventHandler(onEditedMessage, new EditedMessage({}));
  client.addEventHandler(onDeletedMessage, new DeletedMessage({}));

  // Fill the cache in the background so the server starts answering right away.
  prefillCache();

  const server = app.listen(Number(PORT), () => console.log(`HTTP API listening on :${PORT}`));

  const shutdown = async () => {
    server.close();
    try { await client.disconnect(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
