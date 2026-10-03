import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { requireAuth } from './middleware/auth.js';
import { attachClerkAuth } from './middleware/clerkAuth.js';
import authRoutes from './routes/auth.js';
import sessionsRoutes from './routes/sessions.js';
import shareRoutes from './routes/share.js';
import connectionsRoutes, { secretsRouter, connectionsPublicRouter } from './routes/connections.js';
import schedulesRoutes from './routes/schedules.js';
import artifactsRoutes, { usageRouter, auditRouter } from './routes/library.js';
import { settingsRouter, membersRouter, memoryRouter } from './routes/orgAdmin.js';
import sandboxesRoutes from './routes/sandboxes.js';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(attachClerkAuth); // populates req.user/db/orgId/role from a Clerk Bearer token

// Auth routes are mounted before requireAuth — /auth/me, OAuth start/callback,
// and signout must all work while logged out.
// Legacy Supabase-cookie OAuth routes — unused now that Clerk handles sign-in,
// kept mounted only so old links/callbacks 404 gracefully instead of erroring.
app.use('/api/auth', authRoutes);
app.use('/api/share', shareRoutes); // unauthenticated, token-scoped

// Interactive API docs at /api/docs — public, same openapi.yaml published to GitHub Pages.
try {
  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'openapi.yaml'), 'utf8'));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec));
} catch (e) {
  console.error('failed to load openapi.yaml for /api/docs', e);
}

// Everything below requires a valid session + org membership.
// Public OAuth callbacks (GitHub redirects the browser here directly, no
// Clerk auth header) must be mounted before requireAuth.
app.use('/api/connections', connectionsPublicRouter);

app.use('/api', requireAuth);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/connections', connectionsRoutes);
app.use('/api/secrets', secretsRouter);
app.use('/api/schedules', schedulesRoutes);
app.use('/api/artifacts', artifactsRoutes);
app.use('/api/usage', usageRouter);
app.use('/api/audit', auditRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/members', membersRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/sandboxes', sandboxesRoutes);

// GET /api/models — which AI providers are actually configured on this server
// (so Settings can't offer to pick a provider with no key behind it), plus a
// short curated list of known-good models per provider.
app.get('/api/models', requireAuth, async (_req, res) => {
  const { availableProviders } = await import('./lib/llm.js');
  const CATALOG: Record<string, { label: string; models: { id: string; label: string }[] }> = {
    openrouter: { label: 'OpenRouter', models: [
      { id: 'openrouter/free', label: 'Free router (auto-picks a free model)' },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)' },
      { id: 'qwen/qwen-2.5-coder-32b-instruct:free', label: 'Qwen 2.5 Coder 32B (free)' },
    ] },
    google: { label: 'Google Gemini', models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (fastest)' },
    ] },
    ollama: { label: 'Ollama Cloud', models: [
      { id: 'gpt-oss:20b', label: 'GPT-OSS 20B' },
      { id: 'gpt-oss:120b', label: 'GPT-OSS 120B' },
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    ] },
    anthropic: { label: 'Anthropic Claude (paid)', models: [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    ] },
  };
  const configured = new Set(availableProviders());
  res.json(Object.entries(CATALOG).map(([id, v]) => ({ id, ...v, configured: configured.has(id as any) })));
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`kiln-api listening on :${port}`));
