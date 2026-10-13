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

Source is an experimental, self-hosted implementation with working Git transport,
capability-scoped API access, evidence/policy checks, review decisions, a human UI,
and JSON, SQLite and Postgres storage. It is not a hosted production service.

- Run the [three-client local rehearsal](docs/contest/RUNBOOK.md) to reproduce
  concurrent proposals, denied agent approvals, stale-base rejection, actual Git
  conflict recovery and final evidence-backed promotion. Clients and approvals
  are scripted; no LLM or Cloudflare account is needed for this local profile.
- Use Node.js 22 and Git for the contest runbook. SQLite uses `node:sqlite`;
  production deployments use Postgres and durable Git storage.
- See the dated [validation record](docs/contest/VALIDATION.md) for exact results
  and skips. Local checks are distinct from GitHub Actions, container failover
  and production capacity validation.
- Workers/Artifacts bootstrap code exists, but live deployment is blocked by the
  account's paid-plan requirement. The hybrid integration is unfinished.
- The [contest checklist](docs/contest/README.md) and [current roadmap](docs/contest/ROADMAP.md)
  distinguish completed local work from remaining submission gates.

## Quick start

```bash
# Install pinned dependencies and run tests (optional sibling fixtures may skip)
npm ci
npm test

# Repeatable three-client local contest rehearsal
npm run demo:contest

# Run the live Postgres scale gate when a test database is available
SOURCE_TEST_DATABASE_URL='postgresql://source:password@db/source' npm run test:postgres

# Exercise the CLI
node bin/source.js help
node bin/source.js init --name source.kujolang.ai
node bin/source.js org create --name kujolang --slug kujolang
node bin/source.js org list
node bin/source.js org show O1
node bin/source.js project create --org O1 --name spec --slug spec
node bin/source.js repo create --org O1 --project P1 --name main
node bin/source.js principal create --type human --name maintainer --password '<12+ character password>'
node bin/source.js org member add --org O1 --principal U1 --role admin
node bin/source.js work create --org O1 --project P1 --intent "fix parser regression"
node bin/source.js work claim --org O1 --project P1 W1 --principal U1

# Or bootstrap a complete local management tenant in one command.
# The command prints the exact IDs to use on the login page and never creates
# a shared/default password.
node bin/source.js demo --password '<12+ character local password>'

# Issue a bounded capability for an agent (operator/CLI, out-of-band)
node bin/source.js cap issue --principal U2 --org O1 --project P1 \
  --allowed read_source,read_context,submit_change,submit_evidence \
  --denied accept_change,modify_policy,publish_release

# Issue a Git-transport capability (read + push) for a contributor
node bin/source.js git-cap --org O1 --project P1 --principal U1

# Serve the HTTP API + local management UI + smart-HTTP Git transport
node bin/source.js serve --port 8787
#   GET /.well-known/source                          (agent discovery)
#   GET /                                            (human dashboard)
#   GET /o/O1/p/P1                                   (project, repositories, work, changes, actions)
#   GET /o/O1/p/P1/r/R1/tree/main                    (repository browser)
#   GET /o/O1/p/P1/actions                           (workflow/action management and run queue)
#   GET /o/O1/p/P1/settings                          (collaborators and deployment settings)
#   GET /api/v1/orgs/O1/projects/P1/work              (machine interface, requires capability)
#   git clone http://localhost:8787/git/O1/P1/R1.git (smart-HTTP)

# Open http://localhost:8787, sign in with the IDs printed by `source demo`, and select
# “Enable project management controls” to use role-gated create/review/dispatch
# forms. Production workflow execution still requires a Postgres-backed worker.

# Serve over HTTPS (in-process TLS termination)
node bin/source.js serve --host 0.0.0.0 --port 443 \
  --tls-key /path/to/privkey.pem --tls-cert /path/to/fullchain.pem

# JSON and SQLite stores are single-node backends. Exposed serve bindings
# require Postgres and writer fencing; --allow-unsafe-local-store is for local testing.

# Production storage: use a pooled Postgres backend for multi-process serving
SOURCE_DATABASE_URL='postgres://source:password@db/source' \
  node bin/source.js --store postgres serve --host 0.0.0.0 --port 8787 \
  --writer-lease --writer-owner "$SOURCE_INSTANCE_ID"

# Liveness/readiness probes
curl http://localhost:8787/healthz
curl http://localhost:8787/readyz

# Contribute as a Git-only developer (no Source concepts required)
#   public repos clone anonymously; private repos and all pushes need a credential
git clone http://source:<credential>@localhost:8787/git/O1/P1/R1.git
# ... make changes ...
node bin/source.js submit --url http://localhost:8787 --credential <credential>
```

Repository-level acceptance criteria live in [.spec.yml](.spec.yml). The
portable checks are available through `npm run lint`, `npm run format:check`,
and `npm test`; the GitHub Actions workflow mirrors those deterministic checks
while Source's own Kujo release gate remains the authoritative ecosystem gate.
The SiteKit integration and vendor-update procedure are documented in
[`docs/SITEKIT.md`](docs/SITEKIT.md).

The server applies bounded resource controls by default: JSON requests are
limited to 1 MiB, Git request bodies to 100 MiB, chunked Git uploads to 16 MiB
and four concurrent buffered uploads, Git CGI subprocesses to 32
active requests with a 256-request queue and a default per-project budget of
eight active requests with 256 queued, Git CGI responses to 512 MiB, and
connections to 10,000. Durable job payloads default to 64 KiB, per-project
active queue depth (queued plus leased jobs) defaults to 100,000 records, and
completed/failed jobs are pruned after seven days. Evidence artifacts are
bounded to 64 MiB by default (`Source`'s `maxArtifactBytes` option, capped at
512 MiB), preventing verification output from becoming an unbounded memory or
database write. Artifact downloads use a separate bounded budget of eight
active requests and 64 queued by default, so concurrent evidence retrieval
cannot turn bounded artifact sizes into unbounded process memory pressure.
Git CGI subprocesses have a 120-second timeout. Git
responses are streamed with HTTP backpressure so
large clones, fetches, and known-length pushes do not require a full
packfile-sized buffer per request. Override these through
`startServer`/`createServer` options for a
deployment sized to its CPU, memory, and Git workload. For multi-process
deployments use SQLite or Postgres for durable coordination; the JSON backend
is single-process only. Postgres uses a bounded pool (32 connections by
default), a bounded database admission queue (eight waiters per connection by
default), a 10-second connection timeout, a 30-second idle timeout, and a
30-second query timeout; tune these through the store's `connectionOptions` for
the deployment's database capacity. Requests are rejected with backpressure
when the admission queue is exhausted instead of accumulating unboundedly in
the driver. Transient database disconnects, failover shutdowns, serialization
conflicts, and deadlocks return retryable `503` responses with `Retry-After: 1`
so agents can use bounded exponential backoff rather than treating
infrastructure pressure as a permanent request error.

`/healthz` reports process liveness. `/metrics` exposes low-cardinality
Prometheus-compatible request, response, active-request, and abort counters,
plus Postgres pool/admission, global/per-project Git admission, canonical
promotion, and artifact download admission metrics for capacity planning.
`/readyz` verifies that the Source instance, metadata store, and Git root are
available and writable; remove an instance
from service when readiness returns `503`. On shutdown the CLI marks the
instance draining, rejects new work with `503`, allows active requests to
finish, and force-closes connections after 30 seconds.
When writer fencing is enabled, `/metrics` also exposes lease ownership,
contention, renewal, and loss counters so operators can distinguish a standby
from a failed writer.

When Source is behind a trusted reverse proxy, set `trustProxy: true` in
`startServer`/`createServer` (or pass `--trust-proxy` to `serve`) so rate
limits use the first `X-Forwarded-For` address. Leave it disabled for directly
exposed servers; forwarding headers are otherwise client-controlled and must
not influence identity or throttles.

For a real deployment burst test, use the dependency-free load harness:

```bash
npm run load -- --url https://source.example/.well-known/source \
  --requests 10000 --concurrency 1000
```

It reports success rate, event-loop progress, and p50/p95/p99/max latency.
Run it against the Postgres-backed deployment from a separate host; local
tests do not prove database, network, or multi-node capacity.

Agents with `enqueue_job` can submit up to 100 jobs in one request through
`POST /api/v1/orgs/{org}/projects/{project}/jobs/batch`. The Postgres path uses
one transactional quota check and bulk insert, with per-job payload bounds and
work-level authorization and deduplication keys, reducing database round trips
during workflow fan-out. Batch requests are rate-limited by item count, so
batching cannot bypass per-agent admission policy.
Clients should send an `Idempotency-Key` on retriable single or batch enqueue
requests; Source hashes that scoped key into the durable job dedupe key so
agent retries do not create duplicate work.

Postgres-backed workers can claim deferred jobs through `src/job-queue.js`.
Claims use row locking with `SKIP LOCKED` and a bounded per-project burst (8 by
default), so a noisy project cannot starve other eligible projects; a single
eligible project can still use the full batch. Tune it with
`--worker-project-burst`. Expired leases are reclaimable and failed jobs can be
retried with bounded attempts. This is the worker-plane seam
for batch workflows that should not run inside request handlers.
Workers back off and report transient queue/database failures instead of
terminating, while leases allow abandoned jobs to be recovered by another
worker. Idle polls and outage backoff include bounded jitter, preventing a
large worker fleet from synchronizing claim storms. Shutdown drains for 30 seconds by default; a hung handler then leaves
its lease to expire so another worker can recover the job. Handlers also have a
15-minute execution timeout by default and receive an `AbortSignal`; tune it
with `--worker-handler-timeout-ms`. The jitter range is configurable with
`--worker-jitter-ratio` (default `0.2`, capped at `1`).

Workers register handlers by job kind and can run as separate processes:

```js
import { SourceWorker } from './src/worker.js';

const worker = new SourceWorker({
  queue: src.jobs,
  workerId: process.env.WORKER_ID,
  concurrency: 32,
  handlers: { 'agent.batch': async (payload) => runBatch(payload) },
});
worker.start();
```

The built-in process entrypoint accepts a handler module exporting `handlers`:

```bash
SOURCE_DATABASE_URL='postgresql://source:password@db/source' \
  node bin/source.js --store postgres worker \
  --handler-module ./worker-handlers.js --worker-concurrency 32
```

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

Postgres is the recommended backend for large agent fleets; asynchronous
relational record fan-out is committed in one database transaction. Configure pool
options through the store integration and place Git repositories on shared,
durable storage. Set `SOURCE_GIT_ROOT` to the shared Git volume when metadata
and repository objects need separate mounts; all serving nodes must use the
same Git root.

### Deployment

`source serve` is plain HTTP by default. For a real deployment, terminate TLS
either in-process (`--tls-key`/`--tls-cert`) or at a reverse proxy (nginx,
Caddy, HAProxy). See `docs/source/23-tls-deployment.md` for the full self-host
path, certificate management, custom domains, and data-durability/backup
requirements.

The included `Dockerfile` builds a non-root Postgres serving image with
separate `/var/lib/source/data` and `/var/lib/source/git` mount points. Scale
serving nodes and worker processes independently behind the reverse proxy.

Backups are executable and verifiable: `npm run backup -- --output
/var/backups/source` archives the metadata/Git roots, verifies bare repositories,
and emits checksums; `npm run backup:verify -- --backup <directory>` validates
the result. Run `npm run backup:restore-drill -- --backup <directory>
--database-url <postgresql-url>` to restore into temporary filesystem roots and a
temporary Postgres database, verify Git objects, and remove the drill resources.
See the deployment document for backup replication and recovery procedures.

Git roots can be replicated to an independent peer with bounded, resumable
mirror jobs: `npm run replicate:git -- --source-root "$SOURCE_GIT_ROOT"
--target-root /srv/source-peer/git --concurrency 8`. Each repository is
replicated independently with Git's mirror refspec, pruning deleted refs and
running `git fsck`; rerunning after a peer outage is safe. Replication refuses
target-only or divergent refs by default so a peer write cannot be silently
destroyed; use `--allow-deletions` or `--force` only during an intentional
reconciliation operation.

Postgres metadata replication remains a deployment responsibility. Verify the
configured primary/standby contract with
`npm run check:postgres-replication -- --database-url "$SOURCE_DATABASE_URL"
--role primary --min-standbys 1`; the check fails unless a streaming standby is
present and within the configured replay-lag bound.

Serving nodes can enforce the same contract on `/readyz` with
`--require-replication --min-replicas 1`. This keeps a node out of service when
its configured Postgres topology has lost the required standby.

Set `SOURCE_WEBHOOK_SECRET` to enable HMAC-signed workflow webhook ingress;
deliveries require a provider signature and delivery ID and are replay-safe.
Workflow dispatch is bounded to 1,000 jobs per event by default; operators can
adjust the `maxWorkflowJobs` server option for a different controlled fan-out.

## Cloudflare integration bootstrap

The isolated [Workers and Artifacts bootstrap](cloudflare/artifacts-bootstrap/README.md)
provides an authenticated repository-creation Worker and a Git push/clone smoke
command. This prepares the first hybrid integration proof; the Source application
lifecycle remains on Node/Postgres. Live Artifacts access must be verified
separately from local tests.

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
  web.js         — SiteKit-backed human-facing HTML views (org/project/work/change)
  cli.js         — CLI (same services as the API)
  submit.js      — `source submit` contribution client
  integrations/
    kujo.js      — Eval/Spec/ShipCheck artifact normalizers + KujoRunner
  job-queue.js   — durable Postgres lease/retry queue for worker fleets
  worker.js      — bounded worker loop with heartbeats and retry routing
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
- `26-enterprise-readiness.md` — fleet resource controls and operational limits
- `27-kujo-release-gate.md` — Kujo-backed deterministic release gate
- `24-multi-repo-changes.md` — multi-repository Changes
- `25-rate-limiting-scanning.md` — rate limiting + credential scanning
- `27-workflows-actions.md` — durable workflow/action dispatch and idempotency
- `decisions/` — architecture decision records

## License

Source is licensed under [MIT](LICENSE). Vendored asset licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
