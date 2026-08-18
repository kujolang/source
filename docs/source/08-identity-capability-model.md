# 08 — Identity & Capability Model

Status: **Formal model + evidence-backed crypto choice.**

## Principals

The common identity abstraction. Types:

| Type | Meaning | Example |
|---|---|---|
| `human` | A person | maintainer, contributor |
| `agent` | An autonomous participant | `agent:implementation-19` |
| `service` | A non-human, non-agent system | verification service, CI |
| `organization` | A grouping principal | the owning org |

Username/password is **not** the fundamental identity model. A Principal is a
stable identity that Capabilities are issued to. Authentication (how a
principal proves it is that principal) is a separate concern from
authorization (what a capability allows).

## Capabilities

A Capability is a **bounded grant of authority**, scoped by:

```
principal_id
scope          — project | repository | work | action
allowed[]      — read source, read context, submit change, submit evidence, ...
denied[]       — accept change, modify policy, publish release, ...
expires_at     — absolute expiry
issued_at
token          — opaque, HMAC-signed
```

Example (from the MEGA_PROMPT):

```
Principal: agent:implementation-19
Project:   spec
Work:      W184
Allowed:   read source, read context, submit change, submit evidence
Denied:    accept change, modify policy, publish release
Expires:   4 hours
```

## Temporary session identities

```
Agent Definition ──► Temporary Session Identity ──► Scoped Capability
──► Work ──► Change ──► Evidence ──► Session Ends ──► Capability Expires
```

A persistent Agent definition is distinct from a temporary session identity.
The session identity receives a scoped, expiring capability; when the session
ends, the capability expires. No broad permanent repository credentials.

## Crypto choice (evidence-backed)

- **Capability tokens:** opaque random token (Node `crypto.randomBytes`) whose
  server-side record carries the grant. The token is a bearer reference to a
  server-enforced grant, **not** a self-contained signed claim. This avoids
  custom cryptography and makes revocation/expiry a server-side fact.
- **Integrity:** SHA-256 for artifact hashing.
- **No custom primitives.** No hand-rolled signatures, no custom KDFs.

Rationale: capability *authorization* is enforced server-side against the
grant record; the token is only an unguessable reference. This is simpler and
safer than a self-contained signed token (which would require key management,
rotation, and replay protection) for the MVP, and it is a clean seam to replace
with a standard (e.g. JWT with a managed signing key) later.

## Trust assumptions (documented)

1. The token is a bearer credential: possession = authority, bounded by the
   grant and expiry.
2. The server is the authority for grant validity; clients cannot mint or
   extend grants.
3. Transport must be TLS in any non-local deployment (MVP uses localhost).
4. Capability replay is bounded by expiry and by server-side grant state
   (a grant can be revoked).

## Cross-references

- `04-domain-object-model.md` — Principal/Capability fields.
- `09-agent-protocol.md` — how agents obtain and use capabilities.
- `12-threat-model.md` — stolen capability, replay, escalation.
