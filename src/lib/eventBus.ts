import type { Response } from 'express';
import { supabaseAdmin } from './supabase.js';
import { sessionEventSchema, type SessionEvent, type SessionEventType } from '../contracts/events.js';

// In-memory fan-out of live SSE subscribers, per session, per process.
// A multi-instance deployment must replace this with Postgres LISTEN/NOTIFY
// or Redis pub/sub so events reach every instance's connected clients.
const subscribers = new Map<string, Set<Response>>();

export function subscribe(sessionId: string, res: Response) {
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  subscribers.get(sessionId)!.add(res);
}

export function unsubscribe(sessionId: string, res: Response) {
  subscribers.get(sessionId)?.delete(res);
}

// Used when a session is deleted — ends any open SSE streams for it instead
// of leaving clients hanging on a session whose row no longer exists.
export function closeAll(sessionId: string) {
  const set = subscribers.get(sessionId);
  if (!set) return;
  for (const res of set) { try { res.end(); } catch { /* already closed */ } }
  subscribers.delete(sessionId);
}

function broadcast(sessionId: string, event: SessionEvent) {
  const set = subscribers.get(sessionId);
  if (!set) return;
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try { res.write(frame); }
    catch { set.delete(res); }
  }
}

/**
 * Persists a SessionEvent (append-only, auto-incrementing seq per session)
 * before broadcasting it — §4's "persist before send" rule, so a
 * reconnecting client can always replay from `seq`.
 */
export async function emitEvent(
  sessionId: string,
  type: SessionEventType,
  payload: Record<string, unknown>,
): Promise<SessionEvent> {
  // The unique (session_id, seq) constraint is the last line of defense when
  // two tool calls emit concurrently. Retry the read/insert pair on a
  // collision; production should replace this with a DB function/transaction.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data: last } = await supabaseAdmin
      .from('events')
      .select('seq')
      .eq('session_id', sessionId)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();
    const seq = (last?.seq ?? -1) + 1;
    const ts = new Date().toISOString();
    const candidate = { seq, ts, type, payload };
    const parsed = sessionEventSchema.safeParse(candidate);
    if (!parsed.success) throw new Error(`invalid session event ${type}: ${parsed.error.message}`);
    const { error } = await supabaseAdmin
      .from('events')
      .insert({ session_id: sessionId, seq, type, payload: parsed.data.payload, ts });
    if (!error) {
      const event: SessionEvent = parsed.data;
      broadcast(sessionId, event);
      return event;
    }
    if (!/duplicate|unique/i.test(error.message) || attempt === 4) throw error;
  }
  throw new Error('event sequence allocation failed');
}
