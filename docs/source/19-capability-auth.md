# 19 — Capability-Gated API Auth

Status: **Implemented.** The machine interface (`/api/v1/…`) is
capability-gated; the bounded-capability model is enforced at the HTTP boundary,
not only in the domain layer. Scope is `{org, project, work}`.

## What changed

Before this phase, the HTTP API was unauthenticated: any caller could claim Work,
start Sessions, submit Changes, and record Decisions. The capability model
existed (`capability.js`) but was not wired into the API.

Now every `/api/v1/` endpoint requires a capability credential:

```text
Authorization: Bearer <credential>
```

The credential is an opaque bearer token. Authorization is enforced server-side
against the grant record (scope, allowed/denied, expiry, revocation) — the token
is only an unguessable reference, not a self-contained claim.

## Action vocabulary

`src/auth.js` defines the canonical actions (shared by the API, policy, and
discovery manifest):

| Action | Meaning |
|---|---|
| `read_source` | read org/project/repository metadata |
| `read_context` | read Work/Change/Evidence context |
| `claim_work` | claim a Work item |
| `start_session` | start a Session |
| `submit_change` | submit a Change |
| `submit_evidence` | submit Evidence |
| `accept_change` | record a Decision (accept/reject/revision) |
| `modify_policy` | change policy (not yet exposed) |
| `publish_release` | publish a release (not yet exposed) |
| `manage_org` | create an Organization (tenant) |
| `manage_workflows` | create workflow definitions |
| `read_workflows` | list or inspect workflow definitions |
| `dispatch_workflow` | dispatch a workflow event into the durable queue |
| `enqueue_job` | enqueue one job or a bounded batch of jobs |

## Endpoint → action mapping

| Endpoint | Method | Action | Scope |
|---|---|---|---|
| `/.well-known/source` | GET | public | — |
| `/` and `/o/…` HTML | GET | public | — |
| `/git/{org}/{project}/…` | GET/POST | (unchanged) | — |
| `/api/v1/orgs` | GET | `read_source` | instance |
| `/api/v1/orgs` | POST | `manage_org` | instance |
| `/api/v1/orgs/{org}` | GET | `read_source` | org |
| `/api/v1/orgs/{org}/projects/{p}` | GET | `read_source` | org + project |
| `/api/v1/orgs/{org}/projects/{p}/policy` | GET | `read_context` | org + project |
| `/api/v1/orgs/{org}/projects/{p}/work` | GET | `read_context` | org + project |
| `/api/v1/orgs/{org}/projects/{p}/work/{w}` | GET | `read_context` | org + project + work |
| `/api/v1/orgs/{org}/projects/{p}/work/{w}/claim` | POST | `claim_work` | org + project + work |
| `/api/v1/orgs/{org}/projects/{p}/work/{w}/sessions` | POST | `start_session` | org + project + work |
| `/api/v1/orgs/{org}/projects/{p}/work/{w}/context` | GET | `read_context` | org + project + work |
| `/api/v1/orgs/{org}/projects/{p}/work/{w}/changes` | POST | `submit_change` | org + project + work |
| `/api/v1/orgs/{org}/projects/{p}/changes/{c}` | GET | `read_context` | org + project + work |
| `/api/v1/orgs/{org}/projects/{p}/changes/{c}/evidence` | POST | `submit_evidence` | org + project + work |
| `/api/v1/orgs/{org}/projects/{p}/changes/{c}/evaluate` | POST | `submit_evidence` | org + project + work |
| `/api/v1/orgs/{org}/projects/{p}/changes/{c}/decision` | GET | `read_context` | org + project + work |
| `/api/v1/orgs/{org}/projects/{p}/changes/{c}/decision` | POST | `accept_change` | org + project |
| `/api/v1/orgs/{org}/projects/{p}/evidence/{e}` | GET | `read_context` | org + project |
| `/api/v1/orgs/{org}/projects/{p}/evidence/{e}/artifact` | GET | `read_context` | org + project |
| `/api/v1/orgs/{org}/projects/{p}/submit` | POST | public | — |
| `/api/v1/orgs/{org}/projects/{p}/workflows` | GET | `read_workflows` | org + project |
| `/api/v1/orgs/{org}/projects/{p}/workflows` | POST | `manage_workflows` | org + project |
| `/api/v1/orgs/{org}/projects/{p}/workflows/import-github` | POST | `manage_workflows` | org + project |
| `/api/v1/orgs/{org}/projects/{p}/workflows/{w}/dispatch` | POST | `dispatch_workflow` | org + project |
| `/api/v1/orgs/{org}/projects/{p}/workflows/{w}/webhook` | POST | signed delivery | org + project + shared webhook secret |

## Scope enforcement

A capability's `scope` is `{ org?, project?, work? }`. A missing field means
"no restriction". A request is authorized only if the capability's scope covers
the request's `{org, project, work}`:

- `scope.org` set → must equal the request org.
- `scope.project` set → must equal the request project.
- `scope.work` set → must equal the request work.

For Change endpoints, the Work is resolved from the Change (`change.workId`) so a
work-scoped session capability can submit Evidence to its own Change.

The org check is the tenant boundary: a capability scoped to org A cannot reach
anything under org B, even by guessing a project id (see
`21-multi-tenant-orgs.md`).

## Status codes

- **401** — authentication failure: missing, unknown, expired, or revoked
  credential.
- **403** — authorization failure: action not allowed, action denied, or scope
  violation.

## Temporary session identity

`POST …/work/{w}/sessions` now returns a **session-scoped capability** alongside
the Session:

```text
Agent Definition ──► bootstrap capability (claim_work, start_session)
──► Session ──► session capability (submit_change, submit_evidence)
──► Change ──► Evidence ──► Session ends ──► capability expires
```

The session capability is bounded to `{org, project, work}`, expires after 4
hours, and denies `accept_change`, `modify_policy`, `publish_release`. This is
the "temporary session identity" flow from the MEGA_PROMPT §10.

## Issuance

Capabilities are issued **out-of-band** (operator/CLI), not via an
unauthenticated endpoint:

```bash
source cap issue --principal U2 --org O1 --project P1 --work W1 \
  --allowed read_source,read_context,submit_change,submit_evidence \
  --denied accept_change,modify_policy,publish_release
source cap revoke K1
```

There is deliberately no unauthenticated "mint a capability" endpoint — that
would be a privilege-escalation hole.

## What remains public (documented)

- `/.well-known/source` — discovery must be public so agents can find the
  instance.
- HTML views (`/`, `/o/…`) — the human interface; human authentication is a
  separate, later phase.
- `/api/v1/orgs/{org}/projects/{p}/submit` — the low-friction anonymous
  contribution path (`source submit`). Rate limiting is a documented follow-up.
- `/git/…` — smart-HTTP transport is still anonymous; Git-transport auth is a
  separate follow-up (git clients use basic auth, not bearer tokens).

## Tests

`tests/auth.test.js` covers: missing/unknown/expired/revoked credential (401),
not-allowed and denied actions (403), project-scope and work-scope violations
(403), the session-scoped capability (submit allowed, accept denied), and the
public contribution path.

`tests/org.test.js` covers org-scoped enforcement: org creation requires
`manage_org`, and an org-scoped capability cannot reach another org (403/404).

## Cross-references

- `08-identity-capability-model.md` — the capability model and crypto choice.
- `09-agent-protocol.md` — how agents obtain and use capabilities.
- `21-multi-tenant-orgs.md` — the org-scoped URL scheme and tenant boundary.
- `12-threat-model.md` — stolen capability, replay, escalation.
- `16-mvp-results.md` — item 4 of the next-phase list.

Human web login is intentionally narrower than operator capability issuance. Human
principals must have a password-backed record, and `/login` requires the password,
an explicit organization, and an explicit project. The request cannot choose its
allowed actions or TTL; it receives the bounded default human session grant. High-
authority actions such as policy modification and release publication remain
operator-issued capabilities. Passwords are stored as salted `scrypt` hashes and
are never returned in principal responses.
