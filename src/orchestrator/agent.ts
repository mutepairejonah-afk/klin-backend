import { emitEvent } from '../lib/eventBus.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { chat, type ChatMessage } from '../lib/llm.js';
import { webSearch, needsResearch } from '../lib/websearch.js';

export interface Persona { slug: string; name: string; systemPrompt: string }

const BASE = `You are klin, an AI assistant for chat, research, and software work. For plain conversation or research questions, just answer directly and conversationally — you do not need a terminal, sandbox, or repository access for that, and should never pretend to open one for a normal question. When web search results are included below, ground your answer in them and mention the source by name; if none are included, answer from what you know and say so if you're unsure or the topic is time-sensitive. You cannot yet execute code, run shell commands, or push changes to a live sandbox/repository — for tasks that genuinely need that, say so plainly and give the exact code, diff, or commands the person can run themselves instead of claiming to have run them.`;

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

    // Research: a quick, no-terminal web search when the goal looks like it
    // needs live/current info. Shows up as a real "action" in the UI (and
    // the terminal/events tab), same as any other tool call would.
    let researchContext = '';
    if (needsResearch(goal)) {
      await emitEvent(sessionId, 'action.started', { role: 'researcher', tool: 'search', verb: 'search', target: goal.slice(0, 80) });
      try {
        const results = await webSearch(goal, 5);
        if (results.length) {
          researchContext = `Web search results for "${goal}":\n${results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet} (${r.url})`).join('\n')}`;
          await emitEvent(sessionId, 'action.completed', { tool: 'search', result: `${results.length} results` });
        } else {
          await emitEvent(sessionId, 'action.completed', { tool: 'search', result: 'no results' });
        }
      } catch (e) {
        await emitEvent(sessionId, 'action.completed', { tool: 'search', result: 'search failed, answering from general knowledge' });
      }
    }

    const msgs: ChatMessage[] = [
      { role: 'system', content: system(persona) },
      { role: 'user', content: `Goal: ${goal}${researchContext ? `\n\n${researchContext}` : ''}\n\nReply with JSON only: {"steps": ["2 to 5 short imperative steps — keep this to 1-2 steps for a simple chat/research question, more only for an actual multi-part task"]}` },
    ];
    let steps = ['Answer the question'];
    try {
      const plan = await chat(msgs, { json: true, maxTokens: 400 });
      const parsed = JSON.parse(plan.text.replace(/```json|```/g, '').trim());
      if (Array.isArray(parsed.steps) && parsed.steps.length) steps = parsed.steps.slice(0, 5).map(String);
    } catch { /* fall back to the default single-step plan; the main call below reports real failures */ }
    await emitEvent(sessionId, 'plan.updated', { todos: todo(steps, 0) });

    await setStatus('executing');
    await emitEvent(sessionId, 'action.started', { role: 'executor', tool: 'model', verb: 'think', target: goal.slice(0, 80) });
    const answer = await chat(
      [
        { role: 'system', content: system(persona) },
        { role: 'user', content: `Goal: ${goal}${researchContext ? `\n\n${researchContext}` : ''}\n\nPlan:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nCarry out the plan and give the full result.` },
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
