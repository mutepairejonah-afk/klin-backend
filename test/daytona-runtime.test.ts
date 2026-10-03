import test from 'node:test';
import assert from 'node:assert/strict';
import { DaytonaSandboxRuntime } from '../src/sandbox/daytona.js';

function fakeClient() {
  const calls: Array<{ command: string; cwd?: string; timeout?: number }> = [];
  const created: unknown[] = [];
  let deleted = 0;
  const sandbox = {
    id: 'sbx-1',
    process: {
      executeCommand: async (command: string, cwd?: string, _env?: Record<string, string>, timeout?: number) => {
        calls.push({ command, cwd, timeout });
        if (command === 'fail') return { exitCode: 2, result: 'boom' };
        return { exitCode: 0, result: 'ok\n' };
      },
    },
  };
  const client = {
    create: async (params: unknown) => { created.push(params); return sandbox; },
    get: async () => sandbox,
    delete: async () => { deleted += 1; },
  };
  return { client: client as never, calls, created, deleted: () => deleted };
}

test('daytona runtime creates, execs inside /workspace, and destroys', async () => {
  const f = fakeClient();
  const runtime = new DaytonaSandboxRuntime({ client: f.client, snapshot: 'klin-snap', blockNetwork: true });
  const handle = await runtime.create('session-1');
  assert.equal(handle.provider, 'daytona');
  assert.equal(handle.machineId, 'sbx-1');
  assert.deepEqual(f.created[0], {
    labels: { 'klin.session': 'session-1', 'klin.app': 'klin-backend' },
    autoStopInterval: 30, networkBlockAll: true, snapshot: 'klin-snap',
  });

  const out: string[] = [];
  const ok = await runtime.exec(handle, { command: 'echo ok', timeoutMs: 1500, onStdout: (c) => out.push(c) });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, 'ok\n');
  assert.deepEqual(out, ['ok\n']);
  assert.deepEqual(f.calls.at(-1), { command: 'echo ok', cwd: '/workspace', timeout: 2 });

  const bad = await runtime.exec(handle, { command: 'fail' });
  assert.equal(bad.exitCode, 2);
  assert.equal(bad.stderr, 'boom');

  await assert.rejects(runtime.exec(handle, { command: 'ls', cwd: '/etc' }), /inside the sandbox workspace/);
  await runtime.destroy(handle);
  assert.equal(f.deleted(), 1);
});

test('daytona runtime fails clearly without an API key', async () => {
  const saved = process.env.DAYTONA_API_KEY;
  delete process.env.DAYTONA_API_KEY;
  try {
    await assert.rejects(new DaytonaSandboxRuntime().create('s'), /DAYTONA_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.DAYTONA_API_KEY = saved;
  }
});
