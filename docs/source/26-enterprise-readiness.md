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
queue (eight waiters per pool connection by default). Once that queue is full,
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

Chunked Git uploads use a separate four-slot admission budget and a 16 MiB
buffer limit by default. Known-length uploads remain streamed directly to
`git http-backend`.

Git requests also use a per-project admission budget (eight active requests and
256 queued by default) in addition to the process-wide Git budget. This keeps a
single noisy tenant from consuming every Git subprocess slot; both budgets are
configurable through `createServer`/`startServer` or the CLI.

Action handlers can use `EphemeralWorkspaceManager` to apply a separate bounded
workspace budget and automatically remove temporary workspaces on success or
failure. This prevents abandoned action directories from consuming shared
runner storage during large fan-out events.

Evidence artifacts are limited to 64 MiB by default through `Source`'s
`maxArtifactBytes` option (hard-capped at 512 MiB), protecting both worker
memory and durable storage from oversized verification output.

Enqueue endpoints accept `Idempotency-Key`; the scoped hash becomes the durable
job dedupe key, allowing agents to retry after a 503 without multiplying work.
