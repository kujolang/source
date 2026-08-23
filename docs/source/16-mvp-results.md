# 16 — MVP Results

Status: **Complete.** The vertical slice is implemented, tested (119 tests;
118 pass plus one opt-in Postgres test when no DSN is supplied),
and dogfooded against a real Kujo repository.

## What Was Built

A working, zero-dependency Node.js (ESM) implementation of the full Source
lifecycle:

| Layer | Files | What it does |
|---|---|---|
| Domain | `src/domain.js` | Object model + lifecycle state machines (pure, no I/O) |
| Service | `src/source.js` | Application service wiring store/git/policy/capability |
| Storage | `src/store.js`, `src/sqlite-store.js` | JSON-file store (default) + SQLite store (ACID transactions), content-addressed artifacts, append-only audit |
| Git | `src/git.js` | Bare repos, clone/fetch/push, fast-forward TOCTOU guard |
| Git HTTP | `src/git-http.js` | Smart-HTTP transport via `git http-backend` |
| Policy | `src/policy.js` | Deterministic required-evidence evaluation |
| Capability | `src/capability.js` | Bounded, expiring, revocable grants |
| Auth | `src/auth.js` | Capability-gated API (bearer) + Git (basic) authorization |
| Rate limit | `src/ratelimit.js` | Fixed-window rate limiter for anonymous paths |
| Scan | `src/scan.js` | Deterministic credential scanning (redacted findings) |
| API | `src/api.js` | HTTP API + `/.well-known/source` discovery + field selection + TLS |
| Web | `src/web.js` | Minimal human-facing HTML (org/project/work/change) |
| CLI | `src/cli.js`, `bin/source.js` | Same services as the API |
| Submit | `src/submit.js` | `source submit` contribution client |

## Architecture: proposed vs implemented

The implemented architecture matches the proposed architecture
(`03-system-architecture.md`) with no material drift:

- **Modular monolith** — as proposed; no microservices.
- **Node.js (ESM), zero deps** — as decided in `decisions/0001`.
- **JSON-file store** — as decided in `decisions/0002` (implementation
  hypothesis, swappable). A SQLite backend now exists behind the same boundary
  (see `20-sqlite-store.md`).
- **Opaque capability credentials + server-side grants** — as decided in
  `decisions/0003`.
- **Git CLI + bare repos** — as proposed; Git remains authoritative.

One deviation discovered during implementation: the store was made
**synchronous** (rather than async) because the ID counter and capability
issuance are synchronous and the Git operations are already synchronous
(`execFileSync`). This is a simplification, not an architectural change.

## Dogfood Result

**Project used:** `spec` (the Kujo task-contract tool) — a real, active Kujo
repository. Chosen because it is representative, contained, and produces
meaningful evidence (its own Spec/Eval artifacts).

**What happened:**

1. Hosted the real `spec` Git history in a Source bare repository
   (`git push --mirror`).
2. Created a real Work item ("add a dogfood marker file").
3. An agent claimed the Work and started a Session with a bounded capability
   (`allowed: read_source, read_context, submit_change, submit_evidence`;
   `denied: accept_change, modify_policy, publish_release`).
4. The agent made a real change in a working clone and pushed a branch.
5. Submitted a Change against the exact base commit.
6. Generated real evidence: a deterministic check that the change is a single
   additive file (mirrors what Eval/ChangeBucket would assert), stored as a
   content-addressed artifact.
7. Evaluated policy (evidence satisfied).
8. A human maintainer recorded an `accepted` Decision.
9. Updated canonical Git state (fast-forward of `main`).
10. Verified the complete audit chain (`work.create → session.start →
    change.submit → evidence.add → decision.make → canonical.update`) and that
    the evidence artifact is preserved, not reduced to PASS/FAIL.

The dogfood test is `tests/dogfood.test.js` and runs against `../spec` by
default (overridable via `KUJO_REPO`).

## Working Lifecycle (demonstrated)

```text
Project (P1) → Work (W1) → Session (S1) → Change (C1)
→ Evidence (E1, E2) → Decision (D1) → Canonical Git State (main = head)
```

All transitions are enforced by state machines; invalid transitions throw.
The full chain is reconstructable from the audit log and the object graph.

## Existing Kujo Integrations

Per `02-kujo-capability-audit.md`, the dominant relationship is **INTEGRATE**
(Source ingests Kujo tool artifacts as Evidence) and **REFERENCE** (concepts
inform Source's native model). In the MVP:

- **Evidence ingestion** is implemented as a generic, content-addressed
  artifact store with provenance — the seam where Eval/Spec/ShipCheck/etc.
  JSON artifacts plug in. The dogfood test demonstrates this with a
  deterministic check standing in for Eval.
- **No Kujo code is linked.** Source is decoupled from Kujo's implementation;
  it consumes versioned JSON artifacts.

Actual Eval/Spec/ShipCheck binary invocation is implemented in
`src/integrations/kujo.js` (see `17-kujo-evidence-integration.md`).

## Security

Controls implemented:

- Bounded, expiring, revocable capabilities (server-enforced).
- Capability-gated API auth: every `/api/v1/` endpoint requires a credential;
  scope (org/project/work) is enforced server-side (see `19-capability-auth.md`).
- Git-transport auth: public repos allow anonymous read; private repos require
  `read_source`; push always requires `git_push` (Basic auth, server-enforced;
  see `22-git-transport-auth.md`).
- TLS: in-process HTTPS termination (`--tls-key`/`--tls-cert`) or reverse-proxy
  termination (see `23-tls-deployment.md`).
- Rate limiting: the anonymous `submit` path and Git push are throttled by
  client address (see `25-rate-limiting-scanning.md`).
- Credential scanning: submitted Changes are scanned for credentials; findings
  are redacted and recorded as `security` Evidence (see
  `25-rate-limiting-scanning.md`).
- Deny-list (`accept_change`, `modify_policy`, `publish_release`).
- Approval authority: only a `human` principal may accept (policy-enforced).
- Evidence integrity: content-addressed artifacts, SHA-256 hashes.
- TOCTOU guard: fast-forward update refused on non-fast-forward (per repository).
- Tenant isolation: org-scoped paths + org-scoped capability checks, enforced
  server-side (see `21-multi-tenant-orgs.md`).
- Append-only audit log of every authorization/decision/state event.
- HTML escaping of all repo content in web views (untrusted data).
- Smart-HTTP: server-side repo resolution, path-traversal rejection (tested).

Remaining risks (documented in `12-threat-model.md`): trust in the verification
service is a documented assumption; the rate limiter is per-process (in-memory).

## Token Efficiency

Measured in `tests/api.test.js`:

- Discovery manifest (`/.well-known/source`) is a compact JSON object.
- Field selection (`?fields=id,status,intent`) measurably reduces response
  size (asserted in the test).
- Scoped context endpoint returns only intent/requirements/acceptance/policy,
  not the repository.
- Evidence `result` is a compact summary; the full artifact is fetched only
  on demand via `/artifact`.

## Known Limitations (no euphemisms)

1. ~~**Single Organization per Instance**~~ — resolved: the org is now a
   first-class, server-enforced tenant boundary (see `21-multi-tenant-orgs.md`).
2. ~~**Single-repository Changes**~~ — resolved: a Change can now span multiple
   repositories (see `24-multi-repo-changes.md`).
3. ~~**Smart-HTTP has no TLS**~~ — resolved: TLS termination is now available
   in-process or via reverse proxy (see `23-tls-deployment.md`).
4. **JSON-file store** — no transactions across records; fine at MVP scale.
   (A SQLite backend with ACID transactions is now available; see
   `20-sqlite-store.md`.)
5. **No real Kujo tool invocation** — evidence is generated by a deterministic
   stand-in; actual Eval/Spec/ShipCheck integration is next.
6. ~~**No rate limiting or credential scanning**~~ — resolved: the anonymous
   submit path and Git push are rate-limited, and Changes are scanned for
   credentials (see `25-rate-limiting-scanning.md`).
7. **No LLM integration** — the slice is fully deterministic (by design); the
   LLM boundary for semantic judgment is documented but not wired.
8. **Synchronous store** — blocks the event loop; acceptable for MVP.

## Architecture Changes (learned during implementation)

1. **Synchronous store** (vs. async) — for consistency with synchronous Git
   and ID generation.
2. **`makeDecision` must pass Work through `in_review`** before a terminal
   state — the state machine caught this; the guard was added.
3. **`GitRepo.init` must be synchronous** — an async init raced with the first
   push; fixed by making it synchronous.
4. **Smart-HTTP tests must use async `execFile`** — `execFileSync` blocks the
   event loop, so an in-process server cannot answer the git client's requests.
5. **Org and project ids must use independent counters** — `createOrg` reused
   the project counter, so the first project was `P2`; fixed with a dedicated
   `org` prefix (see `21-multi-tenant-orgs.md`).
6. **Git transport uses Basic auth, not bearer** — git clients do not send
   bearer tokens; the capability credential is carried as the Basic-auth
   password (see `22-git-transport-auth.md`).
7. **Multi-repo Changes keep a legacy single-repo view** — `repositoryChanges`
   is canonical, but `baseCommit`/`headCommit`/`repositories` remain as the
   primary-repository convenience view so existing single-repo callers are
   unchanged (see `24-multi-repo-changes.md`).

## Product Questions (require human decision)

1. **Licensing** — intentionally undecided; which parts are open vs commercial?
2. **Capability credential format** — opaque bearer now; migrate to JWT with a
   managed signing key for cross-instance portability?
3. **Evidence trust model** — how much do we trust a verification service vs.
   require human review? (Currently: human Decision is always the gate.)
4. **Smart-HTTP vs. SSH** — which Git transport to prioritize for hosted?
5. **Which Kujo project to dogfood first in production** — `spec` was used here;
   is that the right first `source.kujolang.ai` project?

## Recommended Next Phase (ranked by product value)

1. ~~**Real Kujo evidence integration**~~ — done (`17-kujo-evidence-integration.md`).
2. ~~**Smart-HTTP Git transport**~~ — done (`10-git-integration.md`).
3. ~~**`source submit` contribution flow**~~ — done (`18-source-submit.md`).
4. ~~**Capability-gated API auth**~~ — done (`19-capability-auth.md`).
5. ~~**SQLite/Postgres store**~~ — done (`20-sqlite-store.md`).
6. ~~**Multi-tenant org management**~~ — done (`21-multi-tenant-orgs.md`).

---

## Update (next phase)

All six items of the original "Recommended Next Phase" are now complete:

- **Real Kujo evidence integration** — see `17-kujo-evidence-integration.md`.
- **Smart-HTTP Git transport** — see `10-git-integration.md`; `git clone`,
  `git fetch`, and `git push` work over HTTP via `git http-backend`.
- **`source submit` contribution flow** — see `18-source-submit.md`; a
  Git-only developer can clone, modify, and `source submit`, and Source creates
  the correct Work → Session → Change → Evidence lifecycle.
- **Capability-gated API auth** — see `19-capability-auth.md`; every `/api/v1/`
  endpoint requires a scoped, expiring, revocable capability credential, and
  session start returns a work-scoped "temporary session identity" capability.
- **SQLite store** — see `20-sqlite-store.md`; the JSON store is swappable for
  a zero-dependency SQLite backend (`node:sqlite`) with ACID transactions
  across records, selected via `--store sqlite`.
- **Multi-tenant org management** — see `21-multi-tenant-orgs.md`; the org is
  now explicit in every route (`/api/v1/orgs/{org}/…`, `/git/{org}/{project}/…`),
  org-scoped capabilities are enforced server-side, and org list/get/create is
  exposed via API, CLI, and web.

The default test suite is now **157/157 non-skipped tests passing**, with the live Postgres gate
available through `SOURCE_TEST_DATABASE_URL=... npm run test:postgres`.

## Next phase (fresh prioritization)

With the original six increments complete, the next phase should be ranked by
product value, not coding convenience:

1. ~~**Git-transport auth**~~ — done (`22-git-transport-auth.md`).
2. ~~**TLS + deployment**~~ — done (`23-tls-deployment.md`).
3. ~~**Multi-repository Changes**~~ — done (`24-multi-repo-changes.md`).
4. ~~**Rate limiting + credential scanning**~~ — done
   (`25-rate-limiting-scanning.md`).
5. **Normalized relational schema (Postgres)** — the `storage` boundary is the
   seam; a queryable relationship model replaces the path-keyed records table.
6. **Human authentication** — the HTML views are public; add a real human
   identity path (not username/password as the fundamental model).
