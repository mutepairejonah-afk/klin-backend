import { Router } from 'express';

export const artifactsRouter = Router();

// GET /artifacts?kind= — cross-session feed for the Library page
artifactsRouter.get('/', async (req, res) => {
  let q = req.db!.from('artifacts').select('*').eq('org_id', req.orgId).order('created_at', { ascending: false });
  if (req.query.kind) q = q.eq('kind', req.query.kind as string);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map((a: any) => ({
    id: a.id, sessionId: a.session_id, kind: a.kind, title: a.title,
    meta: a.meta ?? undefined, url: a.url ?? undefined, createdAt: a.created_at,
  })));
});

export const usageRouter = Router();

// GET /usage — aggregates the KPI cards on the Usage page (§12)
usageRouter.get('/', async (req, res) => {
  const orgId = req.orgId;
  const { data: sessions, error } = await req.db!
    .from('sessions')
    .select('id, goal, status, cost_usd, duration_sec, created_at, ended_at')
    .eq('org_id', orgId);
  if (error) return res.status(500).json({ error: error.message });

  const rows = sessions ?? [];
  const done = rows.filter((s: any) => s.status === 'done');
  const failed = rows.filter((s: any) => s.status === 'failed');
  const finished = done.length + failed.length;

  const { count: prCount } = await req.db!
    .from('artifacts')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('kind', 'pr');

  const { count: approvalCount } = await req.db!
    .from('approvals')
    .select('id', { count: 'exact', head: true });

  const durations = done.map((s: any) => s.duration_sec).filter((n: number | null) => n != null).sort((a: number, b: number) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : undefined;

  const totalCost = rows.reduce((sum: number, s: any) => sum + Number(s.cost_usd ?? 0), 0);

  const byDay = new Map<string, number>();
  for (const s of rows) {
    const day = (s.created_at as string).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + Number(s.cost_usd ?? 0));
  }

  res.json({
    jobCompletionRate: finished ? done.length / finished : undefined,
    prMergeRate: prCount != null && done.length ? Math.min(1, prCount / done.length) : undefined,
    medianSessionSec: median,
    approvalPromptRate: rows.length ? (approvalCount ?? 0) / rows.length : undefined,
    costPerJobUsd: done.length ? totalCost / done.length : undefined,
    secretLeaks: 0,
    costByDay: Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, usd]) => ({ date, usd })),
    costBreakdown: [],
    topSessions: rows
      .slice()
      .sort((a: any, b: any) => Number(b.cost_usd ?? 0) - Number(a.cost_usd ?? 0))
      .slice(0, 5)
      .map((s: any) => ({
        id: s.id, userId: '', goal: s.goal, status: s.status,
        costUsd: s.cost_usd != null ? Number(s.cost_usd) : undefined,
        durationSec: s.duration_sec ?? undefined, createdAt: s.created_at, endedAt: s.ended_at ?? undefined,
      })),
  });
});

export const auditRouter = Router();

// GET /audit
auditRouter.get('/', async (req, res) => {
  const { data, error } = await req.db!
    .from('audit_logs')
    .select('*')
    .eq('org_id', req.orgId)
    .order('ts', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map((a: any) => ({
    id: a.id, ts: a.ts, actor: a.actor, action: a.action,
    sessionId: a.session_id ?? undefined, detail: a.detail ?? '', ip: a.ip ?? undefined,
  })));
});

export default artifactsRouter;
