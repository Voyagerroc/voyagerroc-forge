import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.mjs';

const repository = { id: 123, full_name: 'example/before', html_url: 'https://github.com/example/before',
  description: 'Before rename', default_branch: 'main', private: false };

for (const name of ['example/after', 'new-owner/after']) {
  test(`reconnecting ${name} keeps the project and its task history`, t => {
    const store = openStore(':memory:');
    t.after(() => store.close());
    const original = store.connect(repository);
    const task = store.createTask({ projectId: original.id, title: 'Fix spelling', intent: 'Correct typo', adapter: 'github' });
    store.receive('before-rename', 'pull_request', { repository: { id: 123 }, action: 'opened', pull_request: {
      number: 2, title: 'Existing change', state: 'open', head: { sha: 'b'.repeat(40) }, updated_at: '2025-01-01T00:00:00Z',
    } });
    const renamed = store.connect({ ...repository, full_name: name, html_url: `https://github.com/${name}`,
      description: 'After rename', default_branch: 'develop', private: true });
    assert.equal(renamed.id, original.id);
    assert.equal(renamed.full_name, name);
    assert.equal(renamed.url, `https://github.com/${name}`);
    assert.equal(renamed.default_branch, 'develop');
    assert.equal(renamed.description, 'After rename');
    assert.equal(renamed.private, 1);
    assert.equal(renamed.created_at, original.created_at);
    assert.equal(store.snapshot().projects.length, 1);
    assert.equal(store.getTask(task.id).project_id, renamed.id);
    assert.equal(store.taskEvents(task.id)[0].kind, 'task.created');
    assert.equal(store.snapshot().pullRequests[0].url, `https://github.com/${name}/pull/2`);

    store.receive('after-rename', 'pull_request', { repository: { id: 123 }, action: 'opened', pull_request: {
      number: 1, title: 'Fix spelling', state: 'open', head: { sha: 'a'.repeat(40) }, updated_at: '2026-01-01T00:00:00Z',
    } });
    assert.equal(store.snapshot().pullRequests[0].url, `https://github.com/${name}/pull/1`);
  });
}

test('local fixtures with the same numeric id remain separate from GitHub projects', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const local = store.connect({ ...repository, full_name: 'local/demo', source_kind: 'local' });
  const remote = store.connect(repository);
  assert.notEqual(local.id, remote.id);
  assert.equal(store.snapshot().projects.length, 2);
});
