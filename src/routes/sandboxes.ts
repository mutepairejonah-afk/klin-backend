import { Router } from 'express';
import { requireOperator } from '../middleware/auth.js';
import { DockerSandboxRuntime } from '../sandbox/docker.js';
import { shellExec } from '../tools/sandboxTools.js';

const router = Router();
const runtime = new DockerSandboxRuntime();

// POST /sandboxes/:id/exec — operator-only dev/debug surface. Agent work uses
// the worker and tool API; this endpoint exists for diagnosis and is disabled
// unless explicitly enabled.
router.post('/:id/exec', requireOperator, async (req, res) => {
  if (process.env.ALLOW_DEV_SANDBOX_EXEC !== 'true') {
    return res.status(403).json({ error: 'dev sandbox exec is disabled — set ALLOW_DEV_SANDBOX_EXEC=true to enable in dev' });
  }
  const command = String(req.body?.command ?? '');
  if (!command.trim()) return res.status(400).json({ error: 'command required' });
  const timeoutMs = Number(req.body?.timeoutMs ?? 120_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) return res.status(400).json({ error: 'timeoutMs must be between 1 and 900000' });

  const { data: row, error } = await req.db!.from('sandboxes')
    .select('id, session_id, machine_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row?.machine_id) return res.status(404).json({ error: 'sandbox not found' });

  const sandbox = runtime.attach(row.session_id, row.machine_id);
  try {
    const result = await shellExec({ sessionId: row.session_id, sandbox, runtime, events: {
      emit: async (type, payload) => {
        // Direct diagnostics return output in the response; the session event
        // stream still receives the same durable tool events.
        const { emitEvent } = await import('../lib/eventBus.js');
        await emitEvent(row.session_id, type as never, payload);
      },
    } }, command, req.body?.cwd ? String(req.body.cwd) : '/workspace', timeoutMs);
    res.json(result);
  } catch (runError) {
    res.status(422).json({ error: runError instanceof Error ? runError.message : String(runError) });
  }
});

export default router;
