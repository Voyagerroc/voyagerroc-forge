# Evidence bundle and independent verification

Writing a change has become cheap. Trusting it has not. A Forge run already records the pinned commit, the patch and the named static checks, but that record lives only in one server's database. The evidence bundle makes it portable, and `evidence:verify` lets someone who does not trust the producer re-check everything that can be re-checked.

The bundle is shaped as an unsigned in-toto Statement v1 with a Forge-specific predicate. It is **not signed**: it proves consistency, not origin.

## What the bundle is for

Hand it, together with read access to the repository, to a reviewer or a script. They can confirm without asking you or your Forge server:

- the patch text hashes to the recorded SHA-256;
- the patch applies cleanly to the recorded base commit;
- the named static checks, re-run on the patched copy, give the recorded results.

Everything else in the bundle is **recorded, not verifiable**: the time at which the plan was approved (the bundle records when, not by whom), the intent text, every timestamp, the summary and the version of the tool. The verifier lists these separately and never presents them as verified.

## Fields

One JSON document. Keys are sorted at every depth, indentation is two spaces, the encoding is UTF-8 and the file ends with one newline. Array order is kept. Exporting the same run twice therefore gives byte-identical files, as long as the database does not change in between: the event list is read when the bundle is exported, so a later event for the same task changes the next export. Keys are compared by UTF-16 code units, which is the order of JavaScript's default sort.

This form is also the only form the verifier reads. It parses the file, serialises the result with the rule above and compares the two texts, after turning CRLF line endings into LF. A repeated key, keys in another order, other indentation or an escape where Forge writes the character itself makes the texts differ. The verifier then exits with `2` and says that the bundle is not in canonical form; a canonical copy comes from `npm run evidence:export` or `GET /api/runs/<run id>/evidence`, and it must not be reformatted.

| Field | Meaning |
| --- | --- |
| `_type` | Always `https://in-toto.io/Statement/v1`. |
| `subject` | One entry. `name` is `<repository full name>@<base commit>.patch`, or `<repository full name>@<run id>.patch` when the run has no base commit; `digest.sha256` is the patch hash. For a run without a patch the `digest` is omitted. |
| `predicateType` | Always `https://github.com/Voyagerroc/voyagerroc-forge/blob/main/docs/EVIDENCE.md#v1`. Another version is refused. |
| `predicate.repository` | `fullName` and `sourceKind` (`github` or `local`) as the store records them. |
| `predicate.base` | `commit`: the 40 hex digit commit the run pinned. The whole field is omitted when the run ended before pinning one; it is never written as `null`. |
| `predicate.patch` | `sha256`, `bytes` and `text`, the unified diff exactly as stored. `text` is what is hashed. `null` when the run produced no patch. |
| `predicate.patchAbsentReason` | A sentence that says why there is no patch. Present only when `predicate.patch` is `null`. This field is an addition of Forge's own; the specification only says that the document gives the reason. A bundle that carries a patch and this field is inconsistent. |
| `predicate.checks` | `name`, `status` (`passed`, `failed` or `skipped`) and `detail`, in recorded order. |
| `predicate.notRun` | What Forge did not run: project tests, dependency installation, execution of repository code. |
| `predicate.run` | `id`, `status`, `startedAt` (when the run record was created) and, when there are such values, `finishedAt` and `summary`. |
| `predicate.record` | `intent` (`title`, `text`), `planApprovedAt` (when the plan was approved, not by whom) when the store has an approval event, and `events` (`kind`, `at`; both strings) for the task and this run. Absent values are omitted, never invented. |
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
      "commit": "b11b99786d4b9eee4a45ded00fb570bad42fa068"
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
      "The bundle records when the plan was approved, not by whom; that time, the intent text and every other timestamp are recorded by the Forge server that exported the bundle, and nobody can recompute them, so they are recorded, not verified."
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
          "at": "2026-11-19T15:23:59.542Z",
          "kind": "task.created"
        },
        {
          "at": "2026-11-19T15:23:59.543Z",
          "kind": "task.planned"
        },
        {
          "at": "2026-11-19T15:23:59.545Z",
          "kind": "task.in_review"
        },
        {
          "at": "2026-11-19T15:23:59.547Z",
          "kind": "task.approved"
        },
        {
          "at": "2026-11-19T15:23:59.549Z",
          "kind": "run.preparing"
        },
        {
          "at": "2026-11-19T15:24:00.185Z",
          "kind": "run.passed"
        }
      ],
      "intent": {
        "text": "Correct \"helo\" to \"hello\" in hello.mjs.",
        "title": "Fix the greeting spelling"
      },
      "planApprovedAt": "2026-11-19T15:23:59.547Z"
    },
    "repository": {
      "fullName": "local/runner-demo",
      "sourceKind": "local"
    },
    "run": {
      "finishedAt": "2026-11-19T15:24:00.185Z",
      "id": "68782d67-4766-4687-804c-29bd628b7222",
      "startedAt": "2026-11-19T15:23:59.549Z",
      "status": "passed",
      "summary": "Scoped edits and static checks passed. Project tests were not run."
    },
    "tool": {
      "name": "voyagerroc-forge",
      "version": "0.3.0"
    }
  },
  "predicateType": "https://github.com/Voyagerroc/voyagerroc-forge/blob/main/docs/EVIDENCE.md#v1",
  "subject": [
    {
      "digest": {
        "sha256": "8fef16c87de2f20a07bc311f9d8d4056790e485ae1942967573b879e32d90234"
      },
      "name": "local/runner-demo@b11b99786d4b9eee4a45ded00fb570bad42fa068.patch"
    }
  ]
}
```

```text
CLAIM                         RESULT                   DETAIL
bundle format                 MATCH                    unsigned in-toto Statement v1 with a Forge predicate v1; not signed, so origin is not proven
subject name                  MATCH                    local/runner-demo@b11b99786d4b9eee4a45ded00fb570bad42fa068.patch
patch SHA-256                 MATCH                    8fef16c87de2f20a07bc311f9d8d4056790e485ae1942967573b879e32d90234
patch size                    MATCH                    176 bytes
subject digest                MATCH                    subject digest equals the recorded patch hash
run status matches checks     MATCH                    a passed run records a patch, checks and no failed check
internal consistency          MATCH                    status, patch, base commit, approval time and check names do not contradict each other
base commit                   MATCH                    b11b99786d4b9eee4a45ded00fb570bad42fa068 exists in this repository
patch applies to base commit  MATCH                    applies cleanly to b11b99786d4b9eee4a45ded00fb570bad42fa068; 1 file changed
check edit:hello.mjs          MATCH                    recorded and re-run: passed
check conflicts:hello.mjs     MATCH                    recorded and re-run: passed
check syntax:hello.mjs        MATCH                    recorded and re-run: passed
check diff-whitespace         MATCH                    recorded and re-run: passed
repository name               RECORDED NOT VERIFIABLE  local/runner-demo (local); a Git repository does not know its name
intent                        RECORDED NOT VERIFIABLE  task title and text are what the Forge server stored
plan approval time            RECORDED NOT VERIFIABLE  2026-11-19T15:23:59.547Z; the bundle records the time only, and no one can recompute it
run timestamps and events     RECORDED NOT VERIFIABLE  6 events and the run start and finish times are the server's own clock
run summary                   RECORDED NOT VERIFIABLE  free text written by the server
tool version                  RECORDED NOT VERIFIABLE  voyagerroc-forge 0.3.0

13 matched, 0 mismatched, 6 recorded not verifiable. The bundle is not signed: matches show that it is consistent, not who produced it.
```

## Commands

Export a run. It opens the database read-only and without the server lock, so it works while a server is running:

```sh
npm run evidence:export -- --run <run id> [--db <database file>] [--out <file>]
```

The database file is never written and no table is created or changed. Opening it read-only can still make SQLite create its `-shm` and `-wal` side files next to the database when no server has it open, and they may stay there. Delete them if they are in the way; the database file itself is unchanged.

Without `--out` the bundle goes to standard output. An existing `--out` file is not overwritten. `--db` defaults to `FORGE_DB`, then `data/forge.sqlite`. The same bundle is served at `GET /api/runs/<run id>/evidence` with a download file name. It answers 404 for an unknown run and 409 for a run still in flight, and applies the same Host protection as the other routes.

Verify a bundle against a local Git repository:

```sh
npm run evidence:verify -- <file> --repo <path to a local Git repository> [--json]
```

Exit code `0` only when every verifiable claim matches, `1` on any mismatch, `2` on unusable input: a file that is unreadable, larger than 8 MiB, not JSON, not in canonical form, of an unknown `_type` or predicate version, structurally incomplete, with an item in `record.events` that is not an object with a string `kind` and a string `at`, a patch that is refused (below), or a path that is not a Git repository. Input problems print one plain message and no stack trace. The output is a table of claim, result (`MATCH`, `MISMATCH`, `RECORDED NOT VERIFIABLE`) and detail, then one summary line. `--json` prints the same as JSON, with the same character escaping as the table (see the threat model).

## What verification does

It reuses the runner's machinery instead of a second copy: a disposable copy of the pinned commit made with the same snapshot code and limits, no execution of repository code, and the same static checks (exact replacement, conflict markers, JSON validity, JavaScript syntax with `node --check`, whitespace). It reads the repository given with `--repo` only through `git ls-tree`, `git cat-file`, `git rev-list` and `git rev-parse`, and never writes to it. The temporary copy is removed afterwards.

Git is run with `GIT_NO_LAZY_FETCH=1` and `GIT_ALLOW_PROTOCOL=file`, so it cannot download a missing object into the repository, which a partial (promisor) clone would otherwise allow. When the commit or any of its files is missing from the repository, verification stops with exit code `2` and the message that the repository does not contain the base commit with all of its files; use a full clone. A commit that is absent altogether is reported as a `MISMATCH` row for `base commit`.

### Internal consistency

Before anything is re-run, the verifier checks that the bundle does not contradict itself. Any violation is a `MISMATCH` (exit code `1`), and the verifier stops there, because a bundle that disagrees with itself has no single claim to re-run. The rules:

- The recorded patch hash equals the hash of the patch text, `patch.bytes` equals the length of the text in bytes, and the subject digest equals the patch hash. A subject digest without a patch is a contradiction.
- The subject name is `<repository full name>@<base commit>.patch`, or with the run id in place of the commit when there is no base commit.
- A bundle that carries a patch has a base commit, because without one the patch cannot be re-applied. A bundle with a patch has no `patchAbsentReason`.
- A run recorded as `passed` has a patch, at least one check and no check recorded as `failed`.
- A run recorded as `failed` that carries a patch records at least one check as `failed`. A failed run without a patch is consistent.
- `record.planApprovedAt` equals the time of the last `task.approved` event in `record.events`; both are absent together.
- No check name appears twice.
- Every check name is one that Forge writes (`edit:`, `conflicts:`, `json:` and `syntax:` followed by a path, `diff-whitespace`, and `cleanup`, which Forge records only as failed). Any other name, for example `tests:all`, is an `unknown check`: it is a `MISMATCH` and never a match, even though the verifier cannot say that it is false. A check whose name is the same as an item of `notRun` (for example `project tests`) is a `MISMATCH` too, because the bundle says that Forge did not run it.

A run that was `cancelled`, `timed_out` or `interrupted` is not cross-checked against its patch and checks.

### Patch checks

Before Git sees the patch, the verifier refuses it when it has no `diff --git` header, renames, copies, deletes or changes modes, adds a symbolic link or a binary file, or touches more than 20 files. The file names are never split out of the header text, because Git quotes some of them there (a non-ASCII name such as `çalışma.md` is written as `"a/\303\247al..."`). Git itself lists the files the patch changes (`git apply --numstat -z`, which prints raw names), outside any repository. The verifier refuses the patch when one of those paths is rejected by the edit path rules (for example `.git`, `..`, an absolute path or a backslash), when two paths differ only in case, or when the number of files Git lists differs from the number of headers. A refused bundle exits with `2` and nothing is applied.

Checks are re-run by name. A recomputed check missing from the bundle, a recorded check that names a file the patch does not change, a different status, and a different content hash for an `edit:` check are all mismatches. A recorded `cleanup` check (the server could not remove its temporary workspace) cannot be re-run elsewhere and is listed as recorded, not verifiable. Only the detail text of `edit:` checks is compared; for `syntax:` and `diff-whitespace` the status is compared and the detail text is not. The first row, `bundle format`, only states what was read and counts as a match, so the matched count includes it. The verifier checks that `notRun` lists `project tests` and that `limits` is a list of strings, but it does not compare their text.

## What it proves and what it does not

A full match shows that the patch text, the base commit, the recorded static check results and the repository agree. It does not show who produced the bundle, that the approval happened, that the times are right, that the intent text is the one the approver read, that the project tests pass, or that the change is correct. A base commit that the given repository does not contain is reported as a mismatch, because the patch cannot be re-applied. The cause may be a wrong repository.

## Threat model

Who could lie, and which lies verification catches:

- **Someone edits the patch text in the file.** The hash no longer matches: caught.
- **They also fix the hash fields.** The new patch must still apply to the base commit and give the recorded content hash and check results. A patch that does not apply, or that produces other file content, is caught. A different patch that applies cleanly and whose checks are recorded honestly for that new patch is a different valid bundle. Without a signature nobody can tell it from the original.
- **Someone flips a failed check to passed, or deletes it.** The check is re-run on the patched copy. A different status is caught, and so is a check missing from the file.
- **Someone claims another base commit.** The patch usually fails to apply there, or the commit is missing from the repository: caught.
- **Someone claims an approval time, other times or an intent that never existed.** Not caught, except that the bundle must not contradict itself (for example an approval time that no event carries). These are reported as recorded, not verifiable. The bundle records no approver, only the time.
- **Someone adds a check the verifier cannot re-run, such as a test result.** The check name is unknown to the verifier, so it is a `MISMATCH`, not a match. Forge did not run project tests, and `notRun` says so.
- **Someone contradicts the bundle with itself**, for example a run recorded as failed with a patch and no failed check, or a bytes field that is not the text length. Caught before anything is re-run (see Internal consistency).
- **A hostile patch tries to write outside the workspace or into `.git`.** Refused before anything is applied.
- **Someone puts terminal escape sequences or line breaks into a text field, for example the repository name, the tool version or a check name, to hide a MISMATCH row or to forge a MATCH row in the table.** The table shows every control character (C0, DEL, C1), line and paragraph separator and bidirectional formatting character as a backslash-u escape with four hex digits, so one claim is always one line and nothing the bundle says can change how the terminal draws it. `--json` output gets the same treatment: `JSON.stringify` escapes only the C0 controls, quotes, backslashes and lone surrogates, and writes DEL, the C1 controls, U+2028, U+2029 and the bidirectional formatting characters as they are, so the verifier replaces those by their JSON `u` escapes, which still decode to the same text. Printable text from the bundle is still shown as it is, and the table lets a bundle author put misleading words on a line; read the `RESULT` column, not the detail text.
- **Someone repeats a JSON key, reorders keys or changes the whitespace.** A reader that takes the first value of a repeated key would see another document than `JSON.parse`, which takes the last. The verifier therefore refuses every file that does not serialise back to exactly itself (exit code `2`).
- **The repository is a partial clone.** The verifier does not let Git fetch the missing objects into it. It stops with exit code `2` and asks for a full clone.
- **The Forge server or the repository is itself compromised.** Out of scope. The verifier trusts the Git object store it is given.

Signing, attestations, CI integration and importing a patch that Forge did not produce are future work.
