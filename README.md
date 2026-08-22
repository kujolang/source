# Source

> **Git stores the source. Source understands the work required to change it,
> the actors that performed it, the evidence that proves it, and the decisions
> that made it canonical.**

Source is an **agent-first software-development and collaboration platform built
around Git**. Work is fundamental, Evidence is first-class, autonomous
participants receive bounded capabilities, and the complete truth of how
software changes remains inspectable.

This repository contains the **MVP vertical slice**: a working implementation of
the full `Project → Work → Session → Change → Evidence → Decision → Canonical
Git State` lifecycle, validated against a real Kujo repository, plus the
next-phase increments (real Kujo evidence integration, smart-HTTP Git transport,
the `source submit` contribution flow, capability-gated API auth, a SQLite store
backend, multi-tenant org management, capability-gated Git-transport auth,
TLS + deployment, multi-repository Changes, and rate limiting + credential
scanning).

## Status

- **113/113 tests pass**, including a dogfood test against the real `spec` Kujo
  repository, Kujo evidence-integration tests against real Eval/Spec/ShipCheck
  artifacts, smart-HTTP clone/fetch/push tests (authenticated and anonymous),
  `source submit` contribution-flow tests, capability-gated API auth tests,
  Git-transport auth tests (401/403), SQLite store transaction/contract tests,
  multi-tenant org-management/tenant-isolation tests, TLS/deployment tests
  (HTTPS + `git clone` over HTTPS), multi-repository Change tests, rate-limiting
  tests, and credential-scanning tests.
- Runtime dependency: `pg` for pooled Postgres production storage. Node.js ≥ 18
  and `git` on PATH are also required. The SQLite backend requires Node ≥ 22.5
  (`node:sqlite`); the JSON store works on Node ≥ 18.
- Deterministic-first: no LLM is required for any operation in the slice.

## Quick start

```bash
# Run the test suite (includes the dogfood test against ../spec)
npm test

# Run the live Postgres scale gate when a test database is available
SOURCE_TEST_DATABASE_URL='postgresql://source:password@db/source' npm run test:postgres

# Exercise the CLI
node bin/source.js help
node bin/source.js init --name source.kujolang.ai
node bin/source.js org create --name kujolang --slug kujolang
node bin/source.js org list
node bin/source.js org show O1
node bin/source.js project create --org O1 --name spec --slug spec
node bin/source.js principal create --type human --name maintainer --password '<12+ character password>'
node bin/source.js work create --org O1 --project P1 --intent "fix parser regression"
node bin/source.js work claim --org O1 --project P1 W1 --principal U1

# Issue a bounded capability for an agent (operator/CLI, out-of-band)
node bin/source.js cap issue --principal U2 --org O1 --project P1 \
  --allowed read_source,read_context,submit_change,submit_evidence \
  --denied accept_change,modify_policy,publish_release

# Issue a Git-transport capability (read + push) for a contributor
node bin/source.js git-cap --org O1 --project P1 --principal U1

# Serve the HTTP API + minimal web UI + smart-HTTP Git transport
node bin/source.js serve --port 8787
#   GET /.well-known/source                          (agent discovery)
#   GET /                                            (human org index)
#   GET /api/v1/orgs/O1/projects/P1/work              (machine interface, requires capability)
#   git clone http://localhost:8787/git/O1/P1/R1.git (smart-HTTP)

# Serve over HTTPS (in-process TLS termination)
node bin/source.js serve --host 0.0.0.0 --port 443 \
  --tls-key /path/to/privkey.pem --tls-cert /path/to/fullchain.pem

# Production storage: use a pooled Postgres backend for multi-process serving
SOURCE_DATABASE_URL='postgres://source:password@db/source' \
  node bin/source.js --store postgres serve --host 0.0.0.0 --port 8787

# Liveness/readiness probes
curl http://localhost:8787/healthz
curl http://localhost:8787/readyz

# Contribute as a Git-only developer (no Source concepts required)
#   public repos clone anonymously; private repos and all pushes need a credential
git clone http://source:<credential>@localhost:8787/git/O1/P1/R1.git
# ... make changes ...
node bin/source.js submit --url http://localhost:8787 --credential <credential>
```

The server applies bounded resource controls by default: JSON requests are
limited to 1 MiB, Git request bodies to 100 MiB, Git CGI subprocesses to 32
active requests with a 256-request queue, Git CGI responses to 512 MiB, and
connections to 10,000. Git responses are streamed with HTTP backpressure so
large clones and fetches do not require a full packfile-sized buffer per
request. Override these through `startServer`/`createServer` options for a
deployment sized to its CPU, memory, and Git workload. For multi-process
deployments use SQLite or Postgres for durable coordination; the JSON backend
is single-process only.

`/healthz` reports process liveness. `/readyz` verifies that the Source
instance is initialized and the selected store can be read; remove an instance
from service when readiness returns `503`.

For a real deployment burst test, use the dependency-free load harness:

```bash
npm run load -- --url https://source.example/.well-known/source \
  --requests 10000 --concurrency 1000
```

It reports success rate, event-loop progress, and p50/p95/p99/max latency.
Run it against the Postgres-backed deployment from a separate host; local
tests do not prove database, network, or multi-node capacity.

The machine interface (`/api/v1/…`) is capability-gated: send
`Authorization: Bearer <credential>` on every request. The Git transport
(`/git/…`) is capability-gated via HTTP Basic auth: public repos allow anonymous
read, private repos require `read_source`, and push always requires `git_push`.
The Organization is the tenant boundary and is explicit in every route
(`/api/v1/orgs/{org}/…`, `/git/{org}/{project}/…`). See
`docs/source/19-capability-auth.md`, `docs/source/21-multi-tenant-orgs.md`, and
`docs/source/22-git-transport-auth.md`.

### Storage backend

The default store is JSON files on disk for local development only. Select the
SQLite backend (ACID transactions across records) with `--store sqlite` or
`SOURCE_STORE=sqlite`:

```bash
node bin/source.js --store sqlite init --name source.kujolang.ai
```

See `docs/source/20-sqlite-store.md`.

For production multi-process deployments, select the pooled Postgres backend:

```bash
SOURCE_DATABASE_URL='postgres://source:password@db/source' \
  node bin/source.js --store postgres serve --host 0.0.0.0 --port 8787
```

Postgres is the recommended backend for large agent fleets; configure pool
options through the store integration and place Git repositories on shared,
durable storage.

### Deployment

`source serve` is plain HTTP by default. For a real deployment, terminate TLS
either in-process (`--tls-key`/`--tls-cert`) or at a reverse proxy (nginx,
Caddy, HAProxy). See `docs/source/23-tls-deployment.md` for the full self-host
path, certificate management, custom domains, and data-durability/backup
requirements.

## Architecture

A **modular monolith** in Node.js (ESM), with a small native Postgres client
dependency for pooled production storage:

```text
src/
  domain.js      — object model + lifecycle state machines (pure)
  source.js      — application service (wires store/git/policy/capability)
  store.js       — JSON-file store, content-addressed artifacts, audit log
  sqlite-store.js— SQLite store (node:sqlite), ACID transactions
  git.js         — bare-repo storage, clone/fetch/push, fast-forward guard
  git-http.js    — smart-HTTP transport via `git http-backend`
  policy.js      — deterministic required-evidence evaluation
  capability.js  — bounded, expiring capability grants
  auth.js        — capability-gated API (bearer) + Git (basic) authorization
  ratelimit.js   — fixed-window rate limiter for anonymous paths
  scan.js        — deterministic credential scanning (redacted findings)
  api.js         — HTTP API + /.well-known/source discovery + /git/ transport + TLS
  web.js         — minimal human-facing HTML views (org/project/work/change)
  cli.js         — CLI (same services as the API)
  submit.js      — `source submit` contribution client
  integrations/
    kujo.js      — Eval/Spec/ShipCheck artifact normalizers + KujoRunner
bin/source.js    — CLI entry
```

## Documentation

The full architecture, domain model, threat model, and MVP scope are in
`docs/source/`:

- `01-product-interpretation.md` — frozen principles
- `02-kujo-capability-audit.md` — reuse vs own (evidence-backed)
- `03-system-architecture.md` — boundaries + technology selection
- `04-domain-object-model.md` — the formal model
- `05-work-lifecycle.md` / `06-change-model.md` / `07-evidence-model.md`
- `08-identity-capability-model.md` / `09-agent-protocol.md`
- `10-git-integration.md` / `11-storage-model.md` / `12-threat-model.md`
- `13-mvp-scope.md` / `14-implementation-plan.md` / `15-acceptance-tests.md`
- `16-mvp-results.md` — what was built and dogfooded
- `17-kujo-evidence-integration.md` — real Eval/Spec/ShipCheck evidence ingestion
- `18-source-submit.md` — the `source submit` contribution flow
- `19-capability-auth.md` — capability-gated API auth
- `20-sqlite-store.md` — the SQLite store backend and transactions
- `21-multi-tenant-orgs.md` — the org-scoped tenant boundary
- `22-git-transport-auth.md` — capability-gated Git transport (Basic auth)
- `23-tls-deployment.md` — TLS termination + self-host deployment path
- `24-multi-repo-changes.md` — multi-repository Changes
- `25-rate-limiting-scanning.md` — rate limiting + credential scanning
- `decisions/` — architecture decision records

## License

Licensing is intentionally undecided (see `01-product-interpretation.md`).
