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
  lease_expires_at?: string | null;
  resource_profile?: { cpus?: number; memory?: string; pidsLimit?: number; network?: string } | null;
  result?: Record<string, unknown> | null;
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

export async function claimExecutionJob(workerId: string, leaseSeconds = 900): Promise<ExecutionJobRow | null> {
  const { data, error } = await supabaseAdmin.rpc('claim_execution_job', { p_worker_id: workerId, p_lease_seconds: leaseSeconds });
  if (error) throw error;
  return (Array.isArray(data) && data.length ? data[0] : null) as ExecutionJobRow | null;
}

export async function requeueStaleJobs(timeoutSeconds = 900) {
  const { data, error } = await supabaseAdmin.rpc('requeue_stale_execution_jobs', { p_timeout_seconds: timeoutSeconds });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function markExecutionJob(id: string, workerId: string, status: 'succeeded' | 'failed', errorMessage?: string) {
  const { data, error } = await supabaseAdmin.rpc('finish_execution_job', {
    p_job_id: id, p_worker_id: workerId, p_status: status, p_error: errorMessage ?? null, p_result: null,
  });
  if (error) throw error;
  if (data !== true) throw new Error(`worker ${workerId} no longer owns execution job ${id}`);
}

export async function heartbeatExecutionJob(id: string, workerId: string, leaseSeconds = 900) {
  const { data, error } = await supabaseAdmin.rpc('heartbeat_execution_job', {
    p_job_id: id, p_worker_id: workerId, p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  if (data !== true) throw new Error(`worker ${workerId} no longer owns execution job ${id}`);
}
