import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from '../src/store.mjs';
import { Runner } from '../src/runner.mjs';
import { git, command } from '../src/runner-process.mjs';
import { createApp } from '../src/server.mjs';
import { buildEvidence, serializeEvidence, parseBundle, EvidenceInputError, VERIFY_GIT_ENV, STATEMENT_TYPE, PREDICATE_TYPE, plainText, formatJson } from '../src/evidence.mjs';

const cli = fileURLToPath(new URL('../scripts/evidence.mjs', import.meta.url));
const execute = async args => {
  const result = await command(process.execPath, [cli, ...args], { timeout: 90000 });
  return { code: result.code, out: result.stdout.toString(), err: result.stderr.toString() };
};
const sha256 = text => createHash('sha256').update(text).digest('hex');
const edit = { path: 'hello.mjs', before: '"helo"', after: '"hello"' };

// The same three files as `npm run demo:runner` creates.
async function fixture(t, edits = [edit], extraFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forge evidence fixture '));
  const source = join(root, 'demo repository'); await mkdir(source);
  await writeFile(join(source, 'hello.mjs'), 'export const greeting = "helo";\n');
  await writeFile(join(source, 'package.json'), '{"name":"forge-runner-demo","private":true}\n');
  await writeFile(join(source, 'README.md'), '# Local runner fixture\n\nA disposable demonstration repository.\n');
  for (const [name, content] of Object.entries(extraFiles)) await writeFile(join(source, name), content);
  await git(['init', '--quiet', '-b', 'main'], { cwd: source });
  await git(['add', '--all'], { cwd: source });
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'Runner fixture'], { cwd: source });
  const sha = (await git(['rev-parse', 'HEAD'], { cwd: source })).toString().trim();
  const database = join(root, 'data', 'forge.sqlite');
  const store = openStore(database);
  const project = store.connect({ id: -1, full_name: 'local/runner-demo', html_url: '', description: '', default_branch: 'main', private: false, source_kind: 'local' });
  let task = store.createTask({ projectId: project.id, title: 'Fix spelling', intent: 'Use "hello" in the greeting', adapter: 'github' });
  for (const status of ['planned', 'in_review', 'approved']) task = store.transition(task.id, task.version, status, { mode: 'dry-run' });
  const runner = new Runner({ store, localRepositories: { 'local/runner-demo': source } });
  t.after(async () => { await runner.close(); try { store.close(); } catch { /* a test may have closed it */ } await rm(root, { recursive: true, force: true }); });
  const started = runner.start(task.id, { version: task.version, edits });
  await runner.jobs.get(started.id).promise;
  const run = store.getRun(started.id);
  const bundle = JSON.parse(serializeEvidence(buildEvidence(store, run.id)));
  const write = async (value, name = 'bundle.json') => {
    const file = join(root, name);
    await writeFile(file, typeof value === 'string' ? value : serializeEvidence(value));
    return file;
  };
  const verify = async (value, extra = []) => execute(['verify', await write(value), '--repo', source, ...extra]);
  return { root, source, sha, store, runner, run, bundle, database, write, verify };
}
// A tampered bundle whose hash fields are made consistent with its new patch text.
const rehash = bundle => {
  const text = bundle.predicate.patch.text;
  bundle.predicate.patch.sha256 = sha256(text); bundle.predicate.patch.bytes = Buffer.byteLength(text);
  bundle.subject[0].digest.sha256 = bundle.predicate.patch.sha256;
  return bundle;
};
const rowsOf = output => JSON.parse(output).claims;
const row = (rows, claim) => rows.find(r => r.claim === claim);
async function treeState(directory) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    entries.push([path, entry.isDirectory() ? 'dir' : info.size, entry.isDirectory() ? 0 : info.mtimeMs]);
  }
  return entries.sort((a, b) => a[0] < b[0] ? -1 : 1);
}

test('1. a passed run exports and verifies against the demo repository: every verifiable claim matches', async t => {
  const f = await fixture(t);
  assert.equal(f.run.status, 'passed', f.run.summary);
  assert.equal(f.bundle._type, STATEMENT_TYPE);
  assert.equal(f.bundle.predicateType, PREDICATE_TYPE);
  assert.equal(f.bundle.subject[0].name, `local/runner-demo@${f.sha}.patch`);
  assert.equal(f.bundle.subject[0].digest.sha256, f.run.patch_sha256);
  const p = f.bundle.predicate;
  assert.deepEqual(p.repository, { fullName: 'local/runner-demo', sourceKind: 'local' });
  assert.deepEqual(p.base, { commit: f.sha });
  assert.equal(p.patch.text, f.run.patch);
  assert.equal(p.patch.bytes, Buffer.byteLength(f.run.patch));
  assert.deepEqual(p.checks.map(c => c.name), ['edit:hello.mjs', 'conflicts:hello.mjs', 'syntax:hello.mjs', 'diff-whitespace']);
  assert.ok(p.notRun.includes('project tests'));
  assert.equal(p.run.id, f.run.id);
  assert.equal(p.record.intent.title, 'Fix spelling');
  assert.match(p.record.planApprovedAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(p.record.events.every(e => Object.keys(e).sort().join() === 'at,kind'));
  assert.equal(p.tool.name, 'voyagerroc-forge');
  assert.equal(p.limits.length, 3);
  assert.match(JSON.stringify(f.bundle), /not signed/i);

  const result = await f.verify(f.bundle, ['--json']);
  assert.equal(result.code, 0, result.out + result.err);
  const rows = rowsOf(result.out);
  for (const claim of ['patch SHA-256', 'patch size', 'subject digest', 'base commit', 'patch applies to base commit',
    'check edit:hello.mjs', 'check conflicts:hello.mjs', 'check syntax:hello.mjs', 'check diff-whitespace'])
    assert.equal(row(rows, claim)?.result, 'MATCH', claim);
  assert.equal(row(rows, 'plan approval time').result, 'RECORDED NOT VERIFIABLE');
  assert.equal(row(rows, 'intent').result, 'RECORDED NOT VERIFIABLE');
  assert.ok(!rows.some(r => r.result === 'MISMATCH'));

  const table = await f.verify(f.bundle);
  assert.equal(table.code, 0);
  assert.match(table.out, /MATCH/); assert.match(table.out, /RECORDED NOT VERIFIABLE/);
  assert.match(table.out, /not signed/i);
  assert.equal(table.out.trim().split('\n').at(-1).includes('0 mismatched'), true, table.out);
});

test('1b. the export command reads a database that a live server holds open and its output verifies', async t => {
  const f = await fixture(t);
  const out = join(f.root, 'exported.json');
  const exported = await execute(['export', '--run', f.run.id, '--db', f.database, '--out', out]);
  assert.equal(exported.code, 0, exported.err);
  assert.equal(await readFile(out, 'utf8'), serializeEvidence(buildEvidence(f.store, f.run.id)));
  const verified = await execute(['verify', out, '--repo', f.source]);
  assert.equal(verified.code, 0, verified.out + verified.err);
  assert.equal((await execute(['export', '--run', f.run.id, '--db', f.database, '--out', out])).code, 2, 'an existing file is not overwritten');
  assert.equal((await execute(['export', '--run', '00000000-0000-4000-8000-000000000000', '--db', f.database])).code, 2);
  assert.equal((await execute(['export', '--run', f.run.id, '--db', join(f.root, 'missing.sqlite')])).code, 2);
});

test('2. exporting the same run twice gives byte-identical files with sorted keys, two-space indentation and a final newline', async t => {
  const f = await fixture(t);
  const first = serializeEvidence(buildEvidence(f.store, f.run.id));
  const second = serializeEvidence(buildEvidence(f.store, f.run.id));
  assert.equal(first, second);
  assert.ok(first.endsWith('}\n') && !first.endsWith('\n\n'));
  assert.match(first, /^{\n  "_type": /);
  const sorted = value => {
    if (Array.isArray(value)) return value.every(sorted);
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      return keys.every((k, i) => i === 0 || keys[i - 1] < k) && Object.values(value).every(sorted);
    }
    return true;
  };
  assert.ok(sorted(JSON.parse(first)));
  assert.equal(serializeEvidence({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }), '{\n  "a": {\n    "c": null,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
  const a = join(f.root, 'a.json'); const b = join(f.root, 'b.json');
  await execute(['export', '--run', f.run.id, '--db', f.database, '--out', a]);
  await execute(['export', '--run', f.run.id, '--db', f.database, '--out', b]);
  assert.deepEqual(await readFile(a), await readFile(b));
  assert.deepEqual(await readFile(a), Buffer.from(first));
});

test('3. a one character change in the patch text is a hash mismatch', async t => {
  const f = await fixture(t);
  f.bundle.predicate.patch.text = f.bundle.predicate.patch.text.replace('+export const greeting = "hello";', '+export const greeting = "hellp";');
  const result = await f.verify(f.bundle, ['--json']);
  assert.equal(result.code, 1);
  assert.equal(row(rowsOf(result.out), 'patch SHA-256').result, 'MISMATCH');
});

test('4. a recorded hash that matches a different patch text is still caught by applying and re-checking', async t => {
  const changed = await fixture(t);
  changed.bundle.predicate.patch.text = changed.bundle.predicate.patch.text.replace('+export const greeting = "hello";', '+export const greeting = "hullo";');
  rehash(changed.bundle);
  const first = await changed.verify(changed.bundle, ['--json']);
  assert.equal(first.code, 1, first.out);
  const rows = rowsOf(first.out);
  assert.equal(row(rows, 'patch SHA-256').result, 'MATCH');
  assert.equal(row(rows, 'check edit:hello.mjs').result, 'MISMATCH');

  const broken = await fixture(t);
  broken.bundle.predicate.patch.text = broken.bundle.predicate.patch.text.replace('-export const greeting = "helo";', '-export const greeting = "xelo";');
  rehash(broken.bundle);
  const second = await broken.verify(broken.bundle, ['--json']);
  assert.equal(second.code, 1, second.out);
  assert.equal(row(rowsOf(second.out), 'patch SHA-256').result, 'MATCH');
  assert.equal(row(rowsOf(second.out), 'patch applies to base commit').result, 'MISMATCH');
});

test('5. a check recorded as passed that fails when re-run is named in the mismatch', async t => {
  const f = await fixture(t, [{ path: 'hello.mjs', before: '"helo"', after: '"hello"; }' }]);
  assert.equal(f.run.status, 'failed');
  const honest = await f.verify(f.bundle, ['--json']);
  assert.equal(honest.code, 0, 'an honest failed run still verifies: the recorded failure is reproduced');
  assert.equal(row(rowsOf(honest.out), 'check syntax:hello.mjs').result, 'MATCH');

  const forged = structuredClone(f.bundle);
  forged.predicate.checks.find(c => c.name === 'syntax:hello.mjs').status = 'passed';
  forged.predicate.run.status = 'passed'; // a forgery that agrees with itself, so only re-running can catch it
  const result = await f.verify(forged, ['--json']);
  assert.equal(result.code, 1);
  const entry = row(rowsOf(result.out), 'check syntax:hello.mjs');
  assert.equal(entry.result, 'MISMATCH');
  assert.match(entry.detail, /recorded passed.*failed/);
  const text = await f.verify(forged);
  assert.match(text.out, /syntax:hello\.mjs/);

  forged.predicate.run.status = 'passed';
  forged.predicate.checks = forged.predicate.checks.filter(c => c.name !== 'syntax:hello.mjs');
  const omitted = await f.verify(forged, ['--json']);
  assert.equal(omitted.code, 1);
  assert.equal(row(rowsOf(omitted.out), 'check syntax:hello.mjs').result, 'MISMATCH', 'a check removed from the bundle is still recomputed');
});

test('5b. a passed run whose recorded checks contain a failure is inconsistent', async t => {
  const f = await fixture(t);
  f.bundle.predicate.checks[1].status = 'failed';
  const result = await f.verify(f.bundle, ['--json']);
  assert.equal(result.code, 1);
  assert.equal(row(rowsOf(result.out), 'run status matches checks').result, 'MISMATCH');
});

test('6. a base commit where the patch does not apply is a mismatch', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'hello.mjs'), 'export const greeting = "hola";\n');
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-am', 'Another greeting'], { cwd: f.source });
  const other = (await git(['rev-parse', 'HEAD'], { cwd: f.source })).toString().trim();
  f.bundle.predicate.base.commit = other;
  f.bundle.subject[0].name = `local/runner-demo@${other}.patch`;
  const result = await f.verify(f.bundle, ['--json']);
  assert.equal(result.code, 1);
  const entry = row(rowsOf(result.out), 'patch applies to base commit');
  assert.equal(entry.result, 'MISMATCH'); assert.match(entry.detail, /does not apply/);
  f.bundle.predicate.base.commit = 'f'.repeat(40);
  f.bundle.subject[0].name = `local/runner-demo@${'f'.repeat(40)}.patch`;
  const missing = await f.verify(f.bundle, ['--json']);
  assert.equal(missing.code, 1);
  assert.equal(row(rowsOf(missing.out), 'base commit').result, 'MISMATCH');
});

test('7. unusable input exits 2 with a plain message and no stack trace', async t => {
  const f = await fixture(t);
  const cases = {
    'malformed JSON': '{"_type":',
    'a JSON array': '[]',
    'an unknown _type': serializeEvidence({ ...f.bundle, _type: 'https://in-toto.io/Statement/v0.1' }),
    'an unknown predicate version': serializeEvidence({ ...f.bundle, predicateType: PREDICATE_TYPE.replace('#v1', '#v2') }),
    'a foreign predicate type': serializeEvidence({ ...f.bundle, predicateType: 'https://example.com/other' }),
    'a missing predicate': serializeEvidence({ _type: STATEMENT_TYPE, predicateType: PREDICATE_TYPE, subject: f.bundle.subject }),
    'a bad base commit': serializeEvidence({ ...f.bundle, predicate: { ...f.bundle.predicate, base: { commit: '--upload-pack=x' } } }),
    'an oversized file': ' '.repeat(9 * 1024 * 1024),
  };
  for (const [name, content] of Object.entries(cases)) {
    const result = await f.verify(content);
    assert.equal(result.code, 2, `${name}: ${result.out}${result.err}`);
    assert.ok(result.err.trim().length > 0, name);
    assert.doesNotMatch(result.err + result.out, /\n\s+at\s/, `${name} must not print a stack`);
  }
  assert.equal((await execute(['verify', join(f.root, 'nope.json'), '--repo', f.source])).code, 2);
  const file = await f.write(f.bundle);
  assert.equal((await execute(['verify', file])).code, 2, 'repository is required');
  assert.equal((await execute(['verify', file, '--repo', f.root])).code, 2, 'not a Git repository');
  assert.equal((await execute(['verify'])).code, 2);
});

const patchFor = (path, extra = 'new file mode 100644\n') =>
  `diff --git a/${path} b/${path}\n${extra}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;

test('renderer escapes Unicode format characters without changing printable text', () => {
  const format = [0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xe0041].map(code => String.fromCodePoint(code)).join('');
  assert.equal(plainText(`a${format}b`), 'a\\u00ad\\u200b\\u200c\\u200d\\u2060\\ufeff\\u{e0041}b');
  assert.equal(plainText('é日本語😀'), 'é日本語😀');

  const encoded = formatJson({ text: `a${format}b`, printable: 'é日本語😀' });
  assert.equal(/\p{Cf}/u.test(encoded), false);
  assert.match(encoded, /\\udb40\\udc41/);
  assert.deepEqual(JSON.parse(encoded), { text: `a${format}b`, printable: 'é日本語😀' });
});

test('7b. text from the bundle cannot change the table: escape sequences and line breaks are shown as escapes', async t => {
  const f = await fixture(t);
  const c = (...codes) => String.fromCharCode(...codes);
  const ESC = c(27), LF = c(10), CR = c(13);
  const baseline = await f.verify(f.bundle);
  assert.equal(baseline.code, 0, baseline.out + baseline.err);
  const baseLines = baseline.out.trimEnd().split(LF).length;

  const hostile = structuredClone(f.bundle);
  const p = hostile.predicate;
  p.repository.fullName = 'x' + LF + ESC + '[8m' + ESC + '[2K' + c(0x9b) + '31m' + c(0x202e);
  hostile.subject[0].name = p.repository.fullName + '@' + f.sha + '.patch';
  p.tool.version = '1' + LF + 'MATCH  forged row' + CR + ESC + '[8m';
  p.record.planApprovedAt = '2026-01-01' + c(0x2028) + 'MATCH  second forged row';
  p.record.events.findLast(e => e.kind === 'task.approved').at = p.record.planApprovedAt; // keep the record consistent
  const result = await f.verify(hostile);
  assert.equal(result.code, 0, result.out + result.err);
  const unsafe = new RegExp('[' + c(0, 45, 9) + c(11, 45, 31, 127, 45, 0x9f, 0x2028, 0x2029, 0x202a, 45, 0x202e, 0x2066, 45, 0x2069) + ']');
  assert.equal(unsafe.test(result.out), false, 'no control character reaches the table');
  assert.ok(result.out.includes(c(92) + 'u001b[8m'));
  assert.equal(result.out.includes(CR), false);
  assert.equal(result.out.trimEnd().split(LF).length, baseLines, 'no row is made from a line break');
  assert.ok(result.out.trimEnd().split(LF).at(-1).includes('mismatched'));

  // A check name from the bundle is shown too: here in the row that reports it as an unknown check.
  const named = structuredClone(f.bundle);
  named.predicate.checks.push({ name: 'note:' + ESC + '[8m' + LF + 'MATCH  third forged row', status: 'passed', detail: 'x' });
  const unknown = await f.verify(named);
  assert.equal(unknown.code, 1, unknown.out + unknown.err);
  assert.equal(unsafe.test(unknown.out), false);
  assert.equal(unknown.out.split(LF).filter(line => line.startsWith('check note:')).length, 1, 'one row for the unknown check, none forged from its name');
  assert.ok(!unknown.out.split(LF).some(line => line.startsWith('MATCH')));
  const json = await f.verify(hostile, ['--json']);
  assert.equal(json.code, 0);
  assert.match(rowsOf(json.out).find(r => r.claim === 'tool version').detail, /MATCH {2}forged row/);

  for (const [mutate, message] of [
    [b => { b.predicate.tool.name = { x: 1 }; }, /tool must hold a name/],
    [b => { b.predicate.record.planApprovedAt = { x: 1 }; }, /planApprovedAt/],
    [b => { b.predicate.notRun = []; }, /project tests/],
    [b => { b.predicate.limits = [1]; }, /limits/]
  ]) {
    const broken = structuredClone(f.bundle); mutate(broken);
    const bad = await f.verify(broken);
    assert.equal(bad.code, 2);
    assert.match(bad.err, message);
  }
});

test('8. a patch that leaves the workspace, touches .git or changes modes and renames is refused', async t => {
  const f = await fixture(t);
  const before = await treeState(f.source);
  const hostile = {
    '.git/config': patchFor('.git/config'),
    'a nested .GIT folder': patchFor('docs/.GIT/hooks/pre-commit'),
    'a parent directory': patchFor('../outside.txt'),
    'a double parent directory': patchFor('src/../../outside.txt'),
    'an absolute path': patchFor('/etc/outside.txt'),
    'a backslash path': patchFor('docs\\x.txt'),
    'a symlink': patchFor('link', 'new file mode 120000\n'),
    'a rename': 'diff --git a/hello.mjs b/moved.mjs\nsimilarity index 100%\nrename from hello.mjs\nrename to moved.mjs\n',
    'a deletion': 'diff --git a/hello.mjs b/hello.mjs\ndeleted file mode 100644\n--- a/hello.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const greeting = "helo";\n',
    'a header that names two different paths': patchFor('ok.txt').replace('+++ b/ok.txt', '+++ b/../x.txt').replace('b/ok.txt\n', 'b/other.txt\n'),
    'no file headers at all': '--- a/hello.mjs\n+++ b/hello.mjs\n',
  };
  for (const [name, text] of Object.entries(hostile)) {
    const bundle = structuredClone(f.bundle);
    bundle.predicate.patch.text = text;
    rehash(bundle);
    const result = await f.verify(bundle);
    assert.equal(result.code, 2, `${name}: ${result.out}${result.err}`);
    assert.match(result.err, /refus/i, name);
    assert.doesNotMatch(result.err, /\n\s+at\s/, name);
  }
  const tooMany = structuredClone(f.bundle);
  tooMany.predicate.patch.text = Array.from({ length: 21 }, (_, i) => patchFor(`f${i}.txt`)).join('');
  rehash(tooMany);
  assert.equal((await f.verify(tooMany)).code, 2);
  assert.deepEqual(await treeState(f.source), before, 'the repository given with --repo is never written');
});

test('8b. verification leaves the repository byte-for-byte untouched, also when it reports a mismatch', async t => {
  const f = await fixture(t);
  const before = await treeState(f.source);
  assert.equal((await f.verify(f.bundle)).code, 0);
  f.bundle.predicate.patch.text += ' ';
  assert.equal((await f.verify(f.bundle)).code, 1);
  assert.deepEqual(await treeState(f.source), before);
  assert.equal((await git(['status', '--porcelain'], { cwd: f.source })).toString(), '');
});

test('9. a failed run without a patch exports without a digest and verifies as having nothing to recompute', async t => {
  const f = await fixture(t, [{ path: 'hello.mjs', before: '"does not occur"', after: '"x"' }]);
  assert.equal(f.run.status, 'failed');
  const p = f.bundle.predicate;
  assert.equal(p.patch, null);
  assert.equal(f.bundle.subject.length, 1);
  assert.equal('digest' in f.bundle.subject[0], false);
  assert.match(p.patchAbsentReason, /no patch/i);
  assert.equal(p.run.status, 'failed');
  const result = await f.verify(f.bundle, ['--json']);
  assert.equal(result.code, 0, result.out + result.err);
  const patch = row(rowsOf(result.out), 'patch');
  assert.equal(patch.result, 'RECORDED NOT VERIFIABLE'); assert.match(patch.detail, /nothing to recompute/i);
  const text = await f.verify(f.bundle);
  assert.match(text.out, /nothing to recompute/i);
  f.bundle.predicate.run.status = 'passed';
  assert.equal((await f.verify(f.bundle)).code, 1, 'a run claimed as passed needs a patch');
});

test('9b. runs that are cancelled, timed out or interrupted export too; absent values are omitted, never invented', async t => {
  const f = await fixture(t);
  const store = openStore(':memory:'); t.after(() => store.close());
  const project = store.connect({ id: -2, full_name: 'local/other', html_url: '', description: '', default_branch: 'main', private: false, source_kind: 'local' });
  let task = store.createTask({ projectId: project.id, title: 'T', intent: 'I', adapter: 'github' });
  for (const status of ['planned', 'in_review', 'approved']) task = store.transition(task.id, task.version, status, { mode: 'dry-run' });
  const run = store.createRun(task.id, task.version);
  assert.throws(() => buildEvidence(store, run.id), error => error.status === 409);
  store.recoverRuns();
  const bundle = buildEvidence(store, run.id);
  assert.equal(bundle.predicate.run.status, 'interrupted');
  assert.equal('base' in bundle.predicate, false, 'an absent base is omitted, not written as null');
  assert.equal(bundle.subject[0].name, `local/other@${run.id}.patch`, 'no invented "unknown" in the subject name');
  assert.doesNotMatch(serializeEvidence(bundle), /unknown|"base"/);
  assert.equal(bundle.predicate.patch, null);
  assert.throws(() => buildEvidence(store, '00000000-0000-4000-8000-000000000000'), error => error.status === 404);
  assert.ok(f.run);
});

test('10. the API route returns the bundle, 404 for an unknown run, 409 for a run in flight and 403 for a foreign Host', async t => {
  const f = await fixture(t);
  const app = createApp({ store: f.store, runner: f.runner });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(done => app.close(done)));
  const { port } = app.address();
  const get = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
  const ok = await get(`/api/runs/${f.run.id}/evidence`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /^application\/json/);
  assert.match(ok.headers['content-disposition'], new RegExp(`^attachment; filename="forge-evidence-${f.run.id}\\.json"$`));
  assert.equal(ok.body, serializeEvidence(buildEvidence(f.store, f.run.id)));
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(ok.body)._type, STATEMENT_TYPE);

  assert.equal((await get('/api/runs/00000000-0000-4000-8000-000000000000/evidence')).status, 404);

  let task = f.store.getTask(f.run.task_id);
  const other = f.store.createTask({ projectId: task.project_id, title: 'Second', intent: 'Second', adapter: 'github' });
  for (const status of ['planned', 'in_review', 'approved']) task = f.store.transition(other.id, f.store.getTask(other.id).version, status, { mode: 'dry-run' });
  const pending = f.store.createRun(other.id, f.store.getTask(other.id).version);
  const flight = await get(`/api/runs/${pending.id}/evidence`);
  assert.equal(flight.status, 409);
  assert.match(JSON.parse(flight.body).error, /in progress/i);

  for (const host of ['evil.test', `evil.test:${port}`, `127.0.0.1.evil.test:${port}`])
    assert.equal((await get(`/api/runs/${f.run.id}/evidence`, { Host: host })).status, 403, host);
  assert.notEqual((await get(`/api/runs/${f.run.id}/evidence`, {}, 'POST')).status, 200);
});

// ---- Rules added after the second review round (E1 to E10) ----
const unsafeChars = new RegExp('[' + [[0x7f, 0x9f], [0x61c], [0x200e, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]
  .map(range => range.map(code => String.fromCharCode(code)).join('-')).join('') + ']');
const readDoc = async file => readFile(new URL(file, import.meta.url), 'utf8');

test('E1. file names that Git quotes in diff headers (non-ASCII, spaces) export and verify with exit 0', async t => {
  const f = await fixture(t, [
    { path: 'çalışma.md', before: 'eski', after: 'yeni' },
    { path: 'my notes.md', before: null, after: 'a new file with a space in its name\n' },
    { path: 'docs/ünlü dosya.txt', before: null, after: 'x\n' }
  ], { 'çalışma.md': 'eski\n' });
  assert.equal(f.run.status, 'passed', f.run.summary);
  assert.match(f.run.patch, /^diff --git "a\/\\303\\247al/m, 'Git quotes the non-ASCII name in the header');
  const result = await f.verify(f.bundle, ['--json']);
  assert.equal(result.code, 0, result.out + result.err);
  const rows = rowsOf(result.out);
  assert.equal(row(rows, 'patch applies to base commit').result, 'MATCH');
  assert.match(row(rows, 'patch applies to base commit').detail, /3 files changed/);
  for (const name of ['çalışma.md', 'my notes.md', 'docs/ünlü dosya.txt']) assert.equal(row(rows, `check edit:${name}`)?.result, 'MATCH', name);
  // The names come from Git, not from the header text: a header that lies about its path is still refused.
  const lying = structuredClone(f.bundle);
  lying.predicate.patch.text = lying.predicate.patch.text.replace('+++ b/my notes.md', '+++ b/.git/config');
  rehash(lying);
  const refused = await f.verify(lying);
  assert.equal(refused.code, 2, refused.out + refused.err);
});

test('E2. exporting from a closed database does not change its main file and leaves at most the WAL side files', async t => {
  const f = await fixture(t);
  const directory = join(f.database, '..');
  f.store.close();
  const before = await readFile(f.database);
  const namesBefore = (await readdir(directory)).sort();
  const result = await execute(['export', '--run', f.run.id, '--db', f.database]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(await readFile(f.database), before, 'the database file itself is never written');
  const created = (await readdir(directory)).filter(name => !namesBefore.includes(name));
  assert.ok(created.every(name => ['forge.sqlite-shm', 'forge.sqlite-wal'].includes(name)), `unexpected files: ${created}`);
  const docs = await readDoc('../docs/EVIDENCE.md');
  const store = await readDoc('../src/store.mjs');
  assert.doesNotMatch(docs + store, /without creating or migrating anything/);
  assert.match(docs, /-shm/); assert.match(docs, /-wal/);
});

test('E3. a bundle that is not in canonical form is refused with exit 2 and says how to get one', async t => {
  const f = await fixture(t);
  const canonical = serializeEvidence(f.bundle);
  const typeLine = `  "_type": "${STATEMENT_TYPE}",\n`;
  const { _type, predicateType, ...rest } = f.bundle;
  const cases = {
    'a duplicate key': canonical.replace(typeLine, typeLine + typeLine),
    'reordered keys': JSON.stringify({ predicateType, ...rest, _type }, null, 2) + '\n',
    'compact whitespace': JSON.stringify(f.bundle),
    'four-space indentation': JSON.stringify(f.bundle, null, 4) + '\n',
    'a missing final newline': canonical.trimEnd(),
    'an extra blank line at the end': canonical + '\n',
    'an escape where Forge writes the character itself': canonical.replace('"voyagerroc-forge"', '"voyagerroc\\u002dforge"')
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.notEqual(text, canonical, name);
    const result = await f.verify(text);
    assert.equal(result.code, 2, `${name}: ${result.out}${result.err}`);
    assert.match(result.err, /not in canonical form/, name);
    assert.match(result.err, /evidence:export/, name);
  }
  const crlf = await f.verify(canonical.replaceAll('\n', '\r\n'));
  assert.equal(crlf.code, 0, 'line endings are normalised to LF before the comparison: ' + crlf.out + crlf.err);
});

test('E4. contradictions inside the bundle are mismatches with exit 1, found before anything is re-run', async t => {
  const f = await fixture(t);
  const failed = await fixture(t, [{ path: 'hello.mjs', before: '"helo"', after: '"hello"; }' }]);
  assert.equal(failed.run.status, 'failed');
  const cases = [
    [failed, 'a failed run with a patch and every check passed', b => { b.predicate.checks.forEach(c => { c.status = 'passed'; }); }, 'run status matches checks'],
    [f, 'a failed run with a patch and every check passed (status flipped instead)', b => { b.predicate.run.status = 'failed'; }, 'run status matches checks'],
    [f, 'a passed run with a failed check', b => { b.predicate.checks[0].status = 'failed'; }, 'run status matches checks'],
    [f, 'a passed run with no recorded checks', b => { b.predicate.checks = []; }, 'run status matches checks'],
    [f, 'a patch without a base commit', b => { delete b.predicate.base; b.subject[0].name = `local/runner-demo@${b.predicate.run.id}.patch`; }, 'patch has a base commit'],
    [f, 'a bytes field that differs from the text length', b => { b.predicate.patch.bytes += 1; }, 'patch size'],
    [f, 'a SHA-256 that differs from the text', b => { b.predicate.patch.sha256 = 'a'.repeat(64); b.subject[0].digest.sha256 = 'a'.repeat(64); }, 'patch SHA-256'],
    [f, 'a subject digest that differs from the recorded hash', b => { b.subject[0].digest.sha256 = 'b'.repeat(64); }, 'subject digest'],
    [f, 'a patch together with a reason for its absence', b => { b.predicate.patchAbsentReason = 'none'; }, 'patch absent reason'],
    [f, 'an approval time that no event carries', b => { b.predicate.record.planApprovedAt = '2000-01-01T00:00:00.000Z'; }, 'plan approval time matches events'],
    [f, 'an approval event without an approval time', b => { delete b.predicate.record.planApprovedAt; }, 'plan approval time matches events'],
    [f, 'a passed run without a patch', b => { b.predicate.patch = null; delete b.subject[0].digest; }, 'run status matches checks']
  ];
  for (const [fx, name, mutate, claim] of cases) {
    const bundle = structuredClone(fx.bundle); mutate(bundle);
    const result = await fx.verify(bundle, ['--json']);
    assert.equal(result.code, 1, `${name}: ${result.out}${result.err}`);
    const rows = rowsOf(result.out);
    assert.equal(row(rows, claim)?.result, 'MISMATCH', `${name}: ${JSON.stringify(rows.filter(r => r.result === 'MISMATCH'))}`);
    assert.ok(!rows.some(r => r.claim === 'patch applies to base commit' || r.claim.startsWith('check edit:')), `${name}: nothing is re-run after a contradiction`);
  }
  const honest = await failed.verify(failed.bundle, ['--json']);
  assert.equal(honest.code, 0, 'an honest failed run (a failed check and a patch) is consistent: ' + honest.out + honest.err);
  assert.equal(row(rowsOf(honest.out), 'run status matches checks').result, 'MATCH');
  assert.match(await readDoc('../docs/EVIDENCE.md'), /Internal consistency/);
});

test('E5. a check this verifier does not know is a mismatch, never a match; a check that claims a not-run item is one too', async t => {
  const f = await fixture(t);
  for (const [name, check, pattern] of [
    ['an unknown name', { name: 'tests:all', status: 'passed', detail: '1000 passed' }, /unknown check/],
    ['a check named like a not-run item', { name: 'project tests', status: 'passed', detail: '12 passed' }, /not run/],
    ['a check on a file the patch does not change', { name: 'syntax:other.mjs', status: 'passed', detail: 'x' }, /does not change/]
  ]) {
    const bundle = structuredClone(f.bundle); bundle.predicate.checks.push(check);
    const result = await f.verify(bundle, ['--json']);
    assert.equal(result.code, 1, `${name}: ${result.out}${result.err}`);
    const entry = row(rowsOf(result.out), `check ${check.name}`);
    assert.equal(entry?.result, 'MISMATCH', name);
    assert.match(entry.detail, pattern, name);
  }
  assert.ok(!rowsOf((await f.verify(f.bundle, ['--json'])).out).some(r => r.result === 'MISMATCH'));
  const withoutPatch = await fixture(t, [{ path: 'hello.mjs', before: '"does not occur"', after: '"x"' }]);
  withoutPatch.bundle.predicate.checks.push({ name: 'tests:all', status: 'passed', detail: 'x' });
  const none = await withoutPatch.verify(withoutPatch.bundle, ['--json']);
  assert.equal(none.code, 1, 'also when there is no patch');
  assert.match(row(rowsOf(none.out), 'check tests:all').detail, /unknown check/);
  // Forge itself records a failed cleanup check; it cannot be re-run, so it is listed as not verifiable.
  const cleanup = structuredClone(f.bundle);
  cleanup.predicate.run.status = 'failed';
  cleanup.predicate.checks.push({ name: 'cleanup', status: 'failed', detail: 'Temporary workspace cleanup failed; operator cleanup is required.' });
  const cleaned = await f.verify(cleanup, ['--json']);
  assert.equal(cleaned.code, 0, cleaned.out + cleaned.err);
  assert.equal(row(rowsOf(cleaned.out), 'check cleanup').result, 'RECORDED NOT VERIFIABLE');
});

test('E6. absent values are omitted, the subject name has no invented word, patchAbsentReason is documented', async t => {
  const f = await fixture(t);
  const store = openStore(':memory:'); t.after(() => store.close());
  const project = store.connect({ id: -3, full_name: 'local/third', html_url: '', description: '', default_branch: 'main', private: false, source_kind: 'local' });
  let task = store.createTask({ projectId: project.id, title: 'T', intent: 'I', adapter: 'github' });
  for (const status of ['planned', 'in_review', 'approved']) task = store.transition(task.id, task.version, status, { mode: 'dry-run' });
  const run = store.createRun(task.id, task.version); store.recoverRuns();
  const bundle = JSON.parse(serializeEvidence(buildEvidence(store, run.id)));
  assert.equal('base' in bundle.predicate, false);
  assert.equal(bundle.subject[0].name, `local/third@${run.id}.patch`);
  assert.equal(bundle.predicate.patch, null, 'the specification keeps patch: null for a run without a patch');
  const result = await f.verify(bundle, ['--json']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(row(rowsOf(result.out), 'subject name').result, 'MATCH');
  assert.throws(() => parseBundle(serializeEvidence({ ...f.bundle, predicate: { ...f.bundle.predicate, base: null } })), EvidenceInputError);
  assert.match(await readDoc('../docs/EVIDENCE.md'), /\|\s*`predicate\.patchAbsentReason`/);
});

test('E7. the bundle records when the plan was approved, not who approved it, in limits, documentation and output', async t => {
  const f = await fixture(t);
  const claim = /who approved|who approves|approved by|who gave the approval/i;
  assert.doesNotMatch(f.bundle.predicate.limits.join('\n'), claim);
  assert.match(f.bundle.predicate.limits.join('\n'), /not by whom/i);
  assert.doesNotMatch((await f.verify(f.bundle)).out, claim);
  for (const file of ['../docs/EVIDENCE.md', '../src/evidence.mjs', '../scripts/evidence.mjs'])
    assert.doesNotMatch(await readDoc(file), claim, file);
});

test('E8. verification never lets Git fetch into the repository: the environment is fixed and a partial clone is refused untouched', async t => {
  assert.equal(VERIFY_GIT_ENV.GIT_NO_LAZY_FETCH, '1');
  assert.equal(VERIFY_GIT_ENV.GIT_ALLOW_PROTOCOL, 'file');
  const f = await fixture(t);
  await git(['config', 'uploadpack.allowFilter', 'true'], { cwd: f.source });
  await git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: f.source });
  const partial = join(f.root, 'partial clone');
  const cloned = await command('git', ['clone', '--quiet', '--no-checkout', '--filter=blob:none', pathToFileURL(f.source).href, partial], { timeout: 60000 });
  assert.equal(cloned.code, 0, cloned.stderr.toString());
  const objects = async () => (await readdir(join(partial, '.git', 'objects'), { recursive: true })).sort();
  const before = await objects();
  const file = await f.write(f.bundle);
  const result = await execute(['verify', file, '--repo', partial]);
  assert.equal(result.code, 2, result.out + result.err);
  assert.match(result.err, /does not contain the base commit/);
  assert.doesNotMatch(result.err, /\n\s+at\s/);
  assert.deepEqual(await objects(), before, 'no object was downloaded into the repository');
  assert.equal((await execute(['verify', file, '--repo', f.source])).code, 0, 'a full repository still verifies');
  // The environment is what stops Git itself: the same read fails with it and downloads the blob without it.
  const blob = (await git(['ls-tree', '-r', f.sha], { cwd: f.source })).toString().match(/blob (\w+)\s+hello\.mjs/)[1];
  await assert.rejects(git(['cat-file', 'blob', blob], { cwd: partial, env: VERIFY_GIT_ENV }));
  assert.deepEqual(await objects(), before, 'with VERIFY_GIT_ENV Git fetched nothing');
  assert.match((await git(['cat-file', 'blob', blob], { cwd: partial })).toString(), /helo/, 'control: without it Git downloads the blob');
  assert.notDeepEqual(await objects(), before);
});

test('E9. every item of record.events must be an object with a string kind and a string time (at)', async t => {
  const f = await fixture(t);
  for (const [name, item] of [['null', null], ['a number', 7], ['a string', 'task.created'], ['an array', []],
    ['a numeric kind', { kind: 1, at: '2026-01-01T00:00:00.000Z' }], ['a missing time', { kind: 'task.created' }],
    ['a numeric time', { kind: 'task.created', at: 5 }], ['a null time', { kind: 'task.created', at: null }]]) {
    const bundle = structuredClone(f.bundle); bundle.predicate.record.events.push(item);
    assert.throws(() => parseBundle(serializeEvidence(bundle)), error => error instanceof EvidenceInputError && /events/.test(error.message), name);
  }
  const bundle = structuredClone(f.bundle); bundle.predicate.record.events.push(7);
  const result = await f.verify(bundle);
  assert.equal(result.code, 2); assert.match(result.err, /events/);
});

test('E10. --json output cannot carry control, line separator or bidirectional characters either', async t => {
  const f = await fixture(t);
  const c = (...codes) => String.fromCharCode(...codes);
  // JSON.stringify escapes C0 characters, quotes, backslashes and lone surrogates only. It writes DEL, C1,
  // U+2028, U+2029 and the bidirectional controls as they are, so the encoder alone is not enough.
  assert.match(JSON.stringify(c(0x7f, 0x9b, 0x2028, 0x2029, 0x202e, 0x2066, 0x200e)), unsafeChars, 'the plain JSON encoder leaves these characters in place');
  const hostile = structuredClone(f.bundle);
  const text = 'v' + c(0x1b, 0x7f, 0x9b, 0x2028, 0x2029, 0x202e, 0x2066, 0x2069, 0x200f, 0x61c) + 'end';
  hostile.predicate.tool.version = text;
  const result = await f.verify(hostile, ['--json']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(unsafeChars.test(result.out), false, 'no such character reaches the JSON output');
  assert.equal(new RegExp('[' + c(0, 45, 9, 11, 45, 31) + ']').test(result.out), false, 'only the line breaks of the indentation remain');
  assert.ok(rowsOf(result.out).find(r => r.claim === 'tool version').detail.includes(text), 'the escaped JSON still decodes to the original text');
  assert.equal(unsafeChars.test((await f.verify(hostile)).out), false);
});
