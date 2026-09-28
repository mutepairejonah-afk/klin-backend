import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

// GET /share/:token — unauthenticated read-only mirror of GET /sessions/:id
router.get('/:token', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('*')
    .eq('share_token', req.params.token)
    .eq('share_public', true)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'not found' });
  res.json({
    id: data.id, userId: data.user_id, goal: data.goal, status: data.status,
    sandboxId: data.sandbox_id ?? undefined, repo: data.repo ?? undefined, branch: data.branch ?? undefined,
    jobId: data.job_id ?? undefined, connectors: data.connectors ?? [],
    costUsd: data.cost_usd != null ? Number(data.cost_usd) : undefined,
    durationSec: data.duration_sec ?? undefined, createdAt: data.created_at, endedAt: data.ended_at ?? undefined,
  });
});

// GET /share/:token/replay
router.get('/:token/replay', async (req, res) => {
  const { data: session } = await supabaseAdmin
    .from('sessions').select('id').eq('share_token', req.params.token).eq('share_public', true).maybeSingle();
  if (!session) return res.status(404).json({ error: 'not found' });

  const { data, error } = await supabaseAdmin
    .from('events').select('seq, ts, type, payload').eq('session_id', session.id).order('seq', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

export default router;
