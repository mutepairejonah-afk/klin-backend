import { supabaseAdmin } from '../lib/supabase.js';
import type { ModelOverride } from '../lib/llm.js';
import type { CodingJob } from './executionWorker.js';

export interface ExecutionJobRow {
  id: string;
  session_id: string;
  org_id: string;
  goal: string;
  repo?: string | null;
  branch?: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  worker_id?: string | null;
  error?: string | null;
  model_override?: ModelOverride | null;
}

export async function enqueueCodingJob(job: CodingJob) {
  const { data, error } = await supabaseAdmin.from('execution_jobs').insert({
    session_id: job.sessionId,
    org_id: job.orgId,
    goal: job.goal,
    repo: job.repo ?? null,
    branch: job.branch ?? null,
    model_override: job.modelOverride ?? null,
    status: 'queued',
  }).select('id').single();
  if (error || !data) throw error ?? new Error('execution job was not queued');
  return data.id as string;
}

export async function claimExecutionJob(workerId: string): Promise<ExecutionJobRow | null> {
  const { data, error } = await supabaseAdmin.rpc('claim_execution_job', { p_worker_id: workerId });
  if (error) throw error;
  return (Array.isArray(data) && data.length ? data[0] : null) as ExecutionJobRow | null;
}

export async function requeueStaleJobs(timeoutSeconds = 900) {
  const { data, error } = await supabaseAdmin.rpc('requeue_stale_execution_jobs', { p_timeout_seconds: timeoutSeconds });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function markExecutionJob(id: string, status: 'succeeded' | 'failed', errorMessage?: string) {
  const { error } = await supabaseAdmin.from('execution_jobs').update({
    status, error: errorMessage ?? null, finished_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
}

export async function heartbeatExecutionJob(id: string) {
  const { error } = await supabaseAdmin.from('execution_jobs').update({
    heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'running');
  if (error) throw error;
}
