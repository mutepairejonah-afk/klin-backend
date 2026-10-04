import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gitBranch, gitClone, gitPush, githubCreatePullRequest, readFile, runTests, shellExec, writeFile } from '../src/tools/sandboxTools.js';
import type { ExecRequest, ExecResult, SandboxHandle, SandboxRuntime, ToolEventSink } from '../src/sandbox/types.js';

const handle: SandboxHandle = { id: 'fake', provider: 'docker', machineId: 'fake', volume: 'fake-volume', workspace: '/workspace' };

class FakeRuntime implements SandboxRuntime {
  files = new Map<string, string>();
  commands: string[] = [];
  requests: ExecRequest[] = [];
  currentBranch = 'klin/abcd1234';
  async create() { return handle; }
  async destroy() {}
  attach() { return handle; }
  async exec(_handle: SandboxHandle, request: ExecRequest): Promise<ExecResult> {
    this.commands.push(request.command);
    this.requests.push(request);
    if (request.command === 'git branch --show-current') return { exitCode: 0, stdout: `${this.currentBranch}\n`, stderr: '', timedOut: false, durationMs: 1 };
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
  const eventCount = events.length;
  await writeFile(ctx, 'src/restore.txt', 'snapshot', { emitEvents: false });
  assert.equal(events.length, eventCount);
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

test('GitHub clone uses an ephemeral askpass credential without embedding the token in the command or events', async () => {
  const runtime = new FakeRuntime();
  const events: Array<[string, Record<string, unknown>]> = [];
  await gitClone(context(runtime, events), 'https://github.com/acme/private.git', '.', 'secret-token', 'acme-user');
  const request = runtime.requests.at(-1)!;
  assert.match(request.command, /GIT_ASKPASS/);
  assert.equal(request.command.includes('secret-token'), false);
  assert.equal(request.env?.KILN_GITHUB_TOKEN, 'secret-token');
  assert.equal(request.env?.KILN_GITHUB_USERNAME, 'acme-user');
  assert.equal(JSON.stringify(events).includes('secret-token'), false);
  const encoded = request.command.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/);
  assert.ok(encoded, 'askpass script should be transported as encoded source');
  const askpass = Buffer.from(encoded[1], 'base64').toString('utf8');
  const env = { ...process.env, KILN_GITHUB_TOKEN: 'secret-token', KILN_GITHUB_USERNAME: 'acme-user' };
  assert.equal(spawnSync('sh', ['-c', askpass, 'askpass', "Username for 'https://github.com':"], { env, encoding: 'utf8' }).stdout, 'acme-user\n');
  assert.equal(spawnSync('sh', ['-c', askpass, 'askpass', "Password for 'https://github.com':"], { env, encoding: 'utf8' }).stdout, 'secret-token\n');
  assert.notEqual(spawnSync('sh', ['-c', askpass, 'askpass', "Password for 'https://evilgithub.com':"], { env, encoding: 'utf8' }).status, 0);
});

test('GitHub default branch is switched to if it exists before trying to track the remote branch', async () => {
  const runtime = new FakeRuntime();
  await gitBranch(context(runtime, []), 'main');
  assert.match(runtime.requests.at(-1)!.command, /show-ref --quiet --verify 'refs\/heads\/main'.*git switch --quiet -- 'main'/);
  assert.match(runtime.requests.at(-1)!.command, /refs\/remotes\/origin\/main'.*--track --create 'main' 'origin\/main'/);
  assert.match(runtime.requests.at(-1)!.command, /else git switch --quiet --create 'main'/);
});

test('GitHub branch push keeps its token in transient environment only', async () => {
  const runtime = new FakeRuntime();
  const events: Array<[string, Record<string, unknown>]> = [];
  const ctx = { ...context(runtime, events), github: { repository: 'acme/private', baseBranch: 'main', workBranch: 'klin/abcd1234', token: 'secret-token', username: 'acme-user' } };
  await gitPush(ctx);
  const request = runtime.requests.at(-1)!;
  assert.match(request.command, /git push --set-upstream origin/);
  assert.equal(request.command.includes('secret-token'), false);
  assert.equal(request.env?.KILN_GITHUB_TOKEN, 'secret-token');
  assert.equal(request.env?.KILN_GITHUB_USERNAME, 'acme-user');
  assert.equal(JSON.stringify(events).includes('secret-token'), false);
});

test('GitHub push refuses to publish the selected base branch', async () => {
  const runtime = new FakeRuntime();
  runtime.currentBranch = 'main';
  const ctx = { ...context(runtime, []), github: { repository: 'acme/private', baseBranch: 'main', workBranch: 'klin/abcd1234', token: 'secret-token' } };
  await assert.rejects(gitPush(ctx), /only the session feature branch/);
  assert.equal(runtime.requests.some((request) => request.command.includes('git push')), false);
});

test('GitHub pull request creation emits a link artifact without returning credentials', async () => {
  const runtime = new FakeRuntime();
  const events: Array<[string, Record<string, unknown>]> = [];
  const ctx = { ...context(runtime, events), github: { repository: 'acme/private', baseBranch: 'main', workBranch: 'klin/abcd1234', token: 'secret-token' } };
  const originalFetch = globalThis.fetch;
  let requestHeaders: HeadersInit | undefined;
  try {
    globalThis.fetch = (async (_url: any, init: any) => {
      requestHeaders = init.headers;
      return new Response(JSON.stringify({ html_url: 'https://github.com/acme/private/pull/42', title: 'Improve chat controls' }), { status: 201 });
    }) as typeof fetch;
    const result = await githubCreatePullRequest(ctx, 'Improve chat controls', 'Add cancellable runs.');
    assert.equal(result.url, 'https://github.com/acme/private/pull/42');
    assert.equal(JSON.stringify(result).includes('secret-token'), false);
    assert.equal(new Headers(requestHeaders).get('Authorization'), 'Bearer secret-token');
    assert.ok(events.some(([type]) => type === 'git.pr_opened'));
    assert.ok(events.some(([type]) => type === 'artifact.created'));
    assert.equal(JSON.stringify(events).includes('secret-token'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
