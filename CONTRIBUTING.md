# Contributing to Voyagerroc Forge

Forge is about one idea: a change that carries its own proof. Small, careful pull requests that keep that idea honest are the most useful contribution. A reproduction, a documentation fix, a test, a fixture or a code change are all welcome.

## Get started

1. Fork and clone the repository. Install Node.js 24.19+ and Git.
2. Run `npm run check`. It checks local documentation links and syntax and runs the offline test suite.
3. Run `npm run demo:runner` and follow the [two-minute walkthrough](README.md#try-it-in-two-minutes) to see the change record and the evidence bundle.

No npm install, cloud account or model account is needed. Optional browser checks are described in [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## What makes a pull request acceptable

- **One problem, a small diff.** Say what triggers the problem and what behaviour changes. Link the issue if there is one. No unrelated changes, reformatting or renames.
- **A failing test first, where a rule changes.** Add the test, show that it fails without your change, then make it pass. A bug fix needs a regression test that catches the bug.
- **The commands you ran and their real results in the description.** Paste the output or its summary: the command, the pass and fail counts, the Node.js version and the operating system. For example: `npm run check`, 115 tests, 0 failed, Node.js 24.19.0, Windows 11.
- **What is not covered.** Name what you did not test or could not test. A mocked result must be called mocked. Do not call static checks project tests, and do not call a planned feature implemented.
- **Documentation and screenshots follow behaviour.** If you change a user-visible behaviour, a configuration option or a limit, update the documentation. For interface changes, include a screenshot from the running application and notes on keyboard use and a 390 px width.
- **No secrets, databases, private source or machine-specific paths** in commits or descriptions.

Draft pull requests are welcome. Use the pull request template.

## What the maintainer commits to

- A first answer to an issue or pull request, with no promised time.
- A review that reads the diff and runs the tests before anything is merged. A pull request is merged when its diff is understood and the tests pass, not before.
- The project never asks for stars or any other favour in return for a review or a merge, and a review does not depend on one.

## Pick an issue, or ask first

Look at the [labels](https://github.com/Voyagerroc/voyagerroc-forge/labels) and the open issues:

- `good first issue`: a bounded entry point with scope and acceptance criteria.
- `help wanted`: the maintainer welcomes implementation or design help.
- `bug`, `enhancement`, `documentation`, `accessibility`: the kind of work.
- `area: runner`, `area: adapters`, `area: ui`: where in the code it lives.

Small fixes need no reservation. For anything large (a new adapter, a change to the evidence format, anything touching how code is run), open an issue first with the smallest useful experiment and how you would validate it, and wait for an answer before writing the patch. See the [roadmap](ROADMAP.md) for the direction and for what is not planned.

## Design boundaries

- Preserve upstream state unless a designed publication step authorizes a write.
- Separate intent, plan approval, execution evidence and publication approval.
- Repository files are **data** in this backend. Project tests, dependency installation or any execution of repository code require an OS-isolated backend with resource and network controls, cancellation and provenance first ([issue #6](https://github.com/Voyagerroc/voyagerroc-forge/issues/6)).
- Use structured process arguments. Treat source content, webhooks and evidence bundles as untrusted.
- A statement in the interface, the documentation or an evidence bundle must be something the code can back today.
- Prefer Node built-ins; justify any new dependency and its maintenance and license cost.
- Keep hosting, identity and secrets explicit; Forge is local and single-user.

## Entry points

| Area | Start here |
| --- | --- |
| HTTP API | `src/server.mjs` |
| Workflow and evidence storage | `src/store.mjs` |
| Snapshot and lifecycle | `src/runner.mjs` |
| Process supervision | `src/runner-process.mjs` |
| Scoped edits | `src/edit-worker.mjs` |
| Evidence bundle and verifier | `src/evidence.mjs`, `scripts/evidence.mjs` |
| GitHub API and auth | `src/github.mjs` |
| UI | `public/app.js`, `public/index.html`, CSS files |
| Tests | `test/` (`forge.test.mjs`, `runner.test.mjs`, `evidence.test.mjs`, `record-view.test.mjs`) |

Use issues for bounded bugs and proposals. Report vulnerabilities privately through [SECURITY.md](SECURITY.md). Follow the [code of conduct](CODE_OF_CONDUCT.md).

Contributions are under the repository's MIT license. No CLA or DCO sign-off is required. Only contribute code you have permission to license.
