import 'dotenv/config';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ExecutionWorker } from './executionWorker.js';
import { claimExecutionJob, heartbeatExecutionJob, markExecutionJob, requeueStaleJobs, type ExecutionJobRow } from './queue.js';

const workerId = `${process.env.KILN_WORKER_ID ?? os.hostname()}-${randomUUID().slice(0, 8)}`;
const pollMs = Math.max(500, Number(process.env.KILN_WORKER_POLL_MS ?? 2_000));
const staleSeconds = Math.max(60, Number(process.env.KILN_WORKER_STALE_SECONDS ?? 900));
const leaseSeconds = Math.max(60, Number(process.env.KILN_WORKER_LEASE_SECONDS ?? staleSeconds));
const executionWorker = new ExecutionWorker(undefined, 1);
let stopping = false;
let activeJob: ExecutionJobRow | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;

async function runJob(job: ExecutionJobRow) {
  activeJob = job;
  heartbeatTimer = setInterval(() => {
    void heartbeatExecutionJob(job.id, workerId, leaseSeconds).catch((error) => console.error('heartbeat failed', error));
  }, Math.min(30_000, Math.max(5_000, Math.floor(staleSeconds * 1_000 / 3))));
  try {
    await executionWorker.enqueue({
      sessionId: job.session_id,
      orgId: job.org_id,
      actor: `worker:${workerId}`,
      goal: job.goal,
      repo: job.repo ?? undefined,
      branch: job.branch ?? undefined,
      modelOverride: job.model_override ?? undefined,
    });
    await markExecutionJob(job.id, workerId, 'succeeded');
    console.log(JSON.stringify({ event: 'job.succeeded', workerId, jobId: job.id, sessionId: job.session_id }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markExecutionJob(job.id, workerId, 'failed', message).catch((markError) => console.error('failed to mark job failed', markError));
    console.error(JSON.stringify({ event: 'job.failed', workerId, jobId: job.id, sessionId: job.session_id, error: message }));
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    activeJob = undefined;
  }
}

async function loop() {
  console.log(JSON.stringify({ event: 'worker.started', workerId, pollMs, staleSeconds }));
  while (!stopping) {
    try {
      await requeueStaleJobs(staleSeconds);
      if (!activeJob) {
        const job = await claimExecutionJob(workerId, leaseSeconds);
        if (job) await runJob(job);
      }
    } catch (error) {
      console.error('worker poll failed', error);
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  console.log(JSON.stringify({ event: 'worker.stopped', workerId }));
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: 'worker.shutdown', workerId, signal, activeJob: activeJob?.id ?? null }));
  // The heartbeat remains valid until the running job finishes or is requeued
  // by the stale-job function after this process exits.
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
void loop().catch((error) => { console.error(error); process.exitCode = 1; });
