import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openStore } from './store.mjs';
import { GitHubAdapter, verifySignature } from './github.mjs';
import { adapters, buildPlan } from './adapters.mjs';
import { Runner } from './runner.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const field = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name} must contain 1–${max} characters`);
  return value.trim();
};
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw fail('Request is too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(raw) {
  try {
    const result = JSON.parse(raw.toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw fail('Invalid JSON object'); }
}

export function createApp({ store, github = new GitHubAdapter(), webhookSecret = '', runner } = {}) {
  if (!store) throw new Error('Store is required');
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const localOrigin = `http://127.0.0.1:${serverPort(res)}`;
      const allowedHosts = [`127.0.0.1:${serverPort(res)}`, `localhost:${serverPort(res)}`];
      if (!allowedHosts.includes(req.headers.host)) throw fail('Local host required', 403);
      const url = new URL(req.url, localOrigin);
      if (req.method === 'POST' && url.pathname === '/api/webhooks/github') {
        if (!webhookSecret) throw fail('Webhook secret is not configured', 503);
        const raw = await body(req);
        if (!verifySignature(raw, req.headers['x-hub-signature-256'], webhookSecret)) throw fail('Invalid webhook signature', 401);
        const id = req.headers['x-github-delivery'];
        const kind = req.headers['x-github-event'];
        if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(id) || typeof kind !== 'string') throw fail('Missing delivery metadata');
        return send(200, store.receive(id, kind, json(raw)));
      }
      // This MVP is a single-user local app, not a multi-tenant authenticated service.
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (![localOrigin, `http://localhost:${serverPort(res)}`].includes(origin) || req.headers['x-forge-client'] !== 'local-ui')
          throw fail('Local UI origin and client header required', 403);
        if (!req.headers['content-type']?.startsWith('application/json')) throw fail('JSON content type required', 415);
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, mode: 'local-mvp', version: '0.2.0' });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, {
        ...store.snapshot(), adapters,
        integration: { github: github.configured ? 'app-configured' : 'public-read', webhook: Boolean(webhookSecret), execution: runner ? 'scoped-edits' : 'disabled' },
        runner: runner?.capabilities() ?? null
      });
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = json(await body(req));
        return send(201, store.connect(await github.repository(field(input.repository, 'Repository', 200))));
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const input = json(await body(req));
        const adapter = adapters.find(a => a.id === input.adapter);
        if (!adapter) throw fail('Unknown adapter');
        return send(201, store.createTask({
          projectId: field(input.projectId, 'Project', 50), title: field(input.title, 'Title', 160),
          intent: field(input.intent, 'Intent', 5000), adapter: adapter.id
        }));
      }
      const runStart = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/runs$/);
      if (req.method === 'POST' && runStart) {
        if (!runner) throw fail('Runner is not configured', 503);
        return send(202, runner.start(runStart[1], json(await body(req))));
      }
      const runRoute = url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})(\/cancel)?$/);
      if (runRoute && req.method === 'GET' && !runRoute[2]) {
        const run = store.getRun(runRoute[1]);
        if (!run) throw fail('Run not found', 404);
        return send(200, run);
      }
      if (runRoute && req.method === 'POST' && runRoute[2]) {
        if (!runner) throw fail('Runner is not configured', 503);
        return send(200, await runner.cancel(runRoute[1]));
      }
      const match = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/(plan|review|approve)$/);
      if (req.method === 'POST' && match) {
        const input = json(await body(req));
        if (!Number.isSafeInteger(input.version) || input.version < 0) throw fail('Task version is required');
        const task = store.getTask(match[1]);
        if (!task) throw fail('Task not found', 404);
        const status = { plan: 'planned', review: 'in_review', approve: 'approved' }[match[2]];
        const plan = match[2] === 'plan' ? buildPlan(task, store.getProject(task.project_id)) : undefined;
        return send(200, store.transition(task.id, input.version, status, plan));
      }
      if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/runner.css'].includes(url.pathname)) {
        const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = { 'index.html': 'text/html', 'app.js': 'text/javascript', 'style.css': 'text/css', 'runner.css': 'text/css' }[path];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(await readFile(resolve(publicDir, path)));
      }
      send(404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) send(error.status ?? 500, { error: error.status ? error.message : 'Internal error. Check server configuration.' });
      else res.end();
    }
  });
}
function serverPort(res) { return res.socket.localPort; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = openStore(process.env.FORGE_DB || 'data/forge.sqlite');
  const github = new GitHubAdapter({ appId: process.env.GITHUB_APP_ID, installationId: process.env.GITHUB_INSTALLATION_ID,
    privateKeyPath: process.env.GITHUB_PRIVATE_KEY_PATH });
  const localRepositories = JSON.parse(process.env.FORGE_LOCAL_REPOSITORIES || '{}');
  if (!localRepositories || typeof localRepositories !== 'object' || Array.isArray(localRepositories) ||
      Object.values(localRepositories).some(path => typeof path !== 'string')) throw new Error('Invalid local repository mapping');
  const runner = new Runner({ store, github, localRepositories });
  const server = createApp({ store, github, runner, webhookSecret: process.env.GITHUB_WEBHOOK_SECRET });
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  // A port already held by another instance is the one startup failure a
  // first run is likely to hit; name it and point at PORT instead of
  // letting the raw EADDRINUSE stack trace through (#1).
  server.on('error', error => {
    if (error.code !== 'EADDRINUSE') throw error;
    const alternative = port === 65535 ? 4317 : port + 1;
    console.error(`Voyagerroc Forge: port ${port} is already in use. Stop the other instance or start with another port: PORT=${alternative} npm start`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => console.log(`Voyagerroc Forge: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await runner.close(); store.close(); process.exit(0); }));
}
