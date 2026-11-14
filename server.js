'use strict';

const crypto = require('crypto');
const express = require('express');
const bigInt = require('big-integer');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const {
  TG_API_ID,
  TG_API_HASH,
  TG_SESSION,
  API_KEY,
  N8N_WEBHOOK_URL = '',
  N8N_WEBHOOK_SECRET = '',
  SELF_URL = '', // URL n8n should use to reach this service, e.g. http://project_tg-gateway:3000
  MAX_DOWNLOAD_MB = '50',
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

/* ------------------------------ history helpers ------------------------------ */

const NUMERIC_ID_RE = /^-?\d+$/;

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
    try {
      const chat = await matched[0].getChat();
      title = chat?.title || chat?.username || chat?.firstName || null;
    } catch (_) {}
  }

  return {
    examined,
    chat: { chatId: target.key, title },
    messages: matched.map((m) => summarize(m, title)),
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

async function onNewMessage(event) {
  try {
    const m = event.message;
    let title = null;
    try {
      const chat = await m.getChat();
      title = chat?.title || chat?.username || chat?.firstName || null;
    } catch (_) {}
    await postToN8n(summarize(m, title));
  } catch (e) {
    console.error('onNewMessage error:', e);
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
    res.json(msgs.map((m) => summarize(m)));
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
  const hasSingleChat = body.chatId !== undefined && body.chatId !== null && String(body.chatId).trim() !== '';

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

  await warmEntityCache();
  client.addEventHandler(onNewMessage, new NewMessage({}));

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
