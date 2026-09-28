import type { Response } from 'express';
import { supabaseAdmin } from './supabase.js';

export interface SessionEvent {
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

// In-memory fan-out of live SSE subscribers, per session, per process.
// A single-process deployment is fine for this stub; a multi-instance
// deployment should replace this with Postgres LISTEN/NOTIFY or Redis
// pub/sub so events reach every instance's connected clients.
const subscribers = new Map<string, Set<Response>>();

export function subscribe(sessionId: string, res: Response) {
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  subscribers.get(sessionId)!.add(res);
}

export function unsubscribe(sessionId: string, res: Response) {
  subscribers.get(sessionId)?.delete(res);
}

function broadcast(sessionId: string, event: SessionEvent) {
  const set = subscribers.get(sessionId);
  if (!set) return;
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) res.write(frame);
}

/**
 * Persists a SessionEvent (append-only, auto-incrementing seq per session)
 * before broadcasting it — §4's "persist before send" rule, so a
 * reconnecting client can always replay from `seq`.
 */
export async function emitEvent(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<SessionEvent> {
  const { data: last } = await supabaseAdmin
    .from('events')
    .select('seq')
    .eq('session_id', sessionId)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();

  const seq = (last?.seq ?? -1) + 1;
  const ts = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from('events')
    .insert({ session_id: sessionId, seq, type, payload, ts });
  if (error) throw error;

  const event: SessionEvent = { seq, ts, type, payload };
  broadcast(sessionId, event);
  return event;
}
