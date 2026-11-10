# 18 — `source submit` Contribution Flow

Status: **Implemented.** The low-friction path for a developer who knows Git but
not Source.

## Goal

A normal developer must be able to contribute without learning Source concepts
up front:

```text
git clone https://source.example.com/git/{org}/{project}/{repo}.git
# make changes
source submit
```

Existing Git knowledge remains valuable; Source concepts are layered on top,
not required up front. This is the human onboarding ramp — agent-first must not
mean human-hostile.

## Flow

`source submit` runs inside the contributor's working clone. It is a *client*
command: it talks to the remote Source instance over HTTP, unlike the other CLI
commands which operate on the local data root.

```text
1. confirm inside a Git working tree
2. select --remote, source.remote config, source, or origin; parse {org, project, repo}
3. fetch selected Source default branch; determine base = merge-base(HEAD, FETCH_HEAD)
4. determine head = HEAD
5. reject empty changes (base == head)
6. push head to the selected Source URL on a contribution ref (so it is present in the bare repo)
7. POST /api/v1/orgs/{org}/projects/{project}/submit
```

The server then creates the lifecycle:

```text
contribution Work (type=contribution)
  → claim (contributor principal)
  → Session (base commit recorded)
  → Change (exact base/head, repository linked)
  → footprint Evidence (deterministic: change is non-empty)
  → policy evaluation (missing evidence is visible)
```

## What the contributor gets back

A compact JSON object:

```json
{
  "work": { "id": "W1", "type": "contribution", "intent": "add feature doc", ... },
  "session": { "id": "S1", ... },
  "change": { "id": "C1", "baseCommit": "...", "headCommit": "...", ... },
  "evidence": { "id": "E1", "claim": "change is non-empty", ... },
  "evaluation": { "ok": false, "missing": [ { "type": "test", ... }, ... ] },
  "interpretation": [ "Not ready for review", "Missing evidence: 2", ... ]
}
```

The contributor does not need to understand Work/Session/Change/Evidence. They
see a Change id and a clear statement of what is still required.

## Design decisions

- **Base commit is the fork point** (`git merge-base HEAD FETCH_HEAD`, after fetching the selected Source default branch),
  not the contributor's assumption. The Change is tied to the exact source state
  it was based on; a later non-fast-forward is caught by the canonical-state
  update guard.
- **Head commit is pushed to a contribution ref** (`refs/heads/source-submit-…`)
  so it is present in the bare repository for the later canonical-state update.
- **Footprint evidence is deterministic** (changed-file list, non-empty check).
  No LLM, no test suite assumption. It is real evidence but does not satisfy the
  project's full required evidence (tests/eval); the maintainer's verification
  service fills those. Missing evidence is visible, not hidden.
- **Public contribution identity** is a `human` principal created server-side
  from Git `user.name`. Private contributions require `submit_change` and use the
  authenticated principal, rather than trusting a caller-supplied identity.
- **The CLI is a thin client** — `src/submit.js` uses the same HTTP API as any
  other client; no business logic lives only in the CLI.

## Files

- `src/submit.js` — client-side contribution logic (async git + fetch).
- `src/source.js` — `submitContribution` server method (the lifecycle).
- `src/api.js` — `POST /api/v1/orgs/{org}/projects/{project}/submit`.
- `src/cli.js` — `source submit` command.
- `tests/submit.test.js` — end-to-end contribution tests.

## Tests

`tests/submit.test.js` proves:

1. A Git-only developer can clone, modify, and `source submit`, and Source
   creates the correct Work → Session → Change → Evidence lifecycle with the
   exact base state and a distinct head commit.
2. The contribution can be completed end-to-end by a maintainer (fill evidence,
   evaluate, accept, update canonical state), with the full audit chain
   reconstructable.
3. Empty changes are rejected.

## Cross-references

- `10-git-integration.md` — smart-HTTP transport and external contributions.
- `06-change-model.md` — base/head commit semantics.
- `09-agent-protocol.md` — the machine interface this flow uses.
- `16-mvp-results.md` — next-phase status.

## Secondary remotes and imports

GitHub may remain `origin`. Add Source with `source sync --url
http://127.0.0.1:8787/git/O1/P1/R1.git` from an existing clone, then use `source
submit`. Select another remote with `--remote backup` or `git config source.remote
backup`. Explicit selection takes precedence over config, followed by a remote
named `source`, then `origin`. Invalid selections fail rather than silently
falling back. The Source default branch is refreshed before calculating the base;
GitHub tracking refs are never used for a secondary-remote submission.

`source sync` atomically pushes local branches and tags without force or deletion.
It requires an existing Source repository, preserves origin/upstream settings,
and does not create lifecycle evidence. It does not copy GitHub-only branches or
Git LFS data. Use `--cwd` for each local repository and `--dry-run` with an already
configured remote to preview. See the README for the complete setup flow.

## Private project credentials

The client forwards its explicit credential or `SOURCE_CREDENTIAL` as a bearer
capability to the submit API, as well as using it for Git authentication. Issue a
project-scoped capability with `read_source,git_push,submit_change` using `source
cap issue --org O1 --project P1 --principal U1 --allowed
read_source,git_push,submit_change`. A plain `git-cap` remains transport-only and
cannot authorize private submission. A Git credential helper by itself supplies
no API credential.

Authenticated `--url` overrides must have the same origin as the chosen Git
remote. This is checked before fetching or pushing. API redirects are rejected.
Tests exercise explicit and environment credentials against private projects,
retain the authenticated principal, preserve GitHub origin, reject transport-only
capabilities, and reject an unrelated API override before any push.

## Throttled clients

`submit` shares a retry budget across its Git requests and API submission: at
most eight retries within ten minutes, with each network command/request bounded
to two minutes or the remaining budget. `sync` uses the same Git backoff. Server
rate/admission limits and authentication are unchanged.

Git retries only an explicit HTTP 429 reported by the Git client. With no safely
available Retry-After header from Git, it waits 60 seconds initially, doubles the
fallback up to 120 seconds for repeated throttling of the same operation, and
adds up to 15 seconds of jitter. Existing explicit non-force refspecs are reused.
Authentication failures, non-fast-forward errors, connection errors and 5xx
responses are not automatically retried.

The submit API advertises `retryable: true` and a conservative full-window
`Retry-After` only when rejecting the request before lifecycle creation. The
client honors seconds or HTTP-date values plus jitter and replays that same POST
only for this marked 429. It does not replay an uncertain mutation response:
a lost connection, timeout, malformed response or 5xx may follow a committed
change. Those remain errors requiring inspection rather than duplicate creation.
Oversized Retry-After values fail against the deadline instead of retrying early.
Retry notices go to stderr; successful JSON output stays on stdout.
