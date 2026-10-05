import { Router } from 'express';
import { z } from 'zod';
import { appendAudit } from '../lib/audit.js';
import { CONNECTOR_CATALOG } from '../lib/connectorCatalog.js';
import { isManualConnector, verifyConnectorToken } from '../lib/connectorProviders.js';
import { decrypt, encrypt, signState, verifyState } from '../lib/crypto.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireOperator } from '../middleware/auth.js';

const router = Router();

// GitHub uses OAuth; the other catalog providers use encrypted API tokens.
const REAL_OAUTH = new Set(['github']);

function backendUrl(req: import('express').Request) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
}

// GET /connections/github/start — authenticated (needs req.orgId from Clerk).
// Returns a URL for the frontend to navigate to, rather than redirecting
// itself, since this is called via fetch (so the Clerk bearer token attaches).
router.get('/github/start', async (req, res) => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GitHub OAuth is not configured on the server yet' });
  const state = signState({ orgId: req.orgId, ts: Date.now() });
  const redirectUri = `${backendUrl(req)}/api/connections/github/callback`;
  const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('repo read:user')}&state=${encodeURIComponent(state)}`;
  res.json({ url });
});

export const connectionsPublicRouter = Router();

// GET /connections/github/callback — public; GitHub redirects the browser
// here with no auth header, so the org comes from the signed `state` instead.
connectionsPublicRouter.get('/github/callback', async (req, res) => {
  const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    const payload = state ? verifyState<{ orgId: string; ts: number }>(state) : null;
    if (!code || !payload?.orgId) return res.redirect(`${frontend}/connections?error=github_state`);

    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return res.redirect(`${frontend}/connections?error=github_not_configured`);

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${backendUrl(req)}/api/connections/github/callback` }),
    });
    const tokenJson: any = await tokenRes.json();
    if (!tokenJson.access_token) {
      console.error('github token exchange failed', tokenJson);
      return res.redirect(`${frontend}/connections?error=github_token`);
    }

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}`, 'User-Agent': 'klin-app', Accept: 'application/vnd.github+json' },
    });
    const ghUser: any = await userRes.json();

    const { error } = await supabaseAdmin.from('connections').upsert({
      org_id: payload.orgId, provider: 'github', connected: true,
      scopes: ['repo', 'read:user'], connected_at: new Date().toISOString(),
      encrypted_credentials: encrypt(tokenJson.access_token),
      meta: { login: ghUser.login, avatarUrl: ghUser.avatar_url },
    }, { onConflict: 'org_id,provider' });
    if (error) { console.error('github connection save failed', error); return res.redirect(`${frontend}/connections?error=github_save`); }

    await appendAudit({ orgId: payload.orgId, actor: 'oauth:github', action: 'connection.connected', detail: 'github', ip: req.ip });
    res.redirect(`${frontend}/connections?connected=github`);
  } catch (e) {
    console.error('github oauth callback failed', e);
    res.redirect(`${frontend}/connections?error=github_exception`);
  }
});

// GET /connections/github/repos — repos the connected GitHub account can see.
router.get('/github/repos', async (req, res) => {
  const { data: conn } = await req.db!.from('connections').select('encrypted_credentials, connected')
    .eq('org_id', req.orgId).eq('provider', 'github').maybeSingle();
  if (!conn?.connected || !conn.encrypted_credentials) return res.status(400).json({ error: 'GitHub is not connected' });

  let token: string;
  try { token = decrypt(conn.encrypted_credentials); } catch { return res.status(500).json({ error: 'Stored GitHub credentials are unreadable — reconnect GitHub' }); }

  const r = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'klin-app' },
  });
  if (!r.ok) return res.status(502).json({ error: `GitHub API error (${r.status})` });
  const repos = (await r.json()) as any[];
  await req.db!.from('connections').update({ last_used_at: new Date().toISOString() }).eq('org_id', req.orgId).eq('provider', 'github');
  res.json(repos.map((x) => ({ fullName: x.full_name, private: x.private, defaultBranch: x.default_branch, updatedAt: x.updated_at })));
});

// GET /connections/github/repos/:owner/:repo/branches
router.get('/github/repos/:owner/:repo/branches', async (req, res) => {
  const { data: conn } = await req.db!.from('connections').select('encrypted_credentials, connected')
    .eq('org_id', req.orgId).eq('provider', 'github').maybeSingle();
  if (!conn?.connected || !conn.encrypted_credentials) return res.status(400).json({ error: 'GitHub is not connected' });

  let token: string;
  try { token = decrypt(conn.encrypted_credentials); } catch { return res.status(500).json({ error: 'Stored GitHub credentials are unreadable — reconnect GitHub' }); }

  const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/branches?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'klin-app' },
  });
  if (!r.ok) return res.status(502).json({ error: `GitHub API error (${r.status})` });
  const branches = (await r.json()) as any[];
  res.json(branches.map((b) => b.name));
});

// GET /connections — merges the static catalog (name/description/scopes)
// with per-org connected state stored in the `connections` table.
router.get('/', async (req, res) => {
  const { data, error } = await req.db!.from('connections').select('*').eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  const byProvider = new Map((data ?? []).map((c: any) => [c.provider, c]));

  res.json(CONNECTOR_CATALOG.map((c) => {
    const row = byProvider.get(c.id);
    return {
      id: c.id, name: c.name, description: c.description, scopes: c.scopes,
      connected: row?.connected ?? false,
      oauth: REAL_OAUTH.has(c.id),
      meta: row?.meta ?? undefined,
      lastUsedAt: row?.last_used_at ?? undefined,
    };
  }));
});

// POST /connections/:id/connect — validates and encrypts a provider token.
// GitHub remains OAuth-only; all other catalog providers use this token flow.
router.post('/:id/connect', requireOperator, async (req, res) => {
  const catalogEntry = CONNECTOR_CATALOG.find((c) => c.id === req.params.id);
  if (!catalogEntry) return res.status(404).json({ error: 'unknown connector' });
  if (REAL_OAUTH.has(req.params.id)) return res.status(400).json({ error: 'use the OAuth flow for this connector' });
  if (!isManualConnector(req.params.id)) return res.status(400).json({ error: 'connector authentication is not configured' });
  const parsed = z.object({ token: z.string().trim().min(8).max(4096) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'a provider token is required' });
  try {
    const verified = await verifyConnectorToken(req.params.id, parsed.data.token);
    const { data, error } = await req.db!.from('connections').upsert({
      org_id: req.orgId, provider: req.params.id, connected: true,
      scopes: verified.scopes, connected_at: new Date().toISOString(),
      encrypted_credentials: encrypt(parsed.data.token), meta: verified.meta,
    }, { onConflict: 'org_id,provider' }).select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    await appendAudit({ orgId: req.orgId!, actor: req.user!.email, action: 'connection.connected', detail: req.params.id, ip: req.ip });
    res.status(201).json({
      id: catalogEntry.id, name: catalogEntry.name, description: catalogEntry.description,
      scopes: data.scopes, connected: true, oauth: false, meta: data.meta, lastUsedAt: data.last_used_at ?? undefined,
    });
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : 'credential validation failed' });
  }
});

// DELETE /connections/:id
router.delete('/:id', requireOperator, async (req, res) => {
  const { error } = await req.db!.from('connections').delete().eq('org_id', req.orgId).eq('provider', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  await appendAudit({ orgId: req.orgId!, actor: req.user!.email, action: 'connection.disconnected', detail: req.params.id, ip: req.ip });
  res.status(204).end();
});

export const secretsRouter = Router();

function toSecretDTO(row: any) {
  return { id: row.id, handle: row.handle, scope: row.scope, createdAt: row.created_at, lastUsedAt: row.last_used_at ?? undefined };
}

// GET /secrets — handle-only, value never returned (§8)
secretsRouter.get('/', async (req, res) => {
  const { data, error } = await req.db!.from('secrets').select('id, handle, scope, created_at, last_used_at').eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map(toSecretDTO));
});

// POST /secrets — { handle, value, scope }. Value is encrypted at rest and
// never included in any response; the sandbox resolves it at command time.
secretsRouter.post('/', requireOperator, async (req, res) => {
  const { handle, value, scope } = req.body ?? {};
  if (!handle || !value || !scope) return res.status(400).json({ error: 'handle, value, scope required' });

  // Store reversible authenticated encryption: the sandbox must be able to
  // resolve the handle at execution time, while the value never goes to the
  // frontend or event log.
  const encrypted = encrypt(String(value));

  const { data, error } = await req.db!
    .from('secrets')
    .upsert({ org_id: req.orgId, handle, encrypted_value: encrypted, scope }, { onConflict: 'org_id,handle' })
    .select('id, handle, scope, created_at, last_used_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await appendAudit({ orgId: req.orgId!, actor: req.user!.email, action: 'secret.created', detail: handle, ip: req.ip });
  res.status(201).json(toSecretDTO(data));
});

secretsRouter.delete('/:id', requireOperator, async (req, res) => {
  const { error } = await req.db!.from('secrets').delete().eq('id', req.params.id).eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  await appendAudit({ orgId: req.orgId!, actor: req.user!.email, action: 'secret.deleted', detail: req.params.id, ip: req.ip });
  res.status(204).end();
});

export default router;
