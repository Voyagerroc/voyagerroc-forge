import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { loadApp, all } from './helpers/fake-dom.mjs';

function fixture() {
  const clicks = [], blobs = [], revoked = [], timers = [];
  const { context, document } = loadApp({ extra: {
    Blob,
    URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:local-patch'; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
  } });
  // Downloads create a temporary link; record its click instead of navigating.
  const createElement = document.createElement;
  document.createElement = tag => {
    const el = createElement(tag);
    if (tag === 'a') el.click = function () { clicks.push({ href: this.href, filename: this.download, attached: this.parentElement === document.body }); };
    return el;
  };
  const project = { id: 'p', full_name: 'local/demo', default_branch: 'main', source_kind: 'local' };
  const task = { id: 't', project_id: 'p', title: 'Task', intent: 'Do it', status: 'approved', adapter: 'github', version: 3, events: [] };
  // Show the evidence of one run: state from /api/state, patch from /api/runs/<id>.
  async function show(result) {
    const run = { id: result.id, task_id: 't', status: result.status, base_sha: 'a'.repeat(40), patch_sha256: 'b'.repeat(64), checks: [], summary: '', has_patch: Boolean(result.patch), created_at: '2026-11-19T10:00:00.000Z', finished_at: result.status === 'running' || result.status === 'preparing' ? null : '2026-11-19T10:00:01.000Z' };
    context.payload = { projects: [project], tasks: [task], runs: [run], adapters: [], integration: { github: 'public-read', webhook: false }, pullRequests: [], events: [], runner: null };
    vm.runInContext('state = payload', context);
    context.fetch = async () => ({ ok: true, json: async () => ({ checks: [], task_id: 't', ...result }) });
    await context.showResult(result.id);
    return all(document.querySelector('#record'), el => el.tagName === 'button' && el.textContent === 'Download patch')[0];
  }
  return { context, document, show, clicks, blobs, revoked, timers };
}

for (const patch of ['--- a/file\n+++ b/file\n+hello\n', '--- a/file\r\n+++ b/file\r\n+你好 <script>&\r\n', '+no final newline']) {
  test(`download preserves exact UTF-8 bytes: ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    const button = await f.show({ id: 'test-run_1', status: 'passed', patch });
    assert.equal(button.textContent, 'Download patch');
    assert.equal(button.type, 'button');
    button.onclick();
    const bytes = Buffer.from(await f.blobs[0].arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(patch, 'utf8'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(patch).digest('hex'));
    assert.deepEqual(f.clicks, [{ href: 'blob:local-patch', filename: 'forge-test-run_1.patch', attached: true }]);
    assert.equal(f.document.body.children.length, 0);
    assert.deepEqual(f.revoked, []);
    assert.equal(f.timers.length, 1);
    assert.ok(f.timers[0].delay > 0);
    f.timers[0].callback();
    assert.deepEqual(f.revoked, ['blob:local-patch']);
  });
}

test('download filename is bounded and contains no path separators', () => {
  const f = fixture();
  f.context.downloadPatch({ id: '../../' + 'x'.repeat(200) + '\\secret', patch: '+example\n' });
  assert.match(f.clicks[0].filename, /^forge-[a-zA-Z0-9_-]{1,64}\.patch$/);
});

test('no stale download action for empty or still-running evidence', async () => {
  const f = fixture();
  for (const result of [
    { status: 'failed', patch: '' }, { status: 'cancelled', patch: null },
    { status: 'running', patch: '+partial\n' }, { status: 'preparing', patch: '+partial\n' },
  ]) {
    assert.ok(await f.show({ id: 'finished-run', status: 'passed', patch: '+done\n' }));
    assert.equal(await f.show({ id: 'next-run', ...result }), undefined);
  }
  assert.equal(f.blobs.length, 0);
});
