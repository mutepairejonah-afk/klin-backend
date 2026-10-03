import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, _resetLlmState } from '../src/lib/llm.js';

const realFetch = globalThis.fetch;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const ok = (text: string) => json(200, { choices: [{ message: { content: text } }] });

function setup(handler: (url: string, model: string) => Response) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const model = JSON.parse(init.body).model as string;
    calls.push(`${new URL(String(url)).host}|${model}`);
    return handler(String(url), model);
  }) as typeof fetch;
  return calls;
}

test.beforeEach(() => {
  _resetLlmState();
  for (const k of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'OLLAMA_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_MODEL', 'PROVIDER_ORDER']) delete process.env[k];
});
test.afterEach(() => { globalThis.fetch = realFetch; });

test('retired Gemini model 404 falls through to a current model', async () => {
  process.env.GEMINI_API_KEY = 'k';
  process.env.GEMINI_MODEL = 'gemini-2.5-flash'; // what the old .env.example shipped
  const calls = setup((_u, model) => model === 'gemini-3.8-flash' ? ok('hi')
    : json(404, [{ error: { code: 404, message: `This model models/${model} is no longer available.`, status: 'NOT_FOUND' } }]));
  const r = await chat([{ role: 'user', content: 'x' }]);
  assert.equal(r.text, 'hi');
  assert.equal(r.model, 'gemini-3.8-flash');
  assert.deepEqual(calls.map((c) => c.split('|')[1]), ['gemini-2.5-flash', 'gemini-3.8-flash']);
});

test('rate-limited provider is skipped on the next request', async () => {
  process.env.OPENROUTER_API_KEY = 'a';
  process.env.GEMINI_API_KEY = 'b';
  process.env.PROVIDER_ORDER = 'openrouter,google';
  const calls = setup((u) => u.includes('openrouter') ? json(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } }) : ok('from gemini'));
  assert.equal((await chat([{ role: 'user', content: 'x' }])).provider, 'google');
  calls.length = 0;
  assert.equal((await chat([{ role: 'user', content: 'x' }])).provider, 'google');
  assert.equal(calls.filter((c) => c.startsWith('openrouter')).length, 0, 'openrouter should be cooling down');
});

test('error message is concise, not a raw JSON dump', async () => {
  process.env.OPENROUTER_API_KEY = 'a';
  setup(() => json(429, { error: { message: 'Rate limit exceeded: free-models-per-day', metadata: { headers: { 'X-RateLimit-Limit': '50' } } } }));
  await assert.rejects(() => chat([{ role: 'user', content: 'x' }]), (e: Error) => {
    assert.match(e.message, /429 Rate limit exceeded: free-models-per-day/);
    assert.ok(!e.message.includes('metadata'));
    return true;
  });
});
