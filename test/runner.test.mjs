import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { Runner } from '../src/runner.mjs';
import { git, command, processEnvironment } from '../src/runner-process.mjs';
import { validateEdits } from '../src/edit-worker.mjs';
import { createApp } from '../src/server.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forge runner fixture '));
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'hello.mjs'), 'export const greeting = "helo";\n');
  await writeFile(join(source, 'package.json'), '{"name":"fixture","private":true}\n');
  await git(['init','--quiet','-b','main'], { cwd: source });
  await git(['add','--all'], { cwd: source });
  await git(['-c','user.name=Test','-c','user.email=test@localhost','commit','--quiet','-m','Fixture'], { cwd: source });
  const sha = (await git(['rev-parse','HEAD'], { cwd: source })).toString().trim();
  // The runner must use committed content, not these local modifications.
  await writeFile(join(source, 'hello.mjs'), 'export const greeting = "dirty working copy";\n');
  await writeFile(join(source, 'untracked.txt'), 'not part of snapshot');
  const store = openStore(':memory:');
  const project = store.connect({ id: -100, full_name: 'local/fixture', html_url: '', description: '', default_branch: 'main', private: false, source_kind: 'local' });
  let task = store.createTask({ projectId: project.id, title: 'Fix spelling', intent: 'Use hello', adapter: options.adapter ?? 'github' });
  for (const status of ['planned','in_review','approved']) task = store.transition(task.id, task.version, status, { mode: 'dry-run' });
  const runner = new Runner({ store, localRepositories: { 'local/fixture': source }, ...options });
  t.after(async () => { await runner.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, source, store, runner, task, sha };
}
const edit = { path: 'hello.mjs', before: '"helo"', after: '"hello"' };
async function finish(runner, run) { await runner.jobs.get(run.id).promise; return runner.store.getRun(run.id); }

test('runner pins committed source, produces hashed patch and leaves source untouched', async t => {
  const { runner, store, source, task, sha } = await fixture(t);
  const result = await finish(runner, runner.start(task.id, { version: task.version, edits: [edit] }));
  assert.equal(result.status, 'passed', result.summary);
  assert.equal(result.base_sha, sha);
  assert.match(result.patch, /-export const greeting = "helo"/);
  assert.match(result.patch, /\+export const greeting = "hello"/);
  assert.equal(result.patch_sha256, createHash('sha256').update(result.patch).digest('hex'));
  assert.ok(result.checks.some(c => c.name === 'syntax:hello.mjs' && c.status === 'passed'));
  assert.match(await readFile(join(source,'hello.mjs'), 'utf8'), /dirty working copy/);
  assert.equal(store.getTask(task.id).status, 'approved');
  assert.equal(runner.capabilities().projectTests, false);
});
test('syntax checks reject invalid JavaScript and preserve the failed patch', async t => {
  const { runner, task } = await fixture(t);
  const result = await finish(runner, runner.start(task.id, { version: task.version, edits: [{ ...edit, after: '(' }] }));
  assert.equal(result.status, 'failed'); assert.ok(result.patch);
  assert.ok(result.checks.some(c => c.name.startsWith('syntax:') && c.status === 'failed'));
});
test('JSON errors and merge conflict markers report real failures', async t => {
  const { runner, task } = await fixture(t);
  const result = await finish(runner, runner.start(task.id, { version: task.version, edits: [
    { path: 'bad.json', before: null, after: '{"broken":' },
    { path: 'notes.txt', before: null, after: '<<<<<<< ours\ntext\n=======\nother\n>>>>>>> theirs\n' }
  ] }));
  assert.equal(result.status, 'failed');
  assert.ok(result.checks.some(c => c.name === 'json:bad.json' && c.status === 'failed'));
  assert.ok(result.checks.some(c => c.name === 'conflicts:notes.txt' && c.status === 'failed'));
});
test('repository JavaScript is parsed but never executed', async t => {
  const { runner, task, root } = await fixture(t);
  const marker = join(root, 'must-not-exist');
  const code = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n`;
  const result = await finish(runner, runner.start(task.id, { version: task.version, edits: [{ path: 'trap.mjs', before: null, after: code }] }));
  assert.equal(result.status, 'passed', result.summary);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
test('stale edits fail explicitly instead of silently changing another string', async t => {
  const { runner, task } = await fixture(t);
  const result = await finish(runner, runner.start(task.id, { version: task.version, edits: [{ ...edit, before: 'absent text' }] }));
  assert.equal(result.status, 'failed'); assert.match(result.summary, /exactly once/); assert.equal(result.patch, '');
});
test('unsafe paths, duplicate files and empty changes are rejected before creating a run', () => {
  for (const path of ['../secret', '.git/config', 'a/.GIT/config', 'C:/file', 'a\\b', '/absolute', 'x/NUL.txt', 'x/../file', 'x/file.'])
    assert.throws(() => validateEdits([{ ...edit, path }]));
  assert.throws(() => validateEdits([edit, { ...edit, path: 'HELLO.mjs' }]), /Duplicate/);
  assert.throws(() => validateEdits([{ ...edit, after: edit.before }]));
});
test('concurrency guard, cancellation and retry release the runner slot', async t => {
  const { runner, task } = await fixture(t);
  const run = runner.start(task.id, { version: task.version, edits: [edit] });
  assert.throws(() => runner.start(task.id, { version: task.version, edits: [edit] }), /busy/);
  const cancelled = await runner.cancel(run.id); assert.equal(cancelled.status, 'cancelled');
  assert.equal(runner.jobs.size, 0);
  assert.equal((await finish(runner, runner.start(task.id, { version: task.version, edits: [edit] }))).status, 'passed');
});
test('time budget produces timed_out rather than passed', async t => {
  const { runner, task } = await fixture(t, { timeoutMs: 1 });
  assert.equal((await finish(runner, runner.start(task.id, { version: task.version, edits: [edit] }))).status, 'timed_out');
});
test('symbolic-link entries in the Git tree are rejected without following them', async t => {
  const { runner, task, source } = await fixture(t);
  const blob = (await git(['hash-object','-w','--stdin'], { cwd: source, input: '../outside' })).toString().trim();
  await git(['update-index','--add','--cacheinfo',`120000,${blob},danger-link`], { cwd: source });
  await git(['-c','user.name=Test','-c','user.email=test@localhost','commit','--quiet','-m','Link fixture'], { cwd: source });
  const result = await finish(runner, runner.start(task.id, { version: task.version, edits: [edit] }));
  assert.equal(result.status, 'failed'); assert.match(result.summary, /Symlinks/);
});
test('unsupported adapters, missing local config and stale plan versions fail closed', async t => {
  const { runner, task } = await fixture(t);
  assert.throws(() => runner.start(task.id, { version: task.version-1, edits: [edit] }), /Approve/);
  delete runner.localRepositories['local/fixture'];
  assert.throws(() => runner.start(task.id, { version: task.version, edits: [edit] }), /not configured/);
  const unsupported = await fixture(t, { adapter: 'gcp-scion' });
  assert.throws(() => unsupported.runner.start(unsupported.task.id, { version: unsupported.task.version, edits: [edit] }), /no implemented runner/);
});
test('non-UTF-8 files cannot be silently rewritten as corrupted text', async t => {
  const { runner, task, source } = await fixture(t);
  await writeFile(join(source, 'legacy.txt'), Buffer.from([0xff,0xfe,0x41,0x42]));
  await git(['add','legacy.txt'], { cwd: source });
  await git(['-c','user.name=Test','-c','user.email=test@localhost','commit','--quiet','-m','Legacy fixture'], { cwd: source });
  const result = await finish(runner, runner.start(task.id, { version: task.version, edits: [{ path: 'legacy.txt', before: 'AB', after: 'CD' }] }));
  assert.equal(result.status, 'failed'); assert.match(result.summary, /UTF-8/);
});
test('restart recovery records interrupted status and preserves task approval', async t => {
  const { store, runner, task } = await fixture(t);
  const abandoned = store.createRun(task.id, task.version); store.startRun(abandoned.id, 'a'.repeat(40));
  const recovered = new Runner({ store });
  assert.equal(recovered.recovered, 1); assert.equal(store.getRun(abandoned.id).status, 'interrupted');
  assert.equal(store.getTask(task.id).status, 'approved'); await recovered.close(); await runner.close();
});
test('worker process environment excludes application secrets and Node preload flags', () => {
  const env = processEnvironment();
  for (const key of ['NODE_OPTIONS','GITHUB_WEBHOOK_SECRET','GITHUB_PRIVATE_KEY_PATH','HOME','USERPROFILE']) assert.equal(env[key], undefined);
});
test('process supervisor enforces timeout and captures actual exit status', async () => {
  await assert.rejects(command(process.execPath, ['-e','setTimeout(()=>{},10000)'], { timeout: 20 }), { code: 'TIMEOUT' });
  const result = await command(process.execPath, ['-e','process.stderr.write("failed");process.exitCode=7']);
  assert.equal(result.code, 7); assert.equal(result.stderr.toString(), 'failed');
});
test('process timeout terminates descendant processes as well as the parent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge process tree '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = join(root, 'child.pid');
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`;
  await assert.rejects(command(process.execPath, ['-e',script], { timeout: 2000 }), { code: 'TIMEOUT' });
  const pid = Number(await readFile(pidFile, 'utf8'));
  try {
    process.kill(pid, 0);
    // A killed descendant can remain as a non-running zombie until init reaps it.
    if (process.platform === 'linux') assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /\) Z /);
    else assert.fail('Descendant is still alive');
  } catch (error) { if (!['ESRCH','ENOENT'].includes(error.code)) throw error; }
});
test('runner API starts a real job, exposes evidence and rejects cross-origin starts', async t => {
  const { store, runner, task } = await fixture(t);
  const server = createApp({ store, runner }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const start = async originHeader => fetch(`${origin}/api/tasks/${task.id}/runs`, { method: 'POST',
    headers: { Origin: originHeader, 'Content-Type': 'application/json', 'X-Forge-Client': 'local-ui' },
    body: JSON.stringify({ version: task.version, edits: [edit] }) });
  assert.equal((await start('https://evil.test')).status, 403);
  const response = await start(origin); assert.equal(response.status, 202);
  const run = await response.json(); await runner.jobs.get(run.id).promise;
  const evidence = await (await fetch(`${origin}/api/runs/${run.id}`)).json(); assert.equal(evidence.status, 'passed', evidence.summary);
  const state = await (await fetch(`${origin}/api/state`)).json(); assert.equal(state.runner.aiAgent, false);
});
