import { supabaseAdmin } from '../lib/supabase.js';
import { appendAudit } from '../lib/audit.js';
import { checkpoint } from '../lib/sessionControl.js';
import { emitEvent } from '../lib/eventBus.js';
import { createSandboxRuntime } from '../sandbox/index.js';
import { SandboxHandle, SandboxRuntime } from '../sandbox/types.js';
import { eventSink, gitClone, gitBranch, gitStatus } from '../tools/sandboxTools.js';
import { executeCodingTask } from '../orchestrator/executor.js';
import type { ModelOverride } from '../lib/llm.js';

export interface CodingJob {
  sessionId: string;
  orgId: string;
  actor: string;
  goal: string;
  repo?: string;
  branch?: string;
  modelOverride?: ModelOverride;
}

interface QueuedJob { job: CodingJob; resolve: () => void; reject: (error: unknown) => void }

export class ExecutionWorker {
  private readonly queue: QueuedJob[] = [];
  private active = 0;
  private readonly concurrency: number;

  constructor(private readonly runtime: SandboxRuntime = createSandboxRuntime(), concurrency = Number(process.env.KILN_WORKER_CONCURRENCY ?? 2)) {
    this.concurrency = Math.max(1, Math.min(concurrency, 8));
  }

  enqueue(job: CodingJob): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.drain();
    });
  }

  get pending() { return this.queue.length; }
  get running() { return this.active; }

  private drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const entry = this.queue.shift()!;
      this.active += 1;
      void this.run(entry.job).then(entry.resolve, entry.reject).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  private async run(job: CodingJob) {
    let sandbox: SandboxHandle | undefined;
    const events = eventSink(job.sessionId);
    try {
      await checkpoint(job.sessionId);
      await supabaseAdmin.from('sessions').update({ status: 'planning' }).eq('id', job.sessionId).eq('org_id', job.orgId);
      sandbox = await this.runtime.create(job.sessionId);
      const { data: sandboxRow, error: sandboxError } = await supabaseAdmin
        .from('sandboxes')
        .insert({ session_id: job.sessionId, provider: sandbox.provider, machine_id: sandbox.machineId, status: 'running' })
        .select('id')
        .single();
      if (sandboxError || !sandboxRow) throw sandboxError ?? new Error('sandbox row was not created');
      const sandboxRecordId = sandboxRow.id as string;
      await supabaseAdmin.from('sessions').update({ sandbox_id: sandboxRecordId, status: 'executing' }).eq('id', job.sessionId).eq('org_id', job.orgId);
      await events.emit('thought', { role: 'executor', text: `Isolated ${sandbox.provider} workspace is ready.` });

      const context = { sessionId: job.sessionId, sandbox, runtime: this.runtime, events };
      if (job.repo) {
        const repoUrl = /^https:\/\//i.test(job.repo) ? job.repo : `https://github.com/${job.repo}.git`;
        await gitClone(context, repoUrl);
        if (job.branch) await gitBranch(context, job.branch);
      }
      await gitStatus(context);
      const result = await executeCodingTask(job.sessionId, job.orgId, job.goal, sandbox, this.runtime, job.modelOverride);
      await events.emit('session.done', { summary: result.summary.slice(0, 280) });
      await supabaseAdmin.from('sessions').update({ status: 'done', ended_at: new Date().toISOString() }).eq('id', job.sessionId).eq('org_id', job.orgId);
      await supabaseAdmin.from('sandboxes').update({ status: 'idle', updated_at: new Date().toISOString() }).eq('id', sandboxRecordId);
      await appendAudit({ orgId: job.orgId, actor: job.actor, action: 'sandbox.initialized', sessionId: job.sessionId, detail: sandbox.machineId });
    } catch (error) {
      await emitEvent(job.sessionId, 'error', { message: error instanceof Error ? error.message : String(error) });
      await supabaseAdmin.from('sessions').update({ status: 'failed', ended_at: new Date().toISOString() }).eq('id', job.sessionId).eq('org_id', job.orgId);
      if (sandbox) await supabaseAdmin.from('sandboxes').update({ status: 'destroyed', updated_at: new Date().toISOString() }).eq('machine_id', sandbox.machineId);
      throw error;
    } finally {
      if (sandbox && process.env.KILN_KEEP_SANDBOX !== 'true') {
        await this.runtime.destroy(sandbox).catch(() => undefined);
        await supabaseAdmin.from('sandboxes').update({ status: 'destroyed', updated_at: new Date().toISOString() }).eq('machine_id', sandbox.machineId);
      }
    }
  }
}

export const executionWorker = new ExecutionWorker();
