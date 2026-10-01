import { emitEvent } from '../lib/eventBus.js';
import { supabaseAdmin } from '../lib/supabase.js';

/**
 * Compatibility entry point used when no model/runtime is configured.
 * It deliberately does not emit fake terminal output, file edits, tests, or
 * pull requests. A failed truthful session is safer than simulated success.
 */
export async function runUnavailableOrchestrator(sessionId: string, _goal: string) {
  const message = 'Execution is unavailable: configure an AI provider and a real sandbox/runtime before starting coding sessions.';
  await emitEvent(sessionId, 'error', { message });
  await supabaseAdmin
    .from('sessions')
    .update({ status: 'failed', ended_at: new Date().toISOString(), cost_usd: 0 })
    .eq('id', sessionId);
}
