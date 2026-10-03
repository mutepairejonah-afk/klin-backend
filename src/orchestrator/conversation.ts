import type { ChatMessage } from '../lib/llm.js';

export interface StoredConversationEvent {
  type: string;
  payload: Record<string, unknown>;
}

const MAX_HISTORY_EVENTS = 30;
const MAX_HISTORY_CHARS = 60_000;

/** Build a bounded, chronological chat transcript from persisted session events. */
export function buildFollowupMessages(
  systemPrompt: string,
  originalGoal: string,
  events: StoredConversationEvent[],
  currentMessage: string,
): ChatMessage[] {
  const turns = events.flatMap((event): ChatMessage[] => {
    if (event.type === 'message.user' && typeof event.payload.message === 'string') {
      return [{ role: 'user', content: event.payload.message }];
    }
    if (event.type === 'thought' && event.payload.role === 'executor' && typeof event.payload.text === 'string') {
      return [{ role: 'assistant', content: event.payload.text }];
    }
    return [];
  }).slice(-MAX_HISTORY_EVENTS);

  const base: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Original request: ${originalGoal.slice(0, 20_000)}` },
  ];
  const current = currentMessage.slice(0, MAX_HISTORY_CHARS);
  let remaining = Math.max(0, MAX_HISTORY_CHARS - current.length);
  const retained: ChatMessage[] = [];

  // Keep the newest context when the history exceeds the transcript budget.
  for (const turn of [...turns].reverse()) {
    if (!remaining) break;
    const content = turn.content.slice(-remaining);
    retained.push({ ...turn, content });
    remaining -= content.length;
  }

  return [
    ...base,
    ...retained.reverse(),
    { role: 'user', content: current },
  ];
}
