# tg-gateway

Telegram MTProto (GramJS) gateway for n8n. One service that:

- **listens** for new messages and POSTs them to an n8n Webhook
- **downloads** photos / files on demand
- **sends** messages and **reads** history

All endpoints (except `/health`) need header `x-api-key: <API_KEY>`.

| Endpoint | What it does |
|---|---|
| `GET /health` | Connection status |
| `GET /download?chatId=..&messageId=..` | Returns the file bytes. Add `&format=base64` for JSON |
| `POST /send` `{chatId, text, replyTo?}` | Send a message (`chatId` may be `me` or `@username`) |
| `GET /messages?chatId=..&limit=20` | Recent messages |

## 1. Get a session string (once)

Get `API_ID` / `API_HASH` from https://my.telegram.org/apps, then:

    npm install
    TG_API_ID=123 TG_API_HASH=abc node generate-session.js

Paste the printed string into `TG_SESSION`. Treat it like a password.
Generate a NEW one for this server; don't reuse the n8n node's session.

## 2. Deploy on EasyPanel

1. Push this folder to a GitHub repo.
2. In your EasyPanel project: **+ Service -> App**, source = GitHub repo, build = **Dockerfile**.
3. **Environment**: copy everything from `.env.example` and fill it in.
4. **Domains & Ports**: container port `3000`. A public domain is optional;
   if n8n is in the same EasyPanel project, use the internal host instead
   (shown in the service settings, usually `project_service`) for `SELF_URL`.
5. Deploy. Logs should say `Telegram connected as ...`.

## 3. n8n workflow

**Incoming:** Webhook node (POST) -> each message arrives as JSON in `body`
(`messageId`, `chatId`, `text`, `hasMedia`, `mediaType`, `downloadUrl`, `forwardedFrom`, ...).
Optionally protect it with Header Auth (`x-webhook-secret` = `N8N_WEBHOOK_SECRET`).

**Download the image:** IF `{{ $json.body.hasMedia }}` -> HTTP Request node
- Method GET, URL `{{ $json.body.downloadUrl }}`
- Header `x-api-key` = your API_KEY
- Response -> Format: **File**

**Send:** HTTP Request, POST `/send`, JSON body `{"chatId":"...", "text":"..."}`.

Run ONE replica only. Two copies with the same session fight each other.
