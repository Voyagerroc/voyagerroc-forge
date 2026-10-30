# Development and verification

## Offline checks

```sh
npm run check
```

Runs documentation-link validation, syntax checks and Node's built-in tests. The suite uses local fixture repositories and generated test-only keys; it does not need GitHub/model/cloud credentials or network access. Git and Node.js 24.19+ are required. The local Windows run passed 63 tests; hosted Linux/Windows results have not been obtained.

## CI activation

The [GitHub Actions template](ci/github-actions.yml) targets Ubuntu and Windows, uses read-only repository permissions, pins actions to verified commits and runs the offline check command. It is stored outside `.github/workflows` and therefore does not execute automatically.

The initial publishing credential has repository access but lacks `workflow` scope. An authorized maintainer can enable CI through GitHub's web editor, or refresh their own CLI authorization with `gh auth refresh -h github.com -s workflow`, then copy the template to `.github/workflows/ci.yml` and push it. Check the resulting jobs before claiming either hosted platform passes. The current public prototype does not require CI activation to run locally or accept pull requests.

For interactive work:

```sh
npm run demo:runner
```

The UI is at http://127.0.0.1:4317. `npm run dev` uses Node's watch mode for the ordinary server. Only one server may bind to a given port. Do not commit `data/`, `qa/`, secrets or private source.

## Optional browser acceptance

Install Playwright temporarily without changing the manifest/lockfile:

```sh
npm install --no-save --package-lock=false @playwright/test
npx playwright install chromium
```

With the demo server running, run:

```sh
node scripts/runner-browser-smoke.cjs
```

It creates a labeled local task, advances it to approval, runs a scoped edit, checks actual evidence and persistence, and captures ignored QA screenshots. It does not mutate upstream code. Repeated runs create more labeled records. If using an already installed package, `PLAYWRIGHT_MODULE` can point to its module path. `FORGE_URL` selects a nondefault local server for this runner browser script.

`scripts/browser-smoke.cjs` imports public metadata and exercises the planning UI. `scripts/public-runner-smoke.mjs` additionally resolves/fetches a small real public GitHub source and creates a local-only patch. These two scripts require network access and are not in the offline CI suite.

## Test scope

Tests cover persistence, optimistic state transitions, webhook signature/replay/ordering, App signing/token caching, pinned Git snapshots, source preservation, actual diff hashes, failed static checks, nonexecution of repository code, path/UTF-8 restrictions, cancellation, descendants, deadlines, restart recovery and API boundaries.

Snapshot case-collision regressions create committed paths through the Git index, allowing the same fixtures on case-sensitive and case-insensitive filesystems. They cover nested directory prefixes, file/directory overlaps in either order, existing full-file collisions, and valid mixed-case names. Rejected snapshots must leave the output root empty; both rejected and accepted snapshots must preserve the source HEAD, index, tracked changes and untracked fixture contents.

Static syntax/JSON/whitespace checks are not project test execution. UI acceptance does not prove production isolation or external Scion compatibility.

## Reporting results

For a PR, report the command, relevant environment and pass/fail outcome. Include the actual failing check for bugs. Redact credentials, personal paths and private repository data. See [CONTRIBUTING.md](../CONTRIBUTING.md).
