import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadApp, all, withClass, textOf } from './helpers/fake-dom.mjs';

const BASE = '67c3d0c50c5cc98085d89fcd43a6e98520c3fb0a';
const PATCH_HASH = '8fef16c87de2f20a07bc311f9d8d4056790e485ae1942967573b879e32d90234';
const PATCH = 'diff --git a/hello.mjs b/hello.mjs\nindex d720ce4..72a84de 100644\n--- a/hello.mjs\n+++ b/hello.mjs\n@@ -1,2 +1,2 @@\n context line\n-export const greeting = "helo";\n+export const greeting = "hello";\n';
const check = (name, detail = 'ok', status = 'passed') => ({ name, status, detail });
const state = () => ({
  projects: [{ id: 'p', full_name: 'local/runner-demo', default_branch: 'main', source_kind: 'local' }],
  tasks: [{
    id: 't', project_id: 'p', title: 'Fix the greeting typo', intent: 'Change the greeting.', adapter: 'github', status: 'approved', version: 3,
    plan: { steps: [{ stage: 'context', action: 'Resolve.' }], gates: ['No automatic merge'] }, created_at: '2026-11-19T14:10:35.265Z',
    events: [
      { id: 1, kind: 'task.created', created_at: '2026-11-19T14:10:35.265Z', run_id: null }, { id: 2, kind: 'task.planned', created_at: '2026-11-19T14:10:36.000Z', run_id: null },
      { id: 3, kind: 'task.in_review', created_at: '2026-11-19T14:10:38.000Z', run_id: null }, { id: 4, kind: 'task.approved', created_at: '2026-11-19T14:10:39.841Z', run_id: null },
    ],
  }],
  runs: [
    { id: 'r2', task_id: 't', status: 'passed', base_sha: BASE, patch_sha256: PATCH_HASH, has_patch: true, summary: 'Scoped edits and static checks passed. Project tests were not run.', created_at: '2026-11-19T14:10:43.966Z', finished_at: '2026-11-19T14:10:44.580Z',
      checks: [check('edit:hello.mjs', 'sha256:' + '0'.repeat(64)), check('conflicts:hello.mjs', 'No conflict markers'), check('syntax:hello.mjs', 'Node syntax check passed; source was not executed'), check('diff-whitespace', 'No whitespace errors')] },
    { id: 'r1', task_id: 't', status: 'failed', base_sha: BASE, patch_sha256: null, has_patch: false, summary: 'Before text must match exactly once: hello.mjs', created_at: '2026-11-19T14:10:41.369Z', finished_at: '2026-11-19T14:10:42.014Z', checks: [] },
  ],
  adapters: [{ id: 'github', name: 'GitHub', status: 'metadata-ready', detail: '' }], integration: { github: 'public-read', webhook: false }, pullRequests: [], events: [],
  runner: { projectTests: false, active: 0, timeoutMs: 60000, limits: { snapshot: { minFiles: 1, maxFiles: 10, maxFileBytes: 1024, maxBytes: 4096 }, edits: { minCount: 1, maxCount: 5, maxTextBytes: 2048 } } },
});
function open(data = state()) {
  const app = loadApp();
  app.context.payload = data;
  vm.runInContext('state = payload; render()', app.context);
  // Patches come from /api/runs/<id>; supply the finished render with its patch.
  return { ...app, data, rerender: () => vm.runInContext('render()', app.context), record: () => app.get('#record') };
}
const cells = record => all(record, el => el.tagName === 'a' && el.className === 'cell').map(textOf);

test('the evidence summary has four plain cells linking to their sections, from real values only', () => {
  const f = open();
  assert.deepEqual(cells(f.record()), [
    'Source e7473d7f…'.length ? `Source ${BASE.slice(0, 8)}…${BASE.slice(-7)} local/runner-demo` : '',
    `Patch ${PATCH_HASH.slice(0, 8)}…${PATCH_HASH.slice(-7)} SHA-256`,
    'Checks 4 passed, 1 not run Static checks only',
    `Approval Plan approved ${all(f.record(), el => el.className === 'cell').at(-1).children.at(-1).textContent}`,
  ]);
  const links = all(f.record(), el => el.className === 'cell').map(el => el.href);
  assert.deepEqual(links, ['#sec-source-r2', '#sec-patch-r2', '#sec-checks-r2', '#sec-approvals']);
});

test('the trail lists recorded events newest first with one D section', () => {
  const f = open();
  const letters = withClass(f.record(), 'exh-letter').map(el => el.textContent);
  assert.deepEqual(letters, ['A', 'B', 'C', 'D']);
  const times = all(f.record(), el => el.tagName === 'time' && el.dateTime).map(el => el.dateTime);
  const sorted = [...times].sort().reverse();
  assert.deepEqual(times, sorted);
  assert.equal(times.length, 8);
  assert.match(textOf(f.record()), /Earlier in this record: 2 events/);
  const earlier = all(f.record(), el => el.id === 'earlier-events')[0];
  assert.equal(earlier.open, false);
});

test('a failed run stays in the record with its message, no patch and no hash', () => {
  const f = open();
  const text = textOf(f.record());
  assert.match(text, /Run 1 · kept as recorded/);
  assert.match(text, /Before text must match exactly once: hello\.mjs/);
  assert.match(text, /No patch produced\./);
  assert.match(text, /Patch SHA-256 not available/);
  assert.match(text, /How to fix .* Run 2 corrected this\./);
});

test('every hash has a copy button with an accessible name', () => {
  const f = open();
  const names = all(f.record(), el => el.tagName === 'button' && el.textContent === 'Copy').map(el => el.getAttribute('aria-label'));
  assert.ok(names.includes('Copy pinned commit') && names.includes('Copy patch SHA-256'), names.join());
  const hash = all(f.record(), el => String(el.className).includes('hash') && el.tagName === 'span' && el.className === 'hash mono')[0];
  assert.equal(textOf(hash).replace(/ /g, ''), BASE);
});

test('copy announces Copied through the status region and survives a missing clipboard', async () => {
  const written = [];
  const app = loadApp({ extra: { navigator: { clipboard: { writeText: async value => { written.push(value); } } } } });
  app.context.payload = state(); vm.runInContext('state = payload; render()', app.context);
  const button = all(app.get('#record'), el => el.tagName === 'button' && el.getAttribute('aria-label') === 'Copy patch SHA-256')[0];
  await button.onclick();
  assert.deepEqual(written, [PATCH_HASH]);
  assert.equal(app.get('#message').textContent, 'Copied');
  const bare = open();
  const again = all(bare.record(), el => el.tagName === 'button' && el.getAttribute('aria-label') === 'Copy pinned commit')[0];
  await again.onclick();
  assert.match(bare.get('#message').textContent, /Copy failed/);
});

test('a field that is not recorded shows not available', () => {
  const data = state(); data.tasks[0].events = []; data.runs = [];
  const f = open(data);
  const text = textOf(f.record());
  assert.match(cells(f.record()).join('|'), /Source not available Pinned when a run starts\|Patch not available SHA-256\|Checks not available Static checks only\|Approval Not approved/);
  assert.match(text, /No approval has been recorded yet\./);
  assert.equal(all(f.record(), el => el.id === 'earlier-events')[0].open, true);
});

test('running and cancelled runs show a state word, not a patch', () => {
  const data = state(); data.runs = [{ ...data.runs[0], id: 'r3', status: 'running', finished_at: null, patch_sha256: null, has_patch: false, checks: [], summary: '' }];
  const f = open(data);
  const text = textOf(f.record());
  assert.match(text, /Running/);
  assert.match(text, /Preparing a pinned source snapshot…/);
  assert.equal(f.record().getAttribute('aria-busy'), 'true');
  assert.ok(all(f.record(), el => el.tagName === 'button' && el.textContent === 'Cancel run').length === 1);
  data.runs[0].status = 'cancelled'; data.runs[0].finished_at = '2026-11-19T14:10:50.000Z'; f.rerender();
  assert.match(textOf(f.record()), /Cancelled/);
  assert.equal(f.record().getAttribute('aria-busy'), null);
});

test('next-step buttons keep their names and the approved task offers a run', () => {
  const data = state();
  for (const [status, label] of [['queued', 'Generate plan'], ['planned', 'Request review'], ['in_review', 'Approve plan'], ['approved', 'Run scoped edits']]) {
    data.tasks[0].status = status;
    const f = open(JSON.parse(JSON.stringify(data)));
    const names = all(f.record(), el => el.tagName === 'button').map(el => el.textContent);
    assert.ok(names.includes(label), `${status}: ${names}`);
    assert.ok(names.includes('View plan'));
  }
});

test('the diff keeps line numbers, a sign column and sign words', () => {
  const { context } = loadApp();
  const files = vm.runInContext(`patchFiles(${JSON.stringify(PATCH)})`, context);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'hello.mjs');
  assert.deepEqual([files[0].added, files[0].removed], [1, 1]);
  const rows = [...files[0].rows].filter(row => row.type !== 'meta').map(row => [row.type, row.old, row.neu, row.text]);
  assert.deepEqual(rows, [['ctx', 1, 1, 'context line'], ['del', 2, undefined, 'export const greeting = "helo";'], ['add', undefined, 2, 'export const greeting = "hello";']]);
  const two = vm.runInContext(`patchFiles(${JSON.stringify(PATCH + 'diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+x\n')})`, context);
  assert.deepEqual([...two].map(file => file.path), ['hello.mjs', 'b.txt']);
});

test('invalid edits are explained with line, column and a caret', () => {
  const { context } = loadApp();
  const diagnose = text => vm.runInContext(`diagnoseEdits(${JSON.stringify(text)})`, context);
  const comma = diagnose('[\n  {"path":"a","before":"x","after":"y"},\n]');
  assert.match(comma.message, /Trailing comma at line 2, column 40/);
  assert.equal(comma.caret.length, 17);
  assert.equal(comma.line[comma.caret.length - 1], ",");
  assert.match(diagnose('[{"path": }]').message, /not valid JSON near line 1, column \d+/);
  assert.match(diagnose('').message, /Nothing to run yet/);
  assert.match(diagnose('[]').message, /at least one item/);
  assert.match(diagnose('[{"path":"a"}]').message, /Edit 1 needs/);
  assert.equal(diagnose('[{"path":"a","before":null,"after":"y"}]'), null);
});

test('the interface stays inside the page contract', () => {
  const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
  const html = read('index.html'), js = read('app.js'), css = (read('style.css') + read('runner.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.doesNotMatch(html, /\sstyle=|<style|onclick=|<script(?![^>]*\ssrc=)/i);
  assert.doesNotMatch(html + js + css, /data:|https?:\/\/(?!127\.0\.0\.1)/);
  assert.doesNotMatch(css, /@font-face|@import|url\(/);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px/);
  assert.match(html, /<a class="skip" href="#record">/);
  assert.match(html, /<main id="record" tabindex="-1"/);
  assert.match(html, /id="edits-error" role="alert"/);
  assert.match(html, /<p id="message" role="status" aria-live="polite">/);
  assert.match(html, /aria-describedby="runner-limits run-check-scope edits-error"/);
  assert.doesNotMatch(js, /\b(?:agent-based|AI-powered|sandbox|SaaS|tamper-proof|verified by)\b/i);
});
