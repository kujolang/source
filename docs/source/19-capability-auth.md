# 19 — Capability-Gated API Auth

Status: **Implemented.** The machine interface (`/api/v1/…`) is now
capability-gated; the bounded-capability model is enforced at the HTTP boundary,
not only in the domain layer.

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
| `read_source` | read project/repository metadata |
| `read_context` | read Work/Change/Evidence context |
| `claim_work` | claim a Work item |
| `start_session` | start a Session |
| `submit_change` | submit a Change |
| `submit_evidence` | submit Evidence |
| `accept_change` | record a Decision (accept/reject/revision) |
| `modify_policy` | change policy (not yet exposed) |
| `publish_release` | publish a release (not yet exposed) |

## Endpoint → action mapping

| Endpoint | Method | Action | Scope |
|---|---|---|---|
| `/.well-known/source` | GET | public | — |
| `/` and `/p/…` HTML | GET | public | — |
| `/git/…` | GET/POST | (unchanged) | — |
| `/api/v1/projects` | GET | `read_source` | instance |
| `/api/v1/projects/{p}` | GET | `read_source` | project |
| `/api/v1/projects/{p}/policy` | GET | `read_context` | project |
| `/api/v1/projects/{p}/work` | GET | `read_context` | project |
| `/api/v1/projects/{p}/work/{w}` | GET | `read_context` | project + work |
| `/api/v1/projects/{p}/work/{w}/claim` | POST | `claim_work` | project + work |
| `/api/v1/projects/{p}/work/{w}/sessions` | POST | `start_session` | project + work |
| `/api/v1/projects/{p}/work/{w}/context` | GET | `read_context` | project + work |
| `/api/v1/projects/{p}/work/{w}/changes` | POST | `submit_change` | project + work |
| `/api/v1/projects/{p}/changes/{c}` | GET | `read_context` | project + work |
| `/api/v1/projects/{p}/changes/{c}/evidence` | POST | `submit_evidence` | project + work |
| `/api/v1/projects/{p}/changes/{c}/evaluate` | POST | `submit_evidence` | project + work |
| `/api/v1/projects/{p}/changes/{c}/decision` | GET | `read_context` | project + work |
| `/api/v1/projects/{p}/changes/{c}/decision` | POST | `accept_change` | project |
| `/api/v1/projects/{p}/evidence/{e}` | GET | `read_context` | project |
| `/api/v1/projects/{p}/evidence/{e}/artifact` | GET | `read_context` | project |
| `/api/v1/projects/{p}/submit` | POST | public | — |

## Scope enforcement

A capability's `scope` is `{ project?, work? }`. A missing field means "no
restriction". A request is authorized only if the capability's scope covers the
request's `{project, work}`:

- `scope.project` set → must equal the request project.
- `scope.work` set → must equal the request work.

For Change endpoints, the Work is resolved from the Change (`change.workId`) so a
work-scoped session capability can submit Evidence to its own Change.

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

The session capability is bounded to `{project, work}`, expires after 4 hours,
and denies `accept_change`, `modify_policy`, `publish_release`. This is the
"temporary session identity" flow from the MEGA_PROMPT §10.

## Issuance

Capabilities are issued **out-of-band** (operator/CLI), not via an
unauthenticated endpoint:

```bash
source cap issue --principal U2 --project P1 --work W1 \
  --allowed read_source,read_context,submit_change,submit_evidence \
  --denied accept_change,modify_policy,publish_release
source cap revoke K1
```

There is deliberately no unauthenticated "mint a capability" endpoint — that
would be a privilege-escalation hole.

## What remains public (documented)

- `/.well-known/source` — discovery must be public so agents can find the
  instance.
- HTML views (`/`, `/p/…`) — the human interface; human authentication is a
  separate, later phase.
- `/api/v1/projects/{p}/submit` — the low-friction anonymous contribution path
  (`source submit`). Rate limiting is a documented follow-up.
- `/git/…` — smart-HTTP transport is still anonymous; Git-transport auth is a
  separate follow-up (git clients use basic auth, not bearer tokens).

## Tests

`tests/auth.test.js` covers: missing/unknown/expired/revoked credential (401),
not-allowed and denied actions (403), project-scope and work-scope violations
(403), the session-scoped capability (submit allowed, accept denied), and the
public contribution path.

## Cross-references

- `08-identity-capability-model.md` — the capability model and crypto choice.
- `09-agent-protocol.md` — how agents obtain and use capabilities.
- `12-threat-model.md` — stolen capability, replay, escalation.
- `16-mvp-results.md` — item 4 of the next-phase list.
