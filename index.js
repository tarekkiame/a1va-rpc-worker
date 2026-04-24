import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { createRpcHandler } from '@runwayml/avatars-node-rpc';

const PORT = process.env.PORT || 3000;
const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const app = express();

// 🔥 DEBUG LOGGER
app.use((req, res, next) => {
  console.log("Incoming request:", req.method, req.url);
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 🔥 ROOT TEST
app.get("/", (req, res) => {
  console.log("Root endpoint hit");
  res.send("Worker is alive");
});

const activeSessions = new Map();

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
    description: 'Search website knowledge',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        currentUrl: { type: 'string' },
      },
      required: ['query'],
    },
    handler: async ({ query, currentUrl }) => {
      log(sessionId, 'tool called:', query);

      const resp = await axios.post(
        `${supabaseUrl}/functions/v1/search-avatar-knowledge`,
        { avatarId, query, currentUrl, maxResults: 5 },
        {
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );

      const results = resp.data?.results || [];

      return {
        text: results.map(r => r.snippet).join("\n\n") || "No info found"
      };
    },
  });

  await handler.connect();
  log(sessionId, 'connected');
}

app.post('/start-session', async (req, res) => {
  console.log("Webhook received:", req.body);

  const { sessionId, avatarId, livekitUrl, livekitToken, supabaseUrl, ragEnabled } = req.body;

  if (!ragEnabled) return res.json({ skipped: true });

  res.status(202).json({ ok: true });

  startSession({ sessionId, avatarId, livekitUrl, livekitToken, supabaseUrl });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Worker running on ${PORT}`);
});
