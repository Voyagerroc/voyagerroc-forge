# Security policy

## Supported version

Pre-1.0 experimental software. Fixes target the latest `main` and current prototype release; no long-term support or production suitability is promised.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/Voyagerroc/voyagerroc-forge/security/advisories/new). If unavailable, contact **voyagerroc@voyagerroctechnologies.com** with a minimal reproduction and impact description. Do not post credentials, private source or exploitable details in a public issue.

## Current boundaries

- Loopback service, one local operator; no multi-user auth/tenant isolation.
- The fixed worker never evaluates repository source. Node permissions guard trusted code against mistakes; they do not sandbox malicious code.
- Snapshots reject symlinks, submodules, reserved paths and oversized trees. Fetch is time-bounded, not protected by OS disk quotas.
- Process environment, output and runtime are restricted. Cancellation kills descendants; abrupt termination can leave temporary files.
- Local source mappings are operator config, not browser-supplied paths.
- Webhooks require HMAC verification and delivery IDs are deduplicated.
- GitHub credentials stay server-side. Auth is read-only; upstream writes are unimplemented.

Do not expose this prototype publicly or run arbitrary repository commands before implementing isolation, identity and operational controls. Static checks do not establish patch safety or functional correctness.
