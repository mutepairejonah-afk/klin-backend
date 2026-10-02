import test from 'node:test';
import assert from 'node:assert/strict';
import { gitBranch, readFile, runTests, shellExec, writeFile } from '../src/tools/sandboxTools.js';
import type { ExecRequest, ExecResult, SandboxHandle, SandboxRuntime, ToolEventSink } from '../src/sandbox/types.js';

const handle: SandboxHandle = { id: 'fake', provider: 'docker', machineId: 'fake', volume: 'fake-volume', workspace: '/workspace' };

class FakeRuntime implements SandboxRuntime {
  files = new Map<string, string>();
  commands: string[] = [];
  async create() { return handle; }
  async destroy() {}
  async exec(_handle: SandboxHandle, request: ExecRequest): Promise<ExecResult> {
    this.commands.push(request.command);
    if (request.command.startsWith('test -e')) return { exitCode: this.files.has('/workspace/a.txt') ? 0 : 1, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
    if (request.command.startsWith('if [ -f package.json ]')) return { exitCode: 0, stdout: 'npm test', stderr: '', timedOut: false, durationMs: 1 };
    if (request.command === 'npm test') return { exitCode: 0, stdout: '3 passing\n', stderr: '', timedOut: false, durationMs: 1 };
    if (request.command.includes('wc -c')) return { exitCode: 0, stdout: '5\nhello', stderr: '', timedOut: false, durationMs: 1 };
    if (request.command.includes('package.json')) return { exitCode: 0, stdout: 'npm test', stderr: '', timedOut: false, durationMs: 1 };
    if (request.command.includes('git branch')) return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false, durationMs: 1 };
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
  }
}

function context(runtime: FakeRuntime, events: Array<[string, Record<string, unknown>]>) {
  const sink: ToolEventSink = { emit: async (type, payload) => { events.push([type, payload]); } };
  return { sessionId: 's1', sandbox: handle, runtime, events: sink };
}

test('filesystem tools reject traversal and write within workspace', async () => {
  const runtime = new FakeRuntime();
  const events: Array<[string, Record<string, unknown>]> = [];
  const ctx = context(runtime, events);
  await assert.rejects(readFile(ctx, '../etc/passwd'), /inside \/workspace/);
  const written = await writeFile(ctx, 'src/a.txt', 'hello');
  assert.equal(written.bytes, 5);
  assert.ok(events.some(([type]) => type === 'file.created'));
});

test('shell and git tools reject unsafe branch/test commands', async () => {
  const runtime = new FakeRuntime();
  const ctx = context(runtime, []);
  await shellExec(ctx, 'printf hello');
  await assert.rejects(gitBranch(ctx, 'main; rm -rf /'), /invalid branch/);
  await assert.rejects(runTests(ctx, 'npm test && rm -rf /'), /disallowed shell operators/);
});

test('test tool detects npm test and emits parsed result', async () => {
  const runtime = new FakeRuntime();
  const events: Array<[string, Record<string, unknown>]> = [];
  const result = await runTests(context(runtime, events));
  assert.equal(result.passed, 3);
  assert.equal(result.failed, 0);
  assert.ok(events.some(([type, payload]) => type === 'test.result' && payload.passed === 3));
});
