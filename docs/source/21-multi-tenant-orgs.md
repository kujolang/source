# 21 — Multi-Tenant Org Management

Status: **Implemented.** The Organization is now a first-class, server-enforced
tenant boundary across the API, Git transport, CLI, and web UI — not a
single-org hardcode with a latent schema.

## What changed

Before this phase, the Organization boundary existed only in the data model
(paths are `orgs/{org}/projects/{project}/…`) and in one domain-level test. The
HTTP API hardcoded `ORG = 'O1'`, so every route was implicitly single-tenant.

Now the org is explicit in every route and enforced server-side:

```text
/api/v1/orgs/{org}/projects/{project}/…
/git/{org}/{project}/{repo}.git
/o/{org}/p/{project}/…            (human HTML)
```

## URL scheme (breaking change)

The API and Git transport moved from single-org to org-scoped paths. This is a
clean break (the API is versioned and pre-1.0), not a compatibility shim:

| Before | After |
|---|---|
| `/api/v1/projects/{p}` | `/api/v1/orgs/{org}/projects/{p}` |
| `/api/v1/projects/{p}/work` | `/api/v1/orgs/{org}/projects/{p}/work` |
| `/git/{p}/{repo}.git` | `/git/{org}/{p}/{repo}.git` |
| `/p/{p}` (HTML) | `/o/{org}/p/{p}` (HTML) |

The `source submit` client parses the org-scoped remote URL and posts to the
org-scoped submit endpoint.

## Org management

- `GET /api/v1/orgs` — list orgs (`read_source`, instance scope).
- `GET /api/v1/orgs/{org}` — get an org (`read_source`, org scope).
- `POST /api/v1/orgs` — create an org (`manage_org`, instance scope).
- CLI: `source org create|list|show`.
- Web: `/` lists orgs; `/o/{org}` lists the org's projects.

Org creation is a privileged operation gated on a new `manage_org` capability
action. There is deliberately no unauthenticated "create a tenant" endpoint.

## Org-scoped capability enforcement

The capability `scope` now carries an `org` field alongside `project` and
`work`:

```text
scope: { org, project?, work? }
```

`scopeCovers` (in `auth.js`) rejects a request whose org does not match the
capability's org scope. A capability scoped to org A cannot read, list, or
mutate anything under org B — enforced server-side, not by UI filtering.

The session-scoped capability issued on `startSession` is now bounded to
`{org, project, work}`.

## Tenant isolation (server-side, not UI filtering)

Isolation is structural, not cosmetic:

1. **Path keying** — every record lives under `orgs/{org}/…`. A project id is
   only resolvable under its owning org; requesting it under another org
   returns 404.
2. **Git transport** — `/git/{org}/{project}/{repo}.git` resolves the repo only
   within the named org; a repo in another org is unreachable (404).
3. **Capability scope** — org-scoped grants are checked on every `/api/v1/`
   request.

## Org ID counter fix

`createOrg` previously reused the project counter (`nextId(store, 'project')`
then `O${id.slice(1)}`), which meant creating an org consumed a project id — the
first project was `P2`, not `P1`. `ids.js` now has a dedicated `org` prefix, so
org and project ids are independent (`O1`, `P1`, …). This is a correctness fix,
not a cosmetic one: it removes a hidden coupling between tenant and project
identity.

## What is deliberately not built

Per the MEGA_PROMPT §9 ("do not overbuild organization functionality"), this
phase does **not** add: org membership/roles, org-level policy inheritance,
billing metadata, SSO, or org administration UI. The boundary is real and
enforceable; the administration surface is a later phase.

## Tests

`tests/org.test.js` covers:

- org and project ids use independent counters;
- list/get org via the API;
- org creation requires `manage_org` (403 without it, 201 with it);
- an org-scoped capability cannot read another org's project (403);
- an org-scoped capability cannot list another org's work (403);
- a project in another org is unreachable by id (404, server-side isolation).

`tests/git-http.test.js` adds a cross-org repository-isolation test (404).

## Cross-references

- `04-domain-object-model.md` — the Organization object.
- `08-identity-capability-model.md` — capability scope.
- `19-capability-auth.md` — the endpoint → action → scope mapping (now org-scoped).
- `09-agent-protocol.md` — org-scoped discovery and operations.
- `12-threat-model.md` — cross-tenant access.
- `16-mvp-results.md` — item 6 of the next-phase list.
