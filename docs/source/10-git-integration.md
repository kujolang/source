# 10 — Git Integration

Status: **Evidence-backed.** Git is a dependency, not a competitor.

## Division of responsibility

| Responsibility | Owner |
|---|---|
| Repository objects, commits, refs, history | **Git** |
| Clone, fetch, pull, push | **Git** |
| Packfile/network protocol | **Git** (never reimplemented) |
| Bare repository storage | **Git** (bare repos on disk) |
| Object integrity | **Git** (SHA-1 object model) |
| Work/Session/Change/Evidence/Decision association | **Source** |
| AuthN/AuthZ on Git operations | **Source** (capability-gated) |
| Hooks → lifecycle events | **Source** (post-receive → event) |
| Canonical-state update on Decision | **Source** (invokes Git) |

## MVP approach

- **Bare repositories** on disk, one per Repository, under a per-tenant
  directory (e.g. `data/instances/<i>/orgs/<o>/repos/<r>.git`).
- **Transport:** local `file://` and `git` CLI for MVP; smart-HTTP is a
  documented next step (the API server can serve `git-http-backend`).
- **Clone/fetch/pull/push** all work through normal Git; Source does not
  reimplement any of it.
- **Safe concurrent access:** Git's own locking (ref locks, `gc` via
  `git maintenance`) plus Source serializing writes per repository. No custom
  locking protocol.

## Hooks / event integration

A `post-receive` hook (or equivalent) emits a lifecycle event when a ref is
updated. Source maps that event to:

- which Repository/Project it belongs to;
- whether it corresponds to a known Change (head commit match);
- whether it updates canonical state (default branch).

This is the seam where Git state becomes Source state. The hook is thin: it
writes an event; Source's event handler does the association.

## Canonical-state update on Decision

Accepting a Change triggers a **separate, audited** Git step:

1. Verify the Change's `head_commit` still exists and `base_commit` is an
   ancestor of the current default branch (fast-forward check).
2. Update the default branch ref to `head_commit` (fast-forward or explicit
   merge, per policy).
3. Record the update as an audit event tied to the Decision.

If the check fails (non-fast-forward), the update is **refused** and a new
evaluation is required — never a silent merge. See `06-change-model.md`.

## External contributions

A developer who knows Git but not Source can:

```
git clone <url>
# make changes
source submit
```

`source submit` determines the Project, reads contribution policy, identifies
the base state, creates (or links) contribution Work, runs local verification
where possible, creates a Change, connects evidence, and submits for review.

A plain `git push` to a contribution ref is also recognized: the post-receive
event creates a Change from the pushed ref. Existing Git knowledge remains
valuable; Source concepts are layered on top, not required up front.

## Cross-references

- `03-system-architecture.md` — where Git sits in the topology.
- `06-change-model.md` — base/head commit semantics.
- `12-threat-model.md` — Git endpoint abuse, destructive operations.
