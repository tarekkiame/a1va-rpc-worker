# Runway RPC Worker

A standalone Node.js worker that bridges Runway avatar sessions to a Supabase
edge function for knowledge retrieval. On `POST /start-session` it connects to
Runway / LiveKit and registers a `search_knowledge` tool that proxies requests
to `/functions/v1/search-avatar-knowledge` on your Supabase project.

## Requirements

- Node.js 18+

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Add the required secrets to `.env`:

   ```
   RUNWAY_API_KEY=your_runway_api_key
   SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
   PORT=3000
   ```

3. Run the server:

   ```bash
   npm start
   ```

   For auto-reload during development:

   ```bash
   npm run dev
   ```

## Endpoints

### `POST /start-session`

Start (or join) a Runway session and register the `search_knowledge` tool.

Request body:

```json
{
  "sessionId": "sess_...",
  "avatarId": "avatar_...",
  "livekitUrl": "wss://...",
  "livekitToken": "eyJ...",
  "supabaseUrl": "https://xxxx.supabase.co",
  "ragEnabled": true
}
```

Responses:

- `200 { "status": "skipped", "reason": "rag_disabled" }` when `ragEnabled` is false.
- `202 { "status": "starting", "sessionId": "..." }` when the session is being started.
- `200 { "status": "already_running" }` if the sessionId is already active.
- `400` with an `error` field when required fields are missing.

### `POST /stop-session`

```json
{ "sessionId": "sess_..." }
```

Disconnects and removes the session handler.

### `GET /health`

Returns `{ ok: true, activeSessions: <n> }`.

## Notes

- The worker keeps an in-memory map of active sessions and supports multiple
  concurrent sessions.
- All Supabase knowledge lookups go through the edge function; there is no
  direct database access from this process.
- Errors in the tool handler are caught and returned as a structured error
  payload so the session itself does not crash.
