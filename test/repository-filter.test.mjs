import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadApp, all, textOf } from './helpers/fake-dom.mjs';

function fixture() {
  const { context, get } = loadApp();
  const data = {
    projects: ['a', 'b', 'empty'].map(id => ({ id, full_name: `local/${id}`, default_branch: 'main', source_kind: 'local' })),
    tasks: [
      { id: 'a1', project_id: 'a', title: 'A queued', status: 'queued', adapter: 'github', events: [] },
      { id: 'a2', project_id: 'a', title: 'A approved', status: 'approved', adapter: 'github', events: [] },
      { id: 'b1', project_id: 'b', title: 'B queued', status: 'queued', adapter: 'github', events: [] },
    ],
    runs: ['a1', 'a2', 'b1', 'missing-task'].map(task_id => ({ id: `run-${task_id}`, task_id, status: 'passed', summary: 'Static checks passed.', checks: [], created_at: '2026-11-19T10:00:00.000Z', finished_at: '2026-11-19T10:00:01.000Z' })),
    adapters: [{ id: 'github', name: 'GitHub', status: 'metadata-ready', detail: '' }], integration: { github: 'public-read', webhook: false }, pullRequests: [], events: [], runner: null,
  };
  const render = () => { context.payload = data; vm.runInContext('state = payload; render()', context); };
  const select = id => { get('#filter-project').value = id; get('#filter-project').onchange(); };
  const taskTitles = () => all(get('#tasks'), el => el.tagName === 'strong').map(el => el.textContent);
  const heading = () => all(get('#record'), el => el.id === 'workflow-heading')[0]?.textContent;
  render();
  return { data, get, render, select, taskTitles, heading, context };
}

test('repository selection filters the task list and the record; all restores both', () => {
  const f = fixture();
  assert.deepEqual(f.taskTitles(), ['A queued', 'A approved', 'B queued']);
  f.select('a');
  assert.deepEqual(f.taskTitles(), ['A queued', 'A approved']);
  assert.equal(f.heading(), 'A queued');
  f.select('b');
  assert.deepEqual(f.taskTitles(), ['B queued']);
  assert.equal(f.heading(), 'B queued');
  f.select('all');
  assert.equal(f.taskTitles().length, 3);
});

test('a repository without matching work has a scoped empty record', () => {
  const f = fixture(); f.select('empty');
  assert.deepEqual(f.taskTitles(), []);
  assert.match(textOf(f.get('#tasks')), /No tasks for this repository\./);
  assert.match(textOf(f.get('#record')), /No tasks for this repository yet\./);
  assert.equal(f.heading(), 'A change that carries its own proof.');
});

test('choosing a task in the list shows its record and marks it current', () => {
  const f = fixture(); f.select('a');
  const buttons = all(f.get('#tasks'), el => el.tagName === 'button');
  assert.equal(buttons[0].getAttribute('aria-current'), 'true');
  assert.equal(buttons[1].getAttribute('aria-current'), null);
  buttons[1].onclick();
  assert.equal(f.heading(), 'A approved');
  const again = all(f.get('#tasks'), el => el.tagName === 'button');
  assert.equal(again[1].getAttribute('aria-current'), 'true');
});

test('refresh retains a valid filter and the option elements', () => {
  const f = fixture(); f.select('a');
  const option = f.get('#filter-project').options[1];
  f.data.runs.push({ id: 'new-run', task_id: 'a1', status: 'passed', checks: [], created_at: '2026-11-19T10:05:00.000Z', finished_at: '2026-11-19T10:05:01.000Z' });
  f.render();
  assert.equal(f.get('#filter-project').value, 'a');
  assert.equal(f.get('#filter-project').options[1], option);
  assert.deepEqual(f.taskTitles(), ['A queued', 'A approved']);
});

test('a removed selection falls back to all repositories', () => {
  const f = fixture(); f.select('a');
  f.data.projects = f.data.projects.filter(project => project.id !== 'a');
  f.data.tasks = f.data.tasks.filter(task => task.project_id !== 'a');
  f.render();
  assert.equal(f.get('#filter-project').value, 'all');
  assert.deepEqual(f.taskTitles(), ['B queued']);
});

test('filtering and refresh preserve the independent task creation selection', () => {
  const f = fixture(); f.get('#project').value = 'b';
  f.select('a'); f.render();
  assert.equal(f.get('#project').value, 'b');
  assert.deepEqual(f.get('#project').options.map(option => option.value), ['a', 'b', 'empty']);
});
