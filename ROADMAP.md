# Roadmap

Direction: **a change that carries its own proof.** Writing a change has become cheap; trusting it has not. Forge's answer is a change that records what it was based on, exactly what changed, what was checked and what was not, and when its plan was approved. Anyone can re-check the source, the exact change and the static checks without trusting whoever produced it; the approval time and the intent are recorded but cannot be verified.

This is a contribution map, not a delivery-date promise. Items under "Next" and "Later" are plans, not features.

## Done

- [x] Evidence bundle for a finished run and independent verification: `npm run evidence:export`, `npm run evidence:verify`, `GET /api/runs/:id/evidence` (#35, [docs/EVIDENCE.md](docs/EVIDENCE.md))
- [x] One change record per task, with the evidence in the page (#36)
- [x] Per-task recorded events in the state response (#34)
- [x] 0.2.2 fixes: overlapping edit matches rejected, one live server per database file, the real version in `/api/health`, edit worker input limit aligned with the server (#28, #30, #31, #32), and request-protection tests (#29)
- [x] Offline CI on Ubuntu and Windows (#24); accessible dialog names (#23); keyboard focus restoration (#19); runner limits shown before a run (#18); repository filter (#17); patch download (#16)
- [x] Persistent intent → plan → review → approval; disposable pinned Git snapshots; exact edits; actual diffs, patch hashes and named static checks; cancellation and restart recovery; signature-verified, deduplicated GitHub webhook events

## Next

- [ ] Produce the evidence inside the maintainer's own GitHub Actions run and attach it to a pull request, so the proof arrives with the change ([design note](docs/EVIDENCE-IN-CI.md))
- [ ] Sign the evidence through existing standards (GitHub artifact attestations, Sigstore) instead of a format of its own, so a bundle also proves origin
- [ ] Import a patch that was produced outside Forge and give it the same record and verification

## Later

- [ ] An OS-isolated execution backend with resource and network boundaries ([issue #6](https://github.com/Voyagerroc/voyagerroc-forge/issues/6)). **This is the gate for running any project code:** until it exists, Forge does not run project tests, install dependencies or execute repository code.
  - [ ] Threat model and capability contract
  - [ ] One backend with real exit codes and log provenance
  - [ ] Cancellation, cleanup and crash recovery for that backend
- [ ] Draft pull request tied to the exact reviewed patch hash, with least-privilege write permission, idempotent writes and no automatic merge
- [ ] Adapters for `open_scion` and Google Scion. Nothing is implemented and no date is set: the API and the interface list them as placeholders with status `planned`, and no compatibility is claimed. Forge has no verified contract with either system, so the [adapter contract](docs/ADAPTER-CONTRACT.md) stays a proposal until a working implementation justifies it.
- [ ] If a hosted part ever comes, a thin service for evidence pages and verification. User code does not run on it.

## The 90-day test

If no second outside user adopts this direction within 90 days of 19 November 2026, the direction is reconsidered. Adoption means someone other than the maintainer uses the record and the evidence bundle on their own changes and says so, for example in an issue or a pull request. The result, either way, will be written here.

## Small contributions welcome

Good first work is usually bounded: a reproduction of friction in the two-minute demo, a missing test for a documented rule, a clearer message, or a keyboard or mobile defect in the record. Look for the `good first issue`, `help wanted` and `area:` [labels](https://github.com/Voyagerroc/voyagerroc-forge/labels). If none fits, or the change is large, ask in an issue before starting. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Not planned

- **AI code generation inside Forge.** The direction is proof for a change, whoever or whatever wrote it; a generator would add a claim Forge cannot check.
- **Hosted multi-user operation** (login, tenants, durable queues). It is not needed for the direction, and the local, single-user boundary is what keeps the security model small.
- **A format of our own for signatures.** Existing standards are better understood and already supported.

Open a scoped [proposal](https://github.com/Voyagerroc/voyagerroc-forge/issues/new/choose) with the smallest useful experiment and how you would validate it.
