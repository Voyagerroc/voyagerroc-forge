import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { openStore } from '../src/store.mjs';
import { adapters } from '../src/adapters.mjs';
import { Runner } from '../src/runner.mjs';
import { loadApp, all, textOf } from './helpers/fake-dom.mjs';

const PATCH = 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n';
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const project = store.connect({ id: -1, full_name: 'local/retry-fixture', html_url: '', default_branch: 'main', source_kind: 'local' });
  let task = store.createTask({ projectId: project.id, title: 'Review the patch', intent: 'Retry a failed detail request', adapter: 'github' });
  for (const status of ['planned', 'in_review', 'approved']) task = store.transition(task.id, task.version, status, { steps: [], gates: [] });
  const pending = store.createRun(task.id, task.version);
  const detail = store.finishRun(pending.id, { status: 'passed', summary: 'Fixture patch', patch: PATCH });
  const requests = [];
  const app = loadApp({ extra: { fetch: path => new Promise(resolve => {
    if (path !== '/api/state') requests.push({ path, resolve });
  }) } });
  app.context.payload = {
    ...store.snapshot(), adapters, pullRequests: [],
    integration: { github: 'public-read', webhook: false },
    runner: new Runner({ store }).capabilities(),
  };
  const render = () => vm.runInContext('state = payload; render()', app.context);
  render();
  return { ...app, detail, requests, render, record: () => app.get('#record') };
}

const retryButton = f => all(f.record(), el => el.tagName === 'button' && el.textContent === 'Retry loading patch')[0];
const fail = async request => { request.resolve({ ok: false, json: async () => ({ error: 'Temporarily unavailable' }) }); await flush(); };

test('a failed patch request can be retried and then remains cached after success', async t => {
  const f = fixture(t);
  assert.equal(f.requests.length, 1);
  await fail(f.requests[0]);
  assert.match(textOf(f.record()), /Temporarily unavailable/);
  for (let i = 0; i < 3; i++) f.render();
  assert.equal(f.requests.length, 1, 'rendering an error must not start an automatic retry loop');
  const retry = retryButton(f);
  assert.ok(retry, 'the patch error needs an operable retry action');
  retry.focus();
  retry.onclick();
  retry.onclick();
  assert.equal(f.requests.length, 2, 'repeated activation must not duplicate an in-flight request');
  assert.match(textOf(f.record()), /Loading the patch/);
  assert.equal(f.document.activeElement.id, `sec-patch-${f.detail.id}`);
  f.requests[1].resolve({ ok: true, json: async () => f.detail });
  await flush();
  assert.match(textOf(f.record()), /Download patch/);
  assert.match(textOf(f.record()), /after/);
  assert.equal(retryButton(f), undefined);
  assert.equal(f.document.activeElement.id, `sec-patch-${f.detail.id}`);
  f.render();
  assert.equal(f.requests.length, 2);
});

test('a retry that also fails leaves a new retry action without background requests', async t => {
  const f = fixture(t);
  await fail(f.requests[0]);
  const retry = retryButton(f);
  assert.ok(retry);
  retry.onclick();
  await fail(f.requests[1]);
  assert.ok(retryButton(f));
  f.render();
  assert.equal(f.requests.length, 2);
  assert.match(textOf(f.record()), /Temporarily unavailable/);
});
