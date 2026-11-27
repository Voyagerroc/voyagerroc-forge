import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openStore } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';

test('state keeps every task run after more than fifty newer runs are recorded', async t => {
  const store = openStore(':memory:');
  const project = store.connect({ id: 123, full_name: 'example/history', html_url: 'https://github.com/example/history', description: '', default_branch: 'main', private: false });
  function approvedTask(title) {
    let task = store.createTask({ projectId: project.id, title, intent: 'Keep the execution record', adapter: 'github' });
    for (const status of ['planned', 'in_review', 'approved']) task = store.transition(task.id, task.version, status, { mode: 'dry-run' });
    return task;
  }
  const older = approvedTask('Earlier task');
  const first = store.createRun(older.id, older.version);
  store.startRun(first.id, 'a'.repeat(40));
  store.finishRun(first.id, { status: 'failed', summary: 'First attempt failed', patch: 'original patch', patchSha256: 'b'.repeat(64), checks: [{ name: 'diff-whitespace', status: 'failed', detail: 'Whitespace error' }] });
  const newer = approvedTask('Busy task');
  for (let i = 0; i < 60; i++) {
    const run = store.createRun(newer.id, newer.version);
    store.finishRun(run.id, { status: 'cancelled', summary: `Attempt ${i + 1}` });
  }
  const server = createApp({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.runs.length, 61, 'every returned task retains its complete run history');
  const retained = state.runs.find(run => run.id === first.id);
  assert.equal(retained.task_id, older.id);
  assert.equal(retained.status, 'failed');
  assert.equal(retained.summary, 'First attempt failed');
  assert.equal(retained.has_patch, true);
  assert.equal(retained.patch_sha256, 'b'.repeat(64));
  assert.equal(retained.checks[0].status, 'failed');
  assert.ok(state.runs.every(run => !Object.hasOwn(run, 'patch')), 'patch bodies stay out of the state response');
  assert.equal(state.events.length, 50, 'the separate recent-activity window remains bounded');
  assert.equal(store.getRun(first.id).patch, 'original patch');
});
