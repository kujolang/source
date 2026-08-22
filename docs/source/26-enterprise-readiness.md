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
per-request payload size, and shared rate limit. Completed and failed jobs are
retained for seven days by default and pruned in bounded batches. Postgres
fallback `psql` processes have a four-process budget and a ten-second timeout
by default.

Distributed workers receive a random lease token on every claim. Extend,
complete, and fail operations require that token, so a stale worker cannot
mutate a lease reclaimed by another node. Expired jobs are atomically moved to
failed state once their persisted attempt limit is reached.

Chunked Git uploads use a separate four-slot admission budget and a 16 MiB
buffer limit by default. Known-length uploads remain streamed directly to
`git http-backend`.
