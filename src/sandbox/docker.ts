import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SandboxHandle, SandboxRuntime, ExecRequest, ExecResult } from './types.js';

const MAX_OUTPUT = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;

function safeName(sessionId: string) {
  return `klin-${sessionId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48) || randomUUID().slice(0, 12)}`;
}

function bounded(value: string) {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n[output truncated]` : value;
}

function runDocker(args: string[], request?: { timeoutMs?: number; onStdout?: (s: string) => void; onStderr?: (s: string) => void }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = Math.min(Math.max(request?.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      request?.onStdout?.(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      request?.onStderr?.(text);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? (timedOut ? 124 : 1), stdout: bounded(stdout), stderr: bounded(stderr), timedOut, durationMs: Date.now() - started });
    });
  });
}

export interface DockerRuntimeOptions {
  image?: string;
  network?: string;
  cpus?: string;
  memory?: string;
  pidsLimit?: string;
  workspaceVolumePrefix?: string;
}

export class DockerSandboxRuntime implements SandboxRuntime {
  private readonly image: string;
  private readonly network: string;
  private readonly cpus: string;
  private readonly memory: string;
  private readonly pidsLimit: string;
  private readonly volumePrefix: string;

  constructor(options: DockerRuntimeOptions = {}) {
    this.image = options.image ?? process.env.KILN_SANDBOX_IMAGE ?? 'ghcr.io/mutepairejonah-afk/klin-sandbox:node20-python311';
    this.network = options.network ?? process.env.KILN_SANDBOX_NETWORK ?? 'none';
    this.cpus = options.cpus ?? process.env.KILN_SANDBOX_CPUS ?? '2';
    this.memory = options.memory ?? process.env.KILN_SANDBOX_MEMORY ?? '2g';
    this.pidsLimit = options.pidsLimit ?? process.env.KILN_SANDBOX_PIDS_LIMIT ?? '256';
    this.volumePrefix = options.workspaceVolumePrefix ?? 'klin-workspace';
  }

  async create(sessionId: string): Promise<SandboxHandle> {
    const machineId = safeName(sessionId);
    const volume = `${this.volumePrefix}-${sessionId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48) || randomUUID().slice(0, 12)}`;
    const created = await runDocker(['volume', 'create', volume], { timeoutMs: 30_000 });
    if (created.exitCode !== 0) throw new Error(`docker volume create failed: ${created.stderr}`);
    const started = await runDocker([
      'run', '-d', '--name', machineId,
      '--label', `klin.session=${sessionId}`,
      '--cpus', this.cpus, '--memory', this.memory, '--pids-limit', this.pidsLimit,
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
      '--network', this.network,
      '-v', `${volume}:/workspace`,
      this.image, 'sleep', 'infinity',
    ], { timeoutMs: 60_000 });
    if (started.exitCode !== 0) {
      await runDocker(['volume', 'rm', '-f', volume], { timeoutMs: 30_000 });
      throw new Error(`docker sandbox start failed: ${started.stderr}`);
    }
    return { id: machineId, provider: 'docker', machineId, volume, workspace: '/workspace' };
  }

  attach(sessionId: string, machineId: string): SandboxHandle {
    const suffix = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48);
    return { id: machineId, provider: 'docker', machineId, volume: `${this.volumePrefix}-${suffix}`, workspace: '/workspace' };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const result = await runDocker(['rm', '-f', handle.machineId], { timeoutMs: 30_000 });
    if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) throw new Error(`docker sandbox destroy failed: ${result.stderr}`);
    await runDocker(['volume', 'rm', '-f', handle.volume], { timeoutMs: 30_000 });
  }

  async exec(handle: SandboxHandle, request: ExecRequest): Promise<ExecResult> {
    const cwd = request.cwd ?? handle.workspace;
    if (!(cwd === handle.workspace || cwd.startsWith(`${handle.workspace}/`)) || cwd.includes('..')) throw new Error('cwd must remain inside the sandbox workspace');
    const envArgs = Object.entries(request.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    const seconds = Math.ceil(Math.min(Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS) / 1000);
    return runDocker([
      'exec', '-i', '--user', '1000:1000', '-w', cwd, ...envArgs,
      handle.machineId, 'timeout', '--kill-after=5s', `${seconds}s`, 'sh', '-lc', request.command,
    ], request);
  }
}
