# Integration recovery validation — 2026-11-10

This is increment evidence, not the full production-recovery gate.

| Fault or adversary | Reproducer | Proven boundary |
| --- | --- | --- |
| Two candidates race the same base | integration-broker.test.js, independent CLI processes | One Git target/landed-ref transaction wins; loser reports rejection without overwriting winner |
| Git success, Source outcome write throws | integration-broker.test.js, injected post-Git failure | Intent remains and landed ref allows retry to reconstruct outcome |
| Promoter process exits after Git commit | integration-broker.test.js, child process exits 23 before outcome write | Fresh CLI process recognizes landed ref and returns recovered outcome without repeating target update |
| Agent claims another producer ID | integration-broker.test.js, HTTP receipt request | Authenticated agent remains producer; service allowlist rejects it |
| Direct canonical push and legacy promotion | integration-broker.test.js | Smart HTTP and both legacy canonical methods refuse opted-in repositories |
| Policy changes after verification | integration-broker.test.js | Original candidate/receipt remain inspectable; new policy gets another candidate identity; old evidence cannot accept it |
| Wrong commit/tree/config/dependency/tool/environment | verification.test.js | Exact identity mismatch requires re-verification |
| Expired receipt or later failed execution | verification.test.js | Prior successful result cannot authorize promotion |

The concurrent-process and process-exit fixtures use real local Git and Source
JSON fixture records. They demonstrate the Git write/reconciliation protocol,
not distributed JSON support. JSON is still documented as single-process local
storage. PostgreSQL integration crash/failover tests and real host/power-loss
storage durability remain unverified. An intentional child exit is not a power
failure or a deployment disaster-recovery exercise.

## Recovery procedure

1. Keep the repository protected and inspect `integration status` with its exact
   candidate ID. Do not clear intent/landed refs or force-push the target.
2. Retry `integration promote` with an authorized maintainer. If Git already
   landed the candidate, the broker reconstructs the store outcome. The target
   may have advanced since landing; the retained candidate-specific landed ref
   establishes that the earlier operation succeeded.
3. A stale target without a landed receipt is a rejection: replan and reverify
   against the new target. Never reuse acceptance to promote a newly assembled head.
4. A missing/corrupt artifact, changed policy or candidate-integrity error needs
   operator investigation or new verification. Do not mark it successful manually.
5. Back up Git refs together with Source records and artifacts before repair.
   A database-only restore can discard acceptance while leaving Git ahead.

Still required by the mission: process death during assembly/before Git commit,
real PostgreSQL rollback and competing-instance failover, restore after partial
storage loss, verification-worker crash/cancellation, isolated environment cleanup,
bounded retries under outages and measured recovery times under representative
load. Those gates stay open in the work ledger.

## Regression receipt

After the broker/receipt changes settled, all 41 root and Worker test files were
run sequentially with a fresh per-file TMPDIR and cleanup after exit: 282 tests,
275 pass, seven PostgreSQL-only skips, zero failures; 128.91 seconds wall time
for that local run. Log: `/tmp/source-broker-clean-regression.log`. Syntax lint
passed for 89 JavaScript files. Earlier tests run while receipt identity code was
being edited had mixed-version child-process failures and are not the acceptance
run. The unchanged clean rerun above supersedes them; no source edits occurred
during that rerun. This is correctness regression evidence, not an agent capacity
or CI-efficiency benchmark.

## Impact and failed-batch increment — 2026-11-10

Focused split planner/broker validation passed 14 tests. Current impact, adapter
and identity tests passed 11 tests; current broker tests passed nine tests. Syntax
lint checked 93 JavaScript files. Full regression attempted 293 tests across 43
files: 267 passed, 19 failed, seven PostgreSQL skips. Host ENOSPC affected six
suites; this is not a passing regression.

An empty-Git-template retry with per-file temporary cleanup ran 33 tests:
17 passed, 16 failed (40.18 seconds). Multi-repository and scan suites passed;
planner, store, submit and sync still failed disk/Git writes, including inability
to set HEAD and SQLite disk I/O errors. Ten concurrent Git clients and the split
fixture passed. Logs: `/tmp/source-impact-regression.log` and
`/tmp/source-impact-retry.log`. Free disk capacity and rerun those four suites
before claiming complete regression verification. The implementation commit is
`ecc5aa0`; neither this increment nor its focused tests establish production or
performance readiness.

After disk capacity was restored, an unchanged-source rerun of all 43 test files
passed: 293 tests, 286 pass, seven PostgreSQL skips, zero failures (124.16 seconds).
The separate live PostgreSQL baseline ran in a disposable local database and
passed all 22 tests with zero skips (60.25 seconds), including concurrent claims,
worker recovery, evidence relationships and storage parity. Temporary fixtures
and the disposable database were removed after completion. Evidence logs:
`/tmp/source-impact-recovered-regression.log` and
`/tmp/source-postgres-baseline.log`. These successful runs supersede the disk-
limited attempts for regression acceptance. They do not establish the new broker's
PostgreSQL crash/failover behavior or production capacity; those gates remain open.
