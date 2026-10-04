import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSandboxIntent } from '../src/lib/sandboxIntent.js';

test('sandbox intent matches explicit execution and code-creation requests without job templates', () => {
  for (const goal of [
    'open your sandbox and run a simple python code',
    'run this script and show output',
    'execute the tests',
    'use the sandbox',
    'write a website and run it',
    'build me a small React app',
    'fix the bug in my API',
    'create a Python script',
    'please start the website',
    'I need a website built and running',
  ]) {
    assert.ok(hasSandboxIntent(goal), goal);
  }
  for (const goal of [
    'hi',
    'explain how python decorators work',
    'what is a sandbox attack?',
    'how does sandbox isolation work?',
    'what can the sandbox do?',
    'how do I build a website?',
    'tell me how to run a Python script',
    'write me a poem',
  ]) {
    assert.ok(!hasSandboxIntent(goal), goal);
  }
});
