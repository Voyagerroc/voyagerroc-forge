import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadApp, textOf } from './helpers/fake-dom.mjs';

function snapshot(title, status = 'running') {
  return {
    projects: [{ id: 'p', full_name: 'local/refresh-demo', default_branch: 'main', source_kind: 'local' }],
    tasks: [{ id: 't', project_id: 'p', title, intent: 'Keep the latest state.', adapter: 'github', status: 'approved', version: 3,
      created_at: '2026-11-20T12:00:00Z', events: [], plan: { steps: [], gates: [] } }],
    runs: [{ id: 'r', task_id: 't', status, created_at: '2026-11-20T12:01:00Z', finished_at: status === 'running' ? null : '2026-11-20T12:02:00Z',
      checks: [], has_patch: false, summary: '' }],
    adapters: [{ id: 'github', name: 'GitHub', status: 'metadata-ready' }],
    integration: { github: 'public-read' }, pullRequests: [], events: [], runner: null
  };
}

function fixture() {
  const requests = [];
  let poll;
  const app = loadApp({ extra: {
    fetch: url => {
      assert.equal(url, '/api/state');
      return new Promise((resolve, reject) => requests.push({
        respond: value => resolve({ ok: true, json: async () => value }), reject
      }));
    },
    setInterval: callback => { poll = callback; }
  } });
  return { ...app, requests, poll: () => poll(), refresh: () => vm.runInContext('refresh()', app.context) };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a delayed initial state cannot replace a newer successful refresh', async () => {
  const f = fixture();
  const newer = f.refresh();
  f.requests[1].respond(snapshot('Current task', 'passed'));
  await newer;
  f.requests[0].respond(snapshot('Old task'));
  await tick();
  assert.match(textOf(f.get('#record')), /Current task/);
  assert.doesNotMatch(textOf(f.get('#record')), /Old task/);
  assert.notEqual(f.get('#record').getAttribute('aria-busy'), 'true');
});

test('an older poll cannot turn a finished run back into a running run', async () => {
  const f = fixture();
  f.requests[0].respond(snapshot('Running task'));
  await tick();
  const older = f.poll();
  const newer = f.poll();
  f.requests[2].respond(snapshot('Completed task', 'passed'));
  await newer;
  f.requests[1].respond(snapshot('Running task'));
  await older;
  assert.match(textOf(f.get('#record')), /Completed task/);
  assert.notEqual(f.get('#record').getAttribute('aria-busy'), 'true');
});

test('an obsolete request failure cannot overwrite a successful refresh message', async () => {
  const f = fixture();
  const newer = f.refresh();
  f.requests[1].respond(snapshot('Current task', 'passed'));
  await newer;
  f.get('#message').textContent = 'Current operation completed.';
  f.requests[0].reject(new Error('Old request failed'));
  await tick();
  assert.equal(f.get('#message').textContent, 'Current operation completed.');
  assert.match(textOf(f.get('#record')), /Current task/);
});

test('a failed newer refresh does not discard an older successful initial response', async () => {
  const f = fixture();
  const newer = f.refresh();
  f.requests[1].reject(new Error('Current request failed'));
  await assert.rejects(newer, /Current request failed/);
  f.requests[0].respond(snapshot('Available task'));
  await tick();
  assert.match(textOf(f.get('#record')), /Available task/);
});

test('a delayed initial error cannot replace a newer refresh error', async () => {
  const f = fixture();
  const newer = vm.runInContext('refresh().catch(error => message(error.message))', f.context);
  f.requests[1].reject(new Error('Current request failed'));
  await newer;
  f.requests[0].reject(new Error('Old request failed'));
  await tick();
  assert.equal(f.get('#message').textContent, 'Current request failed');
});

test('poll errors keep the newest diagnostic and allow later errors', async () => {
  const f = fixture();
  f.requests[0].respond(snapshot('Running task'));
  await tick();
  const older = f.poll();
  const newer = f.poll();
  f.requests[2].reject(new Error('Current poll failed'));
  await newer;
  f.requests[1].reject(new Error('Old poll failed'));
  await older;
  assert.equal(f.get('#message').textContent, 'Current poll failed');
  const latest = f.poll();
  f.requests[3].reject(new Error('Latest poll failed'));
  await latest;
  assert.equal(f.get('#message').textContent, 'Latest poll failed');
});
