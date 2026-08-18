# 09 — Agent Protocol

Status: **Formal protocol + evidence-backed API style.**

## Design goal

An agent encountering an unknown Source instance must be able to discover how
to interact with it **without scraping the web interface**. Responses must be
compact, structured, and progressively retrievable.

## Discovery

`GET /.well-known/source` returns a compact machine manifest:

```json
{
  "instance": "source.kujolang.ai",
  "api_version": "1",
  "protocols": ["http+json", "git-smart-http"],
  "endpoints": {
    "orgs": "/api/v1/orgs",
    "projects": "/api/v1/orgs/{org}/projects",
    "work": "/api/v1/orgs/{org}/projects/{project}/work",
    "changes": "/api/v1/orgs/{org}/projects/{project}/changes",
    "evidence": "/api/v1/orgs/{org}/projects/{project}/evidence",
    "git": "/git/{org}/{project}/{repo}.git",
    "policy": "/api/v1/orgs/{org}/projects/{project}/policy",
    "submit": "/api/v1/orgs/{org}/projects/{project}/submit"
  },
  "capabilities": ["read_source", "read_context", "claim_work", "start_session", "submit_change", "submit_evidence", "accept_change", "modify_policy", "publish_release", "manage_org"],
  "auth": {
    "type": "capability",
    "header": "Authorization: Bearer <credential>"
  }
}
```

This is a `.well-known` resource (RFC 8615) — a standard, cacheable mechanism
that requires no scraping. It is intentionally compact. The Organization is
the tenant boundary and is explicit in every endpoint.

## Authentication

Every `/api/v1/` request carries a capability credential:

```text
Authorization: Bearer <credential>
```

The credential is an opaque bearer token; authorization is enforced server-side
against the grant record (scope, allowed/denied, expiry, revocation). Scope is
`{org, project, work}`. See `19-capability-auth.md` for the full endpoint →
action → scope mapping.

## Progressive retrieval

```text
discover instance ──► discover org ──► discover project ──► retrieve Work
──► retrieve policy ──► retrieve only relevant context ──► retrieve relevant source
──► perform action ──► submit structured output
```

Each step returns only what the next step needs. Field selection and scoped
retrieval keep payloads small.

## API style (evidence-backed)

- **HTTP + JSON**, REST-shaped resources with stable IDs.
- **Content negotiation** (`Accept: application/json`).
- **Field selection** (`?fields=id,status,assignee`) for token efficiency.
- **Pagination** (`?limit=&cursor=`) for lists.
- **Versioning** via `/api/v1/` prefix and `api_version` in discovery.
- **No HTML required** for any critical capability.

RPC/event-streams were considered and deferred: the MVP's operations are
request/response; a streaming/event channel is a later addition, not a
requirement to prove the vertical slice.

## Agent operations (MVP)

| Operation | Endpoint | Notes |
|---|---|---|
| discover instance | `GET /.well-known/source` | compact manifest |
| discover org | `GET /api/v1/orgs` | list orgs |
| discover project | `GET /api/v1/orgs/{org}/projects/{project}` | identity, repos, policy ref |
| list/get Work | `GET /api/v1/orgs/{org}/projects/{p}/work` / `.../{id}` | field-selectable |
| claim Work | `POST /api/v1/orgs/{org}/projects/{p}/work/{id}/claim` | requires `claim_work` |
| start Session | `POST /api/v1/orgs/{org}/projects/{p}/work/{id}/sessions` | returns session + scoped capability |
| retrieve context | `GET /api/v1/orgs/{org}/projects/{p}/work/{id}/context` | scoped, token-bounded |
| retrieve repo info | `GET /api/v1/orgs/{org}/projects/{p}/repos/{r}` | clone URL, default branch |
| submit Change | `POST /api/v1/orgs/{org}/projects/{p}/work/{id}/changes` | base/head commits |
| submit Evidence | `POST /api/v1/orgs/{org}/projects/{p}/changes/{c}/evidence` | artifact + claim |
| complete Session | `POST /api/v1/.../sessions/{id}/complete` | result, ends capability |
| retrieve Decision | `GET /api/v1/orgs/{org}/projects/{p}/changes/{c}/decision` | decision + evidence snapshot |

## Token efficiency

- Responses default to compact field sets; full objects on explicit request.
- Lists are paginated and field-selectable.
- Evidence `result` is a compact summary; `artifact_ref` is fetched only when
  the full artifact is needed.
- Response sizes are measured in `15-acceptance-tests.md` and
  `16-mvp-results.md`.

## Cross-references

- `08-identity-capability-model.md` — capability issuance.
- `19-capability-auth.md` — capability-gated API auth (actions + scope).
- `21-multi-tenant-orgs.md` — the org-scoped URL scheme and tenant boundary.
- `10-git-integration.md` — Git endpoints.
- `13-mvp-scope.md` — which operations are implemented.
