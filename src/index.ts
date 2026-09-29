import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { requireAuth } from './middleware/auth.js';
import { attachClerkAuth } from './middleware/clerkAuth.js';
import authRoutes from './routes/auth.js';
import sessionsRoutes from './routes/sessions.js';
import shareRoutes from './routes/share.js';
import connectionsRoutes, { secretsRouter } from './routes/connections.js';
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

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`kiln-api listening on :${port}`));
