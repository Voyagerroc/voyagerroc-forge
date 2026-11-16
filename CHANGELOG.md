# Changelog

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
