import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadApp } from './helpers/fake-dom.mjs';

function fixture() {
  const requests = [];
  const app = loadApp({ extra: {
    fetch: url => new Promise(resolve => requests.push({ url, resolve })),
    FormData: class { constructor(form) { return form.fields; } }
  } });
  const task = (id, project_id) => ({ id, project_id, title: `Task ${id}`, intent: 'Inspect recorded evidence.',
    adapter: 'github', status: 'approved', version: 3, plan: { steps: [], gates: [] }, events: [] });
  const run = (id, time) => ({ id, task_id: 'a', status: 'failed', has_patch: false,
    summary: `Recorded failure ${id}`, created_at: time, finished_at: time, checks: [] });
  const data = {
    projects: ['p', 'q'].map(id => ({ id, full_name: `local/${id}`, default_branch: 'main', source_kind: 'local' })),
    tasks: [task('a', 'p'), task('b', 'p'), task('c', 'q')],
    runs: [run('r1', '2026-11-19T14:10:41Z'), run('r2', '2026-11-19T14:10:43Z')],
    adapters: [{ id: 'github', name: 'GitHub', status: 'metadata-ready' }],
    integration: { github: 'public-read', webhook: false }, pullRequests: [], events: [],
    runner: { projectTests: false, active: 0, timeoutMs: 60000, limits: {
      snapshot: { minFiles: 1, maxFiles: 10, maxFileBytes: 1024, maxBytes: 4096 },
      edits: { minCount: 1, maxCount: 5, maxTextBytes: 2048 }
    } }
  };
  app.context.payload = data;
  const evaluate = code => vm.runInContext(code, app.context);
  evaluate('state = payload; render()');
  const focusId = () => app.document.activeElement?.id;
  return {
    ...app, data, requests, evaluate, focusId,
    select(id) {
      const button = app.document.getElementById(`task-select-${id}`);
      button.focus(); button.onclick();
    },
    filter(id) {
      const select = app.get('#filter-project');
      select.id = 'filter-project'; select.focus(); select.value = id; select.onchange();
    },
    show(id) {
      const done = evaluate(`showResult(${JSON.stringify(id)})`);
      const request = requests.at(-1);
      assert.equal(request.url, `/api/runs/${id}`);
      return {
        async finish(error) {
          request.resolve({ ok: !error, json: async () => error ? { error } : {
            ...data.runs.find(run => run.id === id), patch: ''
          } });
          await done;
        }
      };
    }
  };
}

test('a late run response keeps a subsequently selected task and its keyboard focus', async () => {
  const f = fixture();
  const pending = f.show('r1');
  f.select('b');
  await pending.finish();
  assert.equal(f.evaluate('selectedTaskId'), 'b');
  assert.equal(f.focusId(), 'task-select-b');
  assert.equal(f.evaluate("openRuns.has('r1')"), false);
});

test('leaving and returning to the same task still supersedes a pending run navigation', async () => {
  const f = fixture();
  const pending = f.show('r1');
  f.select('b'); f.select('a');
  await pending.finish();
  assert.equal(f.evaluate('selectedTaskId'), 'a');
  assert.equal(f.focusId(), 'task-select-a');
  assert.equal(f.evaluate("openRuns.has('r1')"), false);
});

test('changing the repository filter and returning preserves the newer filter focus', async () => {
  const f = fixture();
  const pending = f.show('r1');
  f.filter('q'); f.filter('p');
  await pending.finish();
  assert.equal(f.evaluate('selectedProjectId'), 'p');
  assert.equal(f.focusId(), 'filter-project');
  assert.equal(f.evaluate("openRuns.has('r1')"), false);
});

test('run links resolved in reverse order keep the most recently requested run focused', async () => {
  const f = fixture();
  const older = f.show('r1');
  const newer = f.show('r2');
  await newer.finish();
  assert.equal(f.focusId(), 'run-r2');
  await older.finish();
  assert.equal(f.focusId(), 'run-r2');
  assert.equal(f.evaluate("openRuns.has('r1')"), false);
});

test('an obsolete run error does not replace a newer navigation message', async () => {
  const f = fixture();
  const pending = f.show('r1');
  f.select('b');
  f.get('#message').textContent = 'Current task message';
  await pending.finish('The old request failed');
  assert.equal(f.get('#message').textContent, 'Current task message');
  assert.equal(f.focusId(), 'task-select-b');
});

test('a late run response does not undo navigation to a newly created task', async () => {
  const f = fixture();
  const pending = f.show('r1');
  const created = { ...f.data.tasks[0], id: 'new-task', title: 'New task', status: 'queued' };
  f.get('#task-form').onsubmit({ preventDefault() {}, submitter: f.get('#create-task'),
    target: { fields: [['project_id', 'p'], ['title', 'New task']], reset() {} } });
  const creation = f.requests.at(-1);
  assert.equal(creation.url, '/api/tasks');
  f.data.tasks.unshift(created);
  creation.resolve({ ok: true, json: async () => created });
  await new Promise(setImmediate);
  const refresh = f.requests.at(-1);
  assert.equal(refresh.url, '/api/state');
  refresh.resolve({ ok: true, json: async () => f.data });
  await new Promise(setImmediate);
  assert.equal(f.evaluate('selectedTaskId'), created.id);
  await pending.finish();
  assert.equal(f.evaluate('selectedTaskId'), created.id);
});

test('a current run request still reports an error', async () => {
  const f = fixture();
  await f.show('r1').finish('Evidence is temporarily unavailable');
  assert.equal(f.get('#message').textContent, 'Evidence is temporarily unavailable');
});

test('a current run request still opens and focuses its evidence after a passive refresh', async () => {
  const f = fixture();
  const pending = f.show('r1');
  f.data.tasks[1].title = 'Updated by a state refresh';
  f.evaluate('applyState(payload)');
  await pending.finish();
  assert.equal(f.evaluate('selectedTaskId'), 'a');
  assert.equal(f.evaluate("openRuns.has('r1')"), true);
  assert.equal(f.focusId(), 'run-summary-r1');
});
