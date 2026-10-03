import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase.js';
import { emitEvent, subscribe, unsubscribe, closeAll } from '../lib/eventBus.js';
import { runUnavailableOrchestrator } from '../orchestrator/unavailable.js';
import { runAgent, runAgentFollowup } from '../orchestrator/agent.js';
import { llmConfigured } from '../lib/llm.js';
import { appendAudit } from '../lib/audit.js';
import { cancelSession, forgetSessionControl, pauseSession, resumeSession, steerSession } from '../lib/sessionControl.js';
import { requireOperator } from '../middleware/auth.js';
import { executionWorker } from '../worker/executionWorker.js';

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
  agent: z.object({ slug: z.string(), name: z.string(), systemPrompt: z.string().max(60_000) }).optional(),
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

  // Settings -> Model: the person's preferred provider/model, if they set one.
  const { data: settings } = await req.db!.from('user_settings').select('model_routing').eq('org_id', req.orgId).eq('user_id', req.user!.id).maybeSingle();
  const modelOverride = settings?.model_routing?.provider ? { provider: settings.model_routing.provider, model: settings.model_routing.model } : undefined;

  // Never simulate a successful coding run. Until a real execution runtime is
  // configured, fail explicitly rather than emitting fake edits, tests, or PRs.
  const codingRuntimeReady = process.env.KILN_EXECUTION_ENABLED === 'true' && process.env.ORCHESTRATOR_MODE === 'coding';
  const executionRequested = Boolean(input.repo || input.jobId);
  const run = executionRequested && codingRuntimeReady
    ? executionWorker.enqueue({ sessionId: data.id, orgId: req.orgId!, actor: req.user!.email, goal: input.goal, repo: input.repo, branch: input.branch, modelOverride })
    : llmConfigured() && !executionRequested
      ? runAgent(data.id, input.goal, input.agent, modelOverride)
      : runUnavailableOrchestrator(data.id, input.goal);
  Promise.resolve(run)
    .catch((err) => console.error('orchestrator error', err));

  res.status(201).json(toSessionDTO(data));
});

// DELETE /sessions/:id
router.delete('/:id', async (req, res) => {
  const { data: existing } = await req.db!.from('sessions').select('id').eq('id', req.params.id).eq('org_id', req.orgId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not found' });

  cancelSession(req.params.id);
  closeAll(req.params.id); // drop any live SSE listeners before the row disappears
  const { error } = await req.db!.from('sessions').delete().eq('id', req.params.id).eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });

  await appendAudit({ orgId: req.orgId!, actor: req.user!.email, action: 'session.deleted', sessionId: req.params.id, ip: req.ip });
  forgetSessionControl(req.params.id);
  res.status(204).end();
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
  const { data: session, error: lookupError } = await req.db!.from('sessions').select('id,status').eq('id', req.params.id).eq('org_id', req.orgId).maybeSingle();
  if (lookupError) return res.status(500).json({ error: lookupError.message });
  if (!session) return res.status(404).json({ error: 'not found' });
  if (session.status === 'done' || session.status === 'failed') return res.status(409).json({ error: 'session is already finished' });
  pauseSession(req.params.id);
  const { error } = await req.db!.from('sessions').update({ status: 'paused' }).eq('id', req.params.id).eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  await emitEvent(req.params.id, 'thought', { role: 'executor', text: 'Session paused by user.' });
  res.status(204).end();
});

router.post('/:id/resume', async (req, res) => {
  const { data: session, error: lookupError } = await req.db!.from('sessions').select('id,status').eq('id', req.params.id).eq('org_id', req.orgId).maybeSingle();
  if (lookupError) return res.status(500).json({ error: lookupError.message });
  if (!session) return res.status(404).json({ error: 'not found' });
  if (session.status !== 'paused') return res.status(409).json({ error: 'session is not paused' });
  resumeSession(req.params.id);
  const { error } = await req.db!.from('sessions').update({ status: 'executing' }).eq('id', req.params.id).eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  await emitEvent(req.params.id, 'thought', { role: 'executor', text: 'Session resumed by user.' });
  res.status(204).end();
});

// POST /sessions/:id/message — steer an active run or continue a completed chat
router.post('/:id/message', async (req, res) => {
  const parsed = z.object({ message: z.string().trim().min(1).max(20_000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'message must be 1–20000 characters' });
  const message = parsed.data.message;
  const { data: session, error: lookupError } = await req.db!.from('sessions')
    .select('id,status,goal,repo,job_id,duration_sec')
    .eq('id', req.params.id).eq('org_id', req.orgId).maybeSingle();
  if (lookupError) return res.status(500).json({ error: lookupError.message });
  if (!session) return res.status(404).json({ error: 'not found' });
  if (session.status !== 'done' && session.status !== 'failed') {
    await emitEvent(req.params.id, 'message.user', { message });
    steerSession(req.params.id, message);
    return res.status(202).json({ accepted: true });
  }

  // A finished repository/code task needs a fresh worker task. Do not pretend
  // the text-only chat continuation can keep operating on its old sandbox.
  if (session.repo || session.job_id) {
    return res.status(409).json({ error: 'Start a new coding session to continue repository work.' });
  }
  if (!llmConfigured()) return res.status(503).json({ error: 'No AI provider is configured.' });

  const { data: claimed, error: claimError } = await req.db!.from('sessions')
    .update({ status: 'planning', ended_at: null })
    .eq('id', req.params.id).eq('org_id', req.orgId).in('status', ['done', 'failed'])
    .select('id').maybeSingle();
  if (claimError) return res.status(500).json({ error: claimError.message });
  if (!claimed) return res.status(409).json({ error: 'A follow-up is already running. Try again when it finishes.' });

  try {
    const userEvent = await emitEvent(req.params.id, 'message.user', { message });
    const { data: settings } = await req.db!.from('user_settings').select('model_routing')
      .eq('org_id', req.orgId).eq('user_id', req.user!.id).maybeSingle();
    const modelOverride = settings?.model_routing?.provider
      ? { provider: settings.model_routing.provider, model: settings.model_routing.model }
      : undefined;
    void runAgentFollowup(
      req.params.id,
      session.goal,
      message,
      userEvent.seq,
      session.duration_sec,
      modelOverride,
    );
    return res.status(202).json({ accepted: true });
  } catch (err) {
    await req.db!.from('sessions').update({ status: session.status }).eq('id', req.params.id).eq('org_id', req.orgId);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Could not queue follow-up.' });
  }
});

// POST /sessions/:id/approvals/:aid
router.post('/:id/approvals/:aid', requireOperator, async (req, res) => {
  const decision = req.body?.decision as 'approved' | 'rejected';
  if (decision !== 'approved' && decision !== 'rejected') return res.status(400).json({ error: 'invalid decision' });

  const { data: approval, error } = await req.db!
    .from('approvals')
    .update({ status: decision, resolved_at: new Date().toISOString(), resolved_by: req.user!.id })
    .eq('id', req.params.aid)
    .eq('session_id', req.params.id)
    .eq('org_id', req.orgId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!approval) return res.status(404).json({ error: 'pending approval not found' });

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
