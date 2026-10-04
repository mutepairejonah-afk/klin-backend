import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstructWorkspaceFiles } from '../src/sandbox/workspaceSnapshot.js';

test('workspace snapshot uses the latest file content and removes deleted files', () => {
  const files = reconstructWorkspaceFiles([
    { type: 'file.created', payload: { path: 'index.html', content: 'v1' } },
    { type: 'file.created', payload: { path: 'src/app.js', content: 'console.log(1)' } },
    { type: 'file.modified', payload: { path: 'index.html', content: 'v2' } },
    { type: 'file.deleted', payload: { path: 'src/app.js' } },
  ]);
  assert.deepEqual(files, [{ path: 'index.html', content: 'v2' }]);
});

test('workspace snapshot ignores unrelated events and refuses path traversal', () => {
  assert.deepEqual(reconstructWorkspaceFiles([{ type: 'thought', payload: { text: 'ignore' } }]), []);
  assert.throws(
    () => reconstructWorkspaceFiles([{ type: 'file.created', payload: { path: '../secret', content: 'x' } }]),
    /unsafe to restore/,
  );
});
