# Changelog

All notable changes to Source are recorded here.

## [Unreleased]

- Added bounded artifact-download admission with retryable backpressure and
  Prometheus metrics.
- Added repeatable Postgres-backed container failover and shared Git-volume
  smoke gates.
- Added Kujo Eval, dependency-audit, and Kujo Doctor release checks.
- Added bounded per-project worker claim bursts so a noisy project cannot starve
  other eligible projects in a shared Postgres worker fleet.
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

## [0.1.0]

- Initial agent-first Git, Work, Change, Evidence, Decision, capability, queue,
  workflow, and deployment vertical slice.
