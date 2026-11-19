# Security policy

## Supported version

Pre-1.0 experimental software. Fixes target the latest `main` and the current prototype release (0.3.x); no long-term support or production suitability is promised.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/Voyagerroc/voyagerroc-forge/security/advisories/new). If unavailable, contact **erol@voyagerroctechnologies.com** with a minimal reproduction and impact description. Do not post credentials, private source or exploitable details in a public issue.

## Current boundaries

- Loopback service, one local operator; no multi-user auth/tenant isolation.
- The fixed worker never evaluates repository source. Node permissions guard trusted code against mistakes; they do not sandbox malicious code.
- Snapshots reject symlinks, submodules, reserved paths and oversized trees. Fetch is time-bounded, not protected by OS disk quotas.
- Process environment, output and runtime are restricted. Cancellation kills descendants; abrupt termination can leave temporary files.
- Local source mappings are operator config, not browser-supplied paths.
- Webhooks require HMAC verification and delivery IDs are deduplicated.
- GitHub credentials stay server-side. Auth is read-only; upstream writes are unimplemented.
- `GET /api/runs/<run id>/evidence` is served only on the loopback address, with the same Host check as the other routes. `npm run evidence:export` opens the database read-only, but SQLite may leave `-shm` and `-wal` files next to it.
- The evidence bundle is not signed. It proves that its parts agree with each other and with the repository, not who produced it; times, the intent text and the approval time are recorded, not verifiable. A bundle is untrusted input to `npm run evidence:verify`, which refuses non-canonical, contradictory or hostile bundles, never writes to the repository it reads, never lets Git fetch objects, never executes repository code, and shows text taken from a bundle as escapes. See [docs/EVIDENCE.md](docs/EVIDENCE.md).

Do not expose this prototype publicly or run arbitrary repository commands before implementing isolation, identity and operational controls. Static checks do not establish patch safety or functional correctness.
