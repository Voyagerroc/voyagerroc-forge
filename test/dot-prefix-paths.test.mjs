import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyEdits } from '../src/edit-worker.mjs';
import { openStore } from '../src/store.mjs';
import { Runner } from '../src/runner.mjs';
import { git } from '../src/runner-process.mjs';
import { buildEvidence, verifyEvidence } from '../src/evidence.mjs';

test('ordinary names beginning with two dots can be created and replaced inside the workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge dot prefix '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['..notes.txt', '..drafts/readme.txt', 'src/..notes.txt']) {
    applyEdits(root, [{ path, before: null, after: 'before\n' }]);
    applyEdits(root, [{ path, before: 'before', after: 'after' }]);
    assert.equal(await readFile(join(root, path), 'utf8'), 'after\n');
  }
  for (const path of ['../outside.txt', '..', 'src/../../outside.txt']) {
    assert.throws(() => applyEdits(root, [{ path, before: null, after: 'outside' }]), /Invalid or reserved relative file path/);
  }
});

test('dot-prefix edits produce evidence that can be independently verified', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge dot evidence '));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, '..notes.txt'), 'before\n');
  await git(['init', '--quiet', '-b', 'main'], { cwd: source });
  await git(['add', '--all'], { cwd: source });
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'Fixture'], { cwd: source });
  const store = openStore(':memory:');
  const project = store.connect({ id: -1, full_name: 'local/dot-prefix', html_url: '', description: '', default_branch: 'main', private: false, source_kind: 'local' });
  let task = store.createTask({ projectId: project.id, title: 'Edit notes', intent: 'Keep ordinary dot-prefix names usable', adapter: 'github' });
  for (const status of ['planned', 'in_review', 'approved']) task = store.transition(task.id, task.version, status, { mode: 'dry-run' });
  const runner = new Runner({ store, localRepositories: { 'local/dot-prefix': source } });
  t.after(async () => { await runner.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const run = runner.start(task.id, { version: task.version, edits: [
    { path: '..notes.txt', before: 'before', after: 'after' },
    { path: '..drafts/readme.txt', before: null, after: 'new notes\n' }
  ] });
  await runner.jobs.get(run.id).promise;
  const finished = store.getRun(run.id);
  assert.equal(finished.status, 'passed', finished.summary);
  const verified = await verifyEvidence(buildEvidence(store, run.id), source);
  assert.equal(verified.ok, true, verified.summary);
  assert.equal(verified.counts.mismatch, 0);
  assert.equal(await readFile(join(source, '..notes.txt'), 'utf8'), 'before\n');
  assert.equal((await git(['status', '--porcelain'], { cwd: source })).toString(), '');
});
