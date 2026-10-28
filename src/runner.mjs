import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { command, git } from './runner-process.mjs';
import { editPath, validateEdits } from './edit-worker.mjs';
import { parseRepository } from './github.mjs';

const worker = fileURLToPath(new URL('./edit-worker.mjs', import.meta.url));
const errorWithStatus = (message, status = 400) => Object.assign(new Error(message), { status });
const terminal = status => ['passed','failed','cancelled','timed_out','interrupted'].includes(status);
const diagnostic = text => text.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+)/g, '[REDACTED]').slice(0, 3000);

export class Runner {
  constructor({ store, github, localRepositories = {}, timeoutMs = 60000, maxConcurrent = 1 } = {}) {
    Object.assign(this, { store, github, localRepositories, timeoutMs, maxConcurrent });
    this.jobs = new Map();
    this.recovered = store.recoverRuns();
  }
  capabilities() {
    return { mode: 'scoped-edits', checks: ['exact-replacement','conflict-markers','json-parse','javascript-syntax','diff-whitespace'],
      projectTests: false, aiAgent: false, publication: false, maxConcurrent: this.maxConcurrent,
      timeoutMs: this.timeoutMs, active: this.jobs.size };
  }
  start(taskId, { version, edits }) {
    if (!Number.isSafeInteger(version) || version < 0) throw errorWithStatus('Task version is required');
    let safeEdits;
    try { safeEdits = validateEdits(edits); } catch (error) { throw errorWithStatus(error.message); }
    const task = this.store.getTask(taskId);
    if (!task) throw errorWithStatus('Task not found', 404);
    const project = this.store.getProject(task.project_id);
    if (project.source_kind === 'local' && !this.localRepositories[project.full_name])
      throw errorWithStatus('Local source is not configured on this server', 503);
    if (project.private && !this.localRepositories[project.full_name])
      throw errorWithStatus('Private source checkout requires a configured local mirror', 503);
    if (this.jobs.size >= this.maxConcurrent) throw errorWithStatus('Runner is busy. Wait for the active run to finish.', 409);
    const run = this.store.createRun(taskId, version);
    const controller = new AbortController();
    const job = { controller, cancelled: false, timedOut: false };
    this.jobs.set(run.id, job);
    job.promise = this.execute(run, task, project, safeEdits, job).finally(() => this.jobs.delete(run.id));
    return run;
  }
  async cancel(id) {
    const run = this.store.getRun(id);
    if (!run) throw errorWithStatus('Run not found', 404);
    if (terminal(run.status)) return run;
    const job = this.jobs.get(id);
    if (!job) throw errorWithStatus('Run is not owned by this server process', 409);
    job.cancelled = true; job.controller.abort();
    await job.promise;
    return this.store.getRun(id);
  }
  async close() {
    await Promise.all([...this.jobs.keys()].map(id => this.cancel(id)));
  }
  async snapshot(project, root, signal) {
    let source = this.localRepositories[project.full_name];
    let sha;
    if (source) {
      source = await realpath(source);
      sha = (await git(['rev-parse','--verify','HEAD^{commit}'], { cwd: source, signal })).toString().trim();
    } else {
      const name = parseRepository(project.full_name);
      sha = await this.github.resolveRevision(name, project.default_branch);
      signal.throwIfAborted();
      source = join(root, 'source'); await mkdir(source);
      await git(['init','--quiet'], { cwd: source, signal });
      await git(['fetch','--quiet','--no-tags','--depth=1',`https://github.com/${name}.git`,sha], { cwd: source, signal });
    }
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Source revision is not a valid SHA-1 commit');
    const tree = (await git(['ls-tree','-r','-z','-l',sha], { cwd: source, signal })).toString('utf8').split('\0').filter(Boolean);
    if (!tree.length || tree.length > 200) throw new Error('Source snapshot must contain 1–200 tracked files');
    const entries = tree.map(line => {
      const match = line.match(/^(\d+) (\w+) ([a-f0-9]{40})\s+(\d+|-)\t([\s\S]+)$/);
      if (!match || !['100644','100755'].includes(match[1]) || match[2] !== 'blob') throw new Error('Symlinks and submodules are not supported');
      const path = editPath(match[5]); const size = Number(match[4]);
      if (!Number.isSafeInteger(size) || size > 1024 * 1024) throw new Error('Source file exceeds 1 MiB');
      return { path, size, blob: match[3] };
    });
    if (entries.reduce((n, e) => n + e.size, 0) > 10 * 1024 * 1024) throw new Error('Source snapshot exceeds 10 MiB');
    const paths = new Set();
    for (const entry of entries) {
      if (paths.has(entry.path.toLowerCase())) throw new Error('Case-colliding source paths are not supported');
      paths.add(entry.path.toLowerCase());
    }
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    for (const entry of entries) {
      signal.throwIfAborted();
      const target = resolve(workspace, entry.path);
      await mkdir(resolve(target, '..'), { recursive: true });
      await writeFile(target, await git(['cat-file','blob',entry.blob], { cwd: source, signal, maxBytes: 1100000 }));
    }
    await git(['init','--quiet'], { cwd: workspace, signal });
    await git(['add','--force','--all'], { cwd: workspace, signal });
    await git(['-c','user.name=Forge Runner','-c','user.email=runner@localhost','commit','--quiet','--no-verify','-m','Pinned source snapshot'], { cwd: workspace, signal });
    return { workspace, sha };
  }
  async execute(run, task, project, edits, job) {
    let root; let patch = ''; let checks = []; let status = 'failed'; let summary = 'Run failed';
    const signal = job.controller.signal;
    const timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, this.timeoutMs);
    try {
      root = await mkdtemp(join(tmpdir(), 'voyagerroc-forge-run-'));
      const { workspace, sha } = await this.snapshot(project, root, signal);
      signal.throwIfAborted();
      this.store.startRun(run.id, sha);
      const output = await command(process.execPath, ['--permission', `--allow-fs-read=${workspace}`,
        `--allow-fs-write=${workspace}`, '--no-addons', '--max-old-space-size=128', worker], {
        cwd: workspace, signal, input: JSON.stringify({ root: workspace, edits })
      });
      if (output.code !== 0) throw new Error(diagnostic(output.stderr.toString()) || 'Edit worker failed');
      const result = JSON.parse(output.stdout.toString('utf8')); checks = result.checks;
      for (const path of result.files.filter(p => /\.(?:js|mjs|cjs)$/.test(p))) {
        const checked = await command(process.execPath, ['--permission', `--allow-fs-read=${workspace}`,
          '--no-addons', '--max-old-space-size=128', '--check', join(workspace, path)], { cwd: workspace, signal });
        checks.push({ name: `syntax:${path}`, status: checked.code === 0 ? 'passed' : 'failed',
          detail: checked.code === 0 ? 'Node syntax check passed; source was not executed' : diagnostic(checked.stderr.toString()).replaceAll(workspace, '[workspace]') });
      }
      await git(['add','--intent-to-add','--force','--all'], { cwd: workspace, signal });
      patch = (await git(['diff','--no-ext-diff','--no-textconv','--no-color','HEAD','--','.'], { cwd: workspace, signal })).toString('utf8');
      const whitespace = await command('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','diff','--no-ext-diff','--no-textconv','--check','HEAD'], { cwd: workspace, signal });
      checks.push({ name: 'diff-whitespace', status: whitespace.code === 0 ? 'passed' : 'failed', detail: diagnostic(whitespace.stdout.toString()) || (whitespace.code === 0 ? 'No whitespace errors' : 'Whitespace errors found') });
      if (!patch.trim()) throw new Error('Edits produced no patch');
      signal.throwIfAborted();
      status = checks.some(c => c.status === 'failed') ? 'failed' : 'passed';
      summary = status === 'passed' ? 'Scoped edits and static checks passed. Project tests were not run.' : 'Static checks failed. Inspect the patch and diagnostics.';
    } catch (error) {
      status = job.cancelled ? 'cancelled' : job.timedOut || error.code === 'TIMEOUT' ? 'timed_out' : 'failed';
      summary = status === 'cancelled' ? 'Run cancelled; no upstream changes were made.' : status === 'timed_out' ? 'Run exceeded its time limit.' : diagnostic(error.message);
    } finally {
      clearTimeout(timer);
      if (root) {
        // Delete only the exact mkdtemp child allocated by this run; never a source repository.
        const parent = resolve(tmpdir()); const target = resolve(root); const rel = relative(parent, target);
        if (rel.startsWith('voyagerroc-forge-run-') && !rel.includes('/') && !rel.includes('\\') && !isAbsolute(rel)) {
          try { await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
          catch { checks.push({ name: 'cleanup', status: 'failed', detail: 'Temporary workspace cleanup failed; operator cleanup is required.' }); status = 'failed'; summary = 'Temporary workspace cleanup failed; inspect the recorded checks.'; }
        }
      }
      this.store.finishRun(run.id, { status, summary, patch, patchSha256: patch ? createHash('sha256').update(patch).digest('hex') : null, checks });
    }
  }
}
