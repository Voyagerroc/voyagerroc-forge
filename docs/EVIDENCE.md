# Evidence bundle and independent verification

Writing a change has become cheap. Trusting it has not. A Forge run already records the pinned commit, the patch and the named static checks, but that record lives only in one server's database. The evidence bundle makes it portable, and `evidence:verify` lets someone who does not trust the producer re-check everything that can be re-checked.

The bundle is shaped as an unsigned in-toto Statement v1 with a Forge-specific predicate. It is **not signed**: it proves consistency, not origin.

## What the bundle is for

Hand it, together with read access to the repository, to a reviewer or a script. They can confirm without asking you or your Forge server:

- the patch text hashes to the recorded SHA-256;
- the patch applies cleanly to the recorded base commit;
- the named static checks, re-run on the patched copy, give the recorded results.

Everything else in the bundle is **recorded, not verifiable**: who approved the plan, the intent text, every timestamp, the summary and the version of the tool. The verifier lists these separately and never presents them as verified.

## Fields

One JSON document. Keys are sorted at every depth, indentation is two spaces, the encoding is UTF-8 and the file ends with one newline. Array order is kept. Exporting the same run twice therefore gives byte-identical files, as long as the database does not change in between: the event list is read when the bundle is exported, so a later event for the same task changes the next export. Keys are compared by UTF-16 code units, which is the order of JavaScript's default sort.

| Field | Meaning |
| --- | --- |
| `_type` | Always `https://in-toto.io/Statement/v1`. |
| `subject` | One entry. `name` is `<repository full name>@<base commit>.patch`; `digest.sha256` is the patch hash. For a run without a patch the `digest` is omitted. |
| `predicateType` | Always `https://github.com/Voyagerroc/voyagerroc-forge/blob/main/docs/EVIDENCE.md#v1`. Another version is refused. |
| `predicate.repository` | `fullName` and `sourceKind` (`github` or `local`) as the store records them. |
| `predicate.base` | `commit`: the 40 hex digit commit the run pinned. `null` when the run ended before pinning one. |
| `predicate.patch` | `sha256`, `bytes` and `text`, the unified diff exactly as stored. `text` is what is hashed. `null` when the run produced no patch; `predicate.patchAbsentReason` then says why. |
| `predicate.checks` | `name`, `status` (`passed`, `failed` or `skipped`) and `detail`, in recorded order. |
| `predicate.notRun` | What Forge did not run: project tests, dependency installation, execution of repository code. |
| `predicate.run` | `id`, `status`, `startedAt` (when the run record was created), `finishedAt` and, when there is one, `summary`. |
| `predicate.record` | `intent` (`title`, `text`), `planApprovedAt` when the store has an approval event, and `events` (`kind`, `at`) for the task and this run. Absent values are omitted, never invented. |
| `predicate.tool` | `name` and `version` of the exporting Forge. |
| `predicate.limits` | Three sentences on what this evidence does not show. |

Only runs that reached a final state (passed, failed, cancelled, timed out, interrupted) can be exported. A run still in flight is refused. A run that ended without a patch exports with `patch: null` and verifies as "nothing to recompute".

## A real example

This bundle was exported from a run against the demo repository (`npm run demo:runner`), then verified against that repository. The base commit differs on every machine, because the demo repository is created with the current time.

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "predicate": {
    "base": {
      "commit": "a1d73ec27b2b22ad77062156bbef1271d4f88cf8"
    },
    "checks": [
      {
        "detail": "sha256:0b26eeb0449337856835ba66be5be5327b016226a2b9d5b994f04fa088c579f9",
        "name": "edit:hello.mjs",
        "status": "passed"
      },
      {
        "detail": "No conflict markers",
        "name": "conflicts:hello.mjs",
        "status": "passed"
      },
      {
        "detail": "Node syntax check passed; source was not executed",
        "name": "syntax:hello.mjs",
        "status": "passed"
      },
      {
        "detail": "No whitespace errors",
        "name": "diff-whitespace",
        "status": "passed"
      }
    ],
    "limits": [
      "This bundle is not signed. It shows that its parts agree with each other and with the repository, not who produced it.",
      "Forge ran static checks only: it did not run the project tests, install dependencies or execute repository code, so a passed run says nothing about whether the change is correct.",
      "Who approved the plan, the intent text and every timestamp are recorded by the Forge server that exported the bundle; nobody can recompute them, so they are recorded, not verified."
    ],
    "notRun": [
      "project tests",
      "dependency installation",
      "execution of repository code"
    ],
    "patch": {
      "bytes": 176,
      "sha256": "8fef16c87de2f20a07bc311f9d8d4056790e485ae1942967573b879e32d90234",
      "text": "diff --git a/hello.mjs b/hello.mjs\nindex d720ce4..72a84de 100644\n--- a/hello.mjs\n+++ b/hello.mjs\n@@ -1 +1 @@\n-export const greeting = \"helo\";\n+export const greeting = \"hello\";\n"
    },
    "record": {
      "events": [
        {
          "at": "2026-11-19T14:17:15.547Z",
          "kind": "task.created"
        },
        {
          "at": "2026-11-19T14:17:15.551Z",
          "kind": "task.planned"
        },
        {
          "at": "2026-11-19T14:17:15.553Z",
          "kind": "task.in_review"
        },
        {
          "at": "2026-11-19T14:17:15.555Z",
          "kind": "task.approved"
        },
        {
          "at": "2026-11-19T14:17:15.557Z",
          "kind": "run.preparing"
        },
        {
          "at": "2026-11-19T14:17:16.253Z",
          "kind": "run.passed"
        }
      ],
      "intent": {
        "text": "Correct \"helo\" to \"hello\" in hello.mjs.",
        "title": "Fix the greeting spelling"
      },
      "planApprovedAt": "2026-11-19T14:17:15.555Z"
    },
    "repository": {
      "fullName": "local/runner-demo",
      "sourceKind": "local"
    },
    "run": {
      "finishedAt": "2026-11-19T14:17:16.253Z",
      "id": "e80d0564-82c0-4abd-9b2d-a7fae356a762",
      "startedAt": "2026-11-19T14:17:15.557Z",
      "status": "passed",
      "summary": "Scoped edits and static checks passed. Project tests were not run."
    },
    "tool": {
      "name": "voyagerroc-forge",
      "version": "0.2.1"
    }
  },
  "predicateType": "https://github.com/Voyagerroc/voyagerroc-forge/blob/main/docs/EVIDENCE.md#v1",
  "subject": [
    {
      "digest": {
        "sha256": "8fef16c87de2f20a07bc311f9d8d4056790e485ae1942967573b879e32d90234"
      },
      "name": "local/runner-demo@a1d73ec27b2b22ad77062156bbef1271d4f88cf8.patch"
    }
  ]
}
```

```text
CLAIM                         RESULT                   DETAIL
bundle format                 MATCH                    unsigned in-toto Statement v1 with a Forge predicate v1; not signed, so origin is not proven
patch SHA-256                 MATCH                    8fef16c87de2f20a07bc311f9d8d4056790e485ae1942967573b879e32d90234
patch size                    MATCH                    176 bytes
subject digest                MATCH                    subject digest equals the recorded patch hash
subject name                  MATCH                    local/runner-demo@a1d73ec27b2b22ad77062156bbef1271d4f88cf8.patch
base commit                   MATCH                    a1d73ec27b2b22ad77062156bbef1271d4f88cf8 exists in this repository
patch applies to base commit  MATCH                    applies cleanly to a1d73ec27b2b22ad77062156bbef1271d4f88cf8; 1 file changed
check edit:hello.mjs          MATCH                    recorded and re-run: passed
check conflicts:hello.mjs     MATCH                    recorded and re-run: passed
check syntax:hello.mjs        MATCH                    recorded and re-run: passed
check diff-whitespace         MATCH                    recorded and re-run: passed
run status matches checks     MATCH                    a passed run records no failed check
repository name               RECORDED NOT VERIFIABLE  local/runner-demo (local); a Git repository does not know its name
intent                        RECORDED NOT VERIFIABLE  task title and text are what the Forge server stored
plan approval time            RECORDED NOT VERIFIABLE  2026-11-19T14:17:15.555Z; who approved is not recorded and no one can recompute it
run timestamps and events     RECORDED NOT VERIFIABLE  6 events and the run start and finish times are the server's own clock
run summary                   RECORDED NOT VERIFIABLE  free text written by the server
tool version                  RECORDED NOT VERIFIABLE  voyagerroc-forge 0.2.1

12 matched, 0 mismatched, 6 recorded not verifiable. The bundle is not signed: matches show that it is consistent, not who produced it.
```

## Commands

Export a run. It opens the database read-only and without the server lock, so it works while a server is running:

```sh
npm run evidence:export -- --run <run id> [--db <database file>] [--out <file>]
```

Without `--out` the bundle goes to standard output. An existing `--out` file is not overwritten. `--db` defaults to `FORGE_DB`, then `data/forge.sqlite`. The same bundle is served at `GET /api/runs/<run id>/evidence` with a download file name. It answers 404 for an unknown run and 409 for a run still in flight, and applies the same Host protection as the other routes.

Verify a bundle against a local Git repository:

```sh
npm run evidence:verify -- <file> --repo <path to a local Git repository> [--json]
```

Exit code `0` only when every verifiable claim matches, `1` on any mismatch, `2` on unusable input: a file that is unreadable, larger than 8 MiB, not JSON, of an unknown `_type` or predicate version, structurally incomplete, a patch that is refused (below), or a path that is not a Git repository. Input problems print one plain message and no stack trace. The output is a table of claim, result (`MATCH`, `MISMATCH`, `RECORDED NOT VERIFIABLE`) and detail, then one summary line. `--json` prints the same as JSON.

## What verification does

It reuses the runner's machinery instead of a second copy: a disposable copy of the pinned commit made with the same snapshot code and limits, no execution of repository code, and the same static checks (exact replacement, conflict markers, JSON validity, JavaScript syntax with `node --check`, whitespace). It reads the repository given with `--repo` only through `git ls-tree`, `git cat-file` and `git rev-parse`, and never writes to it. The temporary copy is removed afterwards. One exception is outside the verifier's control: in a partial (promisor) clone, Git itself may fetch a missing object into that repository when `git cat-file` asks for it. Use a full clone if the repository must stay untouched.

Before Git sees the patch, the verifier refuses it when a diff header does not name one path on both sides, when a path is rejected by the edit path rules (for example `.git`, `..`, an absolute path or a backslash), when it renames, copies, deletes or changes modes, adds a symbolic link or a binary file, touches more than 20 files, or when the headers and the files Git says it changes disagree. A refused bundle exits with `2` and nothing is applied.

Checks are re-run by name. A recomputed check missing from the bundle, a recorded check that names a file the patch does not change, a different status, and a different content hash for an `edit:` check are all mismatches. A run recorded as `passed` that records a failed check is inconsistent and is a mismatch too. Only the detail text of `edit:` checks is compared; for `syntax:` and `diff-whitespace` the status is compared and the detail text is not. The first row, `bundle format`, only states what was read and counts as a match, so the matched count includes it. The verifier checks that `notRun` lists `project tests` and that `limits` is a list of strings, but it does not compare their text. A run status of `cancelled`, `timed_out` or `interrupted` is not cross-checked against the patch and checks.

## What it proves and what it does not

A full match shows that the patch text, the base commit, the recorded static check results and the repository agree. It does not show who produced the bundle, that the approvals happened, that the times are right, that the intent text is the one the approver read, that the project tests pass, or that the change is correct. A base commit that the given repository does not contain is reported as a mismatch, because the patch cannot be re-applied. The cause may be a wrong repository.

## Threat model

Who could lie, and which lies verification catches:

- **Someone edits the patch text in the file.** The hash no longer matches: caught.
- **They also fix the hash fields.** The new patch must still apply to the base commit and give the recorded content hash and check results. A patch that does not apply, or that produces other file content, is caught. A different patch that applies cleanly and whose checks are recorded honestly for that new patch is a different valid bundle. Without a signature nobody can tell it from the original.
- **Someone flips a failed check to passed, or deletes it.** The check is re-run on the patched copy. A different status is caught, and so is a check missing from the file.
- **Someone claims another base commit.** The patch usually fails to apply there, or the commit is missing from the repository: caught.
- **Someone claims approvals, times or an intent that never existed.** Not caught. These are reported as recorded, not verifiable.
- **A hostile patch tries to write outside the workspace or into `.git`.** Refused before anything is applied.
- **Someone puts terminal escape sequences or line breaks into a text field, for example the repository name, the tool version or a check name, to hide a MISMATCH row or to forge a MATCH row in the table.** The table shows every control character (C0, DEL, C1), line and paragraph separator and bidirectional formatting character as a backslash-u escape with four hex digits, so one claim is always one line and nothing the bundle says can change how the terminal draws it. `--json` is escaped by JSON itself. Printable text from the bundle is still shown as it is, and the table lets a bundle author put misleading words on a line; read the `RESULT` column, not the detail text.
- **Someone repeats a JSON key.** The last value wins, as in `JSON.parse`; the verifier does not reject duplicate keys. Every value it reads is still checked against the repository, so a repeated key cannot make a false patch or check match.
- **The Forge server or the repository is itself compromised.** Out of scope. The verifier trusts the Git object store it is given.

Signing, attestations, CI integration and importing a patch that Forge did not produce are future work.
