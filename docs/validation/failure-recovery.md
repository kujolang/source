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
| Assembler SIGKILL after commit-tree or retained-ref update | integration-planner.test.js | Fresh competing processes reconstruct identical candidate/ancestry; canonical branch never moves |
| CLI verification worker SIGKILL before/after receipt persistence | verification-dispatch-live.test.js, live PostgreSQL | Natural lease expiry and competing fresh workers rerun only missing evidence; persisted deterministic receipt is reused |

The promoter process fixtures use real local Git and Source JSON records; they
demonstrate the Git write/reconciliation protocol, not distributed JSON support.
JSON remains single-process local storage. The CLI verification worker crash
fixtures use live PostgreSQL and separate processes. Database-primary failover
and real host/power-loss durability remain unverified. Killing a worker is not a
power failure or a deployment disaster-recovery exercise.

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

Still required by the mission: interruption inside a Git operation, primary
database/host failover, restoration after partial storage loss, isolated runtime
orphan cleanup, and measured recovery under representative load. Controlled
assembly/verification process-death and PostgreSQL rollback boundaries are now
covered by the increments below; they do not close those broader recovery gates.

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

## Queue cancellation and priority — 2026-11-10

The complete regression with a disposable live PostgreSQL database passed all
304 tests across 44 files, zero skips/failures (127.42 seconds). It includes new
priority/dependency ordering, old-schema upgrade, cross-store expired lease
rejection, cancelled lease fencing, ten cancellation-versus-completion races and
HTTP cancellation capability/audit checks. Evidence:
`/tmp/source-queue-complete-regression.log`.

Final review then found and fixed workspace cleanup ownership across attempts:
the manager now keys each workspace by job ID and lease token and rejects duplicate
acquisition. The affected worker/action-runner suite passed all 36 tests after
that final change (`/tmp/source-queue-final-worker.log`); syntax lint checks 94
files. The full suite was not rerun after that isolated workspace change.

Cancellation tests demonstrate durable queue fencing and signal propagation,
not live container teardown. The Docker daemon remains unavailable locally.
Custom handlers must observe abort signals and fence writes; candidate-aware
dispatcher receipt fencing, durable reuse/supersession, staging and cost accounting
remain required. No claim of production capacity follows from these tests.

## Evidence lease fencing — 2026-11-10

Queued broker recordings can now supply an internal `jobLease`. The broker locks
the scoped PostgreSQL job row inside the project mutation transaction, checks the
worker/token and wall-clock expiry, and matches the job kind, repository,
candidate, check and verification identity. It checks the lease again after
writing the receipt and audit, before transaction completion. Cancellation and
reclaim cannot interleave with that locked write. Lease expiry detected after the
write rolls back the evidence transaction. HTTP verification does not accept or
forward client-provided lease ownership; ordinary authorized service attestations
retain their existing behavior.

Focused validation: 13 tests passed, zero failures/skips, in 17.84 seconds using
a disposable live PostgreSQL database (`/tmp/source-evidence-fence.log`). Coverage
includes missing transaction rejection, wrong scope, cancelled/expired/reclaimed
leases, cancellation lock contention across independent connections, rollback on
expiry during a write, and current-lease persistence. The broker suite also checks
that queued recording fails closed on stores without transactional fencing.
Syntax lint checked 94 JavaScript files; diff whitespace validation passed.

This is the fencing seam for the forthcoming candidate dispatcher, not a claim
that dispatch, isolated execution, or end-to-end queued receipt production is
implemented. A live PostgreSQL broker/dispatcher lifecycle test remains required.

## Candidate dispatcher lifecycle — 2026-11-10

The full regression passed 311 tests across 45 files with live PostgreSQL enabled:
zero failures, skips or cancellations, 244.79 seconds. Each file used its own
temporary fixture root, removed after exit; the disposable database was dropped.
Evidence log: `/tmp/source-dispatch-full.log`. Syntax lint checked 96 JavaScript
files and `git diff --check` passed.

New live tests cover ten concurrent dispatches across two Source/store instances,
one job per exact check, ordered prerequisites, deterministic reuse, mandatory
environment-dependent reruns, generation invalidation of old evidence, cancelled
lease rejection before and after execution, forged job rejection, failed-check
receipt persistence, descendant rescheduling, and acceptance/promotion using
queued receipts. A simulated worker loss after receipt persistence but before
acknowledgment expires the lease, reclaims the job and reuses that exact receipt.
The HTTP dispatch test enforces its distinct capability and ignores attempted
client command/producer/priority substitution.

This supersedes the preceding missing live broker/dispatcher lifecycle test. The
executor is a controlled test fixture that reads the assembled candidate through
real Git; it does not prove workload isolation or deployment. Worker loss here is
simulated through lease expiry, not a killed verification worker process. Real
isolated execution, staging teardown, multi-process dispatcher crash/failover,
replacement-candidate cancellation and scale benchmarks remain required.

## Exact-candidate executor contract — 2026-11-10

The optional pinned-image container executor and raw Git exporter passed 40
focused tests with the existing runner/worker suites, zero failures/skips, in
1.60 seconds (`/tmp/source-candidate-executor-tests.log`). Syntax lint checked 99
JavaScript files and diff checks passed. Tests cover raw binary bytes, executable
mode, exclusion of uncommitted/untracked files, export-attribute independence,
tree mismatch, size limits, symlinks, filesystem aliases, corrupt blob hashes,
argument quoting, environment mismatch, cancellation before allocation and
cleanup after export/runtime errors.

The container process in these tests is controlled, not a real Docker/Podman
workload. `docker info` was rechecked and failed because
`/Users/robertdevore/.docker/run/docker.sock` does not exist. The live smoke script
is provided but was not run against a container. No claim of live isolation,
rootless UID mapping compatibility, confirmed runtime teardown or staging
readiness follows from this increment. The previous full 311-test regression
predates these additive modules; it was not repeated for this focused addition.

## Candidate retirement and replacement — 2026-11-10

The focused broker, dispatcher, queue, CLI and authorization regression passed
40 tests, zero failures/skips, in 50.02 seconds with disposable live PostgreSQL
(`/tmp/source-retirement-tests.log`). After extending the replacement test to
inject a lost promotion acknowledgment, the final six live dispatcher tests all
passed in 51.90 seconds (`/tmp/source-retirement-final.log`). Syntax lint checked
99 JavaScript files; diff checks passed. No full-suite result is claimed for this
increment.

Coverage proves rollback of old-job cancellation when a replacement is invalid,
atomic replacement dispatch, idempotent retirement, terminal candidate gating,
late evidence rejection after in-flight execution, distinct retirement and
dispatch capabilities, audit principal integrity, and a promotion-versus-retire
race across two Source instances sharing PostgreSQL. The lost-acknowledgment
case commits Git, rolls back the database outcome, refuses retirement using the
landed Git ref, then reconciles promotion successfully. Prior receipts/approval
remain inspectable and never transfer to a replacement.

Retirement is explicit rather than inferred from unrelated proposals. Runtime
abort/teardown remains a worker responsibility; database fencing is not evidence
that an unreachable container was removed. These tests do not close the pending
isolated staging, multi-process failover, hosting or scale gates.

## Real assembler and verification process death — 2026-11-10

Two live PostgreSQL CLI-worker crash tests passed in 30.26 seconds, with no skips
or failures (`/tmp/source-worker-process-crash.log`). A test-owned worker is killed
with SIGKILL immediately before receipt persistence or immediately after the
handler saves its receipt, before queue completion. Two new CLI worker processes
use the real queue and wait for natural lease expiry; no test SQL changes lease
timestamps. Both cases complete the candidate and promote it after human
acceptance. The before-persistence case executes preflight twice because the
first execution had no durable result. The after-persistence case executes it
once and recovers the same receipt with `reused: true`; the job has exactly two
claim attempts. Fixture execution logs make duplicate execution observable.

The planner suite passed eight tests in 30.83 seconds
(`/tmp/source-assembler-process-crash.log`), including SIGKILL immediately after
the first commit-tree operation and immediately after retaining the candidate
ref. Two fresh assembler processes recover concurrently and return identical
candidate records. Every proposal remains an ancestor, both contributed files
are present, the immutable candidate ref agrees with the report, and the canonical
branch remains at its original base. The early-crash case has no retained ref;
the late-crash case retains exactly one. These are actual child-process deaths,
not thrown exceptions or edited leases.

Lint checked 99 JavaScript files and diff checks passed. This increment changes
tests and validation records only; no new full-regression result is claimed.
The verification executor remains a controlled real-Git-reading fixture. These
tests establish queue/broker recovery, not container isolation, orphan teardown,
host/power-loss durability or database-primary failover. A PostgreSQL client
deprecation warning about overlapping queries on one transaction client was
observed; it did not fail these tests and is not a certification of future driver
compatibility.
