# Architecture and extension points

Forge is a local application with framework building blocks. It does not yet export a stable npm SDK or plugin ABI.

| Component | Responsibility |
| --- | --- |
| `server.mjs` | Loopback HTTP, request validation, capabilities and route orchestration |
| `store.mjs` | SQLite state machine, atomic evidence/events and webhook receipts |
| `github.mjs` | Canonical repository validation, read API, App tokens and signatures |
| `adapters.mjs` | Capability catalog and deterministic plan specification |
| `runner.mjs` | Source pinning, snapshots, fixed-worker lifecycle and evidence |
| `runner-process.mjs` | Minimal process environment, limits and descendant cancellation |
| `edit-worker.mjs` | Explicit file replacements and text/JSON/conflict checks |
| `public/` | Dependency-free local web UI |

## Separate the meanings of approval

Task states: queued → planned → in review → approved. This approves a specification. Run states are independent: preparing → running → terminal result. Neither plan approval nor a passed static run authorizes upstream publication.

The database stores projects, tasks, runs, events, deliveries and PR snapshots. State changes and their audit events use transactions. Run evidence includes immutable source SHA, exact patch bytes, patch hash and named results. Summary responses omit full patch bodies; run-detail responses return them.

## Source and execution adapters

GitHub is initially authoritative. A public run resolves fresh branch HEAD and reads exact Git objects into a disposable copy. Operator mappings use committed local HEAD. Original source repositories are not modified.

Source control and execution should remain separate abstractions. `open_scion` is a source-control experiment; Google Scion is agent orchestration. Both remain planned. Read the [proposed adapter contract](ADAPTER-CONTRACT.md) before designing an implementation.

The current runner is a trusted fixed edit worker with static checks. Future harnesses/tests need OS isolation and real lifecycle/resource/network policies. Keep capability flags honest and preserve the reviewable artifact boundary.

## Design notes

- [Configuration](CONFIGURATION.md)
- [Runner behavior and limits](RUNNER-2026-10-28.md)
- [Scion research and primary sources](RESEARCH-2026-10-28.md)
- [Roadmap](../ROADMAP.md)
- [Security boundaries](../SECURITY.md)
