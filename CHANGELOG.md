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

## [0.1.0]

- Initial agent-first Git, Work, Change, Evidence, Decision, capability, queue,
  workflow, and deployment vertical slice.
