# Changelog

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
