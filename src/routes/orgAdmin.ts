import { Router } from 'express';
import { requireOperator } from '../middleware/auth.js';

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

membersRouter.get('/', async (req, res) => {
  const { data, error } = await req.db!.from('members').select('id, user_id, role').eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });

  // members table only has user_id/role; join display name/email from auth
  // via the admin API (service role) since RLS-scoped clients can't read auth.users.
  const { supabaseAdmin } = await import('../lib/supabase.js');
  const rows = await Promise.all((data ?? []).map(async (m: any) => {
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(m.user_id);
    return {
      id: m.id, role: m.role,
      name: (u?.user?.user_metadata?.name as string) ?? u?.user?.email ?? 'Unknown',
      email: u?.user?.email ?? '',
    };
  }));
  res.json(rows);
});

// POST /members — invite. Requires operator/owner.
membersRouter.post('/', requireOperator, async (req, res) => {
  const { email, role } = req.body ?? {};
  if (!email || !role) return res.status(400).json({ error: 'email, role required' });

  const { supabaseAdmin } = await import('../lib/supabase.js');
  const { data: invite, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email);
  if (inviteErr || !invite?.user) return res.status(500).json({ error: inviteErr?.message ?? 'invite failed' });

  const { data, error } = await req.db!
    .from('members')
    .insert({ org_id: req.orgId, user_id: invite.user.id, role })
    .select('id, role')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ id: data.id, name: email, email, role: data.role });
});

membersRouter.patch('/:id', requireOperator, async (req, res) => {
  const { role } = req.body ?? {};
  if (!role) return res.status(400).json({ error: 'role required' });
  const { data, error } = await req.db!.from('members').update({ role }).eq('id', req.params.id).eq('org_id', req.orgId).select('id, user_id, role').single();
  if (error) return res.status(500).json({ error: error.message });

  const { supabaseAdmin } = await import('../lib/supabase.js');
  const { data: u } = await supabaseAdmin.auth.admin.getUserById(data.user_id);
  res.json({ id: data.id, role: data.role, name: (u?.user?.user_metadata?.name as string) ?? u?.user?.email ?? '', email: u?.user?.email ?? '' });
});

export const memoryRouter = Router();

memoryRouter.get('/repos', async (req, res) => {
  const { data, error } = await req.db!.from('repo_index').select('repo, files, symbols, indexed_at, stale').eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map((r: any) => ({ repo: r.repo, files: r.files, symbols: r.symbols, indexedAt: r.indexed_at, stale: r.stale })));
});

memoryRouter.post('/repos/reindex', async (req, res) => {
  const { repo } = req.body ?? {};
  if (!repo) return res.status(400).json({ error: 'repo required' });
  // Stub: enqueue the real re-index job (§11). Marks not-stale immediately
  // so the UI reflects the request; swap for an actual worker + webhook.
  const { error } = await req.db!
    .from('repo_index')
    .upsert({ org_id: req.orgId, repo, indexed_at: new Date().toISOString(), stale: false }, { onConflict: 'org_id,repo' });
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
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

memoryRouter.post('/org', async (req, res) => {
  const { text, kind } = req.body ?? {};
  if (!text || !kind) return res.status(400).json({ error: 'text, kind required' });
  const { data, error } = await req.db!.from('org_memory').insert({ org_id: req.orgId, text, kind }).select('id, text, kind').single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});
