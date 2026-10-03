export type SandboxStatus = 'provisioning' | 'running' | 'idle' | 'paused' | 'destroyed';

export interface ExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface SandboxHandle {
  id: string;
  provider: 'docker' | 'daytona';
  machineId: string;
  /** Docker named volume. Not used by providers that manage their own disk. */
  volume?: string;
  workspace: string;
}

export interface SandboxRuntime {
  create(sessionId: string): Promise<SandboxHandle>;
  destroy(handle: SandboxHandle): Promise<void>;
  /** Interrupts all work in a session sandbox without exposing its credentials. */
  interrupt?(handle: SandboxHandle): Promise<void>;
  exec(handle: SandboxHandle, request: ExecRequest): Promise<ExecResult>;
  /** Rebuild a handle for an already-provisioned sandbox (machine id from the sandboxes table). */
  attach(sessionId: string, machineId: string): SandboxHandle;
}

export interface ToolEventSink {
  emit(type: string, payload: Record<string, unknown>): Promise<void>;
}

export interface GitHubExecutionContext {
  repository: string;
  baseBranch: string;
  workBranch: string;
  token: string;
  username?: string;
}

export interface ToolContext {
  sessionId: string;
  sandbox: SandboxHandle;
  runtime: SandboxRuntime;
  events: ToolEventSink;
  /** Never serialized into the model transcript or tool result. */
  github?: GitHubExecutionContext;
}

export interface FileEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface TestResult {
  passed: number;
  failed: number;
  exitCode: number;
  timedOut: boolean;
  report: string;
}
