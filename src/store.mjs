import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const processAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
// One live server per database file: recoverRuns() marks every active run
// "interrupted", which is only correct when no other server owns those runs.
// The lock is created atomically (wx) next to the database. A lock whose
// process has exited is stale and is replaced; one that cannot be read is not.
function lockDatabase(filename) {
  const lock = `${filename}.lock`;
  const mine = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
  for (;;) {
    try { writeFileSync(lock, mine, { flag: 'wx' }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let held, owner;
      try { held = readFileSync(lock, 'utf8'); } catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      try { owner = JSON.parse(held); } catch {}
      const pid = Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? owner.pid : null;
      if (pid && !processAlive(pid)) {
        try { if (readFileSync(lock, 'utf8') === held) unlinkSync(lock); } catch (staleError) { if (staleError.code !== 'ENOENT') throw staleError; }
        continue;
      }
      throw Object.assign(new Error(pid
        ? `Voyagerroc Forge: database ${filename} is already in use by process ${pid} (lock file ${lock}, started ${owner.started}). `
          + `If process ${pid} is not a Forge server (a process id can be reused after a crash), delete the lock file. `
          + 'Otherwise run one server per database, or give this server its own database, for example: FORGE_DB=data/second.sqlite npm start'
        : `Voyagerroc Forge: lock file ${lock} exists but does not name a process. If no Forge server is using ${filename}, delete the lock file; `
          + 'otherwise give this server its own database, for example: FORGE_DB=data/second.sqlite npm start'), { code: 'FORGE_DB_LOCKED' });
    }
  }
  return () => {
    try { if (JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) unlinkSync(lock); } catch {}
  };
}

// readOnly opens an existing database without the server lock and without creating tables or migrating the schema,
// so evidence can be exported while a server is running on the same file. It cannot write to the database, but SQLite may leave -shm and -wal side files next to it.
export function openStore(filename, { readOnly = false } = {}) {
  if (readOnly) return openLockedStore(filename, () => {}, true);
  let release = () => {};
  if (filename !== ':memory:') { mkdirSync(dirname(filename), { recursive: true }); release = lockDatabase(filename); }
  try { return openLockedStore(filename, release, false); } catch (error) { release(); throw error; }
}

function openLockedStore(filename, release, readOnly) {
  const db = new DatabaseSync(filename, { readOnly });
  if (readOnly) db.exec('PRAGMA foreign_keys=ON;');
  else db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      github_id INTEGER NOT NULL, url TEXT NOT NULL, description TEXT NOT NULL,
      default_branch TEXT NOT NULL, private INTEGER NOT NULL, latest_sha TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, intent TEXT NOT NULL, adapter TEXT NOT NULL,
      status TEXT NOT NULL, plan TEXT, version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT REFERENCES projects(id),
      kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pull_requests (
      project_id TEXT NOT NULL REFERENCES projects(id), number INTEGER NOT NULL,
      title TEXT NOT NULL, state TEXT NOT NULL, url TEXT NOT NULL,
      head_sha TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, number)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      status TEXT NOT NULL, base_sha TEXT, patch TEXT, patch_sha256 TEXT,
      checks TEXT NOT NULL DEFAULT '[]', summary TEXT, created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active ON runs(task_id)
      WHERE status IN ('preparing','running');`);
  if (!readOnly && !db.prepare('PRAGMA table_info(projects)').all().some(c => c.name === 'source_kind'))
    db.exec("ALTER TABLE projects ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'github'");
  const event = (projectId, kind, detail) => db.prepare(
    'INSERT INTO events(project_id,kind,detail,created_at) VALUES (?,?,?,?)'
  ).run(projectId, kind, JSON.stringify(detail), new Date().toISOString());
  const getProject = id => db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  const getTask = id => {
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    return row ? { ...row, plan: row.plan ? JSON.parse(row.plan) : null } : null;
  };
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const getRun = id => {
    const row = db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    return row ? { ...row, checks: JSON.parse(row.checks) } : null;
  };
  // Events carry their task in the JSON detail. Selecting by task keeps every
  // event of a task, unlike the 50-event project window in snapshot().events.
  const taskEvents = taskId => db.prepare(
    "SELECT id, kind, created_at, json_extract(detail,'$.runId') AS run_id FROM events WHERE json_extract(detail,'$.taskId')=? ORDER BY id ASC"
  ).all(taskId);
  return {
    close() { try { db.close(); } finally { release(); } }, getProject, getTask, getRun,
    // Events that name this task, oldest first. Run events carry the run id as well as the task id.
    taskEvents(taskId) {
      const task = getTask(taskId);
      if (!task) return [];
      return db.prepare('SELECT kind,detail,created_at FROM events WHERE project_id=? ORDER BY id').all(task.project_id)
        .map(row => ({ ...row, detail: JSON.parse(row.detail) })).filter(row => row.detail?.taskId === taskId);
    },
    snapshot() {
      return {
        projects: db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all(),
        tasks: db.prepare('SELECT id FROM tasks ORDER BY created_at DESC').all().map(r => ({ ...getTask(r.id), events: taskEvents(r.id) })),
        pullRequests: db.prepare('SELECT * FROM pull_requests ORDER BY updated_at DESC').all(),
        runs: db.prepare('SELECT id FROM runs ORDER BY created_at DESC').all().map(r => {
          const { patch, ...metadata } = getRun(r.id); return { ...metadata, has_patch: Boolean(patch) };
        }),
        events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 50').all().map(r => ({ ...r, detail: JSON.parse(r.detail) }))
      };
    },
    connect(repo) {
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM projects WHERE full_name=?').get(repo.full_name);
        const id = existing?.id ?? randomUUID();
        db.prepare(`INSERT INTO projects(id,full_name,github_id,url,description,default_branch,private,created_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(full_name) DO UPDATE SET
          github_id=excluded.github_id,url=excluded.url,description=excluded.description,
          default_branch=excluded.default_branch,private=excluded.private`).run(
          id, repo.full_name, repo.id, repo.html_url, repo.description ?? '', repo.default_branch,
          repo.private ? 1 : 0, new Date().toISOString());
        db.prepare('UPDATE projects SET source_kind=? WHERE id=?').run(repo.source_kind ?? 'github', id);
        event(id, 'repository.connected', { repository: repo.full_name });
        return getProject(id);
      });
    },
    createTask({ projectId, title, intent, adapter }) {
      return transaction(() => {
        if (!getProject(projectId)) throw Object.assign(new Error('Project not found'), { status: 404 });
        const id = randomUUID(); const now = new Date().toISOString();
        db.prepare(`INSERT INTO tasks(id,project_id,title,intent,adapter,status,created_at,updated_at)
          VALUES (?,?,?,?,?,'queued',?,?)`).run(id, projectId, title, intent, adapter, now, now);
        event(projectId, 'task.created', { taskId: id, title });
        return getTask(id);
      });
    },
    transition(id, version, status, plan) {
      return transaction(() => {
        const task = getTask(id);
        if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
        const allowed = { queued: 'planned', planned: 'in_review', in_review: 'approved' };
        if (task.version !== version || allowed[task.status] !== status)
          throw Object.assign(new Error('Task changed or transition is invalid. Refresh and retry.'), { status: 409 });
        db.prepare('UPDATE tasks SET status=?,plan=?,version=version+1,updated_at=? WHERE id=?')
          .run(status, JSON.stringify(plan ?? task.plan), new Date().toISOString(), id);
        event(task.project_id, `task.${status}`, { taskId: id, execution: 'not_started' });
        return getTask(id);
      });
    },
    createRun(taskId, version) {
      return transaction(() => {
        const task = getTask(taskId);
        if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
        if (task.status !== 'approved' || task.version !== version)
          throw Object.assign(new Error('Approve the current plan before running'), { status: 409 });
        if (task.adapter !== 'github')
          throw Object.assign(new Error('This source adapter has no implemented runner'), { status: 400 });
        if (db.prepare("SELECT id FROM runs WHERE task_id=? AND status IN ('preparing','running')").get(taskId))
          throw Object.assign(new Error('A run is already active for this task'), { status: 409 });
        const id = randomUUID();
        db.prepare("INSERT INTO runs(id,task_id,status,created_at) VALUES (?,?,'preparing',?)")
          .run(id, taskId, new Date().toISOString());
        event(task.project_id, 'run.preparing', { taskId, runId: id });
        return getRun(id);
      });
    },
    startRun(id, baseSha) {
      const run = getRun(id);
      if (!run || run.status !== 'preparing') throw new Error('Run is not preparing');
      db.prepare("UPDATE runs SET status='running',base_sha=? WHERE id=?").run(baseSha, id);
    },
    finishRun(id, { status, summary, patch = '', patchSha256 = null, checks = [] }) {
      return transaction(() => {
        if (!['passed','failed','cancelled','timed_out','interrupted'].includes(status)) throw new Error('Invalid terminal status');
        const run = getRun(id);
        if (!run || !['preparing','running'].includes(run.status)) return run;
        db.prepare('UPDATE runs SET status=?,summary=?,patch=?,patch_sha256=?,checks=?,finished_at=? WHERE id=?')
          .run(status, summary, patch, patchSha256, JSON.stringify(checks), new Date().toISOString(), id);
        event(getTask(run.task_id).project_id, `run.${status}`, { runId: id, taskId: run.task_id });
        return getRun(id);
      });
    },
    recoverRuns() {
      const active = db.prepare("SELECT id FROM runs WHERE status IN ('preparing','running')").all();
      for (const row of active) this.finishRun(row.id, { status: 'interrupted', summary: 'Server restarted before this run completed. No result was assumed.' });
      return active.length;
    },
    receive(id, kind, payload) {
      return transaction(() => {
        if (db.prepare('SELECT id FROM deliveries WHERE id=?').get(id)) return { duplicate: true };
        const now = new Date().toISOString();
        db.prepare('INSERT INTO deliveries VALUES (?,?)').run(id, now);
        const project = db.prepare('SELECT * FROM projects WHERE github_id=?').get(payload.repository?.id ?? -1);
        if (!project) return { ignored: true, reason: 'Repository is not connected' };
        if (kind === 'push' && payload.ref === `refs/heads/${project.default_branch}` && !payload.deleted) {
          if (!/^[a-f0-9]{40,64}$/.test(payload.after ?? '')) throw Object.assign(new Error('Invalid push SHA'), { status: 400 });
          db.prepare('UPDATE projects SET latest_sha=? WHERE id=?').run(payload.after, project.id);
          event(project.id, 'github.push', { sha: payload.after, ref: payload.ref });
        } else if (kind === 'pull_request' && payload.pull_request) {
          const pr = payload.pull_request;
          if (!Number.isSafeInteger(pr.number) || pr.number < 1 || typeof pr.title !== 'string' ||
              !['open','closed'].includes(pr.state) || !/^[a-f0-9]{40,64}$/.test(pr.head?.sha ?? ''))
            throw Object.assign(new Error('Invalid pull request'), { status: 400 });
          const url = `https://github.com/${project.full_name}/pull/${pr.number}`;
          const updated = pr.updated_at;
          if (typeof updated !== 'string' || !Number.isFinite(Date.parse(updated)))
            throw Object.assign(new Error('Invalid pull request timestamp'), { status: 400 });
          db.prepare(`INSERT INTO pull_requests VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(project_id,number) DO UPDATE SET title=excluded.title,state=excluded.state,
            url=excluded.url,head_sha=excluded.head_sha,updated_at=excluded.updated_at
            WHERE excluded.updated_at >= pull_requests.updated_at`).run(
            project.id, pr.number, pr.title.slice(0,500), pr.merged ? 'merged' : pr.state, url, pr.head.sha, new Date(updated).toISOString());
          event(project.id, 'github.pull_request', { number: pr.number, action: payload.action });
        } else return { ignored: true, reason: 'Event does not update tracked state' };
        return { accepted: true };
      });
    }
  };
}
