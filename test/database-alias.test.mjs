import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-database-alias-'));
  const filename = join(directory, 'original.sqlite');
  const alias = join(directory, 'alias.sqlite');
  const store = openStore(filename);
  const opened = [store];
  t.after(() => {
    for (const item of opened.reverse()) item.close();
    if (existsSync(alias)) unlinkSync(alias);
    rmSync(directory, { recursive: true, force: true });
  });
  try { symlinkSync(filename, alias, 'file'); }
  catch (error) {
    if (!['EPERM', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip('Creating a file symlink is unavailable on this host');
    return null;
  }
  const project = store.connect({ id: 123, full_name: 'fixture/alias', html_url: 'https://github.com/fixture/alias', default_branch: 'main', private: false });
  let task = store.createTask({ projectId: project.id, title: 'Preserve active run', intent: 'A second store must be refused', adapter: 'github' });
  for (const status of ['planned', 'in_review', 'approved']) task = store.transition(task.id, task.version, status, { mode: 'dry-run' });
  const run = store.createRun(task.id, task.version);
  store.startRun(run.id, 'a'.repeat(40));
  return { store, filename, alias, opened, task, run };
}

test('an existing database file alias shares the single-server lock', t => {
  const f = fixture(t);
  if (!f) return;
  let refused;
  try { f.opened.push(openStore(f.alias)); } catch (error) { refused = error; }
  assert.equal(refused?.code, 'FORGE_DB_LOCKED');
  assert.equal(f.store.getRun(f.run.id).status, 'running');
  assert.equal(existsSync(f.alias + '.lock'), false);
  assert.equal(existsSync(f.filename + '.lock'), true);
});

test('a read-only database alias sees committed WAL data without taking the server lock', t => {
  const f = fixture(t);
  if (!f) return;
  const reader = openStore(f.alias, { readOnly: true });
  f.opened.push(reader);
  assert.equal(reader.getRun(f.run.id).status, 'running');
  assert.equal(reader.getTask(f.task.id).title, 'Preserve active run');
  assert.equal(existsSync(f.alias + '.lock'), false);
  assert.equal(existsSync(f.filename + '.lock'), true);
  assert.throws(() => reader.createTask({ projectId: f.task.project_id, title: 'Refuse write', intent: 'read-only', adapter: 'github' }), /readonly/i);
});
