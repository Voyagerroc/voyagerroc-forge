# open_scion / Graft compatibility spike — 2026-11-10

This is the bounded experiment requested in [issue #7](https://github.com/Voyagerroc/voyagerroc-forge/issues/7). It concerns the independent [feder-cr/open_scion](https://github.com/feder-cr/open_scion) project, which now redirects to **feder-cr/git-ai**. Graft is its CLI, SDK and extension namespace. Neither Anthropic's internal Scion nor Google Scion orchestration was used.

## Version, license and prerequisites

| Item | Pin / observed environment |
| --- | --- |
| git-ai | `v0.4.2`, commit `a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6` |
| Source license | MIT for content outside `ee/`; `ee/` is absent at this pin. Copyright Federico Elia / gitai contributors and GitLab Inc. |
| License verification | Read the pinned `LICENSE`, rather than assuming the GitHub API's `NOASSERTION` classification was a license. SHA-256: `328c3514f0a38325f8705804d48502ab8ee6836fb6c88471ae65678e3d956cb5`. The large `NOTICE` contains separate third-party terms; bundled Git has its own GPLv2 license. This PR vendors no upstream code or binaries. |
| Host | Ubuntu 24.04.5, Linux x86_64; host Git 2.43.0; GCC 13.3.0; GNU Make 4.3; Python 3.12 |
| Build tools used | Go 1.26.8, Meson 1.7.0, Ninja 1.13.0; curl, OpenSSL, zlib, PCRE2 and their C development headers |
| Forge validation tools | Node.js 24.22.1, npm 10.9.4 |

The pinned README requires Linux/macOS, Go 1.26, a C toolchain, Meson and Ninja. `go.mod` requires Go 1.26.0; `.tool-versions` pins Go 1.26.8, Meson 1.7.0 and Ninja 1.12.1. The Makefile sets `GOTOOLCHAIN=local`, so an older Go installation will not be upgraded automatically. `make build` compiles and embeds Git plus the hook/SSH helpers; a plain `go build ./cmd/gitaly` is not the documented complete server build.

The documented standalone configuration needs writable repository/runtime directories and local credentials, but no GitLab account, PostgreSQL, Redis, cloud bucket or model account. This experiment uses a Unix socket and the example's local repository storage. It does not enable the database/object-storage core's `shadow` or `authoritative` modes. Graft's storage-mode word “authoritative” is unrelated to the Forge decision to keep GitHub authoritative.

Pinned primary sources: [README](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/README.md), [LICENSE](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/LICENSE), [NOTICE](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/NOTICE), [Makefile](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/Makefile), [quickstart](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/doc/graft/QUICKSTART.md), [limitations](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/doc/graft/LIMITATIONS.md).

## Reproduce the build

Run in a disposable development environment, from the Forge checkout. No repository source is executed by Forge's runner. The commands below build the inspected external tool and run only the small fixture in this report.

```bash
export TMPDIR=$HOME/workspace/.tmp
mkdir -p "$TMPDIR"
forge_root=$PWD
spike_root=$(mktemp -d "$TMPDIR/forge-open-scion.XXXXXX")
git clone --depth 1 --branch v0.4.2 \
  https://github.com/feder-cr/open_scion.git "$spike_root/source"
test "$(git -C "$spike_root/source" rev-parse HEAD)" = \
  a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6

# Ubuntu packages; the host already had all except libcurl4-openssl-dev.
sudo apt-get update
sudo apt-get install -y build-essential pkg-config python3-venv \
  curl git libcurl4-openssl-dev libssl-dev libpcre2-dev zlib1g-dev
mkdir -p "$spike_root/tools"
curl -fL https://go.dev/dl/go1.26.8.linux-amd64.tar.gz \
  -o "$spike_root/tools/go1.26.8.linux-amd64.tar.gz"
printf '%s  %s\n' \
  d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b \
  "$spike_root/tools/go1.26.8.linux-amd64.tar.gz" | sha256sum -c -
tar -xzf "$spike_root/tools/go1.26.8.linux-amd64.tar.gz" -C "$spike_root/tools"
python3 -m venv "$spike_root/tools/build-env"
"$spike_root/tools/build-env/bin/pip" install meson==1.7.0 ninja==1.13.0
export PATH="$spike_root/tools/go/bin:$spike_root/tools/build-env/bin:$PATH"
export GOMAXPROCS=2 GOFLAGS=-p=2
cd "$spike_root/source"

# Exact configured build used here; see the important deviation below.
make build GIT_REPO_URL=https://github.com/git/git.git \
  GIT_VERSION_MVCC=a018953688f1b10bddf91bff8747068f5f4746a4
./_build/bin/gitaly --version
./_build/bin/gitaly-git-prev --version
```

**Build deviation:** retained logs show ordinary `make build` attempts terminated during Git fetches from `gitlab.com/gitlab-org/git.git` (`git-remote-https died of signal 15`, Makefile fetch target error 128). During verification, `timeout 45 git -c credential.helper= -c http.version=HTTP/1.1 ls-remote https://gitlab.com/gitlab-org/git.git HEAD` again exited **124**, with no output. An earlier protocol-v0 trace reaches the `git-upload-pack` POST after a successful advertisement GET; that fetch was not repeated. This is evidence of a limitation in this environment, not evidence that upstream's default build is broken.

The configured build uses the Makefile's existing overrides, without editing git-ai source. Its default runtime Git (`GIT_VERSION_PREV`) remains the pinned Git 2.56.0 commit `a018953688f1b10bddf91bff8747068f5f4746a4`; the master slot remains `3bbf43483e3954291b9fb4caa228eedb9dd528c2`. The GitLab-only MVCC commit `08ed691c4d15bf3e93924c355ce2158b38a8074d` is replaced in that slot by the same ordinary 2.56.0 commit. **Do not use this build for MVCC repositories. The stock three-version bundle was not built or validated.**

Retained setup logs record `No matching distribution found for ninja==1.12.1`; the successful PyPI install used 1.13.0. They also record apt mirror failures followed by a successful `libcurl4-openssl-dev` install from Ubuntu's Azure mirror via a temporary sources list. These installs were not repeated during verification; the installed tools were reused and their versions checked. The retained Go archive's checksum was recomputed and matched the value above. Package downloads require network access.

## Run the documented interfaces

The [fixture script](../scripts/spikes/open-scion.sh) adapts the pinned quickstart's configuration and CLI commands. The [Go probe](../scripts/spikes/open-scion-probe.go) uses the public SDK and generated public gRPC clients from that exact checkout; it adds no dependency to Forge. Run after building:

```bash
export TMPDIR=$HOME/workspace/.tmp
cd "$forge_root"
set -o pipefail
bash scripts/spikes/open-scion.sh "$spike_root/source" 2>&1 | tee "$spike_root/fixture.log"
```

The script creates a new disposable `fixture.git` using `graft repo create --initial-commit`, clones it with `graft clone`, then commits/lands `alpha\n` and `beta\n` in `README.md` on its **local** `main`. It reads the old full commit ID after the branch moves. Host `git rev-parse` supplies independent expected IDs; SDK resolution must agree. A separate `git diff --full-index BASE HEAD` must match the RPC patch byte for byte.

Fixture commit IDs vary with commit timestamps on a rerun; the source-tool pin, file contents and patch comparison do not depend on those timestamps.

The first RPC diff call uses the default agent allowlist and must be refused. The script then restarts the same server with the documented `agent_rpcs = ["/gitaly.DiffService/RawDiff"]` extension and repeats using the same agent token. The shared example token is used only for local repository creation; the reads use a freshly generated planner token. Neither token is GitHub credentials. The server is stopped on exit; the printed temporary directory retains the fixture and logs for inspection and can be deleted afterward. Do not commit its configuration, token files or database/runtime files.

## Observed results

The initial build log contains actual Meson/Ninja compilation, and its fixture log agrees with the retained repository's commits and both patch files. Verification reran the configured `make build` above (exit **0**) using the retained checkout, toolchain and build caches; this was **not a fresh, empty-cache setup**. The checkout had no tracked changes, the remote annotated `v0.4.2` tag peeled to the pinned commit, and `go version -m _build/bin/gitaly` reported `vcs.revision=a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6` and `vcs.modified=false`. Binary output:

```text
Gitaly, version 0.4.2
GO version:   go1.26.8
OS/Arch:      linux/amd64
git version 2.56.0.ga018953
```

The unchanged fixture script was rerun successfully, then rerun again after adding explicit tree-metadata assertions and binary preflight checks. Both runs exited **0**. The following is verbatim output from the final run, omitting only the CLI setup lines and local temporary paths:

```text
RawDiff with default agent allowlist: rpc error: code = PermissionDenied desc = agent "planner" may not call /gitaly.DiffService/RawDiff: the method is not allowed for agents
RawDiff: bytes=188 sha256=406be88e905da840ec022002670992a563e8242d02d142c3636e64e929d987f2
diff --git a/README.md b/README.md
index 4a58007052a65fbc2fc3f910f2855f45a4058e74..65b2df87f7df3aeedef04be96703e55ac19c2cfb 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-alpha
+beta
RepositoryExists(default, fixture.git): true
RepositoryExists(default, absent.git): false
ResolveRevision(refs/heads/main): ce391add80669cee586734e0c33f6ceb41ae4ceb
ResolveRevision(base): f80a93bb50fad38162a06afccc9442495aff80d8
ReadFile(f80a93bb50fad38162a06afccc9442495aff80d8, README.md): "alpha\n"
ReadFile(ce391add80669cee586734e0c33f6ceb41ae4ceb, README.md): "beta\n"
GetTree: path="README.md" oid=65b2df87f7df3aeedef04be96703e55ac19c2cfb type=BLOB mode=100644 size=5
GetTree: path="docs" oid=07735aababbf49a3c53f57b52817377f10422782 type=TREE mode=40000 size=0
GetTree: path="docs/info.txt" oid=ee8c1ee49b4799bbd170233915a897c19e3b55e1 type=BLOB mode=100644 size=8
missing revision: rpc error: code = NotFound desc = revision "refs/heads/absent" not found
missing path: rpc error: code = NotFound desc = tree entry not found
directory read: rpc error: code = FailedPrecondition desc = "docs" at "ce391add80669cee586734e0c33f6ceb41ae4ceb" is not a file
GetObjects(absent): [{OID:1111111111111111111111111111111111111111 Type:UNKNOWN Size:0 Data:[] Missing:true}]
RawDiff(base, base): bytes=0
RawDiff with missing commit: rpc error: code = Internal desc = cmd: exit status 128
probe assertions passed
RPC patch matches independent git diff
```

The final `cmp` compared the live RPC response with host Git's `diff --full-index`; both were exactly 188 bytes with the SHA-256 above. Host `git ls-tree -r -l refs/heads/main` independently confirmed both file blob IDs, modes and sizes. These are live local CLI/SDK/RPC observations, not mock responses. They prove this fixture's mappings; they do not prove GitHub repository ownership, cross-server identity or synchronization.

Verification commands and results (all test invocations followed `export TMPDIR=$HOME/workspace/.tmp`):

| Command | Actual result |
| --- | --- |
| Configured `make build` from the setup block | Exit 0; cached build, with the MVCC-slot substitution described above. |
| `bash scripts/spikes/open-scion.sh "$spike_root/source"` | Exit 0 in both verification runs; CLI/RPC assertions and independent patch comparison passed. |
| `npm run check` | Exit 0; 40/40 Forge tests, JavaScript syntax checks and 37 local documentation targets passed. |
| `bash -n scripts/spikes/open-scion.sh` | Exit 0. |
| `gofmt -l scripts/spikes/open-scion-probe.go` | No output; formatting clean. |
| `git diff --check` | Exit 0. |

## Mapping and smallest proposed interface

The evidence supports a configured, read-only **source** adapter. The following is a proposal, not an implementation or an external Scion protocol. Keep the existing `open-scion` capability planned.

```typescript
type MappedRepository = {
  githubRepositoryId: number; // supplied and revalidated by the GitHub adapter
  endpointKey: string;        // operator configuration, never a browser-supplied URL
  storageName: string;
  relativePath: string;
};
type CommitOID = string; // full SHA-1 commit ID in this validated slice
type GraftReadAdapter = {
  exists(repo: MappedRepository): Promise<boolean>;
  resolveRevision(repo: MappedRepository, ref: string): Promise<CommitOID>;
  readFile(repo: MappedRepository, revision: CommitOID, path: string):
    Promise<{ blobOID: string; mode: 0o100644; bytes: Uint8Array }>;
  diff(repo: MappedRepository, base: CommitOID, candidate: CommitOID):
    Promise<{ bytes: Uint8Array; sha256: string }>;
};
```

| Forge concept | Documented interface and required interpretation |
| --- | --- |
| Repository identity | `RepositoryExists` checks `(endpoint, storage_name, relative_path)`. SDK `Client.Repo(path)` merely constructs a handle. It supplies no GitHub owner, repository ID, installation ownership or rename tracking. The fixture has no GitHub counterpart. |
| Immutable revision | `sdk.Repo.ResolveRevision` calls `CommitService.FindCommit`; retain the full returned commit ID and its repository mapping. Resolve mutable refs freshly, then use only full IDs for reads/diffs. A changeset sequence, workspace base field or branch name is not a substitute. |
| File artifact | `ListTree` / `ObjectService.GetTree` provides the blob ID, type, mode and size; `ReadFile` / `CommitService.TreeEntry` supplies bytes at the pinned commit. Preserve bytes and provenance; apply Forge's path/type/size restrictions before materializing anything. |
| Patch artifact | `DiffService.RawDiff` streams the `git diff --full-index` patch for two commits; concatenate chunks in order and hash the exact bytes. Return success only after stream completion. `graft diff` takes no revision arguments and compares the mutable workspace to its base, so it cannot implement this method. |
| Errors | Preserve RPC status, details and operation context. `FindCommit` can return an empty successful response, which the SDK translates to `NotFound`; missing objects use `missing=true`. Do not treat an error, partial stream or missing object as an empty file/diff or passing check. |

Pinned interface sources: [SDK](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/sdk/repo.go), [repository proto](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/proto/repository.proto), [commit proto](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/proto/commit.proto), [object proto](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/proto/object.proto), [diff proto](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/proto/diff.proto), [agent security](https://github.com/feder-cr/git-ai/blob/a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6/doc/graft/AGENT-SECURITY.md).

Before enabling an implementation, require a server-side configured mapping, GitHub ownership checks and equality between the GitHub-authoritative base SHA and the mapped Graft base. Reject stale/divergent sources rather than treating Graft's `main` as the GitHub head. This fixture establishes none of that synchronization. Metadata stays with `GitHubAdapter`; there is no `publishDraft`, `land`, `commit`, import or migration method in the proposal. The local writes only construct test data.

## Unsupported and unvalidated semantics

- Default agent credentials cannot call `RawDiff`. Diff capability must remain off unless the operator explicitly enables and verifies that RPC. The `agent_rpcs` extension applies to all configured agents, not just the fixture's planner. Graft's agent allowlist and branch policy are not a demonstrated read-only credential or per-GitHub-repository authorization system.
- Only tiny ordinary SHA-1 repositories and regular UTF-8 fixture files were exercised. Binary patches, executable modes, symlinks, submodules, non-UTF-8 paths, renames, case collisions, SHA-256 repositories, large/chunked/resumed reads and truncation limits are unvalidated. The proposed first slice rejects those cases; SDK `ReadFile` alone is insufficient to enforce Forge's file-mode and size rules.
- Go is the only supported SDK at this pin. A Node adapter still needs a bounded helper or generated gRPC bindings, with deadlines, cancellation, byte limits and explicit stream-error handling. This probe's 30-second context and small fixture are not a production resource/isolation design.
- No cache tier, multi-node system, database/object-storage core, MVCC, hosted deployment, GitHub mirroring, GitHub writes or bidirectional publication was exercised. No migration, performance, durability or full-protocol compatibility claim follows.
- Upstream's own full test suite was not run. The experiment validates the specific live calls recorded here; it does not validate arbitrary project execution or model-generated patches.
