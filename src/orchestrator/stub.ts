import { emitEvent } from '../lib/eventBus.js';
import { supabaseAdmin } from '../lib/supabase.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Canned event script so the frontend has something real to render against
 * before the actual agent loop (OpenHands or equivalent) is wired in. Swap
 * this function's body for a call into the real orchestrator/agent loop —
 * everything else (persistence, SSE fan-out, session status) stays the same.
 */
export async function runStubOrchestrator(sessionId: string, goal: string) {
  const setStatus = (status: string, extra: Record<string, unknown> = {}) =>
    supabaseAdmin.from('sessions').update({ status, ...extra }).eq('id', sessionId);

  try {
    await setStatus('planning');
    await sleep(400);
    await emitEvent(sessionId, 'plan.updated', {
      todos: [
        { id: 't1', label: `Understand: ${goal}`, done: false },
        { id: 't2', label: 'Implement change', done: false },
        { id: 't3', label: 'Run tests', done: false },
        { id: 't4', label: 'Open pull request', done: false },
      ],
    });

    await emitEvent(sessionId, 'thought', {
      role: 'planner',
      text: `Breaking "${goal}" into a plan: inspect the repo, make the change, verify, ship.`,
    });

    await setStatus('executing');
    await sleep(300);
    await emitEvent(sessionId, 'action.started', {
      role: 'executor', tool: 'terminal', verb: 'run', target: 'git status',
    });
    await emitEvent(sessionId, 'terminal.stdout', { line: 'On branch main\nnothing to commit, working tree clean' });
    await emitEvent(sessionId, 'action.completed', { tool: 'terminal', result: 'ok' });

    await sleep(300);
    await emitEvent(sessionId, 'action.started', {
      role: 'executor', tool: 'editor', verb: 'edit', target: 'src/index.ts',
    });
    await emitEvent(sessionId, 'file.modified', { path: 'src/index.ts', content: '// stub change' });
    await emitEvent(sessionId, 'diff.ready', {
      path: 'src/index.ts',
      diff: '--- a/src/index.ts\n+++ b/src/index.ts\n@@\n-// TODO\n+// stub change\n',
    });
    await emitEvent(sessionId, 'action.completed', { tool: 'editor', result: 'file updated' });

    await emitEvent(sessionId, 'plan.updated', {
      todos: [
        { id: 't1', label: `Understand: ${goal}`, done: true },
        { id: 't2', label: 'Implement change', done: true },
        { id: 't3', label: 'Run tests', done: false },
        { id: 't4', label: 'Open pull request', done: false },
      ],
    });

    await setStatus('verifying');
    await sleep(300);
    await emitEvent(sessionId, 'action.started', { role: 'critic', tool: 'tests', verb: 'run', target: 'npm test' });
    await emitEvent(sessionId, 'test.result', { passed: 12, failed: 0, report: 'all green' });
    await emitEvent(sessionId, 'action.completed', { tool: 'tests', result: '12 passed' });
    await emitEvent(sessionId, 'critic.verdict', {
      checks: [
        { label: 'Change addresses the stated goal', passed: true },
        { label: 'Tests pass', passed: true },
        { label: 'No lint errors', passed: true },
      ],
    });

    await sleep(300);
    await emitEvent(sessionId, 'git.commit', { sha: 'abc1234', message: `feat: ${goal}` });
    await emitEvent(sessionId, 'git.pr_opened', {
      url: 'https://github.com/example/repo/pull/1',
      title: goal,
      stats: '+12 -3',
    });

    const artifactId = crypto.randomUUID();
    const { data: session } = await supabaseAdmin.from('sessions').select('org_id').eq('id', sessionId).single();
    await supabaseAdmin.from('artifacts').insert({
      id: artifactId,
      session_id: sessionId,
      org_id: session?.org_id,
      kind: 'pr',
      title: goal,
      meta: '+12 -3',
      url: 'https://github.com/example/repo/pull/1',
    });
    await emitEvent(sessionId, 'artifact.created', {
      id: artifactId, sessionId, kind: 'pr', title: goal, meta: '+12 -3',
      url: 'https://github.com/example/repo/pull/1', createdAt: new Date().toISOString(),
    });

    await emitEvent(sessionId, 'plan.updated', {
      todos: [
        { id: 't1', label: `Understand: ${goal}`, done: true },
        { id: 't2', label: 'Implement change', done: true },
        { id: 't3', label: 'Run tests', done: true },
        { id: 't4', label: 'Open pull request', done: true },
      ],
    });
    await emitEvent(sessionId, 'session.done', { summary: `Completed: ${goal}` });
    await setStatus('done', { ended_at: new Date().toISOString(), duration_sec: 3, cost_usd: 0.08 });
  } catch (err) {
    await emitEvent(sessionId, 'error', { message: err instanceof Error ? err.message : String(err) });
    await setStatus('failed', { ended_at: new Date().toISOString() });
  }
}
