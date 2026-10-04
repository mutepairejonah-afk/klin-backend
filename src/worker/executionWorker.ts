import { supabaseAdmin } from '../lib/supabase.js';
import { appendAudit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { checkpoint, forgetSessionControl, sessionSignal, SessionCancelledError } from '../lib/sessionControl.js';
import { emitEvent } from '../lib/eventBus.js';
import { createSandboxRuntime } from '../sandbox/index.js';
import { GitHubExecutionContext, SandboxHandle, SandboxRuntime, ToolContext } from '../sandbox/types.js';
import { reconstructWorkspaceFiles } from '../sandbox/workspaceSnapshot.js';
import { eventSink, gitClone, gitBranch, gitStatus, writeFile } from '../tools/sandboxTools.js';
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
  agent?: { slug: string; name: string; systemPrompt: string };
}

interface QueuedJob { job: CodingJob; resolve: () => void; reject: (error: unknown) => void }

export class ExecutionWorker {
  private readonly queue: QueuedJob[] = [];
  private active = 0;
  private readonly activeSessions = new Set<string>();
  private readonly sandboxes = new Map<string, SandboxHandle>();
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

  async cancel(sessionId: string): Promise<'queued' | 'running' | 'unknown'> {
    const queuedIndex = this.queue.findIndex((entry) => entry.job.sessionId === sessionId);
    if (queuedIndex >= 0) {
      const [entry] = this.queue.splice(queuedIndex, 1);
      entry.resolve();
      return 'queued';
    }
    if (!this.activeSessions.has(sessionId)) return 'unknown';
    const sandbox = this.sandboxes.get(sessionId);
    if (sandbox && this.runtime.interrupt) await this.runtime.interrupt(sandbox);
    return 'running';
  }

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
    this.activeSessions.add(job.sessionId);
    try {
      await checkpoint(job.sessionId);
      await supabaseAdmin.from('sessions').update({ status: 'planning' }).eq('id', job.sessionId).eq('org_id', job.orgId);
      sandbox = await this.runtime.create(job.sessionId);
      this.sandboxes.set(job.sessionId, sandbox);
      await checkpoint(job.sessionId);
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
      let githubContext: GitHubExecutionContext | undefined;
      if (job.repo) {
        const githubRepo = resolveGitHubRepo(job.repo);
        const credentials = githubRepo
          ? await getGitHubCredentials(job.orgId)
          : undefined;
        await gitClone(context, githubRepo?.url ?? job.repo, '.', credentials?.token, credentials?.username);
        await checkpoint(job.sessionId);
        if (job.branch) await gitBranch(context, job.branch);
        if (githubRepo && credentials) {
          const baseBranch = job.branch || await getGitHubDefaultBranch(githubRepo.fullName, credentials.token, sessionSignal(job.sessionId));
          const workBranch = `klin/${job.sessionId.slice(0, 8)}`;
          await gitBranch(context, workBranch);
          githubContext = { repository: githubRepo.fullName, baseBranch, workBranch, ...credentials };
        }
      } else {
        await restoreWorkspaceFiles(job.sessionId, context);
      }
      await gitStatus(context);
      const result = await executeCodingTask(job.sessionId, job.orgId, job.goal, sandbox, this.runtime, job.modelOverride, undefined, events, githubContext, job.agent);
      await events.emit('session.done', { summary: result.summary.slice(0, 280) });
      await supabaseAdmin.from('sessions').update({ status: 'done', ended_at: new Date().toISOString() }).eq('id', job.sessionId).eq('org_id', job.orgId);
      await supabaseAdmin.from('sandboxes').update({ status: 'idle', updated_at: new Date().toISOString() }).eq('id', sandboxRecordId);
      await appendAudit({ orgId: job.orgId, actor: job.actor, action: 'sandbox.initialized', sessionId: job.sessionId, detail: sandbox.machineId });
    } catch (error) {
      const cancelled = sessionSignal(job.sessionId).aborted || error instanceof SessionCancelledError;
      await emitEvent(job.sessionId, 'error', { message: cancelled ? 'Session cancelled by user.' : error instanceof Error ? error.message : String(error) });
      await supabaseAdmin.from('sessions').update({ status: 'failed', ended_at: new Date().toISOString() }).eq('id', job.sessionId).eq('org_id', job.orgId);
      if (sandbox) await supabaseAdmin.from('sandboxes').update({ status: 'destroyed', updated_at: new Date().toISOString() }).eq('machine_id', sandbox.machineId);
      throw error;
    } finally {
      if (sandbox && process.env.KILN_KEEP_SANDBOX !== 'true') {
        await this.runtime.destroy(sandbox).catch(() => undefined);
        await supabaseAdmin.from('sandboxes').update({ status: 'destroyed', updated_at: new Date().toISOString() }).eq('machine_id', sandbox.machineId);
      }
      this.sandboxes.delete(job.sessionId);
      this.activeSessions.delete(job.sessionId);
      forgetSessionControl(job.sessionId);
    }
  }
}

async function restoreWorkspaceFiles(sessionId: string, context: ToolContext) {
  const { data, error } = await supabaseAdmin
    .from('events')
    .select('type,payload')
    .eq('session_id', sessionId)
    .in('type', ['file.created', 'file.modified', 'file.deleted'])
    .order('seq', { ascending: true })
    .limit(101);
  if (error) throw error;
  if ((data ?? []).length > 100) throw new Error('Too many prior file changes to restore safely; start a new coding session.');

  const files = reconstructWorkspaceFiles(data ?? []);
  if (files.length > 100) throw new Error('Too many prior workspace files to restore safely; start a new coding session.');

  let totalBytes = 0;
  for (const { path, content } of files) {
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > 10 * 1024 * 1024) throw new Error('Prior workspace snapshot exceeds the 10 MiB restore limit.');
    await writeFile(context, path, content, { emitEvents: false });
  }
}

function resolveGitHubRepo(repo: string): { url: string; fullName: string } | null {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { url: `https://github.com/${repo}.git`, fullName: repo };
  try {
    const url = new URL(repo);
    if (url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com' && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(url.pathname)) {
      const path = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '');
      return { url: `https://github.com${path}.git`, fullName: path.slice(1) };
    }
    return null;
  } catch {
    throw new Error('Repository must be a GitHub owner/repository selection or an HTTPS clone URL.');
  }
}

async function getGitHubDefaultBranch(repository: string, token: string, signal: AbortSignal): Promise<string> {
  const path = repository.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://api.github.com/repos/${path}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'klin-app', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.default_branch !== 'string') throw new Error(`Could not read the default branch for ${repository} from GitHub.`);
  return body.default_branch;
}

async function getGitHubCredentials(orgId: string): Promise<{ token: string; username: string }> {
  const { data, error } = await supabaseAdmin.from('connections')
    .select('connected,encrypted_credentials,meta')
    .eq('org_id', orgId).eq('provider', 'github').maybeSingle();
  if (error) throw error;
  if (!data?.connected || !data.encrypted_credentials) throw new Error('Connect GitHub before starting work on this repository.');
  try {
    return { token: decrypt(data.encrypted_credentials), username: typeof data.meta?.login === 'string' ? data.meta.login : 'x-access-token' };
  } catch {
    throw new Error('Stored GitHub credentials are unreadable. Reconnect GitHub and try again.');
  }
}

export const executionWorker = new ExecutionWorker();
