import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadApp, all, withClass, textOf } from './helpers/fake-dom.mjs';
import { adapters, buildPlan } from '../src/adapters.mjs';

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

const SIGNED_SENTENCE = 'The record is local and its hashes are not signed.';
const readPublic = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

// Minimal stylesheet reader: every rule, with the media block it sits in, and its declarations.
function cssRules(css, media = '') {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = []; let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i); if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
    const block = text.slice(open + 1, j - 1);
    if (/^@(media|supports)/.test(prelude)) rules.push(...cssRules(block, `${media} ${prelude}`.trim()));
    else if (!prelude.startsWith('@')) rules.push({ media, selectors: prelude.split(','), declarations: block });
    i = j;
  }
  return rules;
}
const HIDING = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?![.\d])|content-visibility\s*:\s*hidden|color\s*:\s*transparent|clip(?:-path)?\s*:|height\s*:\s*0(?![.\d]))/i;
function compoundMatches(compound, el) {
  const classes = String(el.className ?? '').split(/\s+/).filter(Boolean);
  const tag = /^[a-z][a-z0-9]*/i.exec(compound)?.[0];
  if (tag && tag.toLowerCase() !== String(el.tagName).toLowerCase()) return false;
  for (const [, name] of compound.matchAll(/\.([\w-]+)/g)) if (!classes.includes(name)) return false;
  for (const [, name] of compound.matchAll(/#([\w-]+)/g)) if (el.id !== name) return false;
  for (const [, name] of compound.matchAll(/\[([\w-]+)/g)) if (!el.hasAttribute?.(name)) return false;
  return true;
}
// Rules that could hide the element or one of its ancestors, at any width and in any media block.
function hidingRules(css, el) {
  const chain = []; for (let cur = el; cur; cur = cur.parentElement) chain.push(cur);
  const found = [];
  for (const rule of cssRules(css)) {
    if (!HIDING.test(rule.declarations)) continue;
    for (const selector of rule.selectors) {
      if (selector.includes('::')) continue;
      const last = selector.trim().split(/\s*[>+~]\s*|\s+/).at(-1).replace(/:[\w-]+(?:\([^)]*\))?/g, '');
      if (chain.some(candidate => compoundMatches(last, candidate))) found.push(`${rule.media} ${selector.trim()}`.trim());
    }
  }
  return found;
}
const noteOf = f => all(f.record(), el => el.className === 'record-note')[0];

test('the task record states in the trail that hashes are not signed, at every width', () => {
  const f = open();
  assert.equal(textOf(f.record()).split(SIGNED_SENTENCE).length - 1, 1);
  const holder = noteOf(f);
  assert.equal(textOf(holder), SIGNED_SENTENCE);
  assert.deepEqual(hidingRules(readPublic('style.css') + readPublic('runner.css'), holder), []);
  assert.equal(holder.hasAttribute('hidden'), false);
});

test('the signed-sentence check catches a stylesheet rule that hides it', () => {
  const holder = noteOf(open());
  const css = readPublic('style.css');
  assert.deepEqual(hidingRules(`${css}\n@media (min-width: 961px) { .record-note { display: none; } }`, holder), ['@media (min-width: 961px) .record-note']);
  assert.equal(hidingRules(`${css}\n.trail-label { visibility: hidden; }`, holder).length, 1);
  assert.equal(hidingRules(`${css}\n.trail { height: 0; }`, holder).length, 1);
  assert.equal(hidingRules(`${css}\n.something-else { display: none; }`, holder).length, 0);
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

test('no class the record uses collides with the skip link, which is positioned off screen', () => {
  const data = state(); data.runs[0] = { ...data.runs[0], status: 'cancelled', has_patch: false, patch_sha256: null, checks: [], summary: 'Run cancelled; no upstream changes were made.' };
  for (const status of ['cancelled', 'interrupted', 'running']) {
    data.runs[0].status = status;
    const f = open(JSON.parse(JSON.stringify(data)));
    assert.deepEqual(withClass(f.record(), 'skip'), [], status);
  }
  assert.match(readPublic('style.css'), /\.skip \{ position: absolute; left: 12px; top: -80px/);
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
});

// Every string literal of a classic script, skipping comments and regular expressions.
function stringLiterals(js) {
  const found = []; let i = 0;
  while (i < js.length) {
    const c = js[i], next = js[i + 1];
    if (c === '/' && next === '/') { while (i < js.length && js[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { i = js.indexOf('*/', i + 2) + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1; while (j < js.length && js[j] !== c) j += js[j] === '\\' ? 2 : 1;
      found.push(js.slice(i + 1, j)); i = j + 1; continue;
    }
    if (c === '/' && /[=(,:!&|?{};]\s*$/.test(js.slice(Math.max(0, i - 3), i))) {
      let j = i + 1, inClass = false;
      while (j < js.length && (js[j] !== '/' || inClass)) { if (js[j] === '\\') j++; else if (js[j] === '[') inClass = true; else if (js[j] === ']') inClass = false; j++; }
      i = j + 1; continue;
    }
    i++;
  }
  return found;
}
const FORBIDDEN = [[/\bagents?\b/i, 'agent'], [/\bAI-powered\b/i, 'AI-powered'], [/\bsandbox(?:es|ed)?\b/i, 'sandbox'], [/\bhosted\b/i, 'hosted'], [/\bSaaS\b/i, 'SaaS'], [/\btamper-proof\b/i, 'tamper-proof'], [/(?<!not )\bsigned\b/i, 'signed'], [/\bverified by\b/i, 'verified by']];
const forbiddenIn = (label, text) => FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, name]) => `${label}: ${name}`);
const demoPlan = () => buildPlan({ intent: 'x', adapter: 'github' }, { full_name: 'local/demo', latest_sha: null });

test('no text the interface can show uses the words Forge does not claim', () => {
  const literals = stringLiterals(readPublic('app.js'));
  assert.ok(literals.length > 150 && literals.some(text => text.includes('Planned, not available')), `scanner found ${literals.length} literals`);
  const plan = demoPlan();
  const texts = [
    ['index.html', readPublic('index.html')],
    ...literals.map(text => ['app.js', text]),
    ...adapters.flatMap(a => [[`adapter ${a.id} name`, a.name], [`adapter ${a.id} detail`, a.detail]]),
    ...plan.steps.map(step => [`plan step ${step.stage}`, `${step.stage} ${step.action}`]),
    ...plan.gates.map(gate => ['plan gate', gate]),
  ];
  assert.deepEqual(texts.flatMap(([label, text]) => forbiddenIn(label, text)), []);
  // The checker itself: each word is caught, and "not signed" is the one allowed use of "signed".
  assert.equal(forbiddenIn('x', 'a coding agent in a sandbox, hosted SaaS, AI-powered, tamper-proof, signed, verified by').length, 8);
  assert.deepEqual(forbiddenIn('x', 'its hashes are not signed'), []);
});

test('the plan describes only what Forge does today', () => {
  assert.deepEqual(demoPlan().steps.map(step => step.action), [
    'Resolve repository local/demo and pin the base revision.',
    'Make a separate copy of the pinned commit.',
    'Apply the exact edits you provide to that copy.',
    'Run the static checks on the changed files.',
    'Record the patch, the check results and the pinned commit as evidence.'
  ]);
});

test('the task dialog offers only adapters that work; planned ones appear once as plain text', () => {
  assert.deepEqual(adapters.filter(a => a.status === 'planned').map(a => a.id), ['open-scion', 'gcp-scion']);
  const data = state(); data.adapters = adapters.map(a => ({ ...a }));
  const f = open(data);
  assert.deepEqual(f.get('#adapter').children.map(option => option.value), ['github']);
  const rail = textOf(f.get('#adapters'));
  for (const text of ['Planned, not available', 'No compatibility is claimed.', 'open_scion / git-ai', 'Google Scion']) assert.equal(rail.split(text).length - 1, 1, text);
  assert.deepEqual(all(f.get('#adapters'), el => el.className === 'conn').map(textOf), ['GitHub metadata ready', 'open_scion / git-ai', 'Google Scion']);
  assert.equal(all(f.get('#adapters'), el => el.tagName === 'button' || el.tagName === 'a').length, 0);
  assert.equal(textOf(f.get('#adapter')).includes('Scion'), false);
});

// ---------- polling must not disturb a reader ----------
function reader() {
  const f = open(state());
  vm.runInContext(`runDetails.set('r2', { id: 'r2', status: 'passed', task_id: 't', patch: ${JSON.stringify(PATCH)} }); render()`, f.context);
  f.apply = next => { f.context.next = next; return vm.runInContext('applyState(next)', f.context); };
  f.focus = id => { const el = f.document.getElementById(id); assert.ok(el, `no element with id ${id}`); el.focus(); assert.equal(f.document.activeElement, el); return el; };
  f.clone = () => JSON.parse(JSON.stringify(f.data));
  return f;
}
const FOCUSABLE = ['cell-source', 'cell-patch', 'cell-checks', 'cell-approval', 'run-link-r2', 'run-link-r1', 'run-summary-r1', 'earlier-summary', 'copy-commit-r2', 'copy-patch-r2', 'diff-r2-0', 'download-r2', 'workflow-heading'];

test('a render with unchanged or changed state leaves keyboard focus where it was', () => {
  const f = reader();
  f.apply(f.clone());
  for (const id of FOCUSABLE) {
    const before = f.focus(id);
    f.rerender();
    const after = f.document.activeElement;
    assert.equal(after.id, id, `${id}: focus lost after an unchanged render`);
    assert.ok(after.isConnected && after !== before, `${id}: focus must be on the new element`);
    const changed = f.clone(); changed.runs[0].summary = `Changed ${id}`; changed.runs[0].checks.push(check('extra', 'x'));
    assert.equal(f.apply(changed), true);
    assert.equal(f.document.activeElement.id, id, `${id}: focus lost after a changed state`);
    assert.ok(f.document.activeElement.isConnected, id);
    f.apply(f.clone());
  }
});

test('polling with an identical state does not rebuild the record', () => {
  const f = reader();
  assert.equal(f.apply(f.clone()), true);
  const sheet = f.record().children[0], button = f.focus('copy-patch-r2');
  assert.equal(f.apply(f.clone()), false);
  assert.equal(f.record().children[0], sheet);
  assert.equal(f.document.activeElement, button);
  const next = f.clone(); next.runs[1].summary = 'Another message';
  assert.equal(f.apply(next), true);
  assert.notEqual(f.record().children[0], sheet);
});

test('a render keeps the scroll position of each diff region', () => {
  const f = reader();
  const region = f.document.getElementById('diff-r2-0');
  region.scrollTop = 90; region.scrollLeft = 30;
  f.rerender();
  const again = f.document.getElementById('diff-r2-0');
  assert.notEqual(again, region);
  assert.deepEqual([again.scrollTop, again.scrollLeft], [90, 30]);
});

test('when a focused control disappears, focus goes to the next step or the heading', () => {
  const data = state(); data.tasks[0].status = 'queued'; data.runs = [];
  const f = open(data);
  f.document.getElementById('task-t-step').focus();
  data.tasks[0].status = 'planned'; f.rerender();
  assert.equal(f.document.activeElement.id, 'task-t-step');
  const running = state(); running.runs = [{ ...running.runs[0], id: 'r9', status: 'running', finished_at: null, patch_sha256: null, has_patch: false, checks: [], summary: '' }];
  const g = open(running);
  g.document.getElementById('cancel-r9').focus();
  running.runs[0].status = 'cancelled'; running.runs[0].finished_at = '2026-11-19T14:10:50.000Z'; g.rerender();
  assert.equal(g.document.activeElement.id, 'workflow-heading');
});

test('an earlier run is one closed line with its state, time and message or hash ends', () => {
  const f = open(state());
  const folds = all(f.record(), el => el.tagName === 'details' && el.className === 'run-fold');
  assert.deepEqual(folds.map(el => el.id), ['run-r1']);
  assert.equal(folds[0].open, false);
  assert.match(textOf(folds[0].children[0]), /^Failed Run 1 \d\d:\d\d:\d\d Before text must match exactly once: hello\.mjs$/);
  const later = state(); later.runs[0].created_at = '2026-11-19T14:10:30.000Z'; later.runs[0].finished_at = '2026-11-19T14:10:31.000Z';
  const g = open(later);
  const passedFold = all(g.record(), el => el.tagName === 'details' && el.className === 'run-fold')[0];
  assert.match(textOf(passedFold.children[0]), /^Passed Run 1 \d\d:\d\d:\d\d Patch SHA-256 8fef16c8…2d90234$/);
  vm.runInContext("openRuns.add('r1')", f.context); f.rerender();
  assert.equal(all(f.record(), el => el.tagName === 'details' && el.className === 'run-fold')[0].open, true);
});
