import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture() {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; }
    get value() { return this._value ?? (this.tagName === 'select' ? this.children[0]?.value : this.textContent) ?? ''; }
    set value(value) { this._value = String(value); }
    get options() { return this.children; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; if (this.tagName === 'select') this._value = children[0]?.value ?? ''; }
  }
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element(['#project', '#filter-project'].includes(selector) ? 'select' : 'div'));
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: get, createElement: tag => new Element(tag) },
    fetch: () => new Promise(() => {}), setInterval: () => {},
  });
  vm.runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  const data = {
    projects: ['a', 'b', 'empty'].map(id => ({ id, full_name: `local/${id}`, default_branch: 'main', source_kind: 'local' })),
    tasks: [
      { id: 'a1', project_id: 'a', title: 'A queued', status: 'queued', adapter: 'github' },
      { id: 'a2', project_id: 'a', title: 'A approved', status: 'approved', adapter: 'github' },
      { id: 'b1', project_id: 'b', title: 'B queued', status: 'queued', adapter: 'github' },
    ],
    runs: ['a1', 'a2', 'b1', 'missing-task'].map(task_id => ({ id: `run-${task_id}`, task_id, status: 'passed', summary: 'Static checks passed.' })),
    adapters: [], integration: { github: 'public-read', webhook: false }, pullRequests: [], events: [],
  };
  const render = () => { context.payload = data; vm.runInContext('state = payload; render()', context); };
  const select = id => { get('#filter-project').value = id; get('#filter-project').onchange(); };
  function texts(selector, tag) {
    const collect = node => [...(node.tagName === tag ? [node.textContent] : []), ...node.children.flatMap(collect)];
    return collect(get(selector));
  }
  render();
  return { data, get, render, select, texts };
}

test('repository selection filters board counts and run history together; all restores both', () => {
  const f = fixture();
  f.select('a');
  assert.deepEqual(f.texts('#board', 'h4'), ['A queued', 'A approved']);
  assert.deepEqual(f.texts('#board', 'h3'), ['Queued  1', 'Planned  0', 'In review  0', 'Approved  1']);
  assert.deepEqual(f.texts('#runs', 'h3'), ['A queued', 'A approved']);
  f.select('all');
  assert.equal(f.texts('#board', 'h4').length, 3);
  assert.deepEqual(f.texts('#runs', 'h3'), ['A queued', 'A approved', 'B queued', 'missing-task']);
});

test('a repository without matching work has a scoped empty history', () => {
  const f = fixture(); f.select('empty');
  assert.deepEqual(f.texts('#board', 'h4'), []);
  assert.deepEqual(f.texts('#runs', 'h3'), []);
  assert.deepEqual(f.texts('#runs', 'p'), ['No runs for this repository.']);
});

test('refresh retains a valid filter and includes newly returned matching runs', () => {
  const f = fixture(); f.select('a');
  const option = f.get('#filter-project').options[1];
  f.data.runs.push({ id: 'new-run', task_id: 'a1', status: 'passed' });
  f.render();
  assert.equal(f.get('#filter-project').value, 'a');
  assert.equal(f.get('#filter-project').options[1], option);
  assert.deepEqual(f.texts('#runs', 'h3'), ['A queued', 'A approved', 'A queued']);
});

test('a removed selection falls back to all repositories', () => {
  const f = fixture(); f.select('a');
  f.data.projects = f.data.projects.filter(project => project.id !== 'a');
  f.render();
  assert.equal(f.get('#filter-project').value, 'all');
  assert.equal(f.texts('#runs', 'h3').length, 4);
});

test('filtering and refresh preserve the independent task creation selection', () => {
  const f = fixture(); f.get('#project').value = 'b';
  f.select('a'); f.render();
  assert.equal(f.get('#project').value, 'b');
  assert.deepEqual(f.get('#project').options.map(option => option.value), ['a', 'b', 'empty']);
});
