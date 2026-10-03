import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpoint, pauseSession, resumeSession, cancelSession, SessionCancelledError } from '../src/lib/sessionControl.js';
import { sessionEventSchema } from '../src/contracts/events.js';

test('checkpoint blocks while paused and resumes cleanly', async () => {
  const id = `test-${Date.now()}-pause`;
  pauseSession(id);
  let released = false;
  const pending = checkpoint(id).then(() => { released = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(released, false);
  resumeSession(id);
  await pending;
  assert.equal(released, true);
});

test('checkpoint rejects after cancellation', async () => {
  const id = `test-${Date.now()}-cancel`;
  cancelSession(id);
  await assert.rejects(checkpoint(id), (error: unknown) => error instanceof SessionCancelledError);
});

test('event contract rejects fabricated or malformed events', () => {
  const valid = sessionEventSchema.safeParse({
    seq: 0,
    ts: new Date().toISOString(),
    type: 'session.done',
    payload: { summary: 'complete' },
  });
  assert.equal(valid.success, true);

  const invalid = sessionEventSchema.safeParse({
    seq: 0,
    ts: new Date().toISOString(),
    type: 'test.result',
    payload: { passed: '12', failed: 0 },
  });
  assert.equal(invalid.success, false);
});
