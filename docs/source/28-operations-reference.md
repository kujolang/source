# Operations reference

Resource limits, storage, worker processes and recovery commands for Source.
Run commands from the repository root. Start with the
[deployment guide](23-tls-deployment.md) before exposing a server.

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
deployment sized to its CPU, memory, and Git workload. For exposed, multi-process deployments, use Postgres with writer fencing.
JSON and SQLite are local backends. Postgres uses a bounded pool (32 connections by
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
`19-capability-auth.md`, `21-multi-tenant-orgs.md`, and
`22-git-transport-auth.md`.

### Storage backend

The default store is JSON files on disk for local development only. Select the
SQLite backend (ACID transactions across records) with `--store sqlite` or
`SOURCE_STORE=sqlite`:

```bash
node bin/source.js --store sqlite init --name source.kujolang.ai
```

See `20-sqlite-store.md`.

For production multi-process deployments, select the pooled Postgres backend:

```bash
SOURCE_DATABASE_URL='postgres://source:password@db/source' \
  node bin/source.js --store postgres serve --host 0.0.0.0 --port 8787 \
  --writer-lease --writer-owner "$SOURCE_INSTANCE_ID"
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
Caddy, HAProxy). See `23-tls-deployment.md` for the full self-host
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

