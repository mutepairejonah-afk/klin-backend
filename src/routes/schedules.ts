import { Router } from 'express';

const router = Router();

function toDTO(row: any) {
  return {
    id: row.id, name: row.name, jobId: row.job_id, repo: row.repo ?? undefined,
    cadenceLabel: row.cadence_label, cadenceCron: row.cadence_cron,
    nextRunAt: row.next_run_at ?? undefined, enabled: row.enabled,
  };
}

router.get('/', async (req, res) => {
  const { data, error } = await req.db!.from('schedules').select('*').eq('org_id', req.orgId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map(toDTO));
});

router.post('/', async (req, res) => {
  const { name, jobId, repo, cadenceLabel, cadenceCron, enabled } = req.body ?? {};
  if (!name || !jobId || !cadenceLabel || !cadenceCron) {
    return res.status(400).json({ error: 'name, jobId, cadenceLabel, cadenceCron required' });
  }
  const { data, error } = await req.db!
    .from('schedules')
    .insert({ org_id: req.orgId, name, job_id: jobId, repo, cadence_label: cadenceLabel, cadence_cron: cadenceCron, enabled: enabled ?? true })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(toDTO(data));
});

router.patch('/:id', async (req, res) => {
  const patch: Record<string, unknown> = {};
  const b = req.body ?? {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.jobId !== undefined) patch.job_id = b.jobId;
  if (b.repo !== undefined) patch.repo = b.repo;
  if (b.cadenceLabel !== undefined) patch.cadence_label = b.cadenceLabel;
  if (b.cadenceCron !== undefined) patch.cadence_cron = b.cadenceCron;
  if (b.enabled !== undefined) patch.enabled = b.enabled;

  const { data, error } = await req.db!.from('schedules').update(patch).eq('id', req.params.id).eq('org_id', req.orgId).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(toDTO(data));
});

router.delete('/:id', async (req, res) => {
  const { error } = await req.db!.from('schedules').delete().eq('id', req.params.id).eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

export default router;
