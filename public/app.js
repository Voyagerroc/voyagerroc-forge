let state;
let runTask;
const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const labels = { queued: 'Queued', planned: 'Planned', in_review: 'In review', approved: 'Approved' };
const message = text => { $('#message').textContent = text; };
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forge-Client': 'local-ui' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
async function refresh() { state = await api('/api/state'); render(); }
function render() {
  $('#project-count').textContent = state.projects.length;
  $('#task-count').textContent = state.tasks.length;
  $('#review-count').textContent = state.tasks.filter(t => t.status === 'in_review').length;
  $('#pr-count').textContent = state.pullRequests.length;
  $('#new-task').disabled = !state.projects.length;
  $('#projects').replaceChildren(...state.projects.map(project => {
    const card = node('article', undefined, 'project-card');
    const link = node(project.url ? 'a' : 'strong', project.full_name); if (project.url) { link.href = project.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    const local = project.source_kind === 'local';
    card.append(node('span', local ? 'LOCAL / GIT' : 'GIT / GITHUB', 'eyebrow'), link, node('p', project.description || 'No repository description provided.'), node('small', `${project.default_branch} · ${local ? 'Local source' : project.private ? 'Private' : 'Public'} · ${project.latest_sha ? project.latest_sha.slice(0,7) : local ? 'HEAD pinned at run time' : 'No push event received'}`));
    return card;
  }));
  if (!state.projects.length) $('#projects').append(node('p', 'No repositories connected yet. Add your first GitHub repository above.', 'empty'));
  $('#project').replaceChildren(...state.projects.map(p => { const option = node('option', p.full_name); option.value = p.id; return option; }));
  $('#board').replaceChildren(...Object.entries(labels).map(([status, label]) => {
    const column = node('div', undefined, 'column'); const tasks = state.tasks.filter(t => t.status === status);
    column.append(node('h3', `${label}  ${tasks.length}`));
    tasks.forEach(task => {
      const card = node('article', undefined, 'task-card');
      card.append(node('small', state.projects.find(p => p.id === task.project_id)?.full_name), node('h4', task.title), node('p', task.intent), node('span', task.adapter, 'badge'));
      if (task.plan) { const view = node('button', 'View plan', 'text-button'); view.onclick = () => showPlan(task); card.append(view); }
      const action = { queued: ['plan','Generate plan'], planned: ['review','Request review'], in_review: ['approve','Approve plan'] }[status];
      if (action) {
        const button = node('button', action[1]);
        button.onclick = () => run(button, async () => {
          await api(`/api/tasks/${task.id}/${action[0]}`, { version: task.version });
          await refresh(); message(`${task.title}: ${action[1]} completed. No code was executed or published.`);
        }); card.append(button);
      } else {
        const latest = state.runs?.find(r => r.task_id === task.id);
        card.append(node('small', latest ? `Latest run: ${latest.status}` : 'Plan approved · execution not started'));
        if (state.runner && task.adapter === 'github') {
          const start = node('button', 'Run scoped edits');
          start.disabled = Boolean(state.runner.active);
          start.onclick = () => { runTask = task; $('#run-task-title').textContent = task.title; $('#edits').value = ''; $('#run-dialog').showModal(); };
          card.append(start);
        }
      }
      column.append(card);
    });
    if (!tasks.length) column.append(node('p', 'No tasks', 'empty'));
    return column;
  }));
  $('#adapters').replaceChildren(...state.adapters.map(adapter => {
    const item = node('article', undefined, 'integration'); item.append(node('h3', adapter.name), node('span', adapter.status, 'badge'), node('p', adapter.detail)); return item;
  }));
  $('#adapters').append(node('p', `GitHub: ${state.integration.github} · Webhooks: ${state.integration.webhook ? 'configured' : 'not configured'}`, 'muted'));
  $('#pulls').replaceChildren(...state.pullRequests.map(pr => {
    const card = node('article', undefined, 'project-card');
    const link = node('a', `#${pr.number} ${pr.title}`); link.href = pr.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    card.append(node('span', pr.state, 'badge'), link, node('small', `Head ${pr.head_sha.slice(0,7)}`)); return card;
  }));
  if (!state.pullRequests.length) $('#pulls').append(node('p', 'No pull request events received. Configure a GitHub webhook to sync future updates.', 'empty'));
  $('#events').replaceChildren(...state.events.slice(0,10).map(event => {
    const row = node('div', undefined, 'event'); row.append(node('span', event.kind.replaceAll('.', ' / ')), node('small', new Date(event.created_at).toLocaleString())); return row;
  }));
  if (!state.events.length) $('#events').append(node('p', 'Connect a repository to start your activity trail.', 'empty'));
  $('#runs').replaceChildren(...(state.runs ?? []).map(result => {
    const row = node('article', undefined, 'project-card run-card');
    row.append(node('span', result.status, 'badge'), node('h3', state.tasks.find(t => t.id === result.task_id)?.title ?? result.task_id),
      node('p', result.summary || 'Preparing a pinned source snapshot…'), node('small', result.base_sha ? `Base ${result.base_sha}` : 'Base revision pending'));
    const view = node('button', 'View evidence', 'text-button'); view.onclick = () => showResult(result.id); row.append(view);
    if (['preparing','running'].includes(result.status)) {
      const cancel = node('button', 'Cancel run', 'text-button'); cancel.onclick = () => run(cancel, async () => { await api(`/api/runs/${result.id}/cancel`, {}); await refresh(); message('Run cancelled.'); }); row.append(cancel);
    }
    return row;
  }));
  if (!state.runs?.length) $('#runs').append(node('p', 'No executions yet. Approve a GitHub plan, then run scoped edits.', 'empty'));
}
async function showResult(id) {
  try {
    const result = await api(`/api/runs/${id}`);
    const checks = node('ul');
    result.checks.forEach(check => checks.append(node('li', `${check.status.toUpperCase()} · ${check.name}: ${check.detail}`)));
    const patch = node('pre', result.patch || 'No patch produced.');
    $('#run-detail').replaceChildren(node('p', result.summary || result.status), node('p', `Base: ${result.base_sha || 'unresolved'}`, 'muted'),
      node('p', `Patch SHA-256: ${result.patch_sha256 || 'not available'}`, 'muted'), checks, node('h3', 'Patch'), patch);
    $('#result-dialog').showModal();
  } catch (error) { message(error.message); }
}
function showPlan(task) {
  const detail = $('#plan-detail'); const list = node('ol');
  task.plan.steps.forEach(step => list.append(node('li', `${step.stage}: ${step.action}`)));
  detail.replaceChildren(node('h3', task.title), node('p', 'DRY RUN · No agent execution', 'notice'), list, node('p', task.plan.gates.join(' · '), 'muted'));
  $('#plan-dialog').showModal();
}
async function run(button, work) {
  button.disabled = true; message('Working…');
  try { await work(); } catch (error) { message(error.message); } finally { button.disabled = false; }
}
$('#connect-form').onsubmit = event => {
  event.preventDefault(); const button = event.submitter;
  run(button, async () => { await api('/api/projects', { repository: $('#repository').value }); await refresh(); $('#connect-form').reset(); message('GitHub repository connected.'); });
};
$('#new-task').onclick = () => $('#task-dialog').showModal();
$('#close-task').onclick = () => $('#task-dialog').close();
$('#close-plan').onclick = () => $('#plan-dialog').close();
$('#close-run').onclick = () => $('#run-dialog').close();
$('#close-result').onclick = () => $('#result-dialog').close();
$('#refresh-runs').onclick = () => run($('#refresh-runs'), refresh);
$('#run-form').onsubmit = event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const edits = JSON.parse($('#edits').value);
    await api(`/api/tasks/${runTask.id}/runs`, { version: runTask.version, edits });
    $('#run-dialog').close(); await refresh(); message('Runner started. Results update automatically.');
  });
};
$('#task-form').onsubmit = event => {
  event.preventDefault();
  run(event.submitter, async () => {
    await api('/api/tasks', Object.fromEntries(new FormData(event.target)));
    $('#task-dialog').close(); event.target.reset(); await refresh(); message('Workflow task created.');
  });
};
refresh().catch(error => message(error.message));
setInterval(() => {
  if (state?.runs?.some(r => ['preparing','running'].includes(r.status)) && !document.querySelector('dialog[open]')) refresh().catch(error => message(error.message));
}, 1500);
