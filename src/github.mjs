import { createHmac, timingSafeEqual, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function verifySignature(raw, signature, secret) {
  if (!secret || !/^sha256=[0-9a-f]{64}$/.test(signature ?? '')) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export function parseRepository(input) {
  if (typeof input !== 'string') throw Object.assign(new Error('Repository is required'), { status: 400 });
  let value = input.trim();
  if (value.startsWith('https://')) {
    let url;
    try { url = new URL(value); } catch { throw Object.assign(new Error('Invalid repository URL'), { status: 400 }); }
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash)
      throw Object.assign(new Error('Use a github.com repository URL'), { status: 400 });
    value = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  value = value.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value) || ['.','..'].includes(value.split('/')[1]))
    throw Object.assign(new Error('Use owner/repository or https://github.com/owner/repository'), { status: 400 });
  return value;
}

export class GitHubAdapter {
  constructor({ fetchImpl = fetch, appId, installationId, privateKeyPath } = {}) {
    Object.assign(this, { fetchImpl, appId, installationId, privateKeyPath });
  }
  get configured() { return Boolean(this.appId && this.installationId && this.privateKeyPath); }
  async request(path, options = {}, token) {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      ...options, signal: AbortSignal.timeout(15000), redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'Voyagerroc-Forge-MVP', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
    });
    if (!response.ok) {
      const status = response.status === 404 ? 404 : 502;
      throw Object.assign(new Error(response.status === 404 ? 'Repository not found or installation cannot access it' : `GitHub request failed (${response.status})`), { status });
    }
    return response.json();
  }
  async installationToken() {
    if (!this.configured) return null;
    if (this.cached && this.cached.expires > Date.now() + 60000) return this.cached.token;
    if (!/^\d+$/.test(String(this.appId)) || !/^\d+$/.test(String(this.installationId)))
      throw new Error('Invalid GitHub App configuration');
    const now = Math.floor(Date.now()/1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now-60, exp: now+540, iss: String(this.appId) })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(readFileSync(this.privateKeyPath)).toString('base64url');
    const data = await this.request(`/app/installations/${this.installationId}/access_tokens`, {
      method: 'POST', body: JSON.stringify({ permissions: { contents: 'read', pull_requests: 'read' } })
    }, `${unsigned}.${signature}`);
    if (typeof data.token !== 'string' || !Number.isFinite(Date.parse(data.expires_at))) throw new Error('Invalid installation token response');
    this.cached = { token: data.token, expires: Date.parse(data.expires_at) };
    return data.token;
  }
  async repository(input) {
    const name = parseRepository(input);
    const repo = await this.request(`/repos/${name}`, {}, await this.installationToken());
    if (!Number.isSafeInteger(repo.id) || typeof repo.default_branch !== 'string' || !repo.default_branch ||
        typeof repo.full_name !== 'string' || parseRepository(repo.full_name).toLowerCase() !== name.toLowerCase())
      throw Object.assign(new Error('Invalid GitHub repository response'), { status: 502 });
    return { ...repo, html_url: `https://github.com/${repo.full_name}` };
  }
  async resolveRevision(input, ref) {
    const name = parseRepository(input);
    const commit = await this.request(`/repos/${name}/commits/${encodeURIComponent(ref)}`, {}, await this.installationToken());
    if (!/^[a-f0-9]{40}$/.test(commit.sha ?? '')) throw new Error('Invalid GitHub revision response');
    return commit.sha;
  }
}
