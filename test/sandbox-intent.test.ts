import test from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_INTENT } from '../src/lib/sandboxIntent.js';

test('sandbox intent matches execution requests and ignores plain chat', () => {
  for (const goal of ['open your sandbox and run a simple python code', 'run this script and show output', 'execute the tests', 'use the sandbox']) {
    assert.ok(SANDBOX_INTENT.test(goal), goal);
  }
  for (const goal of ['hi', 'explain how python decorators work', 'what is a sandbox attack?'.replace('sandbox', 'jail'), 'write me a poem']) {
    assert.ok(!SANDBOX_INTENT.test(goal), goal);
  }
});
