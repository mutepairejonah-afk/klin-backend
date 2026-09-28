import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { attachAuth, requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import sessionsRoutes from './routes/sessions.js';
import shareRoutes from './routes/share.js';
import connectionsRoutes, { secretsRouter } from './routes/connections.js';
import schedulesRoutes from './routes/schedules.js';
import artifactsRoutes, { usageRouter, auditRouter } from './routes/library.js';
import { settingsRouter, membersRouter, memoryRouter } from './routes/orgAdmin.js';
import sandboxesRoutes from './routes/sandboxes.js';

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(attachAuth); // populates req.user/db/orgId/role when a session cookie is present

// Auth routes are mounted before requireAuth — /auth/me, OAuth start/callback,
// and signout must all work while logged out.
app.use('/api/auth', authRoutes);
app.use('/api/share', shareRoutes); // unauthenticated, token-scoped

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
