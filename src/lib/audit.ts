import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';

export async function appendAudit(opts: {
  orgId: string;
  actor: string;
  action: string;
  sessionId?: string;
  detail?: string;
  ip?: string;
}) {
  const { data: last } = await supabaseAdmin
    .from('audit_logs')
    .select('hash')
    .eq('org_id', opts.orgId)
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle();

  const prevHash = last?.hash ?? null;
  const ts = new Date().toISOString();
  const payload = JSON.stringify({
    org: opts.orgId, actor: opts.actor, action: opts.action,
    session: opts.sessionId ?? null, detail: opts.detail ?? '', ts, prevHash,
  });
  const hash = crypto.createHash('sha256').update(payload).digest('hex');

  await supabaseAdmin.from('audit_logs').insert({
    org_id: opts.orgId,
    actor: opts.actor,
    action: opts.action,
    session_id: opts.sessionId,
    detail: opts.detail,
    ip: opts.ip,
    ts,
    prev_hash: prevHash,
    hash,
  });
}
