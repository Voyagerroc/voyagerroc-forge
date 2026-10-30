import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
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
  assert.equal(blocker.listening, true, 'the existing listener is left untouched');
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
