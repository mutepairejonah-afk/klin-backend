import { randomUUID } from 'node:crypto';
import { Daytona } from '@daytona/sdk';
import type { Sandbox } from '@daytona/sdk';
import { SandboxHandle, SandboxRuntime, ExecRequest, ExecResult } from './types.js';

const MAX_OUTPUT = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const WORKSPACE = '/workspace';

function bounded(value: string) {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n[output truncated]` : value;
}

function safeSuffix(sessionId: string) {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48) || randomUUID().slice(0, 12);
}

export interface DaytonaRuntimeOptions {
  /** Defaults to DAYTONA_API_KEY. Never hard-code or log this value. */
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  /** Preferred: a pre-built Daytona snapshot with git, ripgrep, node and python. */
  snapshot?: string;
  /** Used only when no snapshot is set. Must be pullable by Daytona. */
  image?: string;
  cpus?: number;
  memoryGb?: number;
  /** Block all outbound network. Mirrors KILN_SANDBOX_NETWORK=none. */
  blockNetwork?: boolean;
  /** Comma-separated CIDRs allowed when the network is not fully blocked. */
  networkAllowList?: string;
  autoStopMinutes?: number;
  /** Test seam. */
  client?: Daytona;
}

/**
 * SandboxRuntime backed by Daytona (https://www.daytona.io). One Daytona
 * sandbox per session; /workspace is the working directory, same as the
 * Docker runtime, so the tool layer is unchanged.
 */
export class DaytonaSandboxRuntime implements SandboxRuntime {
  private client?: Daytona;
  private readonly cache = new Map<string, Sandbox>();
  private readonly options: DaytonaRuntimeOptions;

  constructor(options: DaytonaRuntimeOptions = {}) {
    this.options = options;
    this.client = options.client;
  }

  /** The client is built lazily so importing this module never needs the key. */
  private daytona(): Daytona {
    if (this.client) return this.client;
    const apiKey = this.options.apiKey ?? process.env.DAYTONA_API_KEY;
    if (!apiKey) throw new Error('DAYTONA_API_KEY is not set on the server');
    this.client = new Daytona({
      apiKey,
      apiUrl: this.options.apiUrl ?? process.env.DAYTONA_API_URL,
      target: this.options.target ?? process.env.DAYTONA_TARGET,
    });
    return this.client;
  }

  private async resolve(handle: SandboxHandle): Promise<Sandbox> {
    const cached = this.cache.get(handle.machineId);
    if (cached) return cached;
    const sandbox = await this.daytona().get(handle.machineId);
    this.cache.set(handle.machineId, sandbox);
    return sandbox;
  }

  async create(sessionId: string): Promise<SandboxHandle> {
    const snapshot = this.options.snapshot ?? process.env.DAYTONA_SNAPSHOT;
    const image = this.options.image ?? process.env.DAYTONA_IMAGE;
    const blockNetwork = this.options.blockNetwork ?? (process.env.KILN_SANDBOX_NETWORK ?? 'none') === 'none';
    const allowList = this.options.networkAllowList ?? process.env.DAYTONA_NETWORK_ALLOW_LIST;
    const common = {
      labels: { 'klin.session': sessionId, 'klin.app': 'klin-backend' },
      autoStopInterval: this.options.autoStopMinutes ?? Number(process.env.DAYTONA_AUTO_STOP_MINUTES ?? 30),
      networkBlockAll: blockNetwork,
      ...(!blockNetwork && allowList ? { networkAllowList: allowList } : {}),
    };
    const cpu = this.options.cpus ?? Number(process.env.KILN_SANDBOX_CPUS ?? 2);
    const memory = this.options.memoryGb ?? Number(process.env.DAYTONA_MEMORY_GB ?? 2);

    const sandbox = !snapshot && image
      ? await this.daytona().create({ ...common, image, resources: { cpu, memory } }, { timeout: 300 })
      : await this.daytona().create({ ...common, ...(snapshot ? { snapshot } : {}) }, { timeout: 120 });

    try {
      // Tools address files under /workspace. Create it and make it writable
      // for the sandbox user; fall back to sudo when the image is not root.
      const prep = await sandbox.process.executeCommand(
        `mkdir -p ${WORKSPACE} 2>/dev/null || sudo -n mkdir -p ${WORKSPACE}; ` +
        `[ -w ${WORKSPACE} ] || sudo -n chown "$(id -u):$(id -g)" ${WORKSPACE}; [ -w ${WORKSPACE} ]`,
        undefined, undefined, 60,
      );
      if (prep.exitCode !== 0) throw new Error(`could not prepare ${WORKSPACE} in the Daytona sandbox: ${prep.result.slice(0, 500)}`);
    } catch (error) {
      await this.daytona().delete(sandbox).catch(() => undefined);
      throw error;
    }

    this.cache.set(sandbox.id, sandbox);
    return { id: sandbox.id, provider: 'daytona', machineId: sandbox.id, workspace: WORKSPACE };
  }

  /** Rebuild a handle for an existing sandbox row (used by the dev exec route). */
  attach(_sessionId: string, machineId: string): SandboxHandle {
    return { id: machineId, provider: 'daytona', machineId, workspace: WORKSPACE };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.cache.delete(handle.machineId);
    let sandbox: Sandbox;
    try {
      sandbox = await this.daytona().get(handle.machineId);
    } catch (error) {
      if (/not found|404/i.test(error instanceof Error ? error.message : String(error))) return;
      throw error;
    }
    await this.daytona().delete(sandbox);
  }

  async exec(handle: SandboxHandle, request: ExecRequest): Promise<ExecResult> {
    const cwd = request.cwd ?? handle.workspace;
    if (!(cwd === handle.workspace || cwd.startsWith(`${handle.workspace}/`)) || cwd.includes('..')) throw new Error('cwd must remain inside the sandbox workspace');
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
    const seconds = Math.ceil(timeoutMs / 1000);
    const started = Date.now();
    const sandbox = await this.resolve(handle);
    try {
      // Daytona merges stdout/stderr into `result` and enforces the timeout
      // server-side, so output is delivered to the callbacks once, at the end.
      const response = await sandbox.process.executeCommand(request.command, cwd, request.env, seconds);
      const output = bounded(response.result ?? '');
      if (output) (response.exitCode === 0 ? request.onStdout : request.onStderr)?.(output);
      return {
        exitCode: response.exitCode,
        stdout: response.exitCode === 0 ? output : '',
        stderr: response.exitCode === 0 ? '' : output,
        timedOut: response.exitCode === 124 || response.exitCode === 137,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/time(d)? ?out/i.test(message)) {
        return { exitCode: 124, stdout: '', stderr: message, timedOut: true, durationMs: Date.now() - started };
      }
      this.cache.delete(handle.machineId);
      throw error;
    }
  }
}
