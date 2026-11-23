import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEdits, validateEdits } from '../src/edit-worker.mjs';

async function workspace(t, content) {
  const root = await mkdtemp(join(tmpdir(), 'forge edit worker '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'file.txt'), content);
  return root;
}

test('before text that matches at overlapping positions is rejected and the file is unchanged', async t => {
  const root = await workspace(t, 'aaa');
  assert.throws(() => applyEdits(root, [{ path: 'file.txt', before: 'aa', after: 'b' }]), /Before text must match exactly once: file\.txt/);
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'aaa');
});

test('before text that matches once is replaced', async t => {
  const root = await workspace(t, 'one two three');
  applyEdits(root, [{ path: 'file.txt', before: 'two', after: '2' }]);
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'one 2 three');
});

test('before text that matches twice without overlap is still rejected', async t => {
  const root = await workspace(t, 'ab ab');
  assert.throws(() => applyEdits(root, [{ path: 'file.txt', before: 'ab', after: 'c' }]), /Before text must match exactly once/);
});

test('before text that does not match is rejected', async t => {
  const root = await workspace(t, 'abc');
  assert.throws(() => applyEdits(root, [{ path: 'file.txt', before: 'xyz', after: 'q' }]), /Before text must match exactly once/);
});

test('an empty before string is rejected during validation, before the file is read', async t => {
  const root = await workspace(t, 'abc');
  assert.throws(() => applyEdits(root, [{ path: 'file.txt', before: '', after: 'x' }]), /nonempty before string/);
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'abc');
});

test('short-name-shaped segments are rejected before any edit is written', async t => {
  const root = await workspace(t, 'unchanged');
  for (const path of ['GIT~1', 'PROGRA~1', 'FILE~1.TXT', 'a~12', 'src/GIT~1/config', 'src/giT~12/config']) {
    assert.throws(() => applyEdits(root, [
      { path: 'file.txt', before: 'unchanged', after: 'changed' },
      { path, before: null, after: 'new content' }
    ]), /Invalid or reserved relative file path/, path);
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'unchanged');
  }
});

test('other tilde names remain valid edit paths', () => {
  for (const path of ['file~backup.txt', 'a~b.md', 'tilde~.txt', 'longer-name~1.md', 'src/file~backup.txt']) {
    assert.deepEqual(validateEdits([{ path, before: null, after: 'new content' }]),
      [{ path, before: null, after: 'new content' }]);
  }
});
