import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowupMessages } from '../src/orchestrator/conversation.js';
import { sessionEventSchema } from '../src/contracts/events.js';

test('persisted user-message events satisfy the shared session event contract', () => {
  const parsed = sessionEventSchema.safeParse({
    seq: 3,
    ts: new Date().toISOString(),
    type: 'message.user',
    payload: { message: 'Please explain that again.' },
  });
  assert.equal(parsed.success, true);
});

test('follow-up transcript retains prior user/assistant turns in order and ignores planner chatter', () => {
  const messages = buildFollowupMessages('Be helpful.', 'What can you do?', [
    { type: 'thought', payload: { role: 'planner', text: 'internal plan' } },
    { type: 'thought', payload: { role: 'executor', text: 'I can help with research and code.' } },
    { type: 'message.user', payload: { message: 'Can you explain that?' } },
    { type: 'thought', payload: { role: 'executor', text: 'I can answer questions, research, and assist with software.' } },
  ], 'Give me an example.');

  assert.deepEqual(messages.map(({ role, content }) => [role, content]), [
    ['system', 'Be helpful.'],
    ['user', 'Original request: What can you do?'],
    ['assistant', 'I can help with research and code.'],
    ['user', 'Can you explain that?'],
    ['assistant', 'I can answer questions, research, and assist with software.'],
    ['user', 'Give me an example.'],
  ]);
});

test('follow-up transcript bounds retained history while preserving the current message', () => {
  const long = 'x'.repeat(70_000);
  const messages = buildFollowupMessages('system', 'goal', [
    { type: 'thought', payload: { role: 'executor', text: long } },
  ], 'current question');
  assert.equal(messages.at(-1)?.content, 'current question');
  assert.ok(messages.slice(2, -1).reduce((sum, item) => sum + item.content.length, 0) <= 60_000);
});
