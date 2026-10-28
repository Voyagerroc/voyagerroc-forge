# Contributing to Voyagerroc Forge

Welcome. Forge is an early framework starter: small, inspectable changes are especially valuable. A reproduction, documentation improvement, design review, fixture or code change is welcome.

## Get started

1. Fork and clone the repository. Install Node.js 24.19+ and Git.
2. Run `npm run check` for the offline suite.
3. Run `npm run demo:runner` to try the real local fixture and evidence UI.
4. Pick a [good first issue](https://github.com/Voyagerroc/voyagerroc-forge/contribute) or open a proposal before a large architectural change.

No npm install or cloud/model account is needed. Optional browser checks: [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Send a focused pull request

- Branch from `main`; address one problem.
- Describe a concrete trigger and resulting behavior. Link the issue if one exists.
- Run `npm run check`. Behavioral fixes should include a regression check that catches the bug; UI changes should include a screenshot and keyboard/mobile notes.
- Update docs when changing capability flags, configuration or behavior.
- Show actual evidence. Do not call static checks project tests, mock results live integrations, or planned adapters implemented.
- Keep secrets, databases, private source and machine-specific paths out of commits/reports.

Draft PRs are welcome. No guaranteed response time or automatic merge is promised.

## Design boundaries

- Preserve upstream state unless a designed publication step authorizes a write.
- Separate intent, plan approval, execution evidence and publication approval.
- Repository files are **data** in this backend. Agents/project-test commands require OS isolation, resource/network controls, cancellation and provenance before enablement.
- Use structured process arguments. Treat source content and webhooks as untrusted.
- Prefer Node built-ins; justify new dependencies and their maintenance/license cost.
- Keep hosting, tenant identity and secrets explicit; this prototype is local and single-user.

## Entry points

| Area | Start here |
| --- | --- |
| HTTP API | `src/server.mjs` |
| Workflow/evidence storage | `src/store.mjs` |
| Snapshot and lifecycle | `src/runner.mjs` |
| Process supervision | `src/runner-process.mjs` |
| Scoped edits | `src/edit-worker.mjs` |
| GitHub API/auth | `src/github.mjs` |
| UI | `public/app.js`, `public/index.html`, CSS files |
| Regression tests | `test/forge.test.mjs`, `test/runner.test.mjs` |

Use issues for bounded bugs/proposals; report vulnerabilities privately through [SECURITY.md](SECURITY.md). Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Contributions are under the repository's MIT license. No CLA or DCO sign-off is currently required. Only contribute code you have permission to license.
