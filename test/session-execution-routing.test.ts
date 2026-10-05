import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionExecutionMode } from '../src/lib/sandboxIntent.js';

test('jobless coding requests are routed to the sandbox when runtime is ready', () => {
  assert.equal(resolveSessionExecutionMode({ goal: 'write a website and run it' }, true), 'sandbox');
  assert.equal(resolveSessionExecutionMode({ goal: 'build a small app' }, true), 'sandbox');
});

test('jobless coding requests do not silently fall back to text chat when sandbox runtime is off', () => {
  assert.equal(resolveSessionExecutionMode({ goal: 'write a website and run it' }, false), 'unavailable');
});

test('ordinary chat remains on the text-chat path', () => {
  assert.equal(resolveSessionExecutionMode({ goal: 'hi, what can you do?' }, true), 'chat');
  assert.equal(resolveSessionExecutionMode({ goal: 'explain how Python decorators work' }, true), 'chat');
  assert.equal(resolveSessionExecutionMode({ goal: 'hi, what can you do?', connectors: ['github'] }, true), 'chat');
});

test('selected GitHub tasks use the isolated connector executor and fail honestly without a runtime', () => {
  assert.equal(resolveSessionExecutionMode({ goal: 'List my open GitHub issues', connectors: ['github'] }, true), 'sandbox');
  assert.equal(resolveSessionExecutionMode({ goal: 'List my open GitHub issues', connectors: ['github'] }, false), 'unavailable');
});

test('repository, job, and explicit sandbox selections still request isolated execution', () => {
  assert.equal(resolveSessionExecutionMode({ goal: 'review this', repo: 'owner/project' }, true), 'sandbox');
  assert.equal(resolveSessionExecutionMode({ goal: 'do the task', jobId: 'job-1' }, true), 'sandbox');
  assert.equal(resolveSessionExecutionMode({ goal: 'analyze these files', sandbox: true }, true), 'sandbox');
  assert.equal(resolveSessionExecutionMode({ goal: 'review this', repo: 'owner/project' }, false), 'unavailable');
});
