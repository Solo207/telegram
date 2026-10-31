'use strict';

const crypto = require('crypto');
const express = require('express');
const bigInt = require('big-integer');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { getPeerId } = require('telegram/Utils');

const env = process.env;
const {
  TG_API_ID,
  TG_API_HASH,
  TG_SESSION,
  API_KEY,
  N8N_WEBHOOK_URL = '',
  N8N_WEBHOOK_SECRET = '',
  SELF_URL = '', // how n8n reaches this service, e.g. http://project_service:3000
  MAX_DOWNLOAD_MB = '50',
  PORT = '3000',
} = env;

// true  = also forward messages sent FROM your account (incl. ones sent via /send)
const SEND_OUTGOING = (env.SEND_OUTGOING ?? 'true') !== 'false';
// true  = put the file itself (base64) in the webhook payload, not just the downloadUrl
const EMBED_MEDIA = env.EMBED_MEDIA === 'true';
const EMBED_MAX_BYTES = Number(env.EMBED_MAX_MB || 8) * 1024 * 1024;

let client = null;

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

// Describes a Telegram entity: type is one of user | bot | group | channel
function entityInfo(e) {
  if (!e) return null;
  const cls = e.className || '';
  let type = 'unknown';
  if (cls.startsWith('User')) type = e.bot ? 'bot' : 'user';
  else if (cls.startsWith('Chat')) type = 'group';
  else if (cls.startsWith('Channel')) type = e.broadcast ? 'channel' : 'group';

  let id = null;
  try {
    id = String(getPeerId(e));
  } catch (_) {
    id = e.id != null ? String(e.id) : null;
  }
  return {
    id,
    type,
    isSupergroup: cls === 'Channel' && !!e.megagroup,
    isSelf: !!e.self,
    name: e.title || [e.firstName, e.lastName].filter(Boolean).join(' ') || null,
    username: e.username || null,
  };
}

function mediaKind(m) {
  // Link previews look like photos to GramJS; they are not real attachments.
  if (!m.media || m.media.className === 'MessageMediaWebPage') return null;
  if (m.photo) return 'photo';
  if (m.sticker) return 'sticker';
  if (m.gif) return 'gif';
  if (m.video) return 'video';
  if (m.voice) return 'voice';
  if (m.audio) return 'audio';
  if (m.document) return 'document';
  return null;
}

/* ------------------------------ payload ------------------------------ */

async function buildPayload(m, opts = {}) {
  const { includeReply = true, embed = true, chatId: chatIdFallback } = opts;

  const [chatE, senderE] = await Promise.all([
    Promise.resolve().then(() => m.getChat()).catch(() => null),
    Promise.resolve().then(() => m.getSender()).catch(() => null),
  ]);

  const chat = entityInfo(chatE) || { id: null, type: 'unknown', name: null, username: null };
  const chatId = String(m.chatId ?? chatIdFallback ?? chat.id);
  chat.id = chat.id || chatId;

  const sender =
    entityInfo(senderE) ||
    (m.senderId ? { id: String(m.senderId), type: 'unknown', name: null, username: null } : null);

  const kind = mediaKind(m);
  const file = kind ? m.file : null;
  const fileSize = file?.size ? Number(file.size) : null;
  const text = m.message || '';

  const payload = {
    messageId: m.id,
    date: m.date,
    direction: m.out ? 'outgoing' : 'incoming',
    out: !!m.out,
    chatId,
    chat,
    sender,
    text,
    caption: kind ? text || null : null, // text sent together with an image/file
    mentioned: !!m.mentioned,
    hasMedia: !!kind,
    mediaType: kind,
    fileName: file?.name || null,
    mimeType: file?.mimeType || (kind === 'photo' ? 'image/jpeg' : null),
    fileSize,
    downloadUrl:
      kind && SELF_URL
        ? `${SELF_URL.replace(/\/$/, '')}/download?chatId=${chatId}&messageId=${m.id}`
        : null,
    groupedId: m.groupedId ? String(m.groupedId) : null, // same value = same album
    isReply: !!m.replyTo?.replyToMsgId,
    replyToMessageId: m.replyTo?.replyToMsgId ?? null,
    forwardedFrom: m.fwdFrom
      ? {
          channelId: m.fwdFrom.fromId?.channelId ? String(m.fwdFrom.fromId.channelId) : null,
          userId: m.fwdFrom.fromId?.userId ? String(m.fwdFrom.fromId.userId) : null,
          name: m.fwdFrom.fromName || null,
          channelPost: m.fwdFrom.channelPost ?? null,
          date: m.fwdFrom.date ?? null,
        }
      : null,
    replyTo: null,
  };

  // Optionally ship the file itself inside the webhook payload
  if (embed && EMBED_MEDIA && kind) {
    const okSize = fileSize ? fileSize <= EMBED_MAX_BYTES : kind === 'photo';
    if (okSize) {
      try {
        const buf = await client.downloadMedia(m, {});
        if (buf) payload.base64 = buf.toString('base64');
      } catch (e) {
        console.error('embed download failed:', e.message);
      }
    }
  }

  // Attach the message this one replies to
  if (includeReply && payload.isReply) {
    try {
      const r = await m.getReplyMessage();
      if (r && r.className !== 'MessageService') {
        payload.replyTo = await buildPayload(r, {
          includeReply: false,
          embed: false,
          chatId,
        });
      }
    } catch (e) {
      console.error('reply fetch failed:', e.message);
    }
  }

  return payload;
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
    if (!SEND_OUTGOING && m.out) return;
    await postToN8n(await buildPayload(m));
  } catch (e) {
    console.error('onNewMessage error:', e);
  }
}

/* --------------------------------- HTTP API --------------------------------- */

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.status(client?.connected ? 200 : 503).json({ ok: !!client?.connected });
});

app.use((req, res, next) => {
  const key = req.get('x-api-key') || '';
  if (!API_KEY || !safeEq(key, API_KEY)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// GET /download?chatId=...&messageId=...[&format=base64]
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
    const sendFn = (peer) => client.sendMessage(peer, { message: text, replyTo });
    const sent = /^-?\d+$/.test(String(chatId))
      ? await withPeer(chatId, sendFn)
      : await sendFn(String(chatId));
    res.json({ ok: true, messageId: sent.id });
  } catch (e) {
    console.error('/send error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /messages?chatId=...&limit=20[&withReply=true]
app.get('/messages', async (req, res) => {
  try {
    const { chatId } = req.query;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    if (!chatId) return res.status(400).json({ error: 'chatId is required' });
    const msgs = await withPeer(chatId, (peer) => client.getMessages(peer, { limit }));
    const withReply = req.query.withReply === 'true';
    res.json(
      await Promise.all(msgs.map((m) => buildPayload(m, { includeReply: withReply, embed: false }))),
    );
  } catch (e) {
    console.error('/messages error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------- boot ---------------------------------- */

async function main() {
  for (const [k, v] of Object.entries({ TG_API_ID, TG_API_HASH, TG_SESSION, API_KEY })) {
    if (!v) {
      console.error(`Missing required env var: ${k}`);
      process.exit(1);
    }
  }

  client = new TelegramClient(new StringSession(TG_SESSION), Number(TG_API_ID), TG_API_HASH, {
    connectionRetries: 10,
    autoReconnect: true,
  });

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
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal startup error:', e);
    process.exit(1);
  });
}

module.exports = { buildPayload, entityInfo, mediaKind };
