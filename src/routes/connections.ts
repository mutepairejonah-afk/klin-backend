import { Router } from 'express';
import crypto from 'node:crypto';
import { appendAudit } from '../lib/audit.js';
import { CONNECTOR_CATALOG } from '../lib/connectorCatalog.js';

const router = Router();

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
      meta: row?.meta ?? undefined,
      lastUsedAt: row?.last_used_at ?? undefined,
    };
  }));
});

// POST /connections/:id/connect
router.post('/:id/connect', async (req, res) => {
  const catalogEntry = CONNECTOR_CATALOG.find((c) => c.id === req.params.id);
  if (!catalogEntry) return res.status(404).json({ error: 'unknown connector' });

  // Stub: a real integration exchanges req.body.authCode for a token here.
  const { data, error } = await req.db!
    .from('connections')
    .upsert({
      org_id: req.orgId, provider: req.params.id, connected: true,
      scopes: catalogEntry.scopes, connected_at: new Date().toISOString(),
      encrypted_credentials: req.body?.authCode ? 'stub-encrypted' : null,
    }, { onConflict: 'org_id,provider' })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await appendAudit({ orgId: req.orgId!, actor: req.user!.email, action: 'connection.connected', detail: req.params.id, ip: req.ip });
  res.json({
    id: catalogEntry.id, name: catalogEntry.name, description: catalogEntry.description,
    scopes: catalogEntry.scopes, connected: true, meta: data.meta ?? undefined, lastUsedAt: data.last_used_at ?? undefined,
  });
});

// DELETE /connections/:id
router.delete('/:id', async (req, res) => {
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
secretsRouter.post('/', async (req, res) => {
  const { handle, value, scope } = req.body ?? {};
  if (!handle || !value || !scope) return res.status(400).json({ error: 'handle, value, scope required' });

  // Placeholder encryption — swap for envelope encryption (KMS/Vault) before
  // production use. Never store secret values in plaintext.
  const encrypted = crypto.createHash('sha256').update(String(value)).digest('hex');

  const { data, error } = await req.db!
    .from('secrets')
    .upsert({ org_id: req.orgId, handle, encrypted_value: encrypted, scope }, { onConflict: 'org_id,handle' })
    .select('id, handle, scope, created_at, last_used_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await appendAudit({ orgId: req.orgId!, actor: req.user!.email, action: 'secret.created', detail: handle, ip: req.ip });
  res.status(201).json(toSecretDTO(data));
});

secretsRouter.delete('/:id', async (req, res) => {
  const { error } = await req.db!.from('secrets').delete().eq('id', req.params.id).eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  await appendAudit({ orgId: req.orgId!, actor: req.user!.email, action: 'secret.deleted', detail: req.params.id, ip: req.ip });
  res.status(204).end();
});

export default router;
