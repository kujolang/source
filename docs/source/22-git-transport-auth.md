# 22 — Git-Transport Auth

Status: **Implemented.** The smart-HTTP Git transport is now capability-gated
via HTTP Basic auth. Private repositories are actually private; push always
requires a credential.

## What changed

Before this phase, the Git transport was anonymous: `git http-backend` was
invoked with `GIT_HTTP_EXPORT_ALL=1` and each bare repo had
`http.receivepack=true`, so anyone could clone, fetch, or push any repository.

Now the HTTP layer authorizes every Git request before delegating to
`git http-backend`:

| Operation | Public repo | Private repo |
|---|---|---|
| read (clone/fetch, `upload-pack`) | anonymous | `read_source` capability |
| write (push, `receive-pack`) | `git_push` capability | `git_push` capability |

## How it works

1. **Credential format.** Git clients use HTTP Basic auth, not bearer tokens.
   The password field is the capability credential; the username is ignored.
   `basicCredential` (in `auth.js`) extracts it.

2. **Authorization.** `authorizeGit` (in `auth.js`) maps the request to the
   capability model:
   - write → `git_push` action, scoped to `{org, project}`;
   - read on a private repo → `read_source` action, scoped to `{org, project}`;
   - read on a public repo → anonymous (`remoteUser = ''`).

3. **Enforcement point.** The API (`api.js`) resolves the repository, computes
   `isWrite` from the `service` query param or the `git-receive-pack` path
   segment, and calls `authorizeGit` *before* reading the body or invoking
   `git http-backend`. A 401 carries `WWW-Authenticate: Basic realm="source"`
   so git clients know to send credentials.

4. **Defense in depth.** `enableReceivePack()` was removed, so
   `git http-backend` itself refuses `receive-pack` unless `REMOTE_USER` is
   set. The HTTP layer sets `REMOTE_USER` to the authenticated principal id
   (or leaves it empty for anonymous public read). Even if the HTTP layer had a
   bug, `git http-backend` would not accept an anonymous push.

## New capability action

`git_push` was added to the canonical action vocabulary (`ACTIONS` in
`auth.js`). It is distinct from `submit_change`: pushing a branch is a
lower-level transport operation, not the submission of a Change. The discovery
manifest (`/.well-known/source`) now advertises it and documents the Basic-auth
scheme under `git_auth`.

## Issuing a Git capability

`Source.issueGitCapability({ orgId, projectId, principalId, push })` issues a
project-scoped capability with `read_source` (always) and `git_push` (opt-in).
The CLI exposes it as:

```text
source git-cap --org O1 --project P1 --principal U1
source git-cap --org O1 --project P1 --principal U1 --read-only
```

A contributor then uses the credential as the password in the Git URL:

```text
git clone http://source:<credential>@host/git/O1/P1/main.git
```

## Interaction with `source submit`

The `source submit` client (item 3) pushes a contribution ref over HTTP, which
now requires `git_push`. The client accepts a credential (via the `credential`
option or `SOURCE_CREDENTIAL`) and sends it as Basic auth on the push. A
contributor needs a git credential but still does not need to understand Source
concepts — the low-friction onboarding ramp is preserved.

## Deliberately not built

- **Ref-level push policy** — a `git_push` capability authorizes push to any
  ref in the project. Restricting anonymous contribution pushes to
  `refs/heads/source-submit-*` (or similar) is a later phase.
- **TLS** — the transport is still plain HTTP; TLS termination is a deployment
  concern (see `16-mvp-results.md`).
- **SSH transport** — only smart HTTP is implemented.

## Tests

`tests/git-http.test.js` now covers:

- authenticated clone (by id and by name), fetch, and push;
- public repository allows anonymous clone;
- private repository read requires auth (401, with `WWW-Authenticate`);
- push requires auth even for public repositories (401);
- a capability scoped to another org cannot read its repo (403);
- unknown repository / cross-org / path-traversal still 404.

`tests/submit.test.js` exercises the `source submit` flow with a public repo
(anonymous clone) plus a `git_push` credential for the push.

## Cross-references

- `08-identity-capability-model.md` — capability scope and actions.
- `19-capability-auth.md` — the bearer-token API auth (the Git transport uses
  Basic auth over the same capability model).
- `10-git-integration.md` — Git responsibilities vs Source responsibilities.
- `18-source-submit.md` — the contribution client.
- `12-threat-model.md` — Git endpoint abuse, capability replay.
- `16-mvp-results.md` — item 1 of the fresh next-phase list.
