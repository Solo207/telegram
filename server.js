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
    date: m.date,
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

const MAX_HISTORY_LIMIT = 500;   // max messages returned per request
const MAX_HISTORY_SCAN = 5000;   // max messages examined when a single chat is requested
const MAX_DIALOGS = 50;          // chats examined when no chatId is given
const MAX_SCAN_PER_CHAT = 500;   // messages examined per chat in all-chats mode, when filtering by sender

// [123, "456"] -> Set("123", "456"). Missing, null or empty -> null (no sender filter).
// Throws on anything that is not an array of numeric IDs.
function parseSenderIds(input) {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) throw new Error('senderIds must be an array');
  const ids = input.map((v) => String(v).trim()).filter(Boolean);
  const bad = ids.find((id) => !/^\d+$/.test(id));
  if (bad) throw new Error(`invalid Telegram ID in senderIds: ${bad}`);
  return ids.length ? new Set(ids) : null;
}

function clampLimit(raw) {
  return Math.min(Math.max(parseInt(raw, 10) || 20, 1), MAX_HISTORY_LIMIT);
}

// Last `limit` messages in one chat, newest first.
async function historyForChat(chatId, limit, senders) {
  const { found, scanned } = await withPeer(chatId, async (peer) => {
    const matched = [];
    let examined = 0;
    for await (const m of client.iterMessages(peer, { limit: MAX_HISTORY_SCAN })) {
      examined++;
      if (!m || !m.id) continue;
      if (senders && !senders.has(String(m.senderId))) continue;
      matched.push(m);
      if (matched.length >= limit) break;
    }
    return { found: matched, scanned: examined };
  });

  let chatTitle = null;
  if (found.length) {
    try {
      const chat = await found[0].getChat();
      chatTitle = chat?.title || chat?.username || chat?.firstName || null;
    } catch (_) {}
  }

  return {
    count: found.length,
    scanned,
    messages: found.map((m) => summarize(m, chatTitle)),
  };
}

// Last `limit` messages across the most recent chats, newest first.
async function historyAcrossChats(limit, senders) {
  const dialogs = await client.getDialogs({ limit: MAX_DIALOGS });
  const collected = [];
  let scanned = 0;

  for (const d of dialogs) {
    if (!d.inputEntity) continue;
    const title = d.title || d.name || null;
    const perChat = [];
    let examined = 0;

    try {
      const scanLimit = senders ? MAX_SCAN_PER_CHAT : limit;
      for await (const m of client.iterMessages(d.inputEntity, { limit: scanLimit })) {
        examined++;
        if (!m || !m.id) continue;
        if (senders && !senders.has(String(m.senderId))) continue;
        perChat.push(summarize(m, title));
        if (perChat.length >= limit) break;
      }
    } catch (e) {
      console.error(`history scan failed for "${title}":`, e.message);
      continue;
    }

    scanned += examined;
    collected.push(...perChat);
  }

  collected.sort((a, b) => b.date - a.date);
  const messages = collected.slice(0, limit);
  return { count: messages.length, scanned, messages };
}

const NUMERIC_ID_RE = /^-?\d+$/;

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

// POST /history  { chatId?, limit?, senderIds? }
// With chatId: the most recent `limit` messages in that chat, newest first.
// Without chatId: the most recent `limit` messages across your recent chats, newest first.
// If senderIds is a non-empty array, only messages from those Telegram user IDs are returned.
app.post('/history', async (req, res) => {
  const { chatId: rawChatId, limit: rawLimit, senderIds: rawSenderIds } = req.body || {};

  const chatId =
    rawChatId === undefined || rawChatId === null ? '' : String(rawChatId).trim();

  if (chatId && !NUMERIC_ID_RE.test(chatId)) {
    return res.status(400).json({ error: 'chatId must be a numeric Telegram ID' });
  }

  let senders;
  try {
    senders = parseSenderIds(rawSenderIds);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const limit = clampLimit(rawLimit);

  try {
    if (chatId) {
      const result = await historyForChat(chatId, limit, senders);
      return res.json({ ok: true, scope: 'chat', ...result });
    }
    const result = await historyAcrossChats(limit, senders);
    res.json({ ok: true, scope: 'all', ...result });
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
