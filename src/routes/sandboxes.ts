import { Router } from 'express';
import { requireOperator } from '../middleware/auth.js';

const router = Router();

// POST /sandboxes/:id/exec — dev/debug only, never expose to end users
// (BACKEND.md §3). Gated to operators+ and disabled entirely unless
// ALLOW_DEV_SANDBOX_EXEC=true, so it can't be hit by accident in prod.
router.post('/:id/exec', requireOperator, async (req, res) => {
  if (process.env.ALLOW_DEV_SANDBOX_EXEC !== 'true') {
    return res.status(403).json({ error: 'dev sandbox exec is disabled — set ALLOW_DEV_SANDBOX_EXEC=true to enable in dev' });
  }
  // Wire this to the real sandbox-runtime's exec MCP tool (§6/§7) once that
  // service exists. Left unimplemented here since there is no sandbox
  // runtime to call yet — this route only exists to match the documented
  // surface.
  res.status(501).json({ error: 'not implemented — wire to sandbox-runtime exec tool' });
});

export default router;
