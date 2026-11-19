# Changelog

## 0.3.0 — A change that carries its own proof

### Added

- Each task is shown as one change record instead of a workspace board: a
  summary of the source commit, patch hash, checks and approval time, the
  recorded events newest first, and the pinned commit, the diff with line
  numbers, the check results and the approvals as sections. A failed run stays
  in the record with its message. The record states in plain words that the
  hashes are not signed and that project tests are not run. Light and dark
  themes follow the system setting, with a three-state control (#36).
- A portable evidence bundle for every finished run: an unsigned in-toto
  Statement v1 with a Forge predicate, exported with `npm run evidence:export`
  or `GET /api/runs/<run id>/evidence` (#35).
- Independent verification with `npm run evidence:verify`: it re-applies the
  patch to the pinned commit in a disposable copy and re-runs the static checks.
  It reports each claim as `MATCH`, `MISMATCH` or `RECORDED NOT VERIFIABLE`,
  refuses bundles that are not in canonical form or contradict themselves, and
  exits with `0`, `1` or `2` (#35). See [docs/EVIDENCE.md](docs/EVIDENCE.md).
- Each task in the `GET /api/state` response lists its own recorded events,
  oldest first (#34).

### Changed

- The run dialog explains invalid edits next to the field. A cancelled or
  interrupted run tells you what to do next instead of how to fix its edits
  (#36).
- The snapshot, per-file checks, syntax check and whitespace check are shared
  between the runner and the verifier instead of copied (#35).
- README, ROADMAP, CONTRIBUTING and the development guide describe the record
  interface and the evidence bundle, with new screenshots taken from the
  running application.

### Not included

The bundle is not signed: it proves consistency, not origin. Forge still
applies exact edits that you provide, runs static checks only, and runs
locally for one user. The isolated execution backend in #6 is not implemented.

## 0.2.2 — Reliability fixes and regression tests

### Fixed

- An edit that must match exactly once now also rejects overlapping matches,
  for example `aa` in `aaa`, which were previously accepted (#28).
- Only one live server can use a database file. The server takes a
  `<database>.lock` file and, if another live server holds it, exits with a
  message that names the lock and shows how to use a separate `FORGE_DB`;
  a lock left by a process that has exited is replaced (#30).
- `/api/health` reports the version from `package.json` instead of a fixed
  string, and unexpected server errors are written to stderr with the request
  method, path and stack but without request bodies, headers or query strings
  (#31).
- The edit worker's input limit is now derived from the server's request limit
  (1 MiB plus 16 KiB), so edits that the server accepts are no longer refused
  by the worker (#32).

### Tests

- Regression tests for the server request protections: Host header checks,
  and the `X-Forge-Client` header and content-type checks on POST requests
  (#29).

### Documentation and maintenance

- README status line, runner caption and contribution link updated (#27).
- Bump `actions/checkout` from 6.1.0 to 7.0.1 (#26) and `actions/setup-node`
  from 6.5.0 to 7.1.0 (#25) in the CI workflow.

## 0.2.1 — Prototype maintenance

### Fixed

- The Create a workflow, Workflow specification and Run evidence dialogs take
  their accessible name from their visible heading, so a screen reader
  announces each dialog by purpose instead of only "dialog" (#22).
- Starting Forge while its port is already held exits with a message naming
  the port and a `PORT=` hint instead of a raw EADDRINUSE stack trace (#1).

### Maintenance

- Activate the offline dependency-free check suite on clean Ubuntu/Windows
  pull-request runners with read-only permissions and pinned Node 24 actions.
- Monitor GitHub Actions through Dependabot and link actual CI outcomes rather
  than a fixed historical test-count badge.
- Use erol@voyagerroctechnologies.com consistently for private reports.

This remains an experimental, single-user prototype; the isolated execution
backend in #6 and hosted multi-user operation are not implemented.

## 0.2.0 — First public prototype

### Working foundations

- GitHub metadata, fresh branch revision resolution and optional read-only App authentication
- Persistent task intent, plan, review and approval stages
- Disposable pinned Git source snapshots and exact UTF-8 edits
- Actual patch, SHA-256 and named static-check evidence
- Bounded processes, cancellation, descendant termination and interrupted-run recovery
- Signed/deduplicated webhook ingestion and ordered PR snapshots
- Dependency-free local UI, SQLite persistence and a repeatable local demo
- Offline checks and regression tests; Linux/Windows CI configuration

### Community

- MIT license, contribution guide, roadmap and security/reporting policy
- Bug/proposal forms, pull request template and real demo screenshots

### Known boundaries

No AI code generation, arbitrary repository command execution, project test backend, upstream publication, hosted multi-user operation or external Scion integration. Static checks do not establish semantic correctness. See [ROADMAP.md](ROADMAP.md) for scoped opportunities.
