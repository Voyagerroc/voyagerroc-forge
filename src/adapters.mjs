export const adapters = [
  { id: 'github', name: 'GitHub', status: 'metadata-ready', detail: 'Live metadata and signed events. Scoped edits with static checks are available through the local runner.' },
  { id: 'open-scion', name: 'open_scion / git-ai', status: 'planned', detail: 'Independent open-source (MIT) source-control adapter contract only; RPC compatibility is not yet validated. Independent of Anthropic.' },
  { id: 'gcp-scion', name: 'Google Scion agent orchestration', status: 'planned', detail: 'Independent open-source (Apache-2.0) runner adapter contract only; no remote agents are launched. Not an officially supported Google product.' }
];

export function buildPlan(task, project) {
  return {
    mode: 'dry-run', execution: 'not_started', repository: project.full_name,
    adapter: task.adapter, baseSha: project.latest_sha ?? null,
    steps: [
      { stage: 'context', action: `Resolve repository ${project.full_name} and pin the base revision.` },
      { stage: 'workspace', action: 'Provision an isolated worktree or sparse workspace through the selected adapter.' },
      { stage: 'implement', action: 'Run an explicitly configured coding agent against the task intent.' },
      { stage: 'verify', action: 'Execute repository checks in a sandbox and collect evidence.' },
      { stage: 'review', action: 'Show the patch, test results and provenance for human review.' },
      { stage: 'publish', action: 'Create a draft GitHub pull request only after explicit publication approval.' }
    ],
    gates: ['Runner integration required', 'No commands executed by this planner', 'Human review before publication', 'No automatic merge'],
    intent: task.intent
  };
}
