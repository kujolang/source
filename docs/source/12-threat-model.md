# 12 — Threat Model

Status: **Formal threat model.** Each threat: asset, attacker, path, impact,
preventive control, detective control, recovery, remaining risk.

## Trust boundaries

```
[untrusted: git clients, agents, contributors, web content]
        │  (TLS + capability auth)
[Source API / Git endpoint]
        │  (server-side authorization)
[domain services + store + bare repos]
```

Server-side authorization is the only isolation boundary. UI filtering is
never a control.

## Threats

### T1 — Compromised agent
- **Asset:** source, canonical state. **Attacker:** adversary controlling an agent.
- **Path:** agent uses its capability beyond intent.
- **Impact:** unauthorized source change.
- **Preventive:** bounded, expiring capabilities; deny-list (accept change,
  modify policy, publish release); least privilege.
- **Detective:** audit log records every capability use.
- **Recovery:** revoke capability; revert canonical state via Git.
- **Remaining risk:** an agent with `submit_change` can still submit a bad
  change; human Decision is the gate.

### T2 — Malicious contributor
- **Asset:** source. **Attacker:** external contributor.
- **Path:** submits a Change with malicious content.
- **Impact:** poisoned source if accepted.
- **Preventive:** policy requires evidence; human Decision required to accept.
- **Detective:** evidence review; diff inspection.
- **Recovery:** reject; revert.
- **Remaining risk:** social engineering of the maintainer.

### T3 — Stolen capability
- **Asset:** authority. **Attacker:** anyone who obtains a token.
- **Path:** replay the token.
- **Impact:** unauthorized actions within the grant.
- **Preventive:** short expiry; server-side grant state; TLS.
- **Detective:** audit log ties actions to principal.
- **Recovery:** revoke grant.
- **Remaining risk:** window between theft and revocation.

### T4 — Capability replay
- **Asset:** authority. **Attacker:** network observer (no TLS) or log reader.
- **Path:** reuse a captured token.
- **Impact:** same as T3.
- **Preventive:** TLS in deployment; tokens not logged.
- **Detective:** audit log.
- **Recovery:** revoke.
- **Remaining risk:** TLS is now available (in-process or reverse proxy, see
  `23-tls-deployment.md`); plain HTTP remains only for local development.

### T5 — Unauthorized Change acceptance
- **Asset:** canonical state. **Attacker:** principal without accept authority.
- **Path:** forge a Decision.
- **Impact:** unauthorized merge.
- **Preventive:** Decision requires `accept_change` capability; server-enforced.
- **Detective:** audit log.
- **Recovery:** revert.
- **Remaining risk:** none beyond capability theft (T3).

### T6 — Cross-tenant access
- **Asset:** tenant data. **Attacker:** another tenant.
- **Path:** path traversal / missing tenant check.
- **Impact:** data leak.
- **Preventive:** tenant-scoped paths; server-side org/project checks on every
  read/write; no UI-only filtering.
- **Detective:** audit log; path validation.
- **Recovery:** fix; rotate.
- **Remaining risk:** implementation bugs; mitigated by tests (tenant isolation).

### T7 — Git endpoint abuse
- **Asset:** repos, availability. **Attacker:** unauthenticated client.
- **Path:** push to protected refs, force-push, huge objects.
- **Impact:** source corruption, DoS.
- **Preventive:** capability-gated push; ref protection; size limits; rate
  limiting on push.
- **Detective:** post-receive events; audit.
- **Recovery:** reflog; restore refs.
- **Remaining risk:** smart-HTTP request/response bounds, Git subprocess
  timeouts, global/per-project admission, and auth/rate limits are enforced;
  shared Git-volume durability, Git implementation defects, and deployment
  edge throttling remain operational risks.

### T8 — Malicious repository content
- **Asset:** server, other tenants. **Attacker:** contributor.
- **Path:** repo content triggers server-side processing (hooks, rendering).
- **Impact:** RCE, XSS, prompt injection.
- **Preventive:** treat repo content as untrusted data; no server-side
  execution of repo content; render Markdown with escaping.
- **Detective:** content scanning (deferred).
- **Recovery:** isolate; patch.
- **Remaining risk:** Markdown rendering XSS if not escaped (tested).

### T9 — Poisoned / forged evidence
- **Asset:** trust in evidence. **Attacker:** agent/contributor.
- **Path:** submit evidence that does not correspond to a real run.
- **Impact:** false confidence; bad Decision.
- **Preventive:** evidence carries producer + provenance + artifact hash;
  verification-service evidence is distinguished from self-asserted evidence.
- **Detective:** provenance inspection; artifact hash verification.
- **Recovery:** mark evidence invalid; re-evaluate.
- **Remaining risk:** a compromised verification service (T12).

### T10 — Tampered artifacts
- **Asset:** evidence integrity. **Attacker:** anyone with store access.
- **Path:** modify a stored artifact.
- **Impact:** evidence no longer trustworthy.
- **Preventive:** content-addressed storage; integrity hash checked on read.
- **Detective:** hash mismatch on read.
- **Recovery:** restore from backup.
- **Remaining risk:** store-level compromise.

### T11 — Compromised verification service
- **Asset:** evidence trust. **Attacker:** adversary controlling the service.
- **Path:** service emits forged evidence.
- **Impact:** false proof.
- **Preventive:** service identity is a distinct principal; its evidence is
  labeled by producer; human Decision still required.
- **Detective:** audit of service actions.
- **Recovery:** revoke service capability.
- **Remaining risk:** trust in the service is a documented assumption.

### T12 — Dependency attacks
- **Asset:** supply chain. **Attacker:** malicious dependency.
- **Path:** Change introduces a malicious dependency.
- **Impact:** compromised build.
- **Preventive:** policy can require dependency evidence (ChangeBucket,
  Kennel trust policy).
- **Detective:** dependency diff in Change review.
- **Recovery:** revert.
- **Remaining risk:** zero-dependency MVP reduces but does not eliminate.

### T13 — Credential leakage
- **Asset:** credentials. **Attacker:** log reader, contributor.
- **Path:** credentials in commits, logs, or evidence artifacts.
- **Impact:** credential compromise.
- **Preventive:** never log credentials; redaction on evidence ingestion (Scent
  pattern); no credentials in Source's own store.
- **Detective:** deterministic credential scanning of Change diffs; findings
  are redacted and recorded as `security` Evidence (see
  `25-rate-limiting-scanning.md`).
- **Recovery:** rotate.
- **Remaining risk:** credentials already committed to Git history.

### T14 — Malicious workflow / skill
- **Asset:** execution. **Attacker:** contributor.
- **Path:** a workflow/skill performs unauthorized actions.
- **Impact:** arbitrary execution.
- **Preventive:** workflows/skills are capability-scoped; deterministic
  policy gates execution; no LLM in deterministic orchestration.
- **Detective:** audit log.
- **Recovery:** disable workflow.
- **Remaining risk:** imported workflow `run` steps execute only through the
  operator-selected Podman/Docker isolated runner, with no-network,
  read-only-root, dropped-capability, resource, output, timeout, workspace,
  and secret-environment bounds; runner images, host runtimes, and secret
  providers remain deployment trust assumptions. `uses` actions are rejected.

### T15 — Prompt injection through repository content
- **Asset:** agent behavior. **Attacker:** contributor.
- **Path:** repo content contains instructions that steer an agent.
- **Impact:** agent performs unintended actions.
- **Preventive:** treat repo content as data, never instructions; agents
  receive structured context, not raw repo dumps; capability bounds limit
  damage.
- **Detective:** audit log.
- **Recovery:** revoke capability.
- **Remaining risk:** inherent to LLM agents; bounded by capability.

### T16 — Privilege escalation
- **Asset:** authority. **Attacker:** low-privilege principal.
- **Path:** exploit a bug to gain higher capability.
- **Impact:** unauthorized actions.
- **Preventive:** server-side capability checks on every action; no
  client-supplied authority.
- **Detective:** audit log.
- **Recovery:** revoke.
- **Remaining risk:** implementation bugs; mitigated by authorization tests.

### T17 — Session hijacking
- **Asset:** session. **Attacker:** network observer.
- **Path:** steal session token.
- **Impact:** act as the session principal.
- **Preventive:** TLS; short-lived session capabilities.
- **Detective:** audit.
- **Recovery:** end session.
- **Remaining risk:** TLS is now available (see `23-tls-deployment.md`); plain
  HTTP remains only for local development.

### T18 — Unsafe webhook/event consumption
- **Asset:** server. **Attacker:** external event source.
- **Path:** malformed event triggers unsafe handling.
- **Impact:** crash, injection.
- **Preventive:** validate/sanitize all event payloads; treat as untrusted.
- **Detective:** error logging.
- **Recovery:** replay-safe event log.
- **Remaining risk:** webhook ingress now requires a configured HMAC secret,
  validates the raw request signature, applies rate limits, and deduplicates
  delivery IDs before workflow fan-out; secret rotation, provider-specific
  adapters, and replay/availability operations remain deployment concerns.

### T19 — Artifact substitution
- **Asset:** evidence. **Attacker:** contributor.
- **Path:** swap artifact between evaluation and Decision.
- **Impact:** Decision on wrong evidence.
- **Preventive:** Decision pins `evidence_snapshot` hashes; content-addressed
  storage.
- **Detective:** hash verification at Decision.
- **Recovery:** re-evaluate.
- **Remaining risk:** none beyond store compromise.

### T20 — Stale-source execution
- **Asset:** correctness. **Attacker:** (accidental) agent.
- **Path:** evidence produced against an old revision.
- **Impact:** false confidence.
- **Preventive:** evidence records source revision; policy can require
  evidence against the Change's base/head.
- **Detective:** revision mismatch visible.
- **Recovery:** re-run.
- **Remaining risk:** none.

### T21 — TOCTOU between verification and Decision
- **Asset:** canonical state. **Attacker:** concurrent actor.
- **Path:** state moves between evaluation and merge.
- **Impact:** merge on stale base.
- **Preventive:** pin base/head hashes; fast-forward check at update; refuse
  non-fast-forward (per repository).
- **Detective:** update refusal logged.
- **Recovery:** re-evaluate.
- **Remaining risk:** none (deterministic check).

### T22 — Custom-domain abuse
- **Asset:** tenant trust. **Attacker:** another tenant.
- **Path:** claim another tenant's domain.
- **Impact:** phishing, cross-tenant confusion.
- **Preventive:** domain ownership verification (deferred to hosted product).
- **Detective:** domain audit.
- **Recovery:** revoke domain.
- **Remaining risk:** MVP single-domain; documented.

### T23 — Denial of service
- **Asset:** availability. **Attacker:** anyone.
- **Path:** resource exhaustion (huge repos, many requests).
- **Impact:** outage.
- **Preventive:** size limits, rate limits (submit + git push), timeouts.
- **Detective:** observability.
- **Recovery:** restart; scale.
- **Remaining risk:** the JSON development backend is per-process; production
  deployments must use Postgres for shared rate-limit state. Distributed
  edge-level throttling and reputation controls remain deployment concerns.

### T24 — Destructive Git operations
- **Asset:** source. **Attacker:** principal with write.
- **Path:** force-push, delete refs, `gc --prune`.
- **Impact:** history loss.
- **Preventive:** ref protection; no destructive ops exposed; capability
  deny-list.
- **Detective:** audit.
- **Recovery:** reflog; backup.
- **Remaining risk:** none in MVP (no destructive ops exposed).

## Cross-references

- `08-identity-capability-model.md` — capability controls.
- `10-git-integration.md` — Git endpoint controls.
- `15-acceptance-tests.md` — security tests.
- `23-tls-deployment.md` — TLS termination and deployment.
- `25-rate-limiting-scanning.md` — rate limiting and credential scanning.
