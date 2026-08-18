# 06 — Change Model

Status: **Formal model.**

## What a Change is

A Change is a **proposed modification to source**, anchored to an exact base
state and a resulting state, tied to Work and Sessions, and accepted or
rejected by a Decision over Evidence.

It is **not** `branch + diff + comments`. The branch is an implementation
detail of Git transport; the diff is a derived view; comments are not the
collaboration primitive.

## Fields (canonical)

```
id
work_id            — the Work this Change advances
session_id         — the Session that produced it
base_commit        — exact base state (immutable)
head_commit        — resulting state (immutable)
repositories[]     — one or more repositories (multi-repo)
repositoryChanges[]— [{ repoId, baseCommit, headCommit }] (canonical multi-repo)
diff_ref           — pointer to stored diff/patch
evidence[]         — Evidence linked to this Change
review_state       — pending | in_review | approved | changes_requested | rejected
conflict_state     — clean | conflicted | unknown
decision_state     — undecided | accepted | rejected | superseded | deferred | released
created_at
```

## Multi-repository support

A single Work may affect multiple repositories. A Change therefore references
`repositoryChanges[]`, each entry carrying its own `repoId`/`baseCommit`/
`headCommit`. This is now exercised end-to-end (see `24-multi-repo-changes.md`):
a Change can span multiple repositories, and accepting it fast-forwards every
repository's canonical state.

The legacy single-repository fields (`baseCommit`, `headCommit`, `repositories`)
remain as a convenience view over the first (primary) entry, so existing
single-repo callers are unchanged.

## Review state machine

```
pending ──► in_review ──► approved ──► (Decision)
                │
                ├──► changes_requested ──► pending (revised)
                └──► rejected
```

## Relationship to Evidence

A Change carries the Evidence that proves it. Policy evaluation reads the
Change's `evidence[]` against the Project's `required_evidence[]` and produces
a **satisfied / missing** verdict. The Decision records an
`evidence_snapshot` (hashes) so the exact evidence evaluated is immutable and
reconstructable.

## Relationship to canonical state

Accepting a Change does **not** mean "merge a branch." It means: record a
Decision, then update canonical Git state (fast-forward or merge the head
commit into the default branch) as a **separate, audited step**. The Decision
and the Git update are distinct events so the audit trail shows *why* the
state changed, not just *that* it changed.

## TOCTOU guard

Between policy evaluation and Decision, the base/head commits are pinned by
hash. A Decision is recorded against those exact hashes. If canonical state
moved in the meantime, the update step detects a non-fast-forward and requires
a new evaluation — never a silent merge. The guard applies per repository in a
multi-repository Change. See `12-threat-model.md`.

## Cross-references

- `05-work-lifecycle.md` — how Change submission moves Work.
- `07-evidence-model.md` — what Evidence a Change carries.
- `10-git-integration.md` — how head/base map to Git refs.
- `24-multi-repo-changes.md` — the multi-repository representation.
