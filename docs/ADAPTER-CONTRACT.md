# Adapter contract proposal v0.1

This is an internal design contract, not a claimed external Scion protocol or a fully implemented plugin SDK. `src/adapters.mjs` exposes the capability catalog and planner; `GitHubAdapter` implements repository metadata and revision resolution. v0.2 `Runner` implements a narrower explicit-edit/static-check lifecycle (`start`, `cancel`, persisted evidence). The generic AI runner interface below remains a future integration target.

Keep source-control and execution adapters separate. Google Scion is orchestration (`GoogleCloudPlatform/scion`, Apache-2.0); open-scion/git-ai is source control (`feder-cr/git-ai`, MIT). Both are separate open-source projects independent of Anthropic's proprietary in-house infrastructure.

```typescript
type SourceAdapter = {
  capabilities: { metadata: boolean; sparseRead: boolean; diff: boolean; publishDraft: boolean };
  repository(identity: string): Promise<Repository>;
  resolveRevision?(repo: Repository, ref: string): Promise<ImmutableRevision>;
  readPaths?(repo: Repository, revision: ImmutableRevision, paths: string[]): Promise<Artifact[]>;
  diff?(base: ImmutableRevision, candidate: ImmutableRevision): Promise<PatchArtifact>;
  publishDraft?(input: ApprovedPatch & { idempotencyKey: string }): Promise<ExternalChange>;
};
type RunnerAdapter = {
  start(input: TaskIntent & { baseRevision: ImmutableRevision; resourceBudget: Budget }): Promise<Run>;
  status(runId: string): Promise<RunStatus>;
  logs(runId: string, cursor?: string): Promise<RedactedLogPage>;
  cancel(runId: string): Promise<void>;
  artifacts(runId: string): Promise<{ patch: PatchArtifact; checks: CheckEvidence[] }>;
};
```

Future invariants: normalize identities once; immutable revision/patch provenance; separate execution, test and publication states; never synthesize passing check evidence; explicit provider error and timeout handling; idempotent external writes; tenant ownership on every request; capabilities gate UI actions; source files remain untrusted input. A private Anthropic Scion adapter stays unavailable unless a legitimate public/authorized interface exists.

## Pinned source experiment

The [open_scion / Graft compatibility spike](OPEN-SCION-2026-11-10.md) records a pinned git-ai version, build prerequisites and deviations, a disposable CLI/RPC fixture, errors and a smaller read-only interface proposal. Repository identity must include the configured endpoint, storage and relative path; GitHub supplies the authoritative identity and base SHA. This experiment does not enable an adapter or implement publication, synchronization or migration.
