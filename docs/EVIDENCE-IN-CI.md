# Producing evidence inside a GitHub Actions run

This is a design note for the future work listed at the end of [EVIDENCE.md](EVIDENCE.md) and in [ROADMAP.md](../ROADMAP.md): producing a Forge evidence bundle inside a GitHub Actions run for a pull request, signing it with GitHub artifact attestations, and handling patches that were not created through a Forge task.

Nothing in this note is implemented yet. No workflow file is added under `.github/workflows/`, no code is changed, and the current bundle format (`#v1`) is unchanged.

## Why produce evidence in CI

A bundle exported on a contributor's machine (`npm run evidence:export`) is unsigned. As [EVIDENCE.md](EVIDENCE.md) states, it proves that its parts agree with each other and with the repository, not who produced it. If a contributor edits a patch, recomputes its hash and re-runs the static checks locally, the result is a different valid bundle that no offline verifier can distinguish from an original.

Producing the bundle inside the maintainer's own GitHub Actions run moves bundle generation onto a runner the contributor does not control. Signing that output with GitHub artifact attestations binds the bundle to the repository and workflow that produced it, using an existing standard (in-toto + Sigstore) instead of a Forge-specific signature format.

## What a pull-request workflow would do

The steps below describe what a future workflow would run for a pull request, starting from the conventions already used in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) and [`docs/ci/github-actions.yml`](ci/github-actions.yml) (Node.js 24.19, `persist-credentials: false`, actions pinned by full commit SHA).

| Step | What it does | Exists in code today? |
| --- | --- | --- |
| 1. Check out base and head commits | Check out the repository with `actions/checkout` (pinned by commit SHA, `persist-credentials: false`) with enough history to hold both the pull request's base commit (`github.event.pull_request.base.sha`) and head commit (`github.event.pull_request.head.sha`), without running any repository code. | Partial: `.github/workflows/ci.yml` pins `actions/checkout` with `persist-credentials: false`, but does not fetch a PR base+head pair for diffing. |
| 2. Compute the patch | Produce the unified diff between the base commit and the head commit with Git running under Forge's fixed safe flags (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, `credential.helper=`, `protocol.ext.allow=never`, `--no-ext-diff`, `--no-textconv`, cleaned environment). | Partial: [`git`](../src/runner-process.mjs) already enforces the safe Git flags and cleaned environment, but no command computes a patch from two commits outside a Forge run. |
| 3. Validate the patch shape and paths | Scan headers and extract raw paths with `git apply --numstat -z` outside any repository, rejecting deletions, renames, copies, mode changes, symlinks, binary files, disallowed paths and patches over 20 files (`EDIT_LIMITS.maxCount`). | **Yes:** [`scanPatchHeaders`](../src/evidence.mjs), [`patchPaths`](../src/evidence.mjs), [`editPath`](../src/edit-worker.mjs). |
| 4. Materialise a clean base snapshot and apply the patch | Materialise the base commit's tracked blobs into a disposable temporary workspace (bounded by `SNAPSHOT_LIMITS`: 1–200 regular files, 1 MiB per file, 10 MiB total, no symlinks, submodules or case collisions) and apply the patch with `git apply --whitespace=nowarn`. | **Yes:** [`pinSnapshot`](../src/runner.mjs) and the apply path in [`verifyEvidence`](../src/evidence.mjs). |
| 5. Run Forge's static checks | On the patched UTF-8 files, run `edit:` (SHA-256), `conflicts:`, `json:` (for `.json` files), `syntax:` (for `.js`/`.mjs`/`.cjs` via `node --permission --no-addons --max-old-space-size=128 --check`, never executing source) and `diff-whitespace`. | **Yes:** [`contentChecks`](../src/edit-worker.mjs), [`syntaxCheck`](../src/runner.mjs), [`whitespaceCheck`](../src/runner.mjs), [`isJavaScriptPath`](../src/runner.mjs). |
| 6. Write the canonical evidence bundle | Build a canonical JSON bundle (sorted keys at every depth, two-space indentation, LF, trailing newline, `<= 8 MiB`). | **No:** [`buildEvidence`](../src/evidence.mjs) reads a finished run, task and events from SQLite; [`serializeEvidence`](../src/evidence.mjs) exists, but no CLI or function builds a bundle from a Git base/head pair without a database. |
| 7. Self-verify the written bundle | Run `npm run evidence:verify -- <bundle> --repo <clone>` against the local checkout so a broken or refused bundle fails the job before upload. | **Yes** for `#v1` ([`scripts/evidence.mjs`](../scripts/evidence.mjs)); needs `#v2` support for non-Forge bundles (below). |
| 8. Attach the bundle to the run | Upload the canonical JSON file as a workflow artifact (for example with `actions/upload-artifact` pinned by commit SHA) so reviewers can download it from the run. | **No:** no workflow exists yet. |
| 9. Attest the bundle (when token permissions allow) | Call `actions/attest` (pinned by commit SHA) to mint a short-lived Sigstore signature and record a GitHub artifact attestation for the bundle. | **No:** no workflow exists yet. |

Note on current patch limits: because step 3 reuses Forge's existing patch rules, a pull request that deletes, renames or copies files, changes file modes, touches binary files, or modifies more than 20 files would be refused rather than producing a passing bundle. Widening those limits is a separate question and out of scope here.

## What predicate v1 cannot express for a non-Forge patch

In [`src/evidence.mjs`](../src/evidence.mjs), `PREDICATE_TYPE` is versioned as:

```text
https://github.com/Voyagerroc/voyagerroc-forge/blob/main/docs/EVIDENCE.md#v1
```

`parseBundle` requires an exact match and exits with `2` on any other predicate version. It also requires:

- `predicate.record` to be an object containing `record.intent` (an object; `buildEvidence` writes `{ title, text }`) and `record.events` (an array of `{ kind, at }` strings).
- `record.planApprovedAt` (optional string) to match the timestamp of the last `task.approved` event in `record.events`, with both absent together.
- `predicate.run` to carry an `id` and a final status (`passed`, `failed`, `cancelled`, `timed_out`, `interrupted`).

A pull request opened by a contributor without a local Forge server has no Forge task, no `record.intent`, no `record.events` and no `planApprovedAt`. Fabricating placeholder strings (such as copying the PR title into `record.intent`) or writing synthetic empty arrays would break Forge's own rule in [EVIDENCE.md](EVIDENCE.md): *absent values are omitted, never invented*.

### Proposal: predicate `#v2` with honest absent fields

Introduce a new predicate version:

```text
https://github.com/Voyagerroc/voyagerroc-forge/blob/main/docs/EVIDENCE.md#v2
```

rather than silently relaxing `#v1`. In `#v2`:

- `predicate.record` is **optional**. When the bundle comes from a Forge task, `predicate.record` keeps the `#v1` shape (`intent`, `events`, optional `planApprovedAt`). When the bundle comes from a patch outside Forge (such as CI or a future local patch import), `predicate.record` is omitted completely.
- `predicate.run` stays required (`id` can be a CI run identifier or generated UUID, `status` is `passed` or `failed` based on the static checks, `startedAt` and `finishedAt` are recorded timestamps).
- `predicate.notRun` and `predicate.limits` remain required and keep the same honesty statements: static checks only, no project tests, no dependency installation, no execution of repository code.
- **Old verifiers must refuse `#v2`.** Because `src/evidence.mjs` already checks `bundle.predicateType !== PREDICATE_TYPE` and exits with `2` (`predicate version "v2" is not supported (this verifier reads v1)`), an un-updated v1 verifier will reject a `#v2` bundle cleanly instead of misinterpreting missing fields.

### Changes required when `#v2` is built

- **`src/evidence.mjs`:**
  - Define both v1 and v2 predicate constants; accept `#v1` and `#v2` in `parseBundle` while still refusing any other version with exit `2`.
  - In `#v1`, keep `predicate.record` (`intent` and `events`) strictly required as today.
  - In `#v2`, allow `predicate.record` to be omitted (`undefined`), and validate its shape only when present.
  - In `checkConsistency`, skip the `planApprovedAt` / `task.approved` check when `predicate.record` is absent.
  - In `verifyEvidence`, report `intent`, `plan approval time` and `events` as absent (for example `RECORDED NOT VERIFIABLE` with detail `not recorded; patch was not produced by a Forge task`) instead of reading `p.record.events.length` unconditionally.
  - Add a builder that takes `{ repository, baseCommit, patch, checks, run }` without a SQLite store and emits canonical `#v2` JSON.
- **`docs/EVIDENCE.md`:**
  - Document `#v2` alongside `#v1` in the field table, explaining when `predicate.record` is omitted and how `evidence:verify` reports it.
  - Update the predicate version note to state that `#v1` and `#v2` are accepted and any other version is refused.

## Signing with GitHub artifact attestations

Rather than inventing a Forge-specific signature format (a non-goal in [ROADMAP.md](../ROADMAP.md)), the workflow should sign its output using GitHub artifact attestations via [`actions/attest`](https://github.com/actions/attest) (pinned by full commit SHA).

### How it fits Forge's format

`actions/attest` binds a subject (a file and its SHA-256 digest) to an in-toto Statement, signs it with a short-lived Sigstore certificate minted via GitHub OIDC, and uploads the Sigstore bundle to GitHub's attestations API. For public repositories, it uses the Sigstore Public Good Instance and records the signature in the public transparency log; for private or internal repositories on GitHub Enterprise Cloud, it uses GitHub's private Sigstore instance.

There are two ways to attach the attestation:

1. **Attest the canonical evidence JSON file as the subject** (`subject-path: evidence.json`, default SLSA build provenance `https://slsa.dev/provenance/v1`). This is the smallest first step: the downloaded `evidence.json` still passes directly into `npm run evidence:verify`, and `gh attestation verify` works with its default predicate type to prove that exact file came from the repository's workflow.
2. **Attest the `.patch` file with a custom predicate** (`subject-path`, `predicate-type`, `predicate-path`). This wraps the Forge predicate directly inside the signed in-toto Statement, at the cost of requiring `--predicate-type` during `gh attestation verify` and extracting the statement before running `evidence:verify`.

Option 1 is recommended first because it requires no change to `evidence:verify` and works with `gh attestation verify` defaults.

### Permissions, verification and plan limits

Per GitHub's documentation (all pages read on **2026-11-20**):

- **Workflow permissions** ([Use artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)):
  - `id-token: write` — mints the OIDC token needed to request a Sigstore signing certificate.
  - `attestations: write` — persists the signed attestation via GitHub's attestations API.
  - `contents: read` — reads the repository context.
  - *(Note: the [`actions/attest` README](https://github.com/actions/attest) also lists `artifact-metadata: write` when creating an artifact storage record for registry pushes; `action.yml` notes `create-storage-record` requires `push-to-registry: true`, which is not used for plain file artifacts.)*
- **How a reader verifies** ([`gh attestation verify` manual](https://cli.github.com/manual/gh_attestation_verify), [Use artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)):
  ```sh
  # 1. Verify origin (who ran the workflow that produced this exact bundle file)
  gh attestation verify evidence.json \
    --repo Voyagerroc/voyagerroc-forge \
    --signer-workflow Voyagerroc/voyagerroc-forge/.github/workflows/<workflow>.yml

  # 2. Verify content (patch hash, clean apply to base commit, and static checks)
  npm run evidence:verify -- evidence.json --repo /path/to/local/clone
  ```
  If custom-predicate mode is ever used instead of default SLSA provenance, the reader must also pass `--predicate-type <URI>`, because `gh attestation verify` defaults to `https://slsa.dev/provenance/v1`.
- **Plan limits** ([Use artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations), [`actions/attest` README](https://github.com/actions/attest)):
  - **Public repositories:** available on all current GitHub plans (GitHub Free, Pro, Team and Enterprise Cloud).
  - **Private and internal repositories:** requires a **GitHub Enterprise Cloud** plan.
  - **GitHub Enterprise Server:** not supported.

## Open questions from GitHub's documentation

### 1. What can a workflow triggered by a pull request from a fork do with the token and with attestations?

Per [Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) (*How permissions are calculated for a workflow job* and *Using the permissions key for forked repositories*, read 2026-11-20):

- When a workflow is triggered by a pull request event other than `pull_request_target` from a forked repository, GitHub downgrades any `write` permission on `GITHUB_TOKEN` to `read`-only (unless a repository admin has enabled *Send write tokens to workflows from pull requests*). Secrets are also withheld ([Securely using `pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), read 2026-11-20).
- On public repositories, a first-time contributor's fork pull request may also require a maintainer with write access to approve running workflows ([Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), read 2026-11-20).
- `id-token` requires `id-token: write` (it has no read level), and persisting an attestation requires `attestations: write`. GitHub's artifact attestation guide does not add a fork exception to those permission rules. Consequently, a `pull_request` workflow triggered from a fork **cannot** mint an OIDC signing token or write an attestation to the base repository. It *can* still run with `contents: read`, compute the patch and static checks, verify the bundle, and upload the unsigned `evidence.json` as a workflow artifact.

### 2. `pull_request` vs `pull_request_target`, and which trigger this design chooses

Per [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) and [Securely using `pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target) (read 2026-11-20):

| Aspect | `pull_request` | `pull_request_target` |
| --- | --- | --- |
| Workflow file and default checkout | Taken from the pull request's merge commit. | Taken from the base repository's default branch. |
| Token and secrets on fork PRs | `GITHUB_TOKEN` downgraded to read-only; secrets withheld. | Receives base repository's read/write `GITHUB_TOKEN` and secrets. |
| Default GitHub policy on public repos | Allowed (subject to fork-approval settings for first-time contributors). | GitHub provides a default event policy that blocks `pull_request_target` in public repositories (currently in evaluate mode; enforced starting 2 December 2026 unless an explicit Actions event policy allows it). |

**Choice: use `pull_request`, not `pull_request_target`.**

- On `pull_request`, every pull request (including from forks) gets the same unprivileged, read-only run that produces and uploads the canonical evidence bundle artifact. For pull requests from branches inside the same repository, `id-token: write` and `attestations: write` work directly; for fork pull requests, the attestation step is skipped (or separated) and the bundle remains an unsigned artifact.
- Avoiding `pull_request_target` avoids both the pwn-request footgun and GitHub's default public-repository block policy.
- If signed attestations are later desired for fork pull requests before merge, GitHub's [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use) (read 2026-11-20) recommends privilege separation with `workflow_run` over `pull_request_target`: the unprivileged `pull_request` job uploads the bundle artifact, and a separate `workflow_run` job (running code strictly from the default branch, with `id-token: write` and `attestations: write`) treats the downloaded artifact as untrusted data, re-runs `evidence:verify` against the repository, and attests it only if verification passes. Alternatively, signing only on `push` to `main` after merge keeps the pre-merge path completely unprivileged.

### 3. What must never be checked out and executed in a privileged context

Per [Securely using `pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target) and [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use) (read 2026-11-20), any privileged workflow (`pull_request_target`, `workflow_run`, `issue_comment`) must **never**:

- Check out a pull request's head or merge commit (`github.event.pull_request.head.sha`, `refs/pull/<n>/merge`, or the fork repository) and run any code, build script, `npm install`, `npm test`, linter, Makefile, Git hook or action from it.
- Execute or trust unverified artifacts downloaded from a fork's `pull_request` run.

In this design, **the only execution is Forge's own static checks** from the trusted checkout (`src/evidence.mjs`, `src/edit-worker.mjs`, `src/runner.mjs`, `src/runner-process.mjs`):

- Repository files are treated strictly as data, never imported or executed.
- Git runs with `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `credential.helper=`, `protocol.ext.allow=never`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_NO_LAZY_FETCH=1` and `GIT_ALLOW_PROTOCOL=file`.
- JavaScript syntax checking runs `node --permission --allow-fs-read=<workspace> --no-addons --max-old-space-size=128 --check` and never executes the checked file.
- No project tests, dependency installation or arbitrary repository code ever runs.

## Workflow sketch (not an active workflow)

> **Sketch only.** Do not copy this directly into `.github/workflows/` until the `#v2` predicate and a CLI command to produce a bundle from a Git commit pair exist. All actions must be pinned to full commit SHAs before use, matching [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

```yaml
# SKETCH — NOT IMPLEMENTED, NOT AN ACTIVE WORKFLOW
name: Evidence (sketch)

on:
  pull_request:

permissions:
  contents: read
  # Required for actions/attest on same-repo PRs; downgraded to read-only on fork PRs.
  id-token: write
  attestations: write

jobs:
  evidence:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Check out repository (base and head objects, no credentials persisted)
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v6
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Set up Node
        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v6
        with:
          node-version: '24.19.0'
          package-manager-cache: false

      # Does not exist yet: produce canonical #v2 bundle from base..head using Forge's static checks only.
      - name: Produce evidence bundle (proposed CLI)
        run: >
          node scripts/evidence.mjs from-git
          --repo .
          --base "${{ github.event.pull_request.base.sha }}"
          --head "${{ github.event.pull_request.head.sha }}"
          --name "${{ github.repository }}"
          --out "${{ runner.temp }}/evidence.json"

      - name: Verify bundle against local checkout
        run: npm run evidence:verify -- "${{ runner.temp }}/evidence.json" --repo .

      - name: Upload evidence bundle artifact
        uses: actions/upload-artifact@<PINNED_COMMIT_SHA>
        with:
          name: forge-evidence
          path: ${{ runner.temp }}/evidence.json
          if-no-files-found: error

      # Same-repo PRs only: fork PRs have read-only GITHUB_TOKEN and cannot mint OIDC / write attestations.
      - name: Attest evidence bundle
        if: github.event.pull_request.head.repo.full_name == github.repository
        uses: actions/attest@<PINNED_COMMIT_SHA>
        with:
          subject-path: ${{ runner.temp }}/evidence.json
```

## Threat model

This table extends the threat model in [EVIDENCE.md](EVIDENCE.md) to show what an Actions-produced and attested bundle catches that today's local unsigned bundle does not, and which limits stay unchanged.

| Lie or threat | Caught by today's unsigned bundle? | Caught by Actions + attestation? | Notes |
| --- | --- | --- | --- |
| Someone edits the patch text in the bundle without fixing hashes | Yes (`patch SHA-256` mismatch) | Yes (`evidence:verify` + `gh attestation verify`) | Both catch it. |
| Contributor builds a *different* valid bundle locally (different patch, recomputed hash, honest checks for that patch) and passes it off as CI's output | **No** — valid unsigned bundles cannot be told apart | **Yes** — `gh attestation verify --repo ... --signer-workflow ...` fails because the contributor does not control the maintainer's runner or OIDC identity | Main new guarantee of CI + attestation. Does not apply to un-attested fork PR artifacts. |
| Someone edits `recorded, not verifiable` metadata (`repository.fullName`, `run.startedAt`, `tool.version`, `run.summary`) after CI wrote the bundle | **No** — those fields are reported `RECORDED NOT VERIFIABLE` | **Yes** — any byte change invalidates the attested SHA-256 digest of `evidence.json` | Proves CI wrote those bytes, not that external human claims are true. |
| Someone flips a failed check to `passed`, deletes a check, or invents an unknown check (e.g. `tests:all`) | Yes (`evidence:verify` recomputes checks and rejects unknown names) | Yes (`evidence:verify` + attestation) | Unchanged. |
| Hostile patch tries to write outside the workspace, into `.git`, add symlinks/binaries, or spoof terminal output | Yes (`scanPatchHeaders`, `patchPaths`, `plainText`, `formatJson`) | Yes (same static code runs in CI and locally) | Unchanged. |
| Someone claims project tests passed or the change is semantically correct | **No** — static checks only | **No** — static checks only | **Honest limit kept:** CI in this design never runs project tests or repository code. |
| Someone claims a human read the intent or approved the plan at a given time | **No** — recorded, not verifiable | **No** — recorded, not verifiable (and absent for non-Forge PRs in `#v2`) | **Honest limit kept:** attestation proves what the workflow wrote, not human review or approval. |
| Fork PR bundle is downloaded before merge (from an unprivileged `pull_request` run) | Unsigned | **Still unsigned** (not attested on fork `pull_request`) | Origin is not proven until attested by a privileged post-merge or `workflow_run` step. |
| Maintainer repository, GitHub Actions runner, or Sigstore/OIDC issuer is compromised | Out of scope | Out of scope | Same trust boundary as GitHub-hosted CI and Sigstore. |

## Non-goals

- **No hosted service.** Forge stays local and single-user; GitHub Actions and GitHub's attestation API are the only remote components involved.
- **No secret.** Signing uses keyless OIDC (`id-token: write`); no signing key, PAT or GitHub App private key is stored in repository secrets.
- **No paid feature.** For public repositories, GitHub artifact attestations work on all current GitHub plans. Private/internal repositories require GitHub Enterprise Cloud, which is noted as a GitHub plan limit rather than a Forge requirement.
- **No project test execution.** Neither the workflow nor Forge's verifier runs project tests, installs dependencies or executes repository code. Running project code remains gated on an OS-isolated backend ([issue #6](https://github.com/Voyagerroc/voyagerroc-forge/issues/6)).

## References

All GitHub documentation pages below were read on **2026-11-20**:

- [Use artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) — required permissions (`id-token: write`, `contents: read`, `attestations: write`), `actions/attest@v4` usage, `gh attestation verify` command, and plan availability (public repositories on all current plans; private/internal repositories require GitHub Enterprise Cloud).
- [Artifact attestations concepts](https://docs.github.com/en/actions/concepts/security/artifact-attestations) — Sigstore Public Good Instance and public transparency log for public repositories.
- [`actions/attest` repository](https://github.com/actions/attest) — attestation modes (provenance, SBOM, custom `predicate-type`/`predicate-path`), inputs in `action.yml`, plan notes (including GitHub Enterprise Server not supported), and Sigstore private instance for private/internal repositories.
- [`gh attestation verify` CLI manual](https://cli.github.com/manual/gh_attestation_verify) — default `https://slsa.dev/provenance/v1` predicate type, `--predicate-type`, `--repo` and `--signer-workflow` flags.
- [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) — `pull_request` vs `pull_request_target` contexts and fork pull request workflow approval.
- [Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) — `GITHUB_TOKEN` permission calculation, downgrade of `write` permissions to `read` on forked pull requests, and `id-token: write`.
- [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use) — avoiding `pull_request_target` and using `workflow_run` for privilege separation.
- [Securely using `pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target) — pwn-request risks, why checking out and executing fork code in a privileged trigger is unsafe, and GitHub's default policy blocking `pull_request_target` on public repositories (enforced starting 2 December 2026).

## Proposed follow-up issue (smallest first code step)

**Title:** Produce and verify a `#v2` evidence bundle from a local Git commit range without a Forge database

**Why it matters:** Before adding any GitHub Actions workflow, Forge needs a local, offline-testable way to turn a base commit and a head commit (a patch that was not produced by a Forge task) into a canonical evidence bundle and verify it with `npm run evidence:verify`.

**What done looks like:**

- Add predicate version `https://github.com/Voyagerroc/voyagerroc-forge/blob/main/docs/EVIDENCE.md#v2` in `src/evidence.mjs` where `predicate.record` is optional (omitted for non-Forge patches rather than invented). Keep `#v1` unchanged and refuse any unknown predicate version with exit `2`.
- Add a builder in `src/evidence.mjs` and a CLI subcommand in `scripts/evidence.mjs` (for example `from-git --repo <path> --base <sha> --head <sha> --name <fullName> [--out <file>]`) that computes the unified diff with Forge's safe Git flags, applies the existing patch refusal rules (`scanPatchHeaders`, `patchPaths`), runs the existing static checks (`pinSnapshot`, `contentChecks`, `syntaxCheck`, `whitespaceCheck`), and writes canonical `#v2` JSON without touching SQLite or executing repository code.
- Update `verifyEvidence` in `src/evidence.mjs` to verify `#v2` bundles cleanly when `predicate.record` is absent, reporting the missing record fields as `RECORDED NOT VERIFIABLE` (not recorded) while keeping all patch, base-commit, static-check and internal-consistency rules intact.
- Document `#v2` and the new command in `docs/EVIDENCE.md`.
- Add offline tests in `test/evidence.test.mjs` covering: `#v2` generation from a temporary Git repo, verification pass, tampered-patch mismatch, refused patch (deletion/binary/path rule), absent `predicate.record` reporting, and refusal of unknown predicate versions (`#v3`).

**How to verify:** `npm run check` passes with all new tests green, with no network access and no `.github/workflows/` changes.

**Out of scope:** Adding any `.github/workflows/` file, calling `actions/attest`, widening Forge's patch limits (deletions, renames, binary files, >20 files), or running project tests.
