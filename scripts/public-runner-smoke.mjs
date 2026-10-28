// Read-only upstream acceptance: all edits stay in a disposable local copy.
import { writeFile, mkdir } from 'node:fs/promises';
const origin = 'http://127.0.0.1:4317';
async function api(path, data) {
  const response = await fetch(origin + path, data === undefined ? {} : { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forge-Client': 'local-ui' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error); return result;
}
const project = await api('/api/projects', { repository: 'octocat/Hello-World' });
let task = await api('/api/tasks', { projectId: project.id, title: 'Demo: public GitHub runner acceptance',
  intent: 'Validate fresh GitHub revision resolution and local-only scoped edits. Do not publish anything.', adapter: 'github' });
for (const action of ['plan','review','approve']) task = await api(`/api/tasks/${task.id}/${action}`, { version: task.version });
let run = await api(`/api/tasks/${task.id}/runs`, { version: task.version, edits: [
  { path: 'forge-acceptance-note.txt', before: null, after: 'Local-only Voyagerroc Forge runner acceptance.\n' }
] });
const deadline = Date.now() + 80000;
while (['preparing','running'].includes(run.status) && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 500)); run = await api(`/api/runs/${run.id}`);
}
await mkdir('qa', { recursive: true });
await writeFile('qa/forge-public-runner-result-2026-10-28.json', JSON.stringify(run, null, 2));
console.log(JSON.stringify({ status: run.status, baseSha: run.base_sha, patchSha256: run.patch_sha256, summary: run.summary }));
if (run.status !== 'passed') process.exitCode = 1;
