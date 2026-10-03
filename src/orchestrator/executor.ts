import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chat, type ChatMessage, type ModelOverride } from '../lib/llm.js';
import { checkpoint } from '../lib/sessionControl.js';
import {
  applyPatch, eventSink, gitBranch, gitCommit, gitDiff, gitStatus, listDir, readFile,
  runTests, searchFiles, shellExec, writeFile,
} from '../tools/sandboxTools.js';
import type { SandboxHandle, SandboxRuntime, ToolContext, ToolEventSink } from '../sandbox/types.js';

const actionSchema = z.union([
  z.object({ action: z.literal('read_file'), path: z.string() }),
  z.object({ action: z.literal('write_file'), path: z.string(), content: z.string() }),
  z.object({ action: z.literal('list_dir'), path: z.string().optional() }),
  z.object({ action: z.literal('search_files'), pattern: z.string(), path: z.string().optional() }),
  z.object({ action: z.literal('apply_patch'), patch: z.string() }),
  z.object({ action: z.literal('shell_exec'), command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().positive().max(900_000).optional() }),
  z.object({ action: z.literal('git_status') }),
  z.object({ action: z.literal('git_diff') }),
  z.object({ action: z.literal('git_branch'), name: z.string().optional() }),
  z.object({ action: z.literal('git_commit'), message: z.string() }),
  z.object({ action: z.literal('run_tests'), command: z.string().optional(), timeoutMs: z.number().int().positive().max(900_000).optional() }),
  z.object({ action: z.literal('finish'), summary: z.string().min(1).max(4_000) }),
]);

type Action = z.infer<typeof actionSchema>;
type ChatFn = typeof chat;

const MAX_STEPS = 20;
const MAX_TRANSCRIPT_RESULT = 12_000;

const EXECUTOR_SYSTEM = `You are klin's coding executor operating inside an isolated workspace. You must return exactly one JSON object and nothing else.

Available actions:
- {"action":"read_file","path":"src/file.ts"}
- {"action":"write_file","path":"src/file.ts","content":"..."}
- {"action":"list_dir","path":"."}
- {"action":"search_files","pattern":"...","path":"."}
- {"action":"apply_patch","patch":"unified git patch"}
- {"action":"shell_exec","command":"...","cwd":"/workspace","timeoutMs":120000}
- {"action":"git_status"}, {"action":"git_diff"}
- {"action":"git_branch","name":"feature/name"}
- {"action":"git_commit","message":"..."}
- {"action":"run_tests","command":"npm test","timeoutMs":600000}
- {"action":"finish","summary":"what was done and verified"}

Rules:
1. Work only inside /workspace. Never request credentials, Docker access, host paths, or network configuration.
2. Inspect before editing. Prefer small patches and preserve existing behavior.
3. After any write or patch, run relevant tests before finishing. If tests fail, inspect and repair, up to the step limit.
4. Do not claim a command ran unless its result is in the transcript.
5. Do not commit unless the user goal requires a commit and an approval result is provided in the transcript.
6. Use finish only when the requested work is complete or a truthful blocker is reached.`;

function parseAction(text: string): Action {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error('model returned invalid JSON action'); }
  return actionSchema.parse(parsed);
}

function summarize(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_TRANSCRIPT_RESULT ? `${text.slice(0, MAX_TRANSCRIPT_RESULT)}\n[tool result truncated]` : text;
}

async function requestApproval(sessionId: string, orgId: string, title: string, body: string, command: string) {
  const { supabaseAdmin } = await import('../lib/supabase.js');
  const { emitEvent } = await import('../lib/eventBus.js');
  const { data, error } = await supabaseAdmin.from('approvals').insert({
    id: randomUUID(), org_id: orgId, session_id: sessionId, title, body, command,
    status: 'pending', requested_at: new Date().toISOString(),
  }).select('id').single();
  if (error || !data) throw error ?? new Error('approval request was not created');
  await supabaseAdmin.from('sessions').update({ status: 'waiting_approval' }).eq('id', sessionId);
  await emitEvent(sessionId, 'approval.requested', { id: data.id, title, body, command, blastRadius: 'local repository commit' });
  return data.id as string;
}

async function waitForApproval(sessionId: string, orgId: string, approvalId: string, timeoutMs = 30 * 60_000) {
  const { supabaseAdmin } = await import('../lib/supabase.js');
  const { emitEvent } = await import('../lib/eventBus.js');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await checkpoint(sessionId);
    const { data, error } = await supabaseAdmin.from('approvals').select('status').eq('id', approvalId).eq('session_id', sessionId).eq('org_id', orgId).maybeSingle();
    if (error) throw error;
    if (data?.status === 'approved') {
      await supabaseAdmin.from('sessions').update({ status: 'executing' }).eq('id', sessionId).eq('org_id', orgId);
      await emitEvent(sessionId, 'approval.resolved', { id: approvalId, decision: 'approved' });
      return true;
    }
    if (data?.status === 'rejected') {
      await supabaseAdmin.from('sessions').update({ status: 'executing' }).eq('id', sessionId).eq('org_id', orgId);
      await emitEvent(sessionId, 'approval.resolved', { id: approvalId, decision: 'rejected' });
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('approval timed out after 30 minutes');
}

async function executeAction(action: Action, context: ToolContext): Promise<unknown> {
  switch (action.action) {
    case 'read_file': return readFile(context, action.path);
    case 'write_file': return writeFile(context, action.path, action.content);
    case 'list_dir': return listDir(context, action.path ?? '.');
    case 'search_files': return searchFiles(context, action.pattern, action.path ?? '.');
    case 'apply_patch': return applyPatch(context, action.patch);
    case 'shell_exec': return shellExec(context, action.command, action.cwd ?? '/workspace', action.timeoutMs ?? 120_000);
    case 'git_status': return gitStatus(context);
    case 'git_diff': return gitDiff(context);
    case 'git_branch': return gitBranch(context, action.name);
    case 'run_tests': return runTests(context, action.command, action.timeoutMs ?? 10 * 60_000);
    case 'git_commit': throw new Error('git_commit must pass through the approval gate');
    case 'finish': return action;
  }
}

export interface ExecutorResult { summary: string; steps: number; changed: boolean; testsRun: boolean; }

export async function executeCodingTask(
  sessionId: string,
  orgId: string,
  goal: string,
  sandbox: SandboxHandle,
  runtime: SandboxRuntime,
  modelOverride?: ModelOverride,
  chatFn: ChatFn = chat,
  eventsOverride?: ToolEventSink,
): Promise<ExecutorResult> {
  const context: ToolContext = { sessionId, sandbox, runtime, events: eventsOverride ?? eventSink(sessionId) };
  const messages: ChatMessage[] = [
    { role: 'system', content: EXECUTOR_SYSTEM },
    { role: 'user', content: `User goal:\n${goal}\n\nStart by inspecting the repository and then make the smallest correct change. Return one JSON action.` },
  ];
  let changed = false;
  let testsRun = false;
  let invalidActions = 0;

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    await checkpoint(sessionId);
    const response = await chatFn(messages, { json: true, maxTokens: 4_000 }, modelOverride);
    messages.push({ role: 'assistant', content: response.text });
    let action: Action;
    try {
      action = parseAction(response.text);
      invalidActions = 0;
    } catch (error) {
      invalidActions += 1;
      if (invalidActions >= 3) throw error;
      messages.push({ role: 'user', content: `Invalid action: ${error instanceof Error ? error.message : String(error)}. Return exactly one valid JSON action from the tool list.` });
      step -= 1;
      continue;
    }

    if (action.action === 'finish') {
      if (changed && !testsRun) {
        messages.push({ role: 'user', content: 'You changed files but have not run tests. Run the most relevant test command before finishing.' });
        continue;
      }
      await context.events.emit('thought', { role: 'executor', text: action.summary });
      return { summary: action.summary, steps: step, changed, testsRun };
    }

    try {
      if (action.action === 'git_commit') {
        const approvalId = await requestApproval(sessionId, orgId, 'Create a local Git commit', `The executor wants to create a commit for the requested change.`, `git commit -m ${action.message}`);
        const approved = await waitForApproval(sessionId, orgId, approvalId);
        if (!approved) throw new Error('commit rejected by operator');
        const result = await gitCommit(context, action.message);
        messages.push({ role: 'user', content: `Tool result for git_commit:\n${summarize(result)}` });
        continue;
      }
      const result = await executeAction(action, context);
      if (['write_file', 'apply_patch'].includes(action.action)) changed = true;
      if (action.action === 'run_tests') testsRun = true;
      messages.push({ role: 'user', content: `Tool result for ${action.action}:\n${summarize(result)}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      messages.push({ role: 'user', content: `Tool ${action.action} failed:\n${message}\nInspect the failure and choose a corrective action or finish with a truthful blocker.` });
    }
  }

  throw new Error(`executor reached the ${MAX_STEPS}-step safety limit without finishing`);
}
