# Changelog

All notable changes to Source are recorded here.

## [Unreleased]

- Added asynchronous JSON-store reads, writes, listings, artifacts, audit
  access, and counter allocation so compatibility deployments do not block the
  API event loop; async writes are serialized in-process to preserve atomic
  temp-file and counter behavior.
- Serialized Postgres schema bootstrap statements across serving nodes with a
  transaction-scoped advisory lock, preventing concurrent startup DDL races.
- Added an executable backup restore drill that restores Postgres into a
  temporary database, extracts isolated filesystem roots, verifies Git object
  integrity, and removes all drill resources on completion or failure.
- Added bounded, resumable Git-root mirror replication with per-repository
  retries, ref pruning, and post-replication `git fsck` verification.
- Made the default Node test command deterministic by serializing test files;
  the dedicated scale suite still exercises the 1,000-connection burst while
  avoiding host TCP backlog contention from unrelated test servers.
- Added bounded artifact-download admission with retryable backpressure and
  Prometheus metrics.
- Added repeatable Postgres-backed container failover and shared Git-volume
  smoke gates.
- Added Kujo Eval, dependency-audit, and Kujo Doctor release checks.
- Added bounded per-project worker claim bursts so a noisy project cannot starve
  other eligible projects in a shared Postgres worker fleet.
- Added bounded jitter to worker polling and outage backoff to prevent large
  worker fleets from synchronizing claim and retry storms; the range is
  configurable with `--worker-jitter-ratio`.
- Added bounded HTTP request admission (2,048 active and 4,096 queued by
  default) with retryable 503 backpressure and Prometheus metrics.
- Removed a synchronous fallback from asynchronous Change submission when an
  optional session record is absent, preserving nonblocking Postgres behavior.
- Batched Change decision reads and capped decision relationship growth at
  1,000 entries, removing another large-Change query fan-out path.
- Hardened isolated action timeout/output cleanup to kill the runtime process
  group and explicitly remove the named runtime container, preventing orphaned
  containers from consuming worker capacity.
- Fixed maximum-size Postgres keyset pagination by allowing one bounded
  lookahead row, so 1,000-item pages continue to return a correct next cursor.
- Postgres job enqueue now rejects missing dependency references and cyclic
  batch graphs; claims also terminally fail legacy queued jobs whose
  dependencies are missing instead of retaining them forever.
- Added Postgres project-row locking to asynchronous Work claims and
  synchronous canonical promotion, so mixed callers share the same
  multi-node serialization boundary.
- Converted the human-facing HTML routes to async bulk-backed renderers,
  removing synchronous Postgres/psql calls from API request handling and
  bounding project/work/change page reads at 1,000 records.
- Added durable workflow job dependencies with cycle validation and
  dependency-aware claims for GitHub Actions `needs` semantics.
- Batched Postgres workflow record reads to avoid one database round trip per
  workflow during dispatch and listing.
- Extended bounded Postgres bulk reads to organization and Work listings,
  removing their per-record query fan-out.
- Applied the same bulk-read path to repository resolution, keeping Git-facing
  repository lookup bounded for projects with many repositories.
- Added tenant-scoped Postgres repository lookup indexes so name/ID resolution
  does not scan a project’s repository list.
- Bounded multi-repository canonical promotion to eight concurrent Git updates
  per project by default, with a safe operator limit of 64.
- Removed synchronous repository resolution from async contribution submission,
  batched async evidence reads, and bounded multi-repository secret scans.
- Added mutation-time bounds for project repository lists, Change repository
  fan-out, and Change evidence relationships.
- Added a bounded global canonical-promotion admission gate so long-running Git
  promotions cannot exhaust the Postgres connection pool across projects.
- Exposed canonical-promotion admission depth and rejection metrics for
  capacity planning and alerting.
- Added a Postgres `text_pattern_ops` index for bounded prefix directory
  listings over compatibility records.
- Aborted JSON and raw request bodies now reject immediately instead of leaving
  disconnected-agent promises pending.
- Added independent bounded admission to isolated action runners so shared
  worker processes cannot spawn unbounded containers.
- Added a tenant/status/time index aligned with fair Postgres worker claims.
- Backup and backup verification now hash archives through streaming reads,
  avoiding whole-archive memory amplification.

## [0.1.0]

- Initial agent-first Git, Work, Change, Evidence, Decision, capability, queue,
  workflow, and deployment vertical slice.
