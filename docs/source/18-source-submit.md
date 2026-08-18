# 18 — `source submit` Contribution Flow

Status: **Implemented.** The low-friction path for a developer who knows Git but
not Source.

## Goal

A normal developer must be able to contribute without learning Source concepts
up front:

```text
git clone https://source.example.com/git/{project}/{repo}.git
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
2. read `remote.origin.url`, parse {project, repo}
3. determine base = merge-base(HEAD, origin/<default-branch>)
4. determine head = HEAD
5. reject empty changes (base == head)
6. push head to a contribution ref (so it is present in the bare repo)
7. POST /api/v1/projects/{project}/submit
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

- **Base commit is the fork point** (`git merge-base HEAD origin/<default>`),
  not the contributor's assumption. The Change is tied to the exact source state
  it was based on; a later non-fast-forward is caught by the canonical-state
  update guard.
- **Head commit is pushed to a contribution ref** (`refs/heads/source-submit-…`)
  so it is present in the bare repository for the later canonical-state update.
- **Footprint evidence is deterministic** (changed-file list, non-empty check).
  No LLM, no test suite assumption. It is real evidence but does not satisfy the
  project's full required evidence (tests/eval); the maintainer's verification
  service fills those. Missing evidence is visible, not hidden.
- **Contributor identity is a `human` principal** created server-side from the
  Git `user.name`. No auth in the MVP; capability-gated auth is the next phase.
- **The CLI is a thin client** — `src/submit.js` uses the same HTTP API as any
  other client; no business logic lives only in the CLI.

## Files

- `src/submit.js` — client-side contribution logic (async git + fetch).
- `src/source.js` — `submitContribution` server method (the lifecycle).
- `src/api.js` — `POST /api/v1/projects/{project}/submit`.
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
