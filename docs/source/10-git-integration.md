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
- **Transport:** local `file://` and `git` CLI, plus **smart-HTTP** (see below).
- **Clone/fetch/pull/push** all work through normal Git; Source does not
  reimplement any of it.
- **Safe concurrent access:** Git's own locking (ref locks, `gc` via
  `git maintenance`) plus Source serializing writes per repository. No custom
  locking protocol.

## Smart-HTTP transport (implemented)

`git clone https://…`, `git fetch`, and `git push` work against a Source bare
repository. Source delegates to Git's own `git http-backend` CGI program
(`src/git-http.js`); it never reimplements the packfile/network protocol.

URL scheme:

```text
/git/{project}/{repo}.git/{service}
```

`{repo}` may be the repository id (`R1`) or name (`main`); the bare directory is
keyed by id, so the route resolves the repository and maps `pathInfo` to the id.

Implementation facts:

- `GIT_PROJECT_ROOT` is the project's `repos/` directory; `PATH_INFO` is
  `/{repoId}.git/{service}`.
- `GIT_HTTP_EXPORT_ALL=1` serves all repos (MVP has no per-repo export control;
  this is replaced by capability-gated auth).
- `http.receivepack=true` is set on each bare repo at creation, because
  `git http-backend` disables push for unauthenticated users by default and the
  MVP has no auth.
- `Git-Protocol: version=2` is passed through as `HTTP_GIT_PROTOCOL`, so
  protocol v2 negotiation works.
- `REMOTE_USER=anonymous` is a placeholder for the MVP; capability-gated auth
  (next phase) will populate it with the real principal.
- Tenant isolation is server-side: the route resolves the repository against the
  project's repository list and rejects unknown refs and path traversal with
  404. It never trusts the URL to address a bare directory directly.

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

```text
git clone https://source.example.com/git/{project}/{repo}.git
# make changes
git push origin main        # or: source submit
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
