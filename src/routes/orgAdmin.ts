import { Router } from 'express';
import { z } from 'zod';
import { requireOperator } from '../middleware/auth.js';
import { clerk, getClerkProfile } from '../middleware/clerkAuth.js';

export const settingsRouter = Router();

function toSettingsDTO(row: any) {
  return {
    name: row.name ?? '', email: row.email ?? '',
    testFramework: row.test_framework, commitStyle: row.commit_style, branchNaming: row.branch_naming,
    modelRouting: row.model_routing, networkAllowlist: row.network_allowlist, approvalRules: row.approval_rules,
  };
}

settingsRouter.get('/', async (req, res) => {
  const { data, error } = await req.db!
    .from('user_settings').select('*').eq('org_id', req.orgId).eq('user_id', req.user!.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) {
    // Row is created by the on-signup trigger, but fall back gracefully.
    return res.json({
      name: req.user!.name, email: req.user!.email, testFramework: 'auto', commitStyle: 'conventional',
      branchNaming: 'kiln/{job}-{slug}', modelRouting: {}, networkAllowlist: [], approvalRules: {},
    });
  }
  res.json(toSettingsDTO(data));
});

settingsRouter.patch('/', async (req, res) => {
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.email !== undefined) patch.email = b.email;
  if (b.testFramework !== undefined) patch.test_framework = b.testFramework;
  if (b.commitStyle !== undefined) patch.commit_style = b.commitStyle;
  if (b.branchNaming !== undefined) patch.branch_naming = b.branchNaming;
  if (b.modelRouting !== undefined) patch.model_routing = b.modelRouting;
  if (b.networkAllowlist !== undefined) patch.network_allowlist = b.networkAllowlist;
  if (b.approvalRules !== undefined) patch.approval_rules = b.approvalRules;

  const { data, error } = await req.db!
    .from('user_settings')
    .upsert({ org_id: req.orgId, user_id: req.user!.id, ...patch }, { onConflict: 'org_id,user_id' })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(toSettingsDTO(data));
});

export const membersRouter = Router();
const memberInput = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(['owner', 'operator', 'viewer']),
});

membersRouter.get('/invitations', async (req, res) => {
  const { data, error } = await req.db!.from('org_invitations')
    .select('id, email, role, status, created_at')
    .eq('org_id', req.orgId).eq('status', 'pending')
    .order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map((invite: any) => ({
    id: invite.id, name: invite.email, email: invite.email, role: invite.role,
    status: invite.status, createdAt: invite.created_at,
  })));
});

membersRouter.get('/', async (req, res) => {
  const { data, error } = await req.db!.from('members').select('id, user_id, role').eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });

  const rows = await Promise.all((data ?? []).map(async (m: any) => {
    let profile = { name: 'Unknown', email: '' };
    try { profile = await getClerkProfile(m.user_id); } catch { /* stale member; keep a safe placeholder */ }
    return {
      id: m.id, role: m.role,
      name: profile.name || profile.email || 'Unknown',
      email: profile.email,
    };
  }));
  res.json(rows);
});

// POST /members — invite. Requires operator/owner.
membersRouter.post('/', requireOperator, async (req, res) => {
  const parsed = memberInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'email must be valid and role must be owner, operator, or viewer' });
  const { email, role } = parsed.data;
  if (role === 'owner' && req.role !== 'owner') return res.status(403).json({ error: 'only an owner can assign the owner role' });

  let invitation;
  try {
    invitation = await clerk.invitations.createInvitation({
      emailAddress: email.toLowerCase(),
      publicMetadata: { kilnOrgId: req.orgId, kilnRole: role },
      redirectUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : 'Clerk invitation failed' });
  }
  const { data, error } = await req.db!.from('org_invitations').insert({
    org_id: req.orgId, clerk_invitation_id: invitation.id, email: email.toLowerCase(), role,
  }).select('id, role').single();
  if (error) {
    await clerk.invitations.revokeInvitation(invitation.id).catch(() => {});
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ id: data.id, name: email, email, role: data.role, status: 'pending' });
});

membersRouter.patch('/:id', requireOperator, async (req, res) => {
  const parsed = z.object({ role: z.enum(['owner', 'operator', 'viewer']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'role must be owner, operator, or viewer' });
  const { role } = parsed.data;
  if (role === 'owner' && req.role !== 'owner') return res.status(403).json({ error: 'only an owner can assign the owner role' });
  const { data, error } = await req.db!.from('members').update({ role }).eq('id', req.params.id).eq('org_id', req.orgId).select('id, user_id, role').single();
  if (error) return res.status(500).json({ error: error.message });

  let profile = { name: '', email: '' };
  try { profile = await getClerkProfile(data.user_id); } catch { /* keep a safe empty profile */ }
  res.json({ id: data.id, role: data.role, name: profile.name || profile.email, email: profile.email });
});

export const memoryRouter = Router();

memoryRouter.get('/repos', async (req, res) => {
  const { data, error } = await req.db!.from('repo_index').select('repo, files, symbols, indexed_at, stale').eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map((r: any) => ({ repo: r.repo, files: r.files, symbols: r.symbols, indexedAt: r.indexed_at, stale: r.stale })));
});

memoryRouter.post('/repos/reindex', requireOperator, async (req, res) => {
  const { repo } = req.body ?? {};
  if (!repo) return res.status(400).json({ error: 'repo required' });
  return res.status(501).json({ error: 'repository indexing worker is not configured yet' });
});

memoryRouter.get('/user', async (req, res) => {
  const { data, error } = await req.db!.from('user_memory').select('key, value').eq('org_id', req.orgId).eq('user_id', req.user!.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value])));
});

memoryRouter.patch('/user', async (req, res) => {
  const patch = (req.body ?? {}) as Record<string, string>;
  const rows = Object.entries(patch).map(([key, value]) => ({ org_id: req.orgId, user_id: req.user!.id, key, value }));
  if (rows.length) {
    const { error } = await req.db!.from('user_memory').upsert(rows, { onConflict: 'org_id,user_id,key' });
    if (error) return res.status(500).json({ error: error.message });
  }
  const { data } = await req.db!.from('user_memory').select('key, value').eq('org_id', req.orgId).eq('user_id', req.user!.id);
  res.json(Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value])));
});

memoryRouter.get('/org', async (req, res) => {
  const { data, error } = await req.db!.from('org_memory').select('id, text, kind').eq('org_id', req.orgId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

memoryRouter.post('/org', requireOperator, async (req, res) => {
  const { text, kind } = req.body ?? {};
  if (!text || !kind) return res.status(400).json({ error: 'text, kind required' });
  const { data, error } = await req.db!.from('org_memory').insert({ org_id: req.orgId, text, kind }).select('id, text, kind').single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});
