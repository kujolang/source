# Enterprise readiness controls

The HTTP service treats organization membership as the tenant boundary for
human sessions. Operators add a principal to an organization with an explicit
role:

```sh
node bin/source.js org member add --org O1 --principal H1 --role maintainer
```

`member` sessions can read source and context. `maintainer` and `admin`
sessions may also record change decisions. Login cannot select a project or
approval authority without a matching organization membership and existing
project.

Durable job enqueueing is bounded by a configurable per-project record depth,
per-request payload size, and shared rate limit. The Postgres depth quota is
enforced atomically under the project row lock, so concurrent agents cannot
oversubscribe it with a count-then-insert race. Completed and failed jobs are
retained for seven days by default and pruned in bounded batches. Postgres
fallback `psql` processes have a four-process budget and a ten-second timeout
by default.

Every asynchronous Postgres operation also passes through a bounded admission
queue (eight waiters per pool connection by default; the live 1,000-agent gate
uses a 4,096-operation deployment budget). Once that queue is full,
the operation is rejected rather than retained indefinitely in the database
driver's internal wait list. Admission activity and rejections are exposed
through `/metrics` for capacity planning.

Distributed workers receive a random lease token on every claim. Extend,
complete, and fail operations require that token, so a stale worker cannot
mutate a lease reclaimed by another node. Expired jobs are atomically moved to
failed state once their persisted attempt limit is reached.
The queue has dedicated partial indexes for ready and expired leases so worker
claim scans remain bounded as completed history grows. Each claim also caps
expired-attempt cleanup at 1,000 rows, preventing a recovery storm from
rewriting an unbounded backlog in one transaction.
Fair multi-project claims additionally use a tenant/status/time index aligned
with the partitioned ranking query, reducing unrelated queue-history work as
the backlog grows.
Job dependencies are validated at enqueue time against the same batch or an
existing durable job; cyclic and missing references are rejected, and legacy
queued rows with missing prerequisites are terminalized during claim recovery.
Claims apply a bounded per-project burst (8 by default) when multiple projects
are eligible, while allowing a single eligible project to fill the requested
batch. This provides fair progress across tenants without reducing throughput
for a worker fleet serving one project; tune the limit with
`--worker-project-burst`.
Worker idle polls and transient-error backoff use bounded jitter by default, so
large fleets do not wake and retry in lockstep after a queue or database event.
Tune the range with `--worker-jitter-ratio` (default `0.2`, capped at `1`).
Workflow, organization, Work listing/dispatch, and repository-resolution paths
use bounded bulk record reads on Postgres, so large tenants do not fan out into
one database round trip per returned record. Bulk results preserve path order so
keyset pagination remains correct.
Human-facing HTML routes use the same async read paths and bounded bulk loads;
they do not invoke synchronous `psql` compatibility I/O on the API event loop.
The JSON compatibility backend also exposes asynchronous filesystem methods for
API callers. These are not a multi-process durability substitute for Postgres,
but they avoid synchronous filesystem calls in the async request path and
serialize in-process writes and counter allocation. Production multi-node
deployments must still use Postgres and shared durable Git storage. Postgres
schema bootstrap also takes a transaction-scoped advisory lock for each
compatibility-DDL statement, so concurrent serving-node startups do not race
table, column, or index creation.
Git repository resolution on Postgres uses tenant-scoped indexed ID/name lookup,
avoiding a scan of every repository in a large project.
Multi-repository canonical promotion also uses bounded Git update concurrency
(8 by default, capped at 64), preventing a large Change from spawning an
unbounded subprocess burst while preserving parallelism.
Async contribution submission and secret scanning stay on the non-blocking
Postgres/Git paths; evidence reads are bulk-loaded and repository scans share
the same bounded concurrency.
Missing optional session records in asynchronous Change submission also remain
on the async store path rather than falling back to synchronous compatibility
I/O.
Change decision relationships are capped at 1,000 entries and decision
listing uses one bounded bulk read, keeping review responses from creating a
per-decision database round trip.
Postgres list endpoints fetch at most 1,001 records internally—1,000 returned
items plus one lookahead row—so maximum-size keyset pages retain correct
continuation cursors without unbounded reads.
Mutation-time limits also cap project repository membership at 10,000 entries
and Change repository/evidence relationships at 1,000 entries, preventing a
single tenant record from growing without bound.
Canonical promotions additionally pass through a process-wide bounded gate
(8 concurrent projects by default, 64 maximum) before acquiring the Postgres
project-row lock. This limits the number of database connections held while
Git subprocesses perform promotion work.
The gate exposes active, waiting, and rejected counts through `/metrics`, making
promotion pressure visible to operators.
Postgres compatibility-record directory listings use a `text_pattern_ops`
prefix index, keeping keyset listing scans indexable as total tenant records
grow.
Request-body readers also terminate promptly on client aborts, preventing
disconnected agent requests from retaining promises and admission state.
HTTP requests also pass through a bounded process-local admission queue (2,048
active and 4,096 waiting by default), returning retryable 503 backpressure
instead of allowing request work to grow without limit. Tune it with
`--request-concurrency` and `--request-queue`; admission pressure is exposed
through `/metrics`.

Chunked Git uploads use a separate four-slot admission budget and a 16 MiB
buffer limit by default. Known-length uploads remain streamed directly to
`git http-backend`.

Git requests also use a per-project admission budget (eight active requests and
256 queued by default) in addition to the process-wide Git budget. This keeps a
single noisy tenant from consuming every Git subprocess slot; both budgets are
configurable through `createServer`/`startServer` or the CLI.

Canonical Git promotion is serialized per project in-process and, for
Postgres-backed nodes, under a transactional project-row lock held across the
fast-forward check and ref update. This closes the cross-node check-then-update
race while retaining Git's non-fast-forward refusal as the final integrity
guard.
Asynchronous Work claims use the same Postgres project-row lock, preventing
two authorized agents on different nodes from overwriting the winning
assignee. Synchronous canonical callers also acquire the durable lock before
entering the shared update path.

Action handlers can use `EphemeralWorkspaceManager` to apply a separate bounded
workspace budget and automatically remove temporary workspaces on success or
failure. This prevents abandoned action directories from consuming shared
runner storage during large fan-out events.

Evidence artifacts are limited to 64 MiB by default through `Source`'s
`maxArtifactBytes` option (hard-capped at 512 MiB), protecting both worker
memory and durable storage from oversized verification output.

Artifact retrieval has its own bounded admission budget (eight active
downloads and 64 queued by default). The API returns retryable `503` pressure
when that budget is exhausted and exposes active/rejected counts through
`/metrics`; this prevents many concurrent evidence readers from multiplying
large artifact buffers across a serving process.

Enqueue endpoints accept `Idempotency-Key`; the scoped hash becomes the durable
job dedupe key, allowing agents to retry after a 503 without multiplying work.
