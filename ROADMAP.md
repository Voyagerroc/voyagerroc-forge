# Roadmap

A contribution map, not a delivery-date promise.

## Available in v0.2

- [x] GitHub metadata, fresh revision resolution, read-only App auth support
- [x] Persistent intent → plan → review → approval
- [x] Disposable pinned Git snapshots and explicit edits
- [x] Actual diffs, patch hashes and named static checks
- [x] Cancellation, process-tree termination and interrupted-run recovery
- [x] Signed/idempotent event ingestion
- [x] Local demo, responsive UI and offline regression tests

## Small contributions welcome

- [x] Actionable occupied-port error handling
- [ ] Repository filters for tasks and history
- [ ] Runner limits visible before starting
- [ ] Keyboard focus restoration in dialogs
- [x] Case-colliding source directory regression fixtures

Browse [good first issues](https://github.com/Voyagerroc/voyagerroc-forge/contribute). Comment before a large patch to avoid duplicate work; small fixes need no reservation.

## Isolated execution

- [ ] Define OS/container threat model and capability contract
- [ ] Implement one backend with resource/network boundaries
- [ ] Integrate one harness with explicit credentials and budgets
- [ ] Preserve real project-check exit codes and log provenance
- [ ] Cancellation, cleanup and crash recovery for that backend
- [ ] Separate patch review from plan approval

## GitHub publication

- [ ] Least-privilege write permissions and ownership/branch checks
- [ ] Draft PR tied to the exact reviewed patch SHA
- [ ] Idempotent writes and timeout reconciliation
- [ ] No automatic merge or default-branch force push

## Adapter experiments

- [ ] Pinned `open_scion`/Graft build and actual RPC fixture evidence
- [ ] Google Scion orchestration lifecycle validation, separately
- [ ] Evolve the proposed interface from working implementations

Anthropic's internal Scion, independent `open_scion`, and Google Scion orchestration are different systems. No integration or affiliation is implied.

## Before hosted operation

- [ ] User auth, installation ownership and tenant authorization
- [ ] Durable queue, worker leases and restart-safe scheduling
- [ ] Migrations, backups and artifact retention
- [ ] Secrets, quotas, audit records and trusted webhook ingress
- [ ] Postgres/storage migration driven by measured requirements

Open a scoped [proposal](https://github.com/Voyagerroc/voyagerroc-forge/issues/new/choose) with the smallest useful experiment and validation criteria.
