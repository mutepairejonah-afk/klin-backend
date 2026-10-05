import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCodingTask } from '../src/orchestrator/executor.js';
import type { ChatMessage } from '../src/lib/llm.js';
import type { ExecRequest, ExecResult, SandboxHandle, SandboxRuntime, ToolEventSink } from '../src/sandbox/types.js';

const sandbox: SandboxHandle = { id: 'fake', provider: 'docker', machineId: 'fake', volume: 'fake', workspace: '/workspace' };

class FakeRuntime implements SandboxRuntime {
  calls: string[] = [];
  async create() { return sandbox; }
  async destroy() {}
  async exec(_handle: SandboxHandle, request: ExecRequest): Promise<ExecResult> {
    this.calls.push(request.command);
    if (request.command.includes('wc -c')) return { exitCode: 0, stdout: '11\nhello world', stderr: '', timedOut: false, durationMs: 1 };
    if (request.command.startsWith('if [ -f package.json ]')) return { exitCode: 0, stdout: 'npm test', stderr: '', timedOut: false, durationMs: 1 };
    if (request.command === 'npm test') return { exitCode: 0, stdout: '2 passing\n', stderr: '', timedOut: false, durationMs: 1 };
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
  }
}

test('executor loops through tool calls and requires verification after edits', async () => {
  const responses = [
    '{"action":"read_file","path":"README.md"}',
    '{"action":"write_file","path":"README.md","content":"updated"}',
    '{"action":"finish","summary":"done"}',
    '{"action":"run_tests"}',
    '{"action":"finish","summary":"Updated README and verified tests."}',
  ];
  const runtime = new FakeRuntime();
  const events: Array<[string, Record<string, unknown>]> = [];
  const sink: ToolEventSink = { emit: async (type, payload) => { events.push([type, payload]); } };
  const chatFn = async (_messages: ChatMessage[]) => ({ text: responses.shift()!, provider: 'openrouter' as const, model: 'fake' });
  const result = await executeCodingTask('session-1', 'org-1', 'Update the README', sandbox, runtime, undefined, chatFn, sink);

  assert.equal(result.summary, 'Updated README and verified tests.');
  assert.equal(result.changed, true);
  assert.equal(result.testsRun, true);
  assert.ok(runtime.calls.some((command) => command === 'npm test'));
  assert.ok(events.some(([type]) => type === 'file.created' || type === 'file.modified'));
  assert.ok(events.some(([type]) => type === 'test.result'));
});

test('executor preserves the selected specialist prompt when using the sandbox path', async () => {
  const runtime = new FakeRuntime();
  let systemPrompt = '';
  const chatFn = async (messages: ChatMessage[]) => {
    systemPrompt = messages[0].content;
    return { text: '{"action":"finish","summary":"Done."}', provider: 'openrouter' as const, model: 'fake' };
  };
  const sink: ToolEventSink = { emit: async () => undefined };
  await executeCodingTask(
    'session-2', 'org-1', 'Create a website', sandbox, runtime, undefined, chatFn, sink, undefined,
    { slug: 'frontend', name: 'Frontend Specialist', systemPrompt: 'Prefer accessible React components.' },
  );
  assert.match(systemPrompt, /Frontend Specialist/);
  assert.match(systemPrompt, /accessible React components/);
});

test('executor uses the selected GitHub connector for read-only repo listing without leaking its token', async () => {
  const originalFetch = globalThis.fetch;
  const runtime = new FakeRuntime();
  const events: Array<[string, Record<string, unknown>]> = [];
  const sink: ToolEventSink = { emit: async (type, payload) => { events.push([type, payload]); } };
  let transcript = '';
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /api\.github\.com\/user\/repos/);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');
    return new Response(JSON.stringify([{
      full_name: 'sample/project', private: true, default_branch: 'main',
      description: 'Example repository', html_url: 'https://github.com/sample/project',
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const responses = [
    '{"action":"github_list_repositories","limit":10}',
    '{"action":"finish","summary":"Listed the connected repositories."}',
  ];
  const chatFn = async (messages: ChatMessage[]) => {
    transcript = messages.map((message) => message.content).join('\n');
    return { text: responses.shift()!, provider: 'openrouter' as const, model: 'fake' };
  };

  try {
    const result = await executeCodingTask(
      'session-github', 'org-1', 'List my GitHub repositories', sandbox, runtime,
      undefined, chatFn, sink, { token: 'test-token' },
    );
    assert.match(result.summary, /Listed the connected repositories/);
    assert.match(transcript, /sample\/project/);
    assert.doesNotMatch(transcript, /test-token/);
    assert.ok(events.some(([type, payload]) => type === 'action.started' && payload.tool === 'github'));
    assert.ok(events.some(([type, payload]) => type === 'action.completed' && payload.tool === 'github'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
