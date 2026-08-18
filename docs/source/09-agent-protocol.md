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
  "protocols": ["http+json"],
  "endpoints": {
    "projects": "/api/v1/projects",
    "work": "/api/v1/projects/{project}/work",
    "changes": "/api/v1/projects/{project}/changes",
    "evidence": "/api/v1/projects/{project}/evidence",
    "git": "/git/{project}/{repo}.git",
    "auth": "/api/v1/auth",
    "policy": "/api/v1/projects/{project}/policy"
  },
  "capabilities": ["read_source", "read_context", "submit_change", "submit_evidence"],
  "auth": ["capability_token"]
}
```

This is a `.well-known` resource (RFC 8615) — a standard, cacheable mechanism
that requires no scraping. It is intentionally compact.

## Progressive retrieval

```
discover instance ──► discover project ──► retrieve Work ──► retrieve policy
──► retrieve only relevant context ──► retrieve relevant source
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
| discover project | `GET /api/v1/projects/{project}` | identity, repos, policy ref |
| list/get Work | `GET /api/v1/projects/{p}/work` / `.../{id}` | field-selectable |
| claim Work | `POST /api/v1/projects/{p}/work/{id}/claim` | requires capability |
| start Session | `POST /api/v1/projects/{p}/work/{id}/sessions` | returns session + capability |
| retrieve context | `GET /api/v1/projects/{p}/work/{id}/context` | scoped, token-bounded |
| retrieve repo info | `GET /api/v1/projects/{p}/repos/{r}` | clone URL, default branch |
| submit Change | `POST /api/v1/projects/{p}/work/{id}/changes` | base/head commits |
| submit Evidence | `POST /api/v1/projects/{p}/changes/{c}/evidence` | artifact + claim |
| complete Session | `POST /api/v1/.../sessions/{id}/complete` | result, ends capability |
| retrieve Decision | `GET /api/v1/projects/{p}/changes/{c}/decision` | decision + evidence snapshot |

## Token efficiency

- Responses default to compact field sets; full objects on explicit request.
- Lists are paginated and field-selectable.
- Evidence `result` is a compact summary; `artifact_ref` is fetched only when
  the full artifact is needed.
- Response sizes are measured in `15-acceptance-tests.md` and
  `16-mvp-results.md`.

## Cross-references

- `08-identity-capability-model.md` — capability issuance.
- `10-git-integration.md` — Git endpoints.
- `13-mvp-scope.md` — which operations are implemented.
