import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, createVerify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { openStore } from '../src/store.mjs';
import { GitHubAdapter, parseRepository, verifySignature } from '../src/github.mjs';
import { createApp } from '../src/server.mjs';

const repo = { id: 123, full_name: 'example/project', html_url: 'https://github.com/example/project', description: 'Test repository', default_branch: 'main', private: false };
const secret = 'test-only-secret';
const sign = raw => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
async function fixture(t) {
  const store = openStore(':memory:');
  const github = new GitHubAdapter({ fetchImpl: async url => {
    assert.equal(url, 'https://api.github.com/repos/example/project');
    return Response.json(repo);
  }});
  const server = createApp({ store, github, webhookSecret: secret });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const call = async (path, data, extra = {}) => {
    const response = await fetch(origin + path, data === undefined ? {} : {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forge-Client': 'local-ui', ...extra }, body: JSON.stringify(data)
    });
    return { status: response.status, data: await response.json() };
  };
  const webhook = async (id, kind, payload, signature) => {
    const raw = JSON.stringify(payload);
    const response = await fetch(origin + '/api/webhooks/github', { method: 'POST', headers: {
      'X-GitHub-Delivery': id, 'X-GitHub-Event': kind, 'X-Hub-Signature-256': signature ?? sign(raw)
    }, body: raw });
    return { status: response.status, data: await response.json() };
  };
  return { store, origin, call, webhook };
}

test('an occupied port exits with a PORT hint and leaves the listener alone', async t => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const blocker = createServer();
  blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const port = blocker.address().port;
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const dir = mkdtempSync(join(tmpdir(), 'forge-port-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), FORGE_DB: join(dir, 'forge.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1, stderr);
  assert.match(stderr, new RegExp(`port ${port} is already in use`));
  assert.match(stderr, /PORT=/);
  assert.match(stderr, /FORGE_DB=/, 'a second server must not be pointed at the same database');
  assert.equal(existsSync(join(dir, 'forge.sqlite.lock')), false, 'the lock is released when startup fails');
  assert.equal(blocker.listening, true, 'the existing listener is left untouched');
});
function activeRun(store) {
  const project = store.connect(repo);
  let task = store.createTask({ projectId: project.id, title: 'Keep evidence', intent: 'Run is active', adapter: 'github' });
  for (const status of ['planned', 'in_review', 'approved']) task = store.transition(task.id, task.version, status, { mode: 'dry-run' });
  const run = store.createRun(task.id, task.version);
  store.startRun(run.id, 'a'.repeat(40));
  return run;
}
test('a second server on the same database cannot interrupt the first server\'s active runs', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  const filename = join(directory, 'forge.sqlite');
  const first = openStore(filename);
  t.after(() => { first.close(); rmSync(directory, { recursive: true, force: true }); });
  const run = activeRun(first);
  let second, refused;
  try { second = openStore(filename); second.recoverRuns(); second.close(); } catch (error) { refused = error; }
  assert.equal(first.getRun(run.id).status, 'running', 'the first server\'s run is still active');
  assert.match(refused?.message ?? '', /forge\.sqlite\.lock/);
  assert.match(refused.message, /FORGE_DB=/);
  assert.match(refused.message, /delete the lock file/, 'a reused process id must not leave the operator without a way out');
  const result = first.finishRun(run.id, { status: 'passed', summary: 'done', patch: 'diff', patchSha256: 'x' });
  assert.equal(result.status, 'passed'); assert.equal(result.patch, 'diff');
});
test('the database lock is released on close and in-memory databases take none', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'forge.sqlite');
  const store = openStore(filename);
  const info = JSON.parse(readFileSync(filename + '.lock', 'utf8'));
  assert.equal(info.pid, process.pid); assert.ok(Number.isFinite(Date.parse(info.started)));
  store.close();
  assert.equal(existsSync(filename + '.lock'), false);
  openStore(filename).close();
  openStore(':memory:').close(); openStore(':memory:').close();
  assert.equal(existsSync(':memory:.lock'), false);
});
test('a lock left by a process that no longer exists is replaced', async t => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', '']); await once(child, 'exit');
  const directory = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'forge.sqlite');
  writeFileSync(filename + '.lock', JSON.stringify({ pid: child.pid, started: '2020-01-01T00:00:00.000Z' }));
  const store = openStore(filename);
  assert.equal(JSON.parse(readFileSync(filename + '.lock', 'utf8')).pid, process.pid);
  store.close();
  assert.equal(existsSync(filename + '.lock'), false);
});
test('a lock file that cannot be read is not replaced', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'forge.sqlite');
  writeFileSync(filename + '.lock', 'not json');
  assert.throws(() => openStore(filename), /forge\.sqlite\.lock/);
  assert.equal(readFileSync(filename + '.lock', 'utf8'), 'not json');
});
test('npm start refuses a database that another server holds and names the lock file', async t => {
  const { spawn } = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  const filename = join(directory, 'forge.sqlite');
  const holder = openStore(filename);
  t.after(() => { holder.close(); rmSync(directory, { recursive: true, force: true }); });
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(), env: { ...process.env, PORT: '0', FORGE_DB: filename }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1, stderr);
  assert.ok(stderr.includes(filename + '.lock'), stderr);
  assert.match(stderr, /FORGE_DB=/);
  assert.equal(existsSync(filename + '.lock'), true, 'the holder\'s lock is left in place');
});
test('repository parsing permits GitHub repositories and rejects URL injection', () => {
  for (const value of ['example/project', 'https://github.com/example/project', 'https://github.com/example/project.git']) assert.equal(parseRepository(value), 'example/project');
  for (const value of ['https://evil.test/a/b', 'https://github.com@evil.test/a/b', 'https://github.com/a/b?q=1', 'a/..', 'a/b/c', 'http://127.0.0.1/private']) assert.throws(() => parseRepository(value));
});
test('signature matches GitHub published test vector and rejects tampering', () => {
  const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
  assert.ok(verifySignature(Buffer.from('Hello, World!'), signature, "It's a Secret to Everybody"));
  assert.equal(verifySignature(Buffer.from('changed'), signature, "It's a Secret to Everybody"), false);
  for (const value of [undefined, '', 'sha256=abc', 'sha1='+'0'.repeat(40)]) assert.equal(verifySignature(Buffer.from('x'), value, secret), false);
});
test('task lifecycle is persistent and has optimistic concurrency guards', async t => {
  const { call } = await fixture(t);
  const project = await call('/api/projects', { repository: 'example/project' }); assert.equal(project.status, 201);
  const task = await call('/api/tasks', { projectId: project.data.id, title: 'Improve test coverage', intent: 'Verify behavior and report evidence', adapter: 'github' });
  assert.equal(task.status, 201); assert.equal(task.data.status, 'queued');
  const path = `/api/tasks/${task.data.id}`;
  assert.equal((await call(path+'/approve', { version: 0 })).status, 409);
  const planned = await call(path+'/plan', { version: 0 });
  assert.equal(planned.data.plan.mode, 'dry-run'); assert.equal(planned.data.plan.execution, 'not_started');
  assert.equal((await call(path+'/review', { version: 0 })).status, 409);
  assert.equal((await call(path+'/review', { version: 1 })).data.status, 'in_review');
  assert.equal((await call(path+'/approve', { version: 2 })).data.status, 'approved');
  const state = await call('/api/state'); assert.equal(state.data.tasks.length, 1); assert.equal(state.data.events.length, 5);
  assert.equal(state.data.integration.execution, 'disabled');
});
test('each task in the state carries its own recorded events, oldest first, beyond the 50-event project window', t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const project = store.connect(repo);
  const a = store.createTask({ projectId: project.id, title: 'A', intent: 'First task', adapter: 'github' });
  const b = store.createTask({ projectId: project.id, title: 'B', intent: 'Second task', adapter: 'github' });
  let task = store.transition(a.id, 0, 'planned', { steps: [] });
  task = store.transition(a.id, task.version, 'in_review');
  task = store.transition(a.id, task.version, 'approved');
  const run = store.createRun(a.id, task.version); store.startRun(run.id, 'c'.repeat(40));
  store.finishRun(run.id, { status: 'failed', summary: 'x' });
  for (let i = 0; i < 60; i++) store.connect(repo);
  const snapshot = store.snapshot();
  assert.equal(snapshot.events.length, 50);
  assert.equal(snapshot.events.some(e => e.kind === 'task.created'), false, 'the project window no longer holds the oldest events');
  const mine = snapshot.tasks.find(x => x.id === a.id).events;
  assert.deepEqual(mine.map(e => e.kind), ['task.created', 'task.planned', 'task.in_review', 'task.approved', 'run.preparing', 'run.failed']);
  assert.deepEqual(mine.map(e => e.run_id), [null, null, null, null, run.id, run.id]);
  assert.deepEqual(Object.keys(mine[0]).sort(), ['created_at', 'id', 'kind', 'run_id']);
  assert.ok(mine.every((e, i) => i === 0 || e.id > mine[i - 1].id && e.created_at >= mine[i - 1].created_at));
  assert.deepEqual(snapshot.tasks.find(x => x.id === b.id).events.map(e => e.kind), ['task.created']);
});
test('database survives reopening without duplicating repository imports', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-test-'));
  const filename = join(directory, 'test.sqlite'); let store = openStore(filename);
  const id = store.connect(repo).id; store.connect({ ...repo, description: 'Updated' }); store.close();
  store = openStore(filename); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.snapshot().projects.length, 1); assert.equal(store.getProject(id).description, 'Updated');
});
test('signed webhook applies push once; wrong signatures cannot mutate data', async t => {
  const { call, webhook } = await fixture(t); await call('/api/projects', { repository: 'example/project' });
  const payload = { repository: { id: 123 }, ref: 'refs/heads/main', after: 'a'.repeat(40) };
  assert.equal((await webhook('delivery-1', 'push', payload, 'sha256='+'0'.repeat(64))).status, 401);
  assert.equal((await webhook('delivery-1', 'push', payload)).data.accepted, true);
  assert.equal((await webhook('delivery-1', 'push', payload)).data.duplicate, true);
  const state = (await call('/api/state')).data;
  assert.equal(state.projects[0].latest_sha, payload.after); assert.equal(state.events.filter(e => e.kind === 'github.push').length, 1);
});
test('failed webhook processing rolls back delivery receipt for a corrected retry', async t => {
  const { call, webhook } = await fixture(t); await call('/api/projects', { repository: 'example/project' });
  const payload = { repository: { id: 123 }, ref: 'refs/heads/main', after: 'bad' };
  assert.equal((await webhook('retry-1', 'push', payload)).status, 400);
  payload.after = 'b'.repeat(40); assert.equal((await webhook('retry-1', 'push', payload)).data.accepted, true);
});
test('PR synchronization uses trusted URLs and ignores older snapshots', async t => {
  const { call, webhook } = await fixture(t); await call('/api/projects', { repository: 'example/project' });
  const pr = { number: 1, title: '<script>alert(1)</script>', state: 'closed', merged: true, html_url: 'javascript:alert(1)', head: { sha: 'c'.repeat(40) }, updated_at: '2026-10-28T10:00:00Z' };
  await webhook('pr-new', 'pull_request', { repository: { id: 123 }, pull_request: pr, action: 'closed' });
  await webhook('pr-old', 'pull_request', { repository: { id: 123 }, pull_request: { ...pr, state: 'open', merged: false, updated_at: '2026-10-27T10:00:00Z' }, action: 'opened' });
  const synced = (await call('/api/state')).data.pullRequests[0];
  assert.equal(synced.state, 'merged'); assert.equal(synced.url, 'https://github.com/example/project/pull/1');
});
test('unconnected repositories and non-default pushes do not affect project state', async t => {
  const { call, webhook } = await fixture(t); await call('/api/projects', { repository: 'example/project' });
  assert.equal((await webhook('other', 'push', { repository: { id: 999 } })).data.ignored, true);
  assert.equal((await webhook('branch', 'push', { repository: { id: 123 }, ref: 'refs/heads/test', after: 'a'.repeat(40) })).data.ignored, true);
  assert.equal((await call('/api/state')).data.projects[0].latest_sha, null);
});
test('cross-origin mutation, unknown adapters and missing projects are rejected', async t => {
  const { call } = await fixture(t);
  assert.equal((await call('/api/projects', { repository: 'example/project' }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('/api/tasks', { projectId: 'missing', title: 'x', intent: 'x', adapter: 'invalid' })).status, 400);
  assert.equal((await call('/api/tasks', { projectId: 'missing', title: 'x', intent: 'x', adapter: 'github' })).status, 404);
});

test('planned adapters cannot record tasks or events through the API', async t => {
  const { call } = await fixture(t);
  const project = (await call('/api/projects', { repository: 'example/project' })).data;
  const before = (await call('/api/state')).data;
  const planned = before.adapters.filter(adapter => adapter.status === 'planned');
  assert.ok(planned.length > 0);
  for (const adapter of planned) {
    const result = await call('/api/tasks', {
      projectId: project.id, title: 'Unavailable runner', intent: 'Check availability', adapter: adapter.id
    });
    assert.equal(result.status, 400);
    assert.match(result.data.error, new RegExp(adapter.id));
    assert.match(result.data.error, /planned.*not available/i);
    const after = (await call('/api/state')).data;
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.adapters, before.adapters);
  }
  assert.equal((await call('/api/tasks', {
    projectId: project.id, title: 'Available adapter', intent: 'Read metadata', adapter: 'github'
  })).status, 201);
});
test('requests with a foreign Host header are rejected for GET and POST', async t => {
  const { origin } = await fixture(t);
  const { port } = new URL(origin);
  const send = (method, path, host, headers = {}) => new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...headers } }, response => {
      response.resume(); response.on('end', () => resolve(response));
    });
    request.on('error', reject); request.end(method === 'POST' ? '{}' : undefined);
  });
  const local = { Origin: origin, 'Content-Type': 'application/json', 'X-Forge-Client': 'local-ui' };
  for (const host of ['evil.test', `evil.test:${port}`, `127.0.0.1:${Number(port) + 1}`, `[::1]:${port}`]) {
    const get = await send('GET', '/api/state', host); assert.equal(get.statusCode, 403, `GET with Host ${host}`);
    assert.match(get.headers['content-security-policy'], /default-src 'self'/);
    assert.equal((await send('POST', '/api/projects', host, local)).statusCode, 403, `POST with Host ${host}`);
  }
  assert.equal((await send('GET', '/api/state', `localhost:${port}`)).statusCode, 200);
});
test('mutations without the local client header, with another content type or over 1 MiB are rejected', async t => {
  const { origin, store } = await fixture(t);
  const post = (headers, body) => fetch(origin + '/api/projects', { method: 'POST', headers: { Origin: origin, ...headers }, body });
  const valid = { 'Content-Type': 'application/json', 'X-Forge-Client': 'local-ui' };
  const input = JSON.stringify({ repository: 'example/project' });
  assert.equal((await post({ 'Content-Type': 'application/json' }, input)).status, 403);
  assert.equal((await post({ ...valid, 'X-Forge-Client': 'other' }, input)).status, 403);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded']) assert.equal((await post({ ...valid, 'Content-Type': type }, input)).status, 415, type);
  const bare = await new Promise((resolve, reject) => {
    const request = httpRequest(origin + '/api/projects', { method: 'POST', headers: { Origin: origin, 'X-Forge-Client': 'local-ui' } }, response => { response.resume(); response.on('end', () => resolve(response)); });
    request.on('error', reject); request.end(input);
  });
  assert.equal(bare.statusCode, 415);
  const large = await post(valid, JSON.stringify({ repository: 'a'.repeat(1024 * 1024) }));
  assert.equal(large.status, 413); assert.deepEqual(await large.json(), { error: 'Request is too large' });
  assert.equal(store.snapshot().projects.length, 0);
});
test('static routes set CSP and reject traversal', async t => {
  const { origin } = await fixture(t);
  const page = await fetch(origin); assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Voyagerroc Forge/);
  assert.equal((await fetch(origin+'/.env')).status, 404);
  assert.equal((await fetch(origin+'/src/server.mjs')).status, 404);
});
test('GitHub errors and hostile repository responses are not trusted', async () => {
  const denied = new GitHubAdapter({ fetchImpl: async () => new Response('', { status: 404 }) });
  await assert.rejects(denied.repository('example/project'), /not found/);
  const hostile = new GitHubAdapter({ fetchImpl: async () => Response.json({ ...repo, full_name: 'other/repo' }) });
  await assert.rejects(hostile.repository('example/project'), /Invalid GitHub/);
});
test('GitHub App creates a scoped installation token, signs JWT and caches it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-key-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = join(directory, 'test.pem'); writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  let minted = 0;
  const github = new GitHubAdapter({ appId: '123', installationId: '456', privateKeyPath: keyPath, fetchImpl: async (url, options) => {
    if (url.endsWith('/access_tokens')) {
      minted++; assert.deepEqual(JSON.parse(options.body).permissions, { contents: 'read', pull_requests: 'read' });
      const jwt = options.headers.Authorization.slice(7).split('.');
      assert.ok(createVerify('RSA-SHA256').update(jwt.slice(0,2).join('.')).verify(publicKey, Buffer.from(jwt[2], 'base64url')));
      return Response.json({ token: 'test-token-variable-length', expires_at: new Date(Date.now()+3600000).toISOString() });
    }
    assert.equal(options.headers.Authorization, 'Bearer test-token-variable-length'); return Response.json(repo);
  }});
  await github.repository('example/project'); await github.repository('example/project'); assert.equal(minted, 1);
});

test('health reports the version in package.json', async t => {
  const { origin } = await fixture(t);
  const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const response = await fetch(origin + '/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, expected);
});

test('an unexpected error is logged with method and path but not the request body, and answered with 500', async t => {
  const { store, call } = await fixture(t);
  store.connect = () => { throw new Error('forced store failure'); };
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args.join(' ')); });
  const marker = 'body-marker-do-not-log';
  const { status, data } = await call('/api/projects?q=query-marker', { repository: 'example/project', note: marker });
  assert.equal(status, 500);
  assert.equal(data.error, 'Internal error. Check server configuration.');
  const output = logged.join('\n');
  assert.match(output, /POST \/api\/projects/);
  assert.match(output, /forced store failure/);
  assert.doesNotMatch(output, new RegExp(marker));
  assert.doesNotMatch(output, /query-marker/);
});

test('expected client errors are not written to the error log', async t => {
  const { call } = await fixture(t);
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args.join(' ')); });
  assert.equal((await call('/api/tasks', { adapter: 'nope' })).status, 400);
  assert.deepEqual(logged, []);
});

for (const type of ['Application/JSON', 'APPLICATION/JSON; charset=utf-8', 'application/json ; charset=utf-8']) {
  test(`JSON media type accepts ${type}`, async t => {
    const { call } = await fixture(t);
    const result = await call('/api/projects', { repository: 'example/project' }, { 'Content-Type': type });
    assert.equal(result.status, 201);
    assert.equal(result.data.full_name, 'example/project');
  });
}
for (const type of ['application/jsonp', 'application/json-patch+json', 'application/json-extra']) {
  test(`JSON media type rejects ${type}`, async t => {
    const { call, store } = await fixture(t);
    const result = await call('/api/projects', { repository: 'example/project' }, { 'Content-Type': type });
    assert.equal(result.status, 415);
    assert.deepEqual(result.data, { error: 'JSON content type required' });
    assert.equal(store.snapshot().projects.length, 0);
  });
}
