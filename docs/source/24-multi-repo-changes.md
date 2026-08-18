# 24 — Multi-Repository Changes

Status: **Implemented.** A single Change can now span multiple repositories.

## What changed

The Change model always carried a `repositories[]` field, but the MVP only
exercised single-repository Changes. This phase makes the multi-repository
representation canonical and exercises it end-to-end.

## Canonical representation

A Change now carries `repositoryChanges`, an array of per-repository
base/head pairs:

```json
{
  "id": "C1",
  "workId": "W1",
  "sessionId": "S1",
  "repositoryChanges": [
    { "repoId": "R1", "baseCommit": "<sha>", "headCommit": "<sha>" },
    { "repoId": "R2", "baseCommit": "<sha>", "headCommit": "<sha>" }
  ]
}
```

The legacy single-repository fields remain as a convenience view over the
first (primary) entry:

- `baseCommit` / `headCommit` — the primary repository's commits.
- `repositories` — the list of repository ids.

When a Change is submitted with only `baseCommit`/`headCommit`/`repositories`
(the legacy path), `repositoryChanges` is derived from them. When `repositories`
is empty (a legacy single-repo Change whose repository is implied at update
time), `repositoryChanges` is empty and the top-level `baseCommit`/`headCommit`
are preserved.

## Canonical state update

`updateCanonicalState` now fast-forwards **every** repository in the Change:

- With an explicit `repoId`, it updates that repository (single-repo path,
  returning `{ ok, reason }`).
- Without `repoId`, it updates all repositories (multi-repo path, returning
  `{ ok, results }` where `results` is a per-repository `{ repoId, ok, reason }`).

Each repository is still guarded by the TOCTOU fast-forward check: the base
commit must be an ancestor of the current tip, and the head must descend from
it. A multi-repo update is atomic in intent — all repositories are updated in
one call, and the Work is closed only if every repository fast-forwards.

## Decision source state

A Decision now records `sourceStates` (the full `repositoryChanges` array) in
addition to the legacy `sourceState` (the primary head commit), so the exact
multi-repository source state a Decision evaluated is reconstructable.

## Tests

`tests/multi-repo.test.js`:

- A Change can span two repositories (canonical `repositoryChanges` populated).
- A multi-repository Change completes the full lifecycle and updates both
  repositories' canonical state.

## Cross-references

- `06-change-model.md` — the Change model (now exercised multi-repo).
- `10-git-integration.md` — how base/head map to Git refs.
- `12-threat-model.md` — TOCTOU guard applies per repository.
