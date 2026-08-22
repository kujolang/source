# 03 — System Architecture

Status: **Evidence-backed architecture decisions + implementation hypotheses.**
See `decisions/` for the full decision records.

## Topology

A **modular monolith**. No microservices in the MVP. One process serves the
HTTP API, the Git smart-HTTP endpoint, and (in-process) policy evaluation and
event handling. This is the lowest-complexity shape that still preserves the
boundaries required for later scaling.

```
                        ┌─────────────────────────────────────────────┐
  browser (human)  ───► │  Web UI (static HTML/JS)                    │
  CLI (human/agent)───► │  CLI (same interfaces as API)               │
  agent (machine)  ───► │  HTTP API  ──►  Domain services             │
  git client       ───► │  Git smart-HTTP / bare repos                │
                        │      │                                      │
                        │      ├─ Work / Session / Change / Evidence   │
                        │      ├─ Decision / Policy / Capability      │
                        │      ├─ Store (JSON files, atomic writes)   │
                        │      ├─ Artifact store (content-addressed)  │
                        │      └─ Audit log (append-only)             │
                        └─────────────────────────────────────────────┘
```

## Domain boundaries

| Boundary | Responsibility | Owns |
|---|---|---|
| `domain` | Core object model + lifecycle state machines | Project, Work, Session, Change, Evidence, Decision, Principal, Capability |
| `git` | Git server integration | bare repos, clone/fetch/push, refs, hooks |
| `policy` | Deterministic policy evaluation | required assertions, approval rules, capability rules |
| `identity` | Principals + capability issuance/verification | principal records, capability tokens |
| `api` | Machine interface + discovery | `/.well-known/source`, JSON endpoints |
| `cli` | Human/agent command surface | `source ...` commands |
| `web` | Human UI | project/work/change/evidence views |
| `storage` | Persistence | JSON store, artifact store, audit log |
| `events` | In-process event dispatch | lifecycle events → policy/workflow |

## Technology selection

| Concern | Choice | Classification | Rationale |
|---|---|---|---|
| Language | **Node.js (JavaScript, ESM)** | Evidence-backed | Runnable and testable in this environment (`npm`/`node` v23 available); mature `child_process` Git integration; portable and self-hostable. Production Postgres uses a pooled native `pg` client; JSON/SQLite remain dependency-light local options. Alternatives: Kujo (ecosystem language, but runtime not executable in the build environment and Source is a standalone product, not a Kujo feature); Go/Rust (not runnable here). |
| Database | **SQLite or Postgres for production; JSON for local single-process use** | Evidence-backed boundary | SQLite WAL and Postgres provide durable transactions and atomic ID allocation. JSON remains inspectable but is explicitly not a multi-process production backend. |
| Git server | **`git` CLI via `child_process`, bare repos** | Evidence-backed | Git remains authoritative; no packfile/network reimplementation. Smart-HTTP and `file://`/local transport for MVP. |
| Artifact storage | **Filesystem, content-addressed by SHA-256** | Evidence-backed | Immutable artifacts keyed by hash; provenance links to source revision. |
| API | **HTTP + JSON (REST-shaped), discovery endpoint** | Evidence-backed | Compact, cacheable, content-negotiable; `/.well-known/source` for agent discovery. |
| Frontend | **Static HTML + vanilla JS** | Implementation hypothesis | MVP needs enough UI to understand a Change; no framework. |
| Events | **Bounded in-process request work; external queue is the production scale-out seam** | Implementation hypothesis | Git subprocesses and request bodies are bounded in-process. Durable workflows and fan-out still require a queue/worker deployment for thousands of agents. |
| Identity | **Principal records + opaque capability tokens (HMAC-signed)** | Evidence-backed | No custom cryptography; Node `crypto` HMAC-SHA256 for capability tokens. |
| Crypto | **Node built-in `crypto`** | Evidence-backed | SHA-256 hashing, HMAC signing, `randomBytes` for tokens. No custom primitives. |

## Explicitly deferred (not over-engineered in MVP)

- Durable message queue / async job execution (bounded in-process now; required for large deployments).
- Multi-region replication and object storage for Git/artifacts.
- Distributed replication / geographic scaling.
- Full SaaS control plane / billing.
- Plugin marketplace.

## Why a modular monolith

The bounded monolith is suitable for a single deployment unit, but thousands of
agents require SQLite/Postgres, a queue-backed worker plane, shared artifact
storage, and horizontally sharded Git hosting. Git CGI responses are streamed
with backpressure and bounded output, reducing per-request memory pressure in
the monolith. The storage, events, and Git boundaries above are the explicit
split seams.

## Cross-references

- `04-domain-object-model.md` — the objects behind `domain`.
- `10-git-integration.md` — Git responsibilities vs Source responsibilities.
- `11-storage-model.md` — persistence and immutability.
- `12-threat-model.md` — security boundaries.
- `decisions/0001-language-nodejs.md` — language decision record.
