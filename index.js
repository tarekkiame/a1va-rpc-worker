import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { createRpcHandler } from '@runwayml/avatars-node-rpc';

const PORT = process.env.PORT || 3000;
const RUNWAY_API_KEY =
  process.env.RUNWAYML_API_SECRET || process.env.RUNWAY_API_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!RUNWAY_API_KEY) {
  console.warn('[warn] RUNWAY_API_KEY is not set');
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[warn] SUPABASE_SERVICE_ROLE_KEY is not set');
}

const app = express();
app.use((req, res, next) => {
  console.log("Incoming request:", req.method, req.url);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  console.log("Root endpoint hit");
  res.send("Worker is alive");
});

const activeSessions = new Map();

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

function log(sessionId, ...args) {
  console.log(`[session:${sessionId}]`, ...args);
}

async function startSession({ sessionId, avatarId, livekitUrl, livekitToken, supabaseUrl }) {
  log(sessionId, 'starting session', { avatarId });

  const handler = await createRpcHandler({
    apiKey: RUNWAY_API_KEY,
    sessionId,
    livekitUrl,
    livekitToken,
  });

  handler.registerTool({
    name: 'search_knowledge',
    description: 'Search the avatar knowledge base for information relevant to the user query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        currentUrl: { type: 'string', description: 'The current page URL context' },
      },
      required: ['query'],
    },
    handler: async ({ query, currentUrl }) => {
      log(sessionId, 'tool called: search_knowledge', { query, currentUrl });
      const endpoint = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/search-avatar-knowledge`;
      const started = Date.now();
      try {
        const resp = await axios.post(
          endpoint,
          { avatarId, query, currentUrl, maxResults: 5 },
          {
            headers: {
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          }
        );
        const elapsed = Date.now() - started;
        log(sessionId, `supabase responded in ${elapsed}ms`, { status: resp.status });
        const results = resp.data?.results || [];
        if (!results.length) {
          return {
            text: "No relevant information found in the website knowledge."
          };
        }
        const formatted = results.map(r =>
          `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.snippet}`
        ).join('\n\n');
        return {
          text: formatted
        };
      } catch (err) {
        const elapsed = Date.now() - started;
        log(sessionId, `supabase error after ${elapsed}ms`, err?.response?.status, err?.message);
        return { error: 'search_failed', message: err?.message || 'unknown error', results: [] };
      }
    },
  });

  await Promise.race([
    handler.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('connect timeout')), 10000)
    )
  ]);
  log(sessionId, 'connected to Runway / LiveKit');
  log(sessionId, 'RPC tools registered and ready');

  if (typeof handler.on === 'function') {
    handler.on('disconnect', () => {
      log(sessionId, 'disconnected');
      activeSessions.delete(sessionId);
    });
    handler.on('error', (err) => {
      log(sessionId, 'handler error', err?.message || err);
    });
  }

  activeSessions.set(sessionId, handler);
  return handler;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, activeSessions: activeSessions.size });
});

app.post('/start-session', async (req, res) => {
  console.log('Raw body received:', req.body);

  if (!req.body || Object.keys(req.body).length === 0) {
    console.log('⚠️ Empty body received from webhook');
  }

  const body = req.body || {};
  const {
    sessionId,
    avatarId,
    runwaySessionId,
    livekitUrl,
    livekitToken,
    roomName,
    supabaseUrl,
    ragEnabled,
  } = body;

  const rpcSessionId = runwaySessionId || sessionId;

  console.log('Parsed:', { sessionId, avatarId, ragEnabled });
  console.log(`Webhook received for session ${sessionId}`);
  console.log('[start-session] ids', {
    sessionId,
    runwaySessionId,
    rpcSessionId,
  });
  console.log('[start-session] payload', {
    sessionId,
    avatarId,
    ragEnabled,
    runwaySessionId: runwaySessionId ? '<present>' : undefined,
    rpcSessionId,
    roomName,
    hasLivekitUrl: !!livekitUrl,
    hasLivekitToken: !!livekitToken,
    hasSupabaseUrl: !!supabaseUrl,
  });

  if (ragEnabled !== true) {
    console.log('[start-session] rag disabled, skipping', { sessionId });
    return res.status(200).json({ status: 'skipped', reason: 'rag_disabled' });
  }

  if (!sessionId) {
    console.warn('[start-session] missing sessionId, aborting');
    return res.status(400).json({
      status: 'error',
      error: 'missing_session_id',
    });
  }

  if (activeSessions.has(sessionId)) {
    console.log(`[start-session] session ${sessionId} already running`);
    return res.status(200).json({ status: 'already_running', sessionId });
  }

  res.status(202).json({ status: 'starting', sessionId });

  console.log(`[session:${sessionId}] Starting RPC session...`);

  startSession({
    sessionId: rpcSessionId,
    avatarId,
    livekitUrl,
    livekitToken,
    supabaseUrl,
  }).catch((err) => {
    console.error(`[session:${rpcSessionId}] failed to start`, err?.message || err);
    activeSessions.delete(rpcSessionId);
  });
});

app.post('/stop-session', async (req, res) => {
  const { sessionId } = req.body || {};
  const handler = activeSessions.get(sessionId);
  if (!handler) {
    return res.status(404).json({ status: 'not_found' });
  }
  try {
    if (typeof handler.disconnect === 'function') {
      await handler.disconnect();
    }
  } catch (err) {
    console.error(`[session:${sessionId}] disconnect error`, err?.message || err);
  }
  activeSessions.delete(sessionId);
  res.json({ status: 'stopped', sessionId });
});

app.use((err, _req, res, _next) => {
  console.error('[express error]', err);
  res.status(500).json({ status: 'error', error: err?.message || 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`Runway RPC worker listening on :${PORT}`);
});
