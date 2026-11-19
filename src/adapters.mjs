export const adapters = [
  { id: 'github', name: 'GitHub', status: 'metadata-ready', detail: 'Live repository metadata and webhook events. Scoped edits with static checks are available through the local runner.' },
  { id: 'open-scion', name: 'open_scion / git-ai', status: 'planned', detail: 'Planned. Independent open-source (MIT) source-control adapter contract only; RPC compatibility is not validated. No compatibility is claimed. Independent of Anthropic.' },
  { id: 'gcp-scion', name: 'Google Scion', status: 'planned', detail: 'Planned. Independent open-source (Apache-2.0) runner adapter contract only; nothing is launched. No compatibility is claimed. Not an officially supported Google product.' }
];

export function buildPlan(task, project) {
  return {
    mode: 'dry-run', execution: 'not_started', repository: project.full_name,
    adapter: task.adapter, baseSha: project.latest_sha ?? null,
    steps: [
      { stage: 'context', action: `Resolve repository ${project.full_name} and pin the base revision.` },
      { stage: 'copy', action: 'Make a separate copy of the pinned commit.' },
      { stage: 'edit', action: 'Apply the exact edits you provide to that copy.' },
      { stage: 'check', action: 'Run the static checks on the changed files.' },
      { stage: 'record', action: 'Record the patch, the check results and the pinned commit as evidence.' }
    ],
    gates: ['No commands are executed by this plan', 'Project tests are not run', 'Nothing is published or merged'],
    intent: task.intent
  };
}
