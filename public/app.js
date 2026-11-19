let state;
let stateJson = '';
let runTask;
let selectedProjectId = 'all';
let selectedTaskId = null;
let earlierOpen = false;
let numbers = new Map();
const focusReturns = new WeakMap();
const dialogTriggers = new WeakMap();
const openRuns = new Set();
const runDetails = new Map();
const loadingRuns = new Set();
const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const attr = (el, name, value) => { el.setAttribute(name, value); return el; };
const NA = 'not available';
const RECORD_NOTE = 'The record is local and its hashes are not signed.';
const message = text => { $('#message').textContent = text; };
const formatBytes = bytes => bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : `${bytes / 1024} KiB`;

// ---------- theme: system, light, dark ----------
const themeRoot = typeof document.documentElement === 'object' ? document.documentElement : null;
function savedTheme() { try { const value = localStorage.getItem('forge-theme'); return value === 'light' || value === 'dark' ? value : 'system'; } catch { return 'system'; } }
let theme = savedTheme();
function paintTheme() {
  if (theme === 'system') themeRoot?.removeAttribute('data-theme'); else themeRoot?.setAttribute('data-theme', theme);
  const next = { system: 'light', light: 'dark', dark: 'system' }[theme];
  $('#theme-label').textContent = `Theme: ${theme}`;
  attr($('#theme'), 'aria-label', `Theme: ${theme}. Switch to ${next}.`);
}
$('#theme').onclick = () => {
  theme = { system: 'light', light: 'dark', dark: 'system' }[theme];
  try { if (theme === 'system') localStorage.removeItem('forge-theme'); else localStorage.setItem('forge-theme', theme); } catch { /* storage can be unavailable */ }
  paintTheme();
};
paintTheme();

// ---------- API ----------
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forge-Client': 'local-ui' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
// Render only when the state really changed, so a reader keeps focus, selection and scroll position.
function applyState(next) {
  const json = JSON.stringify(next);
  if (state && json === stateJson) return false;
  state = next; stateJson = json; render();
  return true;
}
async function refresh() { applyState(await api('/api/state')); }

// ---------- formatting ----------
const pad = value => String(value).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateOf(iso) { const date = new Date(iso); return iso && !Number.isNaN(date.getTime()) ? date : null; }
function clock(iso) { const d = dateOf(iso); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : NA; }
function dayOf(iso) { const d = dateOf(iso); return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : ''; }
function elapsed(from, to) {
  const a = dateOf(from), b = dateOf(to);
  if (!a || !b) return null;
  const ms = Math.max(0, a.getTime() - b.getTime());
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const shortHash = value => value ? `${value.slice(0, 8)}…${value.slice(-7)}` : NA;

// ---------- state marks: glyph shape + word, never colour alone ----------
const WORDS = {
  passed: ['pass', 'Passed'], failed: ['fail', 'Failed'], cancelled: ['cancel', 'Cancelled'], timed_out: ['fail', 'Timed out'],
  interrupted: ['cancel', 'Interrupted'], preparing: ['run', 'Preparing'], running: ['run', 'Running'], notrun: ['skip', 'Not run'],
  queued: ['skip', 'Queued'], planned: ['skip', 'Planned'], in_review: ['skip', 'In review'], approved: ['skip', 'Awaiting run']
};
const isActive = run => ['preparing', 'running'].includes(run.status);
function mark(status, className = 'st', wordOverride) {
  const [kind, word] = WORDS[status] ?? ['skip', status];
  const el = node('span', undefined, `${className} st-${kind}`);
  el.append(attr(node('span', undefined, `glyph g-${kind}`), 'aria-hidden', 'true'), node('span', wordOverride ?? word, 'word'));
  return el;
}
function hashBlock(value, copyLabel, copyId) {
  const row = node('div', undefined, 'hash-row');
  if (!value) { row.append(node('span', NA, 'mono na')); return row; }
  const hash = node('span', undefined, 'hash mono');
  const chunks = value.match(/.{1,8}/g);
  chunks.forEach((chunk, index) => {
    const group = node('span', undefined, 'g');
    if (index === 0) group.append(node('b', chunk));
    else if (index === chunks.length - 1 && chunk.length > 7) group.append(node('span', chunk.slice(0, -7)), node('b', chunk.slice(-7)));
    else group.append(node('span', chunk));
    hash.append(group);
  });
  const copy = node('button', 'Copy', 'btn btn-quiet copy'); copy.type = 'button'; copy.id = copyId;
  attr(copy, 'aria-label', copyLabel);
  copy.onclick = () => copyValue(value);
  row.append(hash, copy);
  return row;
}
async function copyValue(value) {
  try {
    await navigator.clipboard.writeText(value);
    message('');
    await Promise.resolve();
    message('Copied');
  } catch { message('Copy failed. Select the value and copy it by hand.'); }
}

// ---------- the record: model ----------
const CHECK_NAMES = [['edit:', 'Exact replacement'], ['conflicts:', 'Conflict markers'], ['json:', 'JSON parse'], ['syntax:', 'JavaScript syntax'], ['diff-whitespace', 'Whitespace in the diff']];
const checkName = id => CHECK_NAMES.find(([prefix]) => id === prefix || id.startsWith(prefix))?.[1] ?? id;
function runsOf(task) { return (state.runs ?? []).filter(run => run.task_id === task.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))); }
function taskEvent(task, kind) { return (task.events ?? []).find(event => event.kind === kind); }
function tallyChecks(run) {
  const checks = run.checks ?? [];
  const passed = checks.filter(c => c.status === 'passed').length, failed = checks.filter(c => c.status !== 'passed').length;
  const parts = [];
  if (passed) parts.push(`${passed} passed`);
  if (failed) parts.push(`${failed} failed`);
  parts.push('1 not run');
  return parts.join(', ');
}
function latestStatus(task) { const runs = runsOf(task); return runs.length ? runs.at(-1).status : task.status; }
function patchFiles(text) {
  const files = []; let file = null, inHunk = false, oldLine = 0, newLine = 0;
  const start = path => { file = { path, rows: [], added: 0, removed: 0 }; files.push(file); inHunk = false; };
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      start(match ? match[2] : line.slice(11));
      file.rows.push({ type: 'meta', text: line });
      continue;
    }
    if (!file) start('patch');
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; file.rows.push({ type: 'meta', text: line }); continue; }
    if (!inHunk) {
      if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) file.path = line.slice(4).replace(/^b\//, '').replace(/	.*$/, '');
      file.rows.push({ type: 'meta', text: line });
      continue;
    }
    const sign = line[0];
    if (sign === '+') { file.rows.push({ type: 'add', neu: newLine++, text: line.slice(1) }); file.added++; }
    else if (sign === '-') { file.rows.push({ type: 'del', old: oldLine++, text: line.slice(1) }); file.removed++; }
    else if (sign === '\\') file.rows.push({ type: 'meta', text: line });
    else file.rows.push({ type: 'ctx', old: oldLine++, neu: newLine++, text: sign === ' ' ? line.slice(1) : line });
  }
  return files;
}

// ---------- the record: elements ----------
function glyph(status) { const kind = (WORDS[status] ?? ['skip'])[0]; return attr(node('span', undefined, `glyph g-${kind}`), 'aria-hidden', 'true'); }
function timeCell(iso) {
  const time = node('time'); time.dateTime = iso ?? '';
  time.append(node('b', clock(iso)), node('span', dayOf(iso)));
  return time;
}
// One recorded event on the trail: time, node, body.
function entry({ iso, status, body, className = '' }) {
  const row = node('div', undefined, `ev ${className}`.trim());
  const dot = attr(node('span', undefined, status ? 'node node-state' : 'node'), 'aria-hidden', 'true');
  if (status) dot.append(glyph(status));
  const content = node('div', undefined, 'ev-body'); content.append(...body);
  row.append(timeCell(iso), dot, content);
  return row;
}
function plainRow(body, className = '') {
  const row = node('div', undefined, `ev ev-plain ${className}`.trim());
  const content = node('div', undefined, 'ev-body'); content.append(...body);
  row.append(content);
  return row;
}
function gapPill(text) {
  const wrap = node('span', undefined, 'gap'), pill = node('i');
  pill.append(node('span', 'Time until the next entry below: ', 'sr-only'), node('span', text));
  wrap.append(pill);
  return wrap;
}
function exhibitHead(letter, title, sub, id, extra) {
  const wrap = node('div', undefined, 'exh'), text = node('div');
  const heading = node('h3', title); heading.id = id;
  text.append(heading, node('small', sub));
  if (extra) text.append(extra);
  wrap.append(attr(node('span', letter, 'exh-letter'), 'aria-hidden', 'true'), text);
  return wrap;
}
function lettered(id, letter, title, sub, extra, ...content) {
  const section = node('section', undefined, 'ev ev-plain lettered'); section.id = id;
  attr(section, 'aria-labelledby', `${id}-h`);
  const body = node('div', undefined, 'ev-body'); body.append(exhibitHead(letter, title, sub, `${id}-h`, extra), ...content);
  section.append(body);
  return section;
}
function pair(label, value) { const wrap = node('div', undefined, 'kv-row'), term = node('dd'); term.append(value); wrap.append(node('dt', label), term); return wrap; }
const definitions = (...rows) => { const list = node('dl', undefined, 'kv'); list.append(...rows); return list; };
const plainValue = text => node('span', text, text === NA ? 'na' : '');

const liveRegions = [];
function diffFile(file, id) {
  const wrap = node('div', undefined, 'diff-file');
  const caption = node('div', undefined, 'diff-cap');
  caption.append(node('code', file.path), node('span', `${plural(file.removed, 'line')} removed, ${plural(file.added, 'line')} added`));
  const region = attr(attr(node('div', undefined, 'diff'), 'role', 'region'), 'aria-label', `Patch for ${file.path}`);
  region.tabIndex = 0; region.id = id;
  liveRegions.push(region);
  const table = node('table'), tbody = node('tbody');
  table.append(node('caption', `Unified diff of ${file.path}. Columns: old line, new line, change, text.`, 'sr-only'), tbody);
  for (const row of file.rows) {
    const tr = node('tr', undefined, row.type);
    const sign = node('td', undefined, 'sg');
    if (row.type === 'add' || row.type === 'del') sign.append(attr(node('span', row.type === 'add' ? '+' : '-'), 'aria-hidden', 'true'), node('span', row.type === 'add' ? 'added' : 'removed', 'sr-only'));
    tr.append(node('td', row.old === undefined ? '' : String(row.old), 'no'), node('td', row.neu === undefined ? '' : String(row.neu), 'no'), sign, node('td', row.text === '' ? ' ' : row.text, 'tx'));
    tbody.append(tr);
  }
  region.append(table);
  wrap.append(caption, region);
  return wrap;
}

function sourceSection(rn, project, task) {
  const where = node('span', undefined, 'where');
  where.append(node('span', project?.full_name ?? NA, 'mono'), node('span', ` · ${task.adapter ?? NA} adapter`));
  where.className = 'where exh-where';
  return lettered(`sec-source-${rn.id}`, 'A', 'Source', 'What the change was based on', where, definitions(pair('Pinned commit', hashBlock(rn.base_sha, 'Copy pinned commit', `copy-commit-${rn.id}`))));
}
function patchSection(rn, detail) {
  const content = [definitions(pair('Patch SHA-256', hashBlock(rn.patch_sha256, 'Copy patch SHA-256', `copy-patch-${rn.id}`)))];
  if (!rn.has_patch) content.push(node('p', 'No patch produced.', 'plain-line'));
  else if (!detail) content.push(node('p', 'Loading the patch…', 'plain-line'));
  else if (detail.error) content.push(node('p', `The patch could not be loaded: ${detail.error}`, 'plain-line'));
  else {
    content.push(...patchFiles(detail.patch ?? '').map((file, index) => diffFile(file, `diff-${rn.id}-${index}`)));
    if (detail.patch) {
      const download = node('button', 'Download patch', 'btn btn-primary'); download.type = 'button'; download.id = `download-${rn.id}`;
      download.onclick = () => downloadPatch(detail);
      const bar = node('div', undefined, 'actions'); bar.append(download);
      content.push(bar);
    } else content.push(node('p', 'No patch produced.', 'plain-line'));
  }
  return lettered(`sec-patch-${rn.id}`, 'B', 'Patch', 'Exactly what changed', null, ...content);
}
function checkItem(check) {
  const item = node('li', undefined, check.status === 'passed' ? '' : 'check-failed'), text = node('div');
  const isEdit = check.name.startsWith('edit:');
  text.append(node('strong', checkName(check.name)), node('code', check.name), node('p', isEdit && check.status === 'passed' ? 'The text to replace was found once and was replaced.' : (check.detail || NA)));
  item.append(mark(check.status === 'passed' ? 'passed' : 'failed'), text);
  return item;
}
function checksSection(rn) {
  const checks = rn.checks ?? [];
  const list = node('ul', undefined, 'checks');
  list.append(...checks.map(checkItem));
  if (!checks.length) list.append(node('li', 'No checks were recorded for this run.', 'no-checks'));
  const notRun = node('li', undefined, 'notrun'), text = node('div');
  text.append(node('strong', 'Project tests'), node('code', 'not part of Forge'), node('p', "Not run. Forge does not run project tests, so beyond the checks above this change is untested."));
  notRun.append(mark('notrun'), text);
  list.append(notRun);
  return lettered(`sec-checks-${rn.id}`, 'C', 'Checks', 'What was checked, and what was not', null, list);
}
function failureHelp(rn, later) {
  const box = node('div', undefined, 'fix');
  let text = 'Read the message above, correct the edits and run again. This run stays in the record.';
  if (/^Before text must match exactly once/.test(rn.summary ?? '')) text = 'The before text must appear exactly once in the file. Check its spelling and whitespace, or copy a longer, unique line.';
  const fixed = later.find(candidate => candidate.status === 'passed');
  box.append(node('strong', 'How to fix'), node('p', fixed ? `${text} Run ${numbers.get(fixed.id)} corrected this.` : text));
  return box;
}
const hasEvidence = rn => !isActive(rn) && (rn.has_patch || (rn.checks ?? []).length > 0);

// The rows of one run: the end entry with its evidence sections, then the start entry.
function runRows(rn, project, task, latest, later) {
  const title = `Run ${numbers.get(rn.id)}`, active = isActive(rn);
  const verdictKind = rn.status === 'passed' ? 'pass' : active ? 'run' : ['failed', 'timed_out'].includes(rn.status) ? 'fail' : 'skip';
  const verdict = node('div', undefined, `verdict ${verdictKind}`);
  verdict.append(mark(rn.status), node('p', rn.summary || (active ? 'Preparing a pinned source snapshot…' : NA)));
  const body = [node('h2', `${title} · ${active ? 'in progress' : latest ? 'latest' : 'kept as recorded'}`, 'ev-kind'), verdict];
  if (active) {
    const cancel = node('button', 'Cancel run', 'btn'); cancel.type = 'button'; cancel.id = `cancel-${rn.id}`;
    cancel.onclick = () => run(cancel, async () => { await api(`/api/runs/${rn.id}/cancel`, {}); await refresh(); message('Run cancelled.'); });
    const actions = node('div', undefined, 'actions'); actions.append(cancel); body.push(actions);
  }
  const end = entry({ iso: active ? rn.created_at : (rn.finished_at || rn.created_at), status: rn.status, body, className: 'run-end' });
  end.id = latest || active ? `run-${rn.id}` : `run-end-${rn.id}`;
  const rows = [end];
  if (!active) {
    if (hasEvidence(rn)) rows.push(sourceSection(rn, project, task), patchSection(rn, runDetails.get(rn.id)), checksSection(rn));
    else {
      const none = plainRow([definitions(pair('Pinned commit', hashBlock(rn.base_sha, 'Copy pinned commit', `copy-commit-${rn.id}`)), pair('Patch', plainValue('No patch produced.')), pair('Patch SHA-256', plainValue(NA))), failureHelp(rn, later)], 'no-evidence');
      rows.push(none);
    }
  }
  return rows;
}
// An earlier run is one line in the trail; its full rows open inside a native details element.
function foldedRun(rn) {
  const details = node('details', undefined, 'run-fold'); details.id = `run-${rn.id}`;
  details.open = openRuns.has(rn.id);
  details.ontoggle = () => { if (details.open) openRuns.add(rn.id); else openRuns.delete(rn.id); };
  const summary = node('summary'); summary.id = `run-summary-${rn.id}`;
  summary.append(mark(rn.status), node('strong', `Run ${numbers.get(rn.id)}`), node('span', clock(rn.finished_at || rn.created_at), 'mono when'), node('span', rn.patch_sha256 ? `Patch SHA-256 ${shortHash(rn.patch_sha256)}` : (rn.summary || NA), 'fold-line'));
  details.append(summary);
  return details;
}
const startRow = rn => entry({ iso: rn.created_at, body: [node('h3', `Run ${numbers.get(rn.id)} started`)], className: 'run-start' });

function timelineEvents(task, runs) {
  const events = [];
  runs.forEach(rn => {
    events.push({ type: 'end', iso: isActive(rn) ? rn.created_at : (rn.finished_at || rn.created_at), run: rn, order: 3 });
    if (!isActive(rn)) events.push({ type: 'start', iso: rn.created_at, run: rn, order: 2 });
  });
  for (const [kind, type, order] of [['task.approved', 'approved', 1.4], ['task.in_review', 'review', 1.3], ['task.planned', 'plan', 1.2]]) {
    const found = taskEvent(task, kind); if (found) events.push({ type, iso: found.created_at, order });
  }
  events.push({ type: 'intent', iso: taskEvent(task, 'task.created')?.created_at ?? task.created_at, order: 1.1 });
  return events.sort((a, b) => String(b.iso).localeCompare(String(a.iso)) || b.order - a.order);
}

function buildTrail(task, runs, project) {
  const trail = node('div', undefined, 'trail');
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* time zone unknown */ }
  const label = node('div', undefined, 'trail-label');
  label.append(node('span', 'Time'), node('p', zone ? `Record, newest first · times in ${zone}` : 'Record, newest first'), node('p', RECORD_NOTE, 'record-note'));
  trail.append(label);
  const events = timelineEvents(task, runs);
  const gapFor = event => { const next = events[events.indexOf(event) + 1]; return next ? elapsed(event.iso, next.iso) : null; };
  const withGap = (rows, event) => { const text = gapFor(event), last = rows.at(-1); if (text && last) last.append(gapPill(text)); return rows; };
  const latest = runs.at(-1), folds = new Map();
  const place = (rn, rows) => {
    if (rn === latest || isActive(rn)) { trail.append(...rows); return; }
    if (!folds.has(rn.id)) { folds.set(rn.id, foldedRun(rn)); trail.append(folds.get(rn.id)); }
    folds.get(rn.id).append(...rows);
  };
  for (const event of events.filter(e => e.type === 'end' || e.type === 'start')) {
    if (event.type === 'start') { place(event.run, withGap([startRow(event.run)], event)); continue; }
    const later = runs.filter(r => numbers.get(r.id) > numbers.get(event.run.id));
    place(event.run, withGap(runRows(event.run, project, task, event.run === latest, later), event));
  }
  // Approvals: one section, one letter, both recorded events.
  const approved = events.find(e => e.type === 'approved'), review = events.find(e => e.type === 'review');
  const group = node('section', undefined, 'group'); group.id = 'sec-approvals'; attr(group, 'aria-labelledby', 'sec-approvals-h');
  const header = exhibitHead('D', 'Approvals', 'When the plan was reviewed and approved', 'sec-approvals-h');
  const first = approved ?? review;
  if (first) {
    const describe = event => event.type === 'approved'
      ? [node('h4', 'Plan approved'), node('p', 'Approved by: not available. Forge records the approval, not who gave it.')]
      : [node('h4', 'Review requested'), node('p', 'The plan was put forward for review.')];
    const firstRow = entry({ iso: first.iso, body: [header, ...describe(first)], className: 'approval with-head' });
    group.append(...withGap([firstRow], first));
    if (approved && review) group.append(...withGap([entry({ iso: review.iso, body: describe(review), className: 'approval' })], review));
  } else group.append(plainRow([header, node('p', 'No approval has been recorded yet.', 'plain-line')]));
  trail.append(group);
  // Earlier events fold away once a run exists.
  const earlier = events.filter(e => e.type === 'plan' || e.type === 'intent');
  const details = node('details', undefined, 'earlier'); details.id = 'earlier-events';
  details.open = earlierOpen || !runs.length;
  details.ontoggle = () => { if (runs.length) earlierOpen = details.open; };
  const earlierSummary = node('summary', `Earlier in this record: ${plural(earlier.length, 'event')}`); earlierSummary.id = 'earlier-summary';
  details.append(earlierSummary);
  for (const event of earlier) {
    const body = event.type === 'plan'
      ? [node('span', 'Plan', 'ev-kind'), node('h3', 'Plan generated'), node('p', 'A dry-run plan of the steps. Nothing was changed when it was written.')]
      : [node('span', 'Intent', 'ev-kind'), node('h3', task.title), node('p', task.intent || NA, 'intent-text')];
    details.append(...withGap([entry({ iso: event.iso, body, className: event.type })], event));
  }
  trail.append(details);
  return trail;
}

function evidenceSummary(task, runs, project) {
  const latest = runs.at(-1), approved = taskEvent(task, 'task.approved');
  const nav = node('nav', undefined, 'summary'); attr(nav, 'aria-label', 'Evidence summary');
  const sectioned = latest && hasEvidence(latest);
  const target = suffix => sectioned ? `#sec-${suffix}-${latest.id}` : latest ? `#run-${latest.id}` : '#sec-approvals';
  const cell = (label, value, sub, href, id) => {
    const link = node('a', undefined, 'cell'); link.href = href; link.id = id;
    link.append(node('span', label, 'cell-label'), node('strong', value, value === NA ? 'na' : ''), node('span', sub, 'cell-sub'));
    return link;
  };
  const active = latest && isActive(latest);
  nav.append(
    cell('Source', shortHash(latest?.base_sha), latest ? (project?.full_name ?? NA) : 'Pinned when a run starts', target('source'), 'cell-source'),
    cell('Patch', !latest || active ? NA : latest.patch_sha256 ? shortHash(latest.patch_sha256) : 'No patch produced', 'SHA-256', target('patch'), 'cell-patch'),
    cell('Checks', !latest || active ? NA : tallyChecks(latest), 'Static checks only', target('checks'), 'cell-checks'),
    cell('Approval', approved ? 'Plan approved' : 'Not approved', approved ? `${clock(approved.created_at)} · ${dayOf(approved.created_at)}` : 'No approval recorded', '#sec-approvals', 'cell-approval')
  );
  return nav;
}
function runsList(runs) {
  const wrap = node('section', undefined, 'runs-list'); attr(wrap, 'aria-labelledby', 'runs-h');
  const heading = node('h2', `Runs on this task: ${runs.length}`); heading.id = 'runs-h';
  const list = node('ul');
  [...runs].reverse().forEach(rn => {
    const item = node('li'), link = node('a'); link.href = `#run-${rn.id}`; link.id = `run-link-${rn.id}`;
    link.append(node('strong', `Run ${numbers.get(rn.id)}`), mark(rn.status), node('span', rn.status === 'passed' ? `Patch SHA-256 ${shortHash(rn.patch_sha256)}` : (rn.summary || NA), 'run-line'), node('time', clock(rn.finished_at || rn.created_at), 'mono'));
    link.onclick = event => { event.preventDefault(); showResult(rn.id, link); };
    item.append(link); list.append(item);
  });
  wrap.append(heading, list);
  return wrap;
}

function stepButton(task) {
  const actions = [];
  const next = { queued: ['plan', 'Generate plan'], planned: ['review', 'Request review'], in_review: ['approve', 'Approve plan'] }[task.status];
  if (next) {
    const button = node('button', next[1], 'btn btn-primary'); button.type = 'button'; button.id = `task-${task.id}-step`;
    button.onclick = () => run(button, async () => {
      await api(`/api/tasks/${task.id}/${next[0]}`, { version: task.version });
      await refresh(); message(`${task.title}: ${next[1]} completed. No code was executed or published.`);
    });
    actions.push(button);
  } else if (state.runner && task.adapter === 'github') {
    const start = node('button', 'Run scoped edits', 'btn btn-primary'); start.type = 'button';
    rememberFocus(start, `task-${task.id}-run`, [`task-${task.id}-plan`, 'workflow-heading']);
    start.disabled = Boolean(state.runner.active);
    start.onclick = () => openRunDialog(task, start);
    actions.push(start);
  }
  if (task.plan) {
    const view = node('button', 'View plan', 'btn btn-quiet'); view.type = 'button';
    rememberFocus(view, `task-${task.id}-plan`, ['workflow-heading']);
    view.onclick = () => showPlan(task, view);
    actions.push(view);
  }
  return actions;
}
function openRunDialog(task, trigger) {
  runTask = task;
  $('#run-task-title').textContent = `Task: ${task.title}`;
  $('#edits').value = ''; clearEditsError();
  const { snapshot, edits } = state.runner.limits;
  $('#runner-limits').replaceChildren(
    node('strong', 'Runner limits'),
    node('p', `Source snapshot: ${snapshot.minFiles}–${snapshot.maxFiles} regular tracked files, up to ${formatBytes(snapshot.maxFileBytes)} per file and ${formatBytes(snapshot.maxBytes)} total.`),
    node('p', `Edits: ${edits.minCount}–${edits.maxCount} files; up to ${formatBytes(edits.maxTextBytes)} of UTF-8 text across all before and after strings combined.`),
    node('p', `Run timeout: ${state.runner.timeoutMs / 1000} seconds.`)
  );
  openDialog($('#run-dialog'), trigger);
}

function buildRecord(task) {
  const project = state.projects.find(p => p.id === task.project_id);
  const runs = runsOf(task); numbers = new Map(runs.map((rn, index) => [rn.id, index + 1]));
  const latest = runs.at(-1);
  const sheet = node('article', undefined, 'sheet');
  const head = node('div', undefined, 'sheet-head');
  const heading = node('h1', task.title); heading.id = 'workflow-heading'; heading.tabIndex = -1;
  const row = node('div', undefined, 'title-row');
  const stamp = mark(latest ? latest.status : task.status, 'stamp');
  row.append(heading, stamp);
  const top = node('div', undefined, 'head-top');
  const actions = node('div', undefined, 'actions head-actions'); actions.append(...stepButton(task));
  if (task.status === 'approved' && !runs.length) actions.append(node('span', 'Plan approved · execution not started', 'head-note'));
  top.append(node('p', `Change record · ${project?.full_name ?? NA}`, 'eyebrow'), actions);
  head.append(top, row, node('p', 'Forge applies exact edits that you provide. It does not write code with an AI model. Its checks are static; project tests are not run. It runs locally for one user; nothing is published or merged.', 'limits-line'), evidenceSummary(task, runs, project));
  if (runs.length > 1) head.append(runsList(runs));
  sheet.append(head, buildTrail(task, runs, project));
  return sheet;
}

function emptyRecord() {
  const sheet = node('article', undefined, 'sheet empty');
  const head = node('div', undefined, 'sheet-head');
  const heading = node('h1', 'A change that carries its own proof.'); heading.id = 'workflow-heading'; heading.tabIndex = -1;
  head.append(node('p', 'Forge', 'eyebrow'), heading);
  const noProjects = !state.projects.length;
  head.append(node('p', noProjects ? 'Connect a repository, describe one change, and Forge keeps a single record of it: what the change was based on, exactly what changed, what was checked, what was not checked, and who approved it.' : 'Describe one change as a task. Forge keeps a single record of it: what it was based on, exactly what changed, what was checked, what was not checked, and who approved it.', 'lead'));
  if (noProjects) { const slot = node('div', undefined, 'connect-slot'); slot.id = 'connect-slot-main'; slot.append($('#connect-form')); head.append(slot); }
  else head.append(node('p', selectedProjectId === 'all' ? 'No tasks yet. Choose New task to start the first record.' : 'No tasks for this repository yet. Choose New task to start its first record.', 'empty-note'));
  const list = node('ul', undefined, 'not-list');
  for (const text of ['It applies exact edits that you provide.', 'It does not write code with an AI model.', 'Its checks are static. Project tests are not run.', 'It runs locally for one user. Nothing is published or merged.']) {
    list.append(node('li', text));
  }
  const parts = node('ul', undefined, 'will-show');
  for (const [letter, title, sub] of [['A', 'Source', 'What the change was based on'], ['B', 'Patch', 'Exactly what changed'], ['C', 'Checks', 'What was checked, and what was not'], ['D', 'Approvals', 'When the plan was reviewed and approved']]) {
    const item = node('li'); item.append(attr(node('span', letter, 'exh-letter'), 'aria-hidden', 'true'), node('strong', title), node('span', sub)); parts.append(item);
  }
  const body = node('div', undefined, 'sheet-foot'); body.append(node('h2', 'Each record shows', 'sect-title'), parts, node('h2', 'What Forge does not do', 'sect-title'), list, node('p', `${RECORD_NOTE} It is evidence to read, not proof against tampering.`, 'sub'));
  sheet.append(head, body);
  return sheet;
}

function renderRail() {
  const detail = $('#repo-detail');
  const project = state.projects.find(p => p.id === selectedProjectId);
  if (project) {
    const link = node(project.url ? 'a' : 'strong', project.full_name, 'repo-line mono'); if (project.url) { link.href = project.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    const local = project.source_kind === 'local';
    detail.replaceChildren(link, node('p', project.description || 'No repository description provided.'), node('p', `${project.default_branch} · ${local ? 'Local source' : project.private ? 'Private' : 'Public'} · ${project.latest_sha ? project.latest_sha.slice(0, 7) : local ? 'HEAD pinned at run time' : 'No push event received'}`, 'repo-meta'));
  } else detail.replaceChildren(node('p', state.projects.length ? `${state.projects.length} ${state.projects.length === 1 ? 'repository' : 'repositories'} connected.` : 'No repository connected yet.', 'repo-meta'));
  const tasks = visibleTasks();
  const list = $('#tasks');
  if (!tasks.length) { list.replaceChildren(node('p', selectedProjectId === 'all' ? 'No tasks yet.' : 'No tasks for this repository.', 'empty-note')); }
  else list.replaceChildren(...tasks.map(task => {
    const button = node('button', undefined, 'task'); button.type = 'button'; button.id = `task-select-${task.id}`;
    if (task.id === selectedTaskId) attr(button, 'aria-current', 'true');
    const latest = runsOf(task).at(-1);
    button.append(mark(latest ? latest.status : task.status), node('strong', task.title), node('small', latest ? `Latest run ${WORDS[latest.status]?.[1].toLowerCase() ?? latest.status}, ${clock(latest.finished_at || latest.created_at)}` : { queued: 'Not planned yet', planned: 'Plan generated', in_review: 'Plan in review', approved: 'Plan approved, no run yet' }[task.status] ?? task.status));
    button.onclick = () => { selectedTaskId = task.id; earlierOpen = false; render(); };
    return button;
  }));
  const planned = state.adapters.filter(adapter => adapter.status === 'planned');
  const plannedBlock = planned.length ? [node('h3', 'Planned, not available', 'conn-head'), ...planned.map(adapter => node('p', adapter.name, 'conn')), node('p', 'No compatibility is claimed.', 'repo-meta')] : [];
  $('#adapters').replaceChildren(...workingAdapters().map(adapter => { const item = node('p', undefined, 'conn'); item.append(node('strong', adapter.name), node('span', ` ${adapter.status.replaceAll('-', ' ')}`)); return item; }),
    node('p', `GitHub: ${state.integration.github} · Webhooks: ${state.integration.webhook ? 'configured' : 'not configured'}`, 'repo-meta'), ...plannedBlock);
  $('#pulls').replaceChildren(...state.pullRequests.map(pr => {
    const card = node('p', undefined, 'conn'); const link = node('a', `#${pr.number} ${pr.title}`); link.href = pr.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    card.append(node('span', `${pr.state} `, 'badge'), link, node('span', ` head ${pr.head_sha.slice(0, 7)}`)); return card;
  }));
}
const workingAdapters = () => state.adapters.filter(adapter => adapter.status !== 'planned');
function visibleTasks() { return selectedProjectId === 'all' ? state.tasks : state.tasks.filter(t => t.project_id === selectedProjectId); }

function loadDetails(runs) {
  for (const run of runs) {
    if (!run.has_patch || isActive(run)) continue;
    const cached = runDetails.get(run.id);
    if ((cached && cached.status === run.status) || loadingRuns.has(run.id)) continue;
    loadingRuns.add(run.id);
    api(`/api/runs/${run.id}`).then(result => runDetails.set(run.id, result), error => runDetails.set(run.id, { status: run.status, error: error.message }))
      .finally(() => { loadingRuns.delete(run.id); if (state) render(); });
  }
}

// What a re-render must not disturb: the focused control, the scroll of the page and of every diff region.
function captureView() {
  const active = document.activeElement, win = globalThis.window;
  return { active, id: active?.id || '', scrolls: new Map(liveRegions.map(el => [el.id, [el.scrollLeft || 0, el.scrollTop || 0]])), x: win?.scrollX || 0, y: win?.scrollY || 0 };
}
const FOCUS_FALLBACKS = [[/^task-(.+)-step$/, m => [`task-${m[1]}-run`, `task-${m[1]}-plan`]], [/^cancel-/, () => []]];
function restoreView(view) {
  for (const region of liveRegions) {
    const saved = view.scrolls.get(region.id);
    if (saved) { region.scrollLeft = saved[0]; region.scrollTop = saved[1]; }
  }
  if (view.id && view.active && !view.active.isConnected && typeof document.getElementById === 'function') {
    const extra = FOCUS_FALLBACKS.flatMap(([pattern, ids]) => { const m = pattern.exec(view.id); return m ? ids(m) : []; });
    for (const id of [view.id, ...extra, 'workflow-heading']) {
      const again = document.getElementById(id);
      if (again) { again.focus({ preventScroll: true }); if (document.activeElement === again) break; }
    }
  }
  const win = globalThis.window;
  if (win?.scrollTo && (win.scrollX !== view.x || win.scrollY !== view.y)) win.scrollTo(view.x, view.y);
}

function render() {
  const view = captureView();
  const focusReturn = focusReturns.get(document.activeElement);
  liveRegions.length = 0;
  $('#new-task').disabled = !state.projects.length;
  const creationProject = $('#project'); const creationProjectId = creationProject.value;
  creationProject.replaceChildren(...state.projects.map(p => { const option = node('option', p.full_name); option.value = p.id; return option; }));
  if (state.projects.some(p => p.id === creationProjectId)) creationProject.value = creationProjectId;
  const adapterSelect = $('#adapter'); const adapterId = adapterSelect.value;
  adapterSelect.replaceChildren(...workingAdapters().map(a => { const option = node('option', `${a.name} (${a.status.replaceAll('-', ' ')})`); option.value = a.id; return option; }));
  if (workingAdapters().some(a => a.id === adapterId)) adapterSelect.value = adapterId;
  const filterSelect = $('#filter-project');
  if (filterSelect) {
    const currentVal = selectedProjectId;
    const choices = [{ id: 'all', full_name: 'All repositories' }, ...state.projects];
    // Keep an open native select usable while background refreshes render.
    if (filterSelect.options.length !== choices.length || choices.some((p, i) => filterSelect.options[i].value !== p.id || filterSelect.options[i].textContent !== p.full_name)) {
      filterSelect.replaceChildren(...choices.map(p => { const option = node('option', p.full_name); option.value = p.id; return option; }));
    }
    if (['all', ...state.projects.map(p => p.id)].includes(currentVal)) {
      if (filterSelect.value !== currentVal) filterSelect.value = currentVal;
    } else {
      selectedProjectId = 'all';
      filterSelect.value = 'all';
    }
  }
  const tasks = visibleTasks();
  if (!tasks.some(t => t.id === selectedTaskId)) selectedTaskId = tasks[0]?.id ?? null;
  const task = tasks.find(t => t.id === selectedTaskId);
  const record = $('#record');
  // The connect form lives in the rail once a repository exists, and in the main column before that.
  const railConnect = $('#connect-slot-rail');
  railConnect.hidden = !state.projects.length;
  if (state.projects.length && $('#connect-form').parentElement !== railConnect) railConnect.append($('#connect-form'));
  const sheet = task ? buildRecord(task) : emptyRecord();
  record.replaceChildren(sheet);
  if (task) loadDetails(runsOf(task));
  if (task && runsOf(task).some(isActive)) attr(record, 'aria-busy', 'true'); else record.removeAttribute?.('aria-busy');
  renderRail();
  const railLimits = $('#lim-h').parentElement; // the empty record already states the limits
  if (railLimits) railLimits.hidden = !task;
  // A submission or polling refresh can replace the button after a dialog closes.
  if (document.querySelector('dialog[open]')) return;
  if (focusReturn && !view.active?.isConnected) restoreFocus(focusReturn);
  restoreView(view);
}
function rememberFocus(trigger, id, fallbackIds) {
  trigger.id = id;
  focusReturns.set(trigger, { trigger, id, fallbackIds });
}
function restoreFocus(target) {
  if (!target) return;
  // Prefer the original control, then its replacement, then nearby controls.
  const candidates = [target.trigger, ...[target.id, ...target.fallbackIds].map(id => document.getElementById(id))];
  for (const candidate of candidates) {
    if (!candidate?.isConnected || candidate.disabled) continue;
    candidate.focus();
    if (document.activeElement === candidate) {
      candidate.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
  }
}
function openDialog(dialog, trigger) {
  trigger ||= document.activeElement;
  dialogTriggers.set(dialog, focusReturns.get(trigger) || { trigger, id: trigger?.id, fallbackIds: ['workflow-heading'] });
  dialog.showModal();
}
function closeDialog(dialog) {
  dialog.close();
}
function downloadPatch(result) {
  const url = URL.createObjectURL(new Blob([result.patch], { type: 'text/plain;charset=utf-8' }));
  const link = node('a');
  const id = String(result.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'run';
  link.href = url;
  link.download = `forge-${id}.patch`;
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    // Let the browser start reading the Blob before releasing its URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
// Loads one run's full evidence (the patch is not part of /api/state) into the record, opens it and moves focus to its patch.
async function showResult(id, trigger) {
  try {
    const result = await api(`/api/runs/${id}`);
    runDetails.set(id, result);
    if (result.task_id) selectedTaskId = result.task_id;
    openRuns.add(id);
    if (state) render();
    const target = typeof document.getElementById === 'function' ? document.getElementById(`sec-patch-${id}`) ?? document.getElementById(`run-summary-${id}`) ?? document.getElementById(`run-${id}`) : null;
    if (target) { if (target.tagName.toLowerCase() !== 'summary') target.tabIndex = -1; target.scrollIntoView({ block: 'start' }); target.focus(); }
  } catch (error) { message(error.message); }
}
function showPlan(task, trigger) {
  const detail = $('#plan-detail'); const list = node('ol', undefined, 'plan-list');
  task.plan.steps.forEach(step => { const item = node('li'); item.append(node('span', step.stage, 'who'), node('span', step.action)); list.append(item); });
  $('#plan-dialog-title').textContent = `Plan for “${task.title}”`;
  detail.replaceChildren(node('p', 'DRY RUN · Nothing was executed', 'banner'), node('p', 'Nothing in this plan was executed. When you run scoped edits, Forge applies only the exact edits you provide and runs static checks; no AI model writes code.', 'sub'), list, node('p', task.plan.gates.join(' · '), 'help'));
  openDialog($('#plan-dialog'), trigger);
}

// ---------- run dialog: JSON problems are explained next to the field ----------
function lineColumn(text, position) { const before = text.slice(0, position).split('\n'); return { line: before.length, column: before.at(-1).length + 1 }; }
function trailingComma(text) {
  let inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; continue; }
    if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) return i;
  }
  return -1;
}
function diagnoseEdits(text) {
  if (!text.trim()) return { message: 'Nothing to run yet. Paste a JSON array with at least one edit, for example [{"path":"README.md","before":"old text","after":"new text"}].' };
  let data;
  try { data = JSON.parse(text); } catch (error) {
    const comma = trailingComma(text), reported = /position (\d+)/.exec(error.message);
    const where = lineColumn(text, comma >= 0 ? comma : reported ? Number(reported[1]) : 0);
    // Show a short window around the problem so the caret stays visible on a narrow dialog.
    const full = text.split('\n')[where.line - 1], from = Math.max(0, where.column - 16);
    const line = `${from > 0 ? '…' : ''}${full.slice(from, from + 30)}${from + 30 < full.length ? '…' : ''}`;
    const caretAt = where.column - 1 - from + (from > 0 ? 1 : 0);
    return {
      message: comma >= 0
        ? `Trailing comma at line ${where.line}, column ${where.column}. A comma must be followed by another item. Delete this comma, then run again.`
        : `The text is not valid JSON near line ${where.line}, column ${where.column}. Check quotes, commas and brackets at the marked spot, then run again.`,
      line, caret: `${' '.repeat(caretAt)}^`
    };
  }
  if (!Array.isArray(data) || !data.length) return { message: 'The edits must be a JSON array with at least one item. Wrap your edit in [ ].' };
  for (let i = 0; i < data.length; i++) {
    const edit = data[i];
    if (!edit || typeof edit.path !== 'string' || typeof edit.after !== 'string' || !(typeof edit.before === 'string' || edit.before === null)) return { message: `Edit ${i + 1} needs "path" (text), "before" (text, or null to create a file) and "after" (text).` };
  }
  return null;
}
function clearEditsError() { $('#edits-error').replaceChildren(); const area = $('#edits'); area.removeAttribute?.('aria-invalid'); }
function showEditsError(problem) {
  const box = node('div', undefined, 'err-box');
  box.append(mark('failed', 'st', 'Edits not run'), node('p', problem.message));
  if (problem.line !== undefined) { const context = node('pre'); context.append(node('span', `${problem.line}\n`), node('span', problem.caret, 'caret')); box.append(context); }
  $('#edits-error').replaceChildren(box);
  const area = $('#edits'); attr(area, 'aria-invalid', 'true'); area.focus();
}

const activeOperations = new WeakSet();

async function run(button, work, onError) {
  if (!button || typeof work !== 'function') return;
  const busyElement = button.form || button;
  if (activeOperations.has(busyElement)) return;

  const wasDisabled = button.disabled;
  const previousAriaBusy = busyElement.getAttribute('aria-busy');

  activeOperations.add(busyElement);
  button.disabled = true;
  busyElement.setAttribute('aria-busy', 'true');

  message('Working…');

  try {
    await work();
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Request failed';
    message(text);
    if (onError) onError(text);
  } finally {
    if (previousAriaBusy === null) {
      busyElement.removeAttribute('aria-busy');
    } else {
      busyElement.setAttribute('aria-busy', previousAriaBusy);
    }
    button.disabled = wasDisabled;
    activeOperations.delete(busyElement);
  }
}

$('#connect-form').onsubmit = event => {
  event.preventDefault(); const button = event.submitter;
  run(button, async () => { await api('/api/projects', { repository: $('#repository').value }); await refresh(); $('#connect-form').reset(); message('GitHub repository connected.'); });
};
const filterElem = $('#filter-project');
if (filterElem) {
  filterElem.onchange = () => {
    selectedProjectId = filterElem.value;
    render();
  };
}
rememberFocus($('#new-task'), 'new-task', ['workflow-heading']);
$('#new-task').onclick = event => openDialog($('#task-dialog'), event.currentTarget);
$('#close-task').onclick = () => closeDialog($('#task-dialog'));
$('#cancel-task').onclick = () => closeDialog($('#task-dialog'));
$('#close-plan').onclick = () => closeDialog($('#plan-dialog'));
$('#close-run').onclick = () => closeDialog($('#run-dialog'));
$('#cancel-run').onclick = () => closeDialog($('#run-dialog'));
for (const id of ['task-dialog', 'plan-dialog', 'run-dialog']) {
  const dialog = $(`#${id}`);
  // Native Escape, close buttons and successful submissions share this event.
  dialog.onclose = () => {
    if (dialog.open) return;
    const target = dialogTriggers.get(dialog);
    dialogTriggers.delete(dialog);
    if (!document.querySelector('dialog[open]')) restoreFocus(target);
  };
}
$('#edits').oninput = () => clearEditsError();
$('#run-form').onsubmit = event => {
  event.preventDefault();
  const problem = diagnoseEdits($('#edits').value);
  if (problem) { showEditsError(problem); return; }
  clearEditsError();
  run(event.submitter, async () => {
    const edits = JSON.parse($('#edits').value);
    await api(`/api/tasks/${runTask.id}/runs`, { version: runTask.version, edits });
    closeDialog($('#run-dialog')); await refresh(); message('Runner started. Results update automatically.');
  }, text => showEditsError({ message: text }));
};
$('#task-form').onsubmit = event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const created = await api('/api/tasks', Object.fromEntries(new FormData(event.target)));
    // Show the new task's record, even when the repository filter would hide it.
    selectedTaskId = created.id;
    if (selectedProjectId !== 'all' && selectedProjectId !== created.project_id) { selectedProjectId = 'all'; $('#filter-project').value = 'all'; }
    closeDialog($('#task-dialog')); event.target.reset(); await refresh(); message('Workflow task created.');
  });
};
refresh().catch(error => message(error.message));
setInterval(async () => {
  if (!state?.runs?.some(isActive) || document.querySelector('dialog[open]')) return;
  try {
    applyState(await api('/api/state'));
  } catch (error) { message(error.message); }
}, 1500);
