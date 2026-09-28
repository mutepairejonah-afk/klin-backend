import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase.js';
import { emitEvent, subscribe, unsubscribe } from '../lib/eventBus.js';
import { runStubOrchestrator } from '../orchestrator/stub.js';
import { appendAudit } from '../lib/audit.js';

const router = Router();

function toSessionDTO(row: any) {
  return {
    id: row.id,
    userId: row.user_id,
    goal: row.goal,
    status: row.status,
    sandboxId: row.sandbox_id ?? undefined,
    repo: row.repo ?? undefined,
    branch: row.branch ?? undefined,
    jobId: row.job_id ?? undefined,
    connectors: row.connectors ?? [],
    costUsd: row.cost_usd != null ? Number(row.cost_usd) : undefined,
    durationSec: row.duration_sec ?? undefined,
    createdAt: row.created_at,
    endedAt: row.ended_at ?? undefined,
  };
}

// GET /sessions?status=&repo=
router.get('/', async (req, res) => {
  let q = req.db!.from('sessions').select('*').eq('org_id', req.orgId).order('created_at', { ascending: false });
  if (req.query.status) q = q.eq('status', req.query.status as string);
  if (req.query.repo) q = q.eq('repo', req.query.repo as string);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map(toSessionDTO));
});

const createSchema = z.object({
  goal: z.string().min(1),
  jobId: z.string().nullish(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  connectors: z.array(z.string()).optional(),
});

// POST /sessions
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const input = parsed.data;

  const { data, error } = await req.db!
    .from('sessions')
    .insert({
      org_id: req.orgId,
      user_id: req.user!.id,
      goal: input.goal,
      job_id: input.jobId ?? null,
      repo: input.repo,
      branch: input.branch,
      connectors: input.connectors ?? [],
      status: 'queued',
    })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await appendAudit({ orgId: req.orgId!, actor: req.user!.email, action: 'session.created', sessionId: data.id, detail: input.goal, ip: req.ip });

  // Kick off the orchestrator. Swap runStubOrchestrator for the real
  // agent loop (OpenHands or equivalent) once §5/§7 are wired up — the
  // session/event persistence and SSE fan-out around it don't change.
  runStubOrchestrator(data.id, input.goal).catch((err) => console.error('orchestrator error', err));

  res.status(201).json(toSessionDTO(data));
});

// GET /sessions/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await req.db!.from('sessions').select('*').eq('id', req.params.id).eq('org_id', req.orgId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'not found' });
  res.json(toSessionDTO(data));
});

// GET /sessions/:id/events — SSE
router.get('/:id/events', async (req, res) => {
  const { data: session } = await req.db!.from('sessions').select('id').eq('id', req.params.id).eq('org_id', req.orgId).maybeSingle();
  if (!session) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  subscribe(req.params.id, res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe(req.params.id, res);
  });
});

// GET /sessions/:id/replay
router.get('/:id/replay', async (req, res) => {
  const { data: session } = await req.db!.from('sessions').select('id').eq('id', req.params.id).eq('org_id', req.orgId).maybeSingle();
  if (!session) return res.status(404).json({ error: 'not found' });

  const { data, error } = await req.db!.from('events').select('seq, ts, type, payload').eq('session_id', req.params.id).order('seq', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// POST /sessions/:id/pause | /resume
router.post('/:id/pause', async (req, res) => {
  const { error } = await req.db!.from('sessions').update({ status: 'paused' }).eq('id', req.params.id).eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  await emitEvent(req.params.id, 'thought', { role: 'executor', text: 'Session paused by user.' });
  res.status(204).end();
});

router.post('/:id/resume', async (req, res) => {
  const { error } = await req.db!.from('sessions').update({ status: 'executing' }).eq('id', req.params.id).eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  await emitEvent(req.params.id, 'thought', { role: 'executor', text: 'Session resumed by user.' });
  res.status(204).end();
});

// POST /sessions/:id/message — steer the agent mid-run
router.post('/:id/message', async (req, res) => {
  const message = String(req.body?.message ?? '');
  if (!message) return res.status(400).json({ error: 'message required' });
  await emitEvent(req.params.id, 'thought', { role: 'executor', text: `User steered: "${message}"` });
  res.status(204).end();
});

// POST /sessions/:id/approvals/:aid
router.post('/:id/approvals/:aid', async (req, res) => {
  const decision = req.body?.decision as 'approved' | 'rejected';
  if (decision !== 'approved' && decision !== 'rejected') return res.status(400).json({ error: 'invalid decision' });

  const { error } = await req.db!
    .from('approvals')
    .update({ status: decision, resolved_at: new Date().toISOString(), resolved_by: req.user!.id })
    .eq('id', req.params.aid)
    .eq('session_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await emitEvent(req.params.id, 'approval.resolved', { id: req.params.aid, decision });
  await appendAudit({
    orgId: req.orgId!, actor: req.user!.email, action: `approval.${decision}`,
    sessionId: req.params.id, detail: req.params.aid, ip: req.ip,
  });
  res.status(204).end();
});

// GET /sessions/:id/artifacts
router.get('/:id/artifacts', async (req, res) => {
  const { data, error } = await req.db!.from('artifacts').select('*').eq('session_id', req.params.id).eq('org_id', req.orgId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map((a: any) => ({
    id: a.id, sessionId: a.session_id, kind: a.kind, title: a.title,
    meta: a.meta ?? undefined, url: a.url ?? undefined, createdAt: a.created_at,
  })));
});

// GET/POST /sessions/:id/share
router.get('/:id/share', async (req, res) => {
  const { data, error } = await req.db!.from('sessions').select('share_token, share_public').eq('id', req.params.id).eq('org_id', req.orgId).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'not found' });
  res.json({ url: data.share_token ? `${process.env.FRONTEND_URL}/share/${data.share_token}` : '', public: data.share_public });
});

router.post('/:id/share', async (req, res) => {
  const wantsPublic = Boolean(req.body?.public);
  const token = crypto.randomUUID();
  const { data, error } = await req.db!
    .from('sessions')
    .update({ share_public: wantsPublic, share_token: wantsPublic ? token : null })
    .eq('id', req.params.id)
    .eq('org_id', req.orgId)
    .select('share_token, share_public')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: data.share_token ? `${process.env.FRONTEND_URL}/share/${data.share_token}` : '', public: data.share_public });
});

export default router;
