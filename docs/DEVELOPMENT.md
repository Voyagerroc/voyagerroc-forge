# Development and verification

## Offline checks

```sh
npm run check
```

Runs documentation-link validation, syntax checks and Node's built-in tests. The suite uses local fixture repositories and generated test-only keys; it does not need GitHub/model/cloud credentials or network access. Git and Node.js 24.19+ are required. Use the check summary for the tested revision; the workflow badge links to current hosted results.

## Continuous integration

The [active workflow](../.github/workflows/ci.yml) runs on pull requests, pushes to main and manual dispatch. It targets Ubuntu and Windows with Node.js 24.19.0, read-only repository permissions and commit-pinned actions using the Node 24 runtime. No npm install, provider credentials, browser profile or connected-repository workloads are needed.

The [portable template](ci/github-actions.yml) contains the same job for forks. Workflow configuration is separate from check outcomes: inspect the actual run for the reviewed commit before claiming either hosted platform passes. Dependabot monitors action updates; each update still needs review. The CI suite does not implement the OS-isolated execution backend tracked in issue #6, run arbitrary project tests or change the prototype's local single-user boundaries.

For interactive work:

```sh
npm run demo:runner
```

The UI is at http://127.0.0.1:4317. `npm run dev` uses Node's watch mode for the ordinary server. Only one server may bind to a given port. Do not commit `data/`, `qa/`, secrets or private source.

## Failed edit and corrected follow-up

With Node.js 24.19+ and Git, start `npm run demo:runner` from the repository root and open http://127.0.0.1:4317. The bundled `local/runner-demo` source needs no credentials or network access. On macOS, if Node's permission check reports `ERR_ACCESS_DENIED` for `/var`, restart with `TMPDIR=/private/tmp npm run demo:runner` to use a canonical temporary path.

In another terminal, record the original fixture before running edits:

```sh
git -C data/demo-repository rev-parse HEAD
git -C data/demo-repository status --porcelain
git -C data/demo-repository diff HEAD
```

The last two commands produce no output for a fresh fixture. Choose **New task**, pick **local/runner-demo**, keep the **GitHub** adapter and create the task. In its change record choose **Generate plan**, **Request review** and **Approve plan**. Choose **Run scoped edits**, paste this deliberately absent `before` value, and submit **Run edits & static checks**:

```json
[{"path":"hello.mjs","before":"\"not-present\"","after":"\"hello\""}]
```

The record shows the run as **Failed**. The evidence is in the page itself, not in a dialog:

- The latest result reads `Before text must match exactly once: hello.mjs`.
- **Source** shows the pinned fixture commit; compare it with the HEAD recorded above.
- **Patch SHA-256** is `not available` and the patch says `No patch produced.`
- No static check ran: validation stops before a patch is produced, so the record lists the checks as not run.

On the same approved task, choose **Run scoped edits** again and submit the corrected JSON:

```json
[{"path":"hello.mjs","before":"\"helo\"","after":"\"hello\""}]
```

This creates a **separate run**. The record now lists **Runs on this task: 2**. Run 2 shows **Passed** results for `edit:hello.mjs`, `conflicts:hello.mjs`, `syntax:hello.mjs` and `diff-whitespace`, a **Project tests** row marked **Not run**, a patch SHA-256, and a diff changing `"helo"` to `"hello"`. The summary is `Scoped edits and static checks passed. Project tests were not run.` Choose Run 1 in the runs list: its failure message and lack of patch remain unchanged. A follow-up does not overwrite historical evidence.

Repeat the three Git commands above. HEAD must match the original value, and status/diff must still be empty. The original `data/demo-repository/hello.mjs` still contains `export const greeting = "helo";`; only the disposable copy was edited.

The runner's syntax/JSON/conflict/whitespace checks are static validation, not execution of the source repository's project tests or an AI agent. Stop the server with Ctrl+C. To re-check the passed run without trusting the server, follow [EVIDENCE.md](EVIDENCE.md). Run `npm run check` to validate Forge itself, including documentation links (use `TMPDIR=/private/tmp npm run check` for the macOS path condition above).

## Optional browser acceptance

The repository filter scopes both workflow-board columns and runner history. **All repositories** restores both, including runs whose task is no longer available. Refresh retains a valid selection; a repository removed from the returned state falls back to **All repositories**. The new-task form keeps its own repository selection. For a focused check, use synthetic state with two repositories and runs for each, change the filter by keyboard, refresh, and verify both sections plus the empty-repository case at desktop and 390px widths. The built-in tests cover these cases with a stubbed DOM.

Install Playwright temporarily without changing the manifest/lockfile:

```sh
npm install --no-save --package-lock=false @playwright/test
npx playwright install chromium
```

With the demo server running, run:

```sh
node scripts/runner-browser-smoke.cjs
```

It creates a labeled local task, advances it to approval, runs a scoped edit, checks that the change record shows the actual diff and result and that it persists, and captures ignored QA screenshots. It does not mutate upstream code. Repeated runs create more labeled records. If using an already installed package, `PLAYWRIGHT_MODULE` can point to its module path. `FORGE_URL` selects a nondefault local server for this runner browser script.

The runner browser check also opens the run dialog using the keyboard at 390px, compares displayed limits with API metadata, checks Tab/Shift+Tab navigation and Escape focus restoration, and submits an edit with Enter. It captures `qa/forge-runner-limits-mobile.png` and checks that substituted capability metadata changes the displayed limits without starting another run. The substituted response is a UI fixture; the edit and persisted evidence use the real local runner.

In a completed run's record, **Download patch** saves the exact returned diff as a local UTF-8 `.patch` file. It does not apply the patch or write upstream. For a browser acceptance check, Tab to the button and activate it with Enter, compare the downloaded bytes and SHA-256 with the run's API evidence, then open a no-patch result and confirm the action is absent. Repeat at a 390px viewport. `npm run check` covers line endings, Unicode, final-newline preservation, filename bounds, deferred URL cleanup and action availability with a stubbed DOM; a real browser download remains a separate check.

`scripts/browser-smoke.cjs` imports public metadata and exercises the planning UI. `scripts/public-runner-smoke.mjs` additionally resolves/fetches a small real public GitHub source and creates a local-only patch. These two scripts require network access and are not in the offline CI suite.

### Dialog keyboard walkthrough

With the local demo running, use Tab / Shift+Tab to reach **New task**, then Enter to open it. Close with Escape or Tab to **Close** and press Enter; focus returns to **New task**. Create a task, then use **Generate plan**, **Request review** and **Approve plan** in its record. Repeat the same open/close sequence for **View plan** and **Run scoped edits**. A run's evidence is part of the record, not a dialog: the **Copy** buttons are ordinary buttons and each patch is a focusable, scrollable region. Submit a task or valid scoped edits with the submit button using Enter; the same focus restoration applies. Invalid submissions keep the dialog open. At 390px, the focused control should remain visible and the page and dialogs should not scroll horizontally.

Native `<dialog>` handles modality, Escape and tab navigation. After closing, focus returns to the original trigger or its replacement with the same task ID. If **Run scoped edits** is unavailable, the fallback is that task's **View plan**. If the task is no longer visible, or **New task** is disabled, focus moves to the record heading (programmatically focusable, outside the Tab order). Later state refreshes preserve focus on rebuilt triggers and on a rebuilt **Copy** button without moving focus out of an open dialog.

Run the keyboard regression with an installed Playwright package and a fresh local demo database:

```sh
export TMPDIR="$HOME/workspace/.tmp" # Use an existing, writable temporary directory.
FORGE_DB=data/dialog-focus.sqlite PORT=4319 npm run demo:runner
# In another terminal, with the same TMPDIR (and PLAYWRIGHT_MODULE if needed):
FORGE_URL=http://127.0.0.1:4319 node scripts/dialog-focus-smoke.cjs
```

This script was written for the earlier interface. It has not been re-run against the record interface, so treat it as unverified until it is. The script uses keyboard input for all UI actions at 1440px and 390px. It checks Escape, close buttons, successful forms, rejected JSON, visible focus and horizontal overflow against a real local scoped-edit run. Explicit state refreshes and temporary in-page state changes simulate replaced/disabled/removed triggers; these are UI regressions, not live concurrent-user evidence. Screenshots and the JSON report are written to ignored `qa/`.

## Test scope

Tests cover the change record view, the evidence bundle and its verifier (canonical form, internal consistency, patch refusal and tampered bundles), per-task events, persistence, optimistic state transitions, webhook signature/replay/ordering, App signing/token caching, pinned Git snapshots, source preservation, actual diff hashes, failed static checks, nonexecution of repository code, path/UTF-8 restrictions, cancellation, descendants, deadlines, restart recovery and API boundaries.

Snapshot case-collision regressions create committed paths through the Git index, allowing the same fixtures on case-sensitive and case-insensitive filesystems. They cover nested directory prefixes, file/directory overlaps in either order, existing full-file collisions, and valid mixed-case names. Rejected snapshots must leave the output root empty; both rejected and accepted snapshots must preserve the source HEAD, index, tracked changes and untracked fixture contents.

Static syntax/JSON/whitespace checks are not project test execution. UI acceptance does not prove production isolation or external Scion compatibility.

## Reporting results

For a PR, report the command, relevant environment and pass/fail outcome. Include the actual failing check for bugs. Redact credentials, personal paths and private repository data. See [CONTRIBUTING.md](../CONTRIBUTING.md).
