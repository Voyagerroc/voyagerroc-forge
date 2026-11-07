import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function fixture() {
  const clicks = [], blobs = [], revoked = [], timers = [];
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; }
    append(...children) {
      children.forEach(child => { child.parentElement = this; this.children.push(child); });
    }
    replaceChildren(...children) { this.children.forEach(child => child.parentElement = null); this.children = []; this.append(...children); }
    before(child) { child.parentElement = this.parentElement; this.parentElement.children.splice(this.parentElement.children.indexOf(this), 0, child); }
    remove() { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    click() { clicks.push({ href: this.href, filename: this.download, attached: this.parentElement === document.body }); }
    showModal() { this.open = true; }
  }
  const elements = new Map();
  const document = {
    body: new Element('body'), activeElement: null,
    createElement: tag => new Element(tag),
    querySelector: selector => {
      if (!elements.has(selector)) elements.set(selector, new Element('div'));
      return elements.get(selector);
    },
  };
  const context = vm.createContext({
    document, Blob,
    URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:local-patch'; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout: (callback, delay) => timers.push({ callback, delay }), setInterval: () => {},
    // Keep startup refresh pending; each test supplies only its evidence response.
    fetch: () => new Promise(() => {}),
  });
  vm.runInContext(source, context);
  async function show(result) {
    context.fetch = async () => ({ ok: true, json: async () => ({ checks: [], ...result }) });
    await context.showResult(result.id);
    return document.querySelector('#run-detail').children.find(el => el.tagName === 'button');
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
