import { emitEvent } from '../lib/eventBus.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { chat, type ChatMessage } from '../lib/llm.js';

export interface Persona { slug: string; name: string; systemPrompt: string }

const BASE = `You are an autonomous software agent inside the "klin" app. You cannot yet run code, browse, or touch a repository — say so plainly if a task needs that, and give the best concrete help you can in text (plans, code blocks, diffs, commands the user can run). Never claim to have executed anything.`;

function system(persona?: Persona) {
  if (!persona) return BASE;
  // Persona prompts are long; cap so free-tier context windows aren't blown.
  return `${BASE}\n\nAdopt this specialist role for the whole task:\n\n${persona.systemPrompt.slice(0, 24_000)}`;
}

export async function runAgent(sessionId: string, goal: string, persona?: Persona) {
  const setStatus = (status: string, extra: Record<string, unknown> = {}) =>
    supabaseAdmin.from('sessions').update({ status, ...extra }).eq('id', sessionId);
  const started = Date.now();
  const todo = (labels: string[], doneCount: number) =>
    labels.map((label, i) => ({ id: `t${i + 1}`, label, done: i < doneCount }));

  try {
    await setStatus('planning');
    if (persona) await emitEvent(sessionId, 'thought', { role: 'planner', text: `Specialist: ${persona.name}` });

    const msgs: ChatMessage[] = [
      { role: 'system', content: system(persona) },
      { role: 'user', content: `Goal: ${goal}\n\nReply with JSON only: {"steps": ["3 to 5 short imperative steps"]}` },
    ];
    let steps = ['Understand the goal', 'Work out the solution', 'Write up the result'];
    try {
      const plan = await chat(msgs, { json: true, maxTokens: 500 });
      const parsed = JSON.parse(plan.text.replace(/```json|```/g, '').trim());
      if (Array.isArray(parsed.steps) && parsed.steps.length) steps = parsed.steps.slice(0, 5).map(String);
    } catch { /* fall back to the default plan; the main call below reports real failures */ }
    await emitEvent(sessionId, 'plan.updated', { todos: todo(steps, 0) });

    await setStatus('executing');
    await emitEvent(sessionId, 'action.started', { role: 'executor', tool: 'model', verb: 'think', target: goal.slice(0, 80) });
    const answer = await chat(
      [
        { role: 'system', content: system(persona) },
        { role: 'user', content: `Goal: ${goal}\n\nPlan:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nCarry out the plan and give the full result.` },
      ],
      { maxTokens: 3000 },
    );
    await emitEvent(sessionId, 'action.completed', { tool: 'model', result: `${answer.provider} · ${answer.model}` });
    await emitEvent(sessionId, 'thought', { role: 'executor', text: answer.text });
    await emitEvent(sessionId, 'plan.updated', { todos: todo(steps, steps.length) });

    await emitEvent(sessionId, 'session.done', { summary: answer.text.slice(0, 280) });
    await setStatus('done', { ended_at: new Date().toISOString(), duration_sec: Math.round((Date.now() - started) / 1000), cost_usd: 0 });
  } catch (err) {
    await emitEvent(sessionId, 'error', { message: err instanceof Error ? err.message : String(err) });
    await setStatus('failed', { ended_at: new Date().toISOString() });
  }
}
