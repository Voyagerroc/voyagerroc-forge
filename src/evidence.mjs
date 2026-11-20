// Portable evidence for a finished run, and an independent check of it. See docs/EVIDENCE.md.
// The bundle is shaped as an unsigned in-toto Statement v1 with a Forge-specific predicate.
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, realpath, lstat, readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { git } from './runner-process.mjs';
import { EDIT_LIMITS, editPath, contentChecks } from './edit-worker.mjs';
import { pinSnapshot, syntaxCheck, whitespaceCheck, isJavaScriptPath } from './runner.mjs';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PREDICATE_TYPE = 'https://github.com/Voyagerroc/voyagerroc-forge/blob/main/docs/EVIDENCE.md#v1';
// A patch is bounded by the edit limits plus context lines, but JSON escaping can multiply its size.
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
// Verification reads a repository the user names and must never change it. Git is told not to fetch missing
// objects on demand (partial clones) and to use no transport but local files, so a missing object is an
// error instead of a download. These variables are added to the fixed Git environment of runner-process.
export const VERIFY_GIT_ENV = Object.freeze({ GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'file' });
const gitSafely = (args, options) => git(args, { ...options, env: VERIFY_GIT_ENV });
export const MATCH = 'MATCH';
export const MISMATCH = 'MISMATCH';
export const NOT_VERIFIABLE = 'RECORDED NOT VERIFIABLE';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const FINAL = ['passed', 'failed', 'cancelled', 'timed_out', 'interrupted'];
const LIMITS = Object.freeze([
  'This bundle is not signed. It shows that its parts agree with each other and with the repository, not who produced it.',
  'Forge ran static checks only: it did not run the project tests, install dependencies or execute repository code, so a passed run says nothing about whether the change is correct.',
  'The bundle records when the plan was approved, not by whom; that time, the intent text and every other timestamp are recorded by the Forge server that exported the bundle, and nobody can recompute them, so they are recorded, not verified.'
]);
const NOT_RUN = Object.freeze(['project tests', 'dependency installation', 'execution of repository code']);

// Input the verifier cannot use (exit 2). The message is meant to be shown as it is.
export class EvidenceInputError extends Error { constructor(message) { super(message); this.name = 'EvidenceInputError'; } }
// A well-formed bundle that asks the verifier to do something it never does (exit 2).
export class EvidenceRefusal extends EvidenceInputError {}
const status = (message, code) => Object.assign(new Error(message), { status: code });

// Object keys sorted by UTF-16 code units at every depth, two-space indentation, final newline.
// Array order is kept. The same run therefore always serialises to the same bytes.
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
  : value;
export const serializeEvidence = bundle => `${JSON.stringify(sortKeys(bundle), null, 2)}\n`;

export function buildEvidence(store, runId) {
  const run = store.getRun(runId);
  if (!run) throw status('Run not found', 404);
  if (!FINAL.includes(run.status)) throw status('Run is still in progress; evidence can be exported only for a finished run', 409);
  const task = store.getTask(run.task_id);
  const project = store.getProject(task.project_id);
  const hasPatch = typeof run.patch === 'string' && run.patch.length > 0;
  const events = store.taskEvents(task.id)
    .filter(e => !e.kind.startsWith('run.') || e.detail?.runId === run.id)
    .map(e => ({ kind: e.kind, at: e.created_at }));
  const approved = events.findLast(e => e.kind === 'task.approved');
  const sha256 = hasPatch ? run.patch_sha256 ?? createHash('sha256').update(run.patch).digest('hex') : null;
  const predicate = {
    repository: { fullName: project.full_name, sourceKind: project.source_kind ?? 'github' },
    ...(run.base_sha ? { base: { commit: run.base_sha } } : {}),
    patch: hasPatch ? { sha256, bytes: Buffer.byteLength(run.patch), text: run.patch } : null,
    ...(hasPatch ? {} : { patchAbsentReason: 'The run ended as ' + run.status + ' without producing a patch, so there is no patch hash and nothing to recompute.' }),
    checks: run.checks.map(({ name, status: result, detail }) => ({ name, status: result, detail })),
    notRun: [...NOT_RUN],
    run: { id: run.id, status: run.status, startedAt: run.created_at, ...(run.finished_at ? { finishedAt: run.finished_at } : {}),
      ...(run.summary ? { summary: run.summary } : {}) },
    record: { intent: { title: task.title, text: task.intent }, ...(approved ? { planApprovedAt: approved.at } : {}), events },
    tool: { name: 'voyagerroc-forge', version },
    limits: [...LIMITS]
  };
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: `${project.full_name}@${run.base_sha ?? run.id}.patch`, ...(hasPatch ? { digest: { sha256 } } : {}) }],
    predicateType: PREDICATE_TYPE,
    predicate
  };
}

// The text both the command and the API deliver. A bundle the verifier would refuse to read is not exported.
export function exportEvidence(store, runId) {
  const text = serializeEvidence(buildEvidence(store, runId));
  if (Buffer.byteLength(text) > MAX_BUNDLE_BYTES)
    throw status(`The evidence is larger than ${MAX_BUNDLE_BYTES / (1024 * 1024)} MiB, which the verifier does not accept`, 413);
  return text;
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function parseBundle(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  if (bytes.length > MAX_BUNDLE_BYTES) throw new EvidenceInputError(`The file is larger than ${MAX_BUNDLE_BYTES / (1024 * 1024)} MiB, which is more than a Forge bundle can be.`);
  let bundle;
  try { bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new EvidenceInputError('The file is not valid UTF-8 JSON.'); }
  const bad = what => new EvidenceInputError(`Not a usable Forge evidence bundle: ${what}.`);
  if (!isObject(bundle)) throw bad('the document is not a JSON object');
  if (bundle._type !== STATEMENT_TYPE) throw bad(`_type must be ${STATEMENT_TYPE}`);
  if (bundle.predicateType !== PREDICATE_TYPE) {
    throw bad(String(bundle.predicateType).startsWith(PREDICATE_TYPE.split('#')[0])
      ? `predicate version ${JSON.stringify(String(bundle.predicateType).split('#')[1])} is not supported (this verifier reads v1)`
      : 'predicateType is not the Forge evidence predicate');
  }
  const { subject, predicate: p } = bundle;
  if (!Array.isArray(subject) || subject.length !== 1 || !isObject(subject[0]) || typeof subject[0].name !== 'string') throw bad('subject must hold exactly one named entry');
  if (subject[0].digest !== undefined && !(isObject(subject[0].digest) && typeof subject[0].digest.sha256 === 'string')) throw bad('subject digest must be an object with sha256');
  if (!isObject(p)) throw bad('predicate is missing');
  if (!isObject(p.repository) || typeof p.repository.fullName !== 'string' || typeof p.repository.sourceKind !== 'string') throw bad('repository is incomplete');
  if (p.base !== undefined && !(isObject(p.base) && /^[a-f0-9]{40}$/.test(p.base.commit ?? ''))) throw bad('base must be omitted or hold a 40 character lowercase hex commit');
  if (p.patch !== null && !(isObject(p.patch) && /^[a-f0-9]{64}$/.test(p.patch.sha256 ?? '') && Number.isSafeInteger(p.patch.bytes) &&
      typeof p.patch.text === 'string' && p.patch.text.length > 0)) throw bad('patch must be null or hold sha256, bytes and text');
  if (!Array.isArray(p.checks) || p.checks.length > 200 || !p.checks.every(c => isObject(c) && typeof c.name === 'string' && c.name.length <= 400 &&
      ['passed', 'failed', 'skipped'].includes(c.status) && typeof c.detail === 'string')) throw bad('checks must be a list of name, status and detail');
  if (!Array.isArray(p.notRun) || !p.notRun.every(item => typeof item === 'string') || !p.notRun.includes('project tests')) throw bad('notRun must be a list of strings that includes "project tests"');
  if (!isObject(p.run) || typeof p.run.id !== 'string' || !FINAL.includes(p.run.status)) throw bad('run must hold an id and a final status');
  if (['startedAt', 'finishedAt', 'summary'].some(key => p.run[key] !== undefined && typeof p.run[key] !== 'string')) throw bad('run.startedAt, finishedAt and summary must be strings when present');
  if (p.patchAbsentReason !== undefined && typeof p.patchAbsentReason !== 'string') throw bad('patchAbsentReason must be a string');
  if (!isObject(p.record) || !isObject(p.record.intent) || !Array.isArray(p.record.events)) throw bad('record is incomplete');
  if (p.record.planApprovedAt !== undefined && typeof p.record.planApprovedAt !== 'string') throw bad('record.planApprovedAt must be a string');
  if (!p.record.events.every(e => isObject(e) && typeof e.kind === 'string' && typeof e.at === 'string')) throw bad('every item of record.events must be an object with a string kind and a string at');
  if (!isObject(p.tool) || typeof p.tool.name !== 'string' || typeof p.tool.version !== 'string') throw bad('tool must hold a name and a version');
  if (!Array.isArray(p.limits) || !p.limits.every(item => typeof item === 'string')) throw bad('limits must be a list of strings');
  // Only the form Forge writes is read. A repeated key, another key order or other whitespace could make two
  // readers see two different documents, so the parsed bundle must serialise to exactly the input text.
  if (bytes.toString('utf8').replace(/\r\n/g, '\n') !== serializeEvidence(bundle))
    throw new EvidenceInputError('The bundle is not in canonical form (a repeated key, keys in another order, or changed whitespace or escapes). ' +
      'Verification reads only the form that Forge writes. Get a canonical copy with npm run evidence:export or GET /api/runs/<run id>/evidence, and do not reformat it.');
  return bundle;
}

// Header scan. A Forge patch only ever adds or edits regular text files at paths the edit rules accept.
// Everything else is refused before the patch is applied. This scan looks only at lines that start a header
// (hunk lines always start with a space, + or -, so they can never be taken for one) and counts the file
// headers. The file names themselves are never split out of a header line: Git quotes some names there
// (non-ASCII names, for example, as "a/\303\247..."), so they are taken from Git itself, see patchPaths.
const UNSUPPORTED = /^(?:old mode|new mode|deleted file mode|rename |copy |similarity index|dissimilarity index|GIT binary patch|Binary files )/;
const refuse = why => new EvidenceRefusal(`Refused: ${why}. Nothing was applied.`);
export function scanPatchHeaders(text) {
  let headers = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) headers++;
    else if (UNSUPPORTED.test(line)) {
      throw refuse(`the patch uses ${JSON.stringify(line.slice(0, 40))}, which Forge never produces`);
    } else {
      const mode = line.match(/^new file mode (\S+)/)?.[1] ?? line.match(/^index [0-9a-f]+\.\.[0-9a-f]+ (\S+)/)?.[1];
      if (mode !== undefined && !['100644', '100755'].includes(mode)) throw refuse(`file mode ${mode} is not a regular file`);
    }
  }
  if (!headers) throw refuse('the patch has no git diff header');
  if (headers > EDIT_LIMITS.maxCount) throw refuse(`the patch touches more than ${EDIT_LIMITS.maxCount} files`);
  return headers;
}

// The paths the patch changes, as Git reads them. `git apply --numstat -z` prints each name raw, with no
// quoting and no escapes, and it runs outside any repository, in an empty directory, so it reads nothing.
export async function patchPaths(text, directory, signal) {
  const headers = scanPatchHeaders(text);
  let output;
  try { output = (await gitSafely(['apply', '--numstat', '-z'], { cwd: directory, signal, input: text })).toString('utf8'); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw refuse('Git cannot read the patch as a unified diff');
  }
  const paths = output.split('\0').filter(Boolean).map(entry => {
    const match = entry.match(/^(\d+)\t(\d+)\t([\s\S]+)$/);
    if (!match) throw refuse('the patch changes a binary file, or names a file in a form Forge never produces');
    return match[3];
  });
  if (paths.length !== headers) throw refuse('the diff headers and the files the patch really changes disagree');
  for (const path of paths) {
    try { editPath(path); } catch { throw refuse(`the patch touches ${JSON.stringify(path.slice(0, 80))}, which the edit path rules reject`); }
  }
  if (new Set(paths.map(p => p.toLowerCase())).size !== paths.length) throw refuse('the patch names a path twice');
  return paths;
}

// Check names Forge writes: one per edited file for the first four, one for the whole patch, and "cleanup",
// which Forge records only when removing its temporary workspace failed (it cannot be re-run elsewhere).
const KNOWN_CHECK = /^(?:edit|conflicts|json|syntax):[\s\S]+$|^diff-whitespace$/;
const short = (value, n = 160) => String(value).replace(/\s+/g, ' ').slice(0, n);
const normalized = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Internal consistency, checked before anything is re-run: the bundle must not contradict itself.
// Every contradiction is a MISMATCH row; the caller stops there, because a bundle that disagrees with itself
// has no single claim that could be re-run. The rules are written down in docs/EVIDENCE.md.
function checkConsistency(bundle, add) {
  const p = bundle.predicate;
  const hasPatch = p.patch !== null;
  const subject = bundle.subject[0];
  const expectedName = `${p.repository.fullName}@${p.base?.commit ?? p.run.id}.patch`;
  add('subject name', subject.name === expectedName ? MATCH : MISMATCH,
    subject.name === expectedName ? expectedName : `expected ${expectedName}, found ${short(subject.name)}`);
  if (hasPatch) {
    const actual = createHash('sha256').update(p.patch.text).digest('hex');
    add('patch SHA-256', actual === p.patch.sha256 ? MATCH : MISMATCH,
      actual === p.patch.sha256 ? actual : `recorded ${p.patch.sha256}, patch text hashes to ${actual}`);
    const size = Buffer.byteLength(p.patch.text);
    add('patch size', size === p.patch.bytes ? MATCH : MISMATCH, size === p.patch.bytes ? `${size} bytes` : `recorded ${p.patch.bytes} bytes, patch text has ${size}`);
    const digest = subject.digest?.sha256;
    add('subject digest', digest === p.patch.sha256 ? MATCH : MISMATCH,
      digest === p.patch.sha256 ? 'subject digest equals the recorded patch hash' : `subject digest is ${digest ?? 'missing'}`);
    if (!p.base) add('patch has a base commit', MISMATCH, 'the bundle carries a patch but no base commit, so the patch cannot be re-applied');
    if (p.patchAbsentReason !== undefined) add('patch absent reason', MISMATCH, 'the bundle carries a patch and also gives a reason why there is none');
  } else if (subject.digest !== undefined) add('subject digest', MISMATCH, 'the subject names a digest but the bundle has no patch');

  const failedChecks = p.checks.filter(c => c.status === 'failed').map(c => c.name);
  if (p.run.status === 'passed') {
    const problems = [];
    if (failedChecks.length) problems.push(`${failedChecks.join(', ')} is recorded as failed`);
    if (!hasPatch) problems.push('the bundle has no patch');
    if (!p.checks.length) problems.push('no check is recorded');
    add('run status matches checks', problems.length ? MISMATCH : MATCH,
      problems.length ? `the run is recorded as passed but ${problems.join(' and ')}` : 'a passed run records a patch, checks and no failed check');
  } else if (p.run.status === 'failed') {
    const contradiction = hasPatch && !failedChecks.length;
    add('run status matches checks', contradiction ? MISMATCH : MATCH,
      contradiction ? 'the run is recorded as failed and carries a patch, but no check is recorded as failed' : 'a failed run has no patch or records a failed check');
  }

  const approved = p.record.events.findLast(e => e.kind === 'task.approved');
  if (approved?.at !== p.record.planApprovedAt)
    add('plan approval time matches events', MISMATCH, `planApprovedAt is ${p.record.planApprovedAt ?? 'absent'}, the last task.approved event is ${approved?.at ?? 'absent'}`);

  const seen = new Set();
  const notRun = p.notRun.map(normalized);
  for (const check of p.checks) {
    const claim = `check ${check.name}`;
    if (seen.has(check.name)) { add(claim, MISMATCH, 'the bundle records this check more than once'); continue; }
    seen.add(check.name);
    if (notRun.includes(normalized(check.name))) add(claim, MISMATCH, 'claims something that notRun lists as not run; Forge ran no such check');
    else if (check.name === 'cleanup') {
      if (check.status !== 'failed') add(claim, MISMATCH, 'Forge records a cleanup check only when the cleanup failed');
    } else if (!KNOWN_CHECK.test(check.name))
      add(claim, MISMATCH, `unknown check: this verifier does not know a check called ${JSON.stringify(short(check.name, 80))}, so it cannot re-run it and never reports it as a match`);
  }
  if (!claimsHaveMismatch(add.claims))
    add('internal consistency', MATCH, 'status, patch, base commit, approval time and check names do not contradict each other');
}
const claimsHaveMismatch = claims => claims.some(c => c.result === MISMATCH);

export async function verifyEvidence(bundle, repository, { timeoutMs = 120000 } = {}) {
  const claims = [];
  const add = (claim, result, detail) => claims.push({ claim, result, detail });
  add.claims = claims;
  const p = bundle.predicate;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;
  let root;
  try {
    add('bundle format', MATCH, 'unsigned in-toto Statement v1 with a Forge predicate v1; not signed, so origin is not proven');
    const notVerifiable = [
      ['repository name', `${p.repository.fullName} (${p.repository.sourceKind}); a Git repository does not know its name`],
      ['intent', 'task title and text are what the Forge server stored'],
      ['plan approval time', p.record.planApprovedAt ? `${p.record.planApprovedAt}; the bundle records the time only, and no one can recompute it` : 'no approval event was recorded'],
      ['run timestamps and events', `${p.record.events.length} events and the run start and finish times are the server's own clock`],
      ['run summary', 'free text written by the server'],
      ['tool version', `${p.tool.name} ${p.tool.version}`]
    ];
    const finishNotVerifiable = () => { for (const [claim, detail] of notVerifiable) add(claim, NOT_VERIFIABLE, detail); };

    checkConsistency(bundle, add);
    if (claimsHaveMismatch(claims)) { finishNotVerifiable(); return report(claims); }

    if (p.patch === null) {
      add('patch', NOT_VERIFIABLE, `nothing to recompute: ${p.patchAbsentReason ?? 'the run produced no patch'}`);
      if (p.checks.length) add('recorded checks', NOT_VERIFIABLE, `${p.checks.length} checks are recorded, but without a patch they cannot be re-run`);
      finishNotVerifiable();
      return report(claims);
    }

    root = await mkdtemp(join(tmpdir(), 'voyagerroc-forge-verify-'));
    const probe = join(root, 'probe'); await mkdir(probe);
    const paths = await patchPaths(p.patch.text, probe, signal);

    let source;
    try {
      source = await realpath(resolve(repository));
      await gitSafely(['rev-parse', '--git-dir'], { cwd: source, signal });
    } catch { throw new EvidenceInputError(`${repository} is not a readable Git repository.`); }
    try { await gitSafely(['rev-parse', '--verify', '--quiet', `${p.base.commit}^{commit}`], { cwd: source, signal }); }
    catch {
      add('base commit', MISMATCH, `${p.base.commit} is not in this repository, so the patch cannot be re-applied`);
      finishNotVerifiable();
      return report(claims);
    }
    add('base commit', MATCH, `${p.base.commit} exists in this repository`);
    // A partial clone can hold the commit but not its files. Git is not allowed to fetch them (VERIFY_GIT_ENV), so
    // list what the commit needs and stop when something is missing, instead of reporting a misleading failure later.
    let needed;
    try { needed = (await gitSafely(['rev-list', '--objects', '--missing=print', '--no-walk', p.base.commit], { cwd: source, signal, maxBytes: 64 * 1024 * 1024 })).toString('utf8'); }
    catch (error) { if (signal.aborted) throw error; needed = '?'; }
    if (needed.split(String.fromCharCode(10)).some(line => line.startsWith('?')))
      throw new EvidenceInputError(`The repository does not contain the base commit ${p.base.commit} with all of its files: objects are missing, as in a partial clone. Verification never downloads objects into the repository; use a full clone.`);

    let workspace;
    try { workspace = await pinSnapshot(source, p.base.commit, root, signal, VERIFY_GIT_ENV); }
    catch (error) {
      if (signal.aborted) throw error;
      if (/^Git operation failed/.test(error.message))
        throw new EvidenceInputError(`The repository does not contain the base commit ${p.base.commit} with all of its files: objects are missing, as in a partial clone. Verification never downloads objects into the repository; use a full clone.`);
      throw new EvidenceInputError(`The pinned commit cannot be snapshotted with Forge's limits: ${short(error.message)}`);
    }

    let applied = false;
    try { await gitSafely(['apply', '--whitespace=nowarn'], { cwd: workspace, signal, input: p.patch.text }); applied = true; } catch {}
    if (!applied) {
      add('patch applies to base commit', MISMATCH, `the patch does not apply to ${p.base.commit} in a clean copy of this repository`);
      finishNotVerifiable();
      return report(claims);
    }
    add('patch applies to base commit', MATCH, `applies cleanly to ${p.base.commit}; ${paths.length} file${paths.length === 1 ? '' : 's'} changed`);

    // Recompute the static checks with the same code the runner uses.
    const recomputed = [];
    for (const path of paths) {
      const target = resolve(workspace, path);
      const rel = relative(workspace, target);
      if (rel.startsWith('..') || isAbsolute(rel)) throw refuse('a path leaves the workspace');
      const info = await lstat(target);
      if (!info.isFile()) throw refuse(`${path} is not a regular file after applying the patch`);
      const bytes = await readFile(target);
      if (!isUtf8(bytes) || bytes.includes(0)) throw refuse(`${path} is not UTF-8 text after applying the patch`);
      recomputed.push(...contentChecks(path, bytes.toString('utf8')));
    }
    for (const path of paths.filter(isJavaScriptPath)) recomputed.push(await syntaxCheck(workspace, path, signal));
    await gitSafely(['add', '--intent-to-add', '--force', '--all'], { cwd: workspace, signal });
    recomputed.push(await whitespaceCheck(workspace, signal));

    // Names are unique and known here: checkConsistency rejected repeated, unknown and not-run names.
    const recorded = new Map(p.checks.map(check => [check.name, check]));
    for (const check of recomputed) {
      const claim = `check ${check.name}`;
      const was = recorded.get(check.name);
      if (!was) add(claim, MISMATCH, `not recorded in the bundle; re-running it gives ${check.status}`);
      else if (was.status !== check.status) add(claim, MISMATCH, `recorded ${was.status}, re-running it gives ${check.status}`);
      else if (check.name.startsWith('edit:') && was.detail !== check.detail) add(claim, MISMATCH, `recorded ${short(was.detail)}, the patched file gives ${short(check.detail)}`);
      else add(claim, MATCH, `recorded and re-run: ${check.status}`);
    }
    const recomputedNames = new Set(recomputed.map(c => c.name));
    for (const check of p.checks) {
      if (recomputedNames.has(check.name)) continue;
      if (check.name === 'cleanup') add('check cleanup', NOT_VERIFIABLE, `recorded ${check.status}; the removal of the server's temporary workspace cannot be re-run here`);
      else add(`check ${check.name}`, MISMATCH, 'names a check on a file this patch does not change');
    }
    finishNotVerifiable();
    return report(claims);
  } finally {
    clearTimeout(timer);
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

function report(claims) {
  const count = result => claims.filter(c => c.result === result).length;
  const counts = { match: count(MATCH), mismatch: count(MISMATCH), notVerifiable: count(NOT_VERIFIABLE) };
  return { ok: counts.mismatch === 0, exitCode: counts.mismatch === 0 ? 0 : 1, claims, counts,
    summary: `${counts.match} matched, ${counts.mismatch} mismatched, ${counts.notVerifiable} recorded not verifiable. ` +
      'The bundle is not signed: matches show that it is consistent, not who produced it.' };
}

// The table is read by a person in a terminal, and many of its words come from the bundle, which is
// untrusted. Control characters (C0, DEL, C1: escape sequences, line breaks, tabs), line and paragraph
// separators, bidirectional formatting characters and all other Unicode format characters are shown as
// escapes, so they can neither hide a row nor forge one. The --json output has its own step, formatJson.
const isUnsafe = code => code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c || code === 0x200e || code === 0x200f ||
  code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ||
  /\p{Cf}/u.test(String.fromCodePoint(code));
export const plainText = value => Array.from(String(value), ch => isUnsafe(ch.codePointAt(0))
  ? ch.codePointAt(0) > 0xffff ? '\\u{' + ch.codePointAt(0).toString(16) + '}' : '\\' + 'u' + ch.codePointAt(0).toString(16).padStart(4, '0') : ch).join('');

const jsonEscape = code => {
  if (code <= 0xffff) return '\\u' + code.toString(16).padStart(4, '0');
  const scalar = code - 0x10000;
  const high = 0xd800 + (scalar >> 10);
  const low = 0xdc00 + (scalar & 0x3ff);
  return '\\u' + high.toString(16) + '\\u' + low.toString(16);
};

// --json needs the same care as the table. JSON.stringify escapes the C0 controls, quotes, backslashes and lone
// surrogates, but it writes DEL, the C1 controls, U+2028, U+2029 and the bidirectional controls as they are. They are
// replaced by their JSON escape, so the output is still valid JSON that decodes to the same text.
export const formatJson = result => Array.from(JSON.stringify(result, null, 2), ch => {
  const code = ch.codePointAt(0);
  return code > 0x1f && isUnsafe(code) ? jsonEscape(code) : ch;
}).join('') + '\n';

export function formatReport({ claims, summary }) {
  const rows = claims.map(c => ({ claim: plainText(c.claim), result: plainText(c.result), detail: plainText(c.detail) }));
  const claimWidth = Math.max('CLAIM'.length, ...rows.map(c => c.claim.length));
  const resultWidth = Math.max(6, ...rows.map(c => c.result.length));
  const line = (a, b, c) => `${a.padEnd(claimWidth)}  ${b.padEnd(resultWidth)}  ${c}`;
  return [line('CLAIM', 'RESULT', 'DETAIL'), ...rows.map(c => line(c.claim, c.result, c.detail)), '', plainText(summary), ''].join('\n');
}
