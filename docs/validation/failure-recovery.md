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

## Serialized PostgreSQL transaction queries — 2026-11-10

Async transaction contexts now serialize admitted queries on their single physical
connection. Commit/rollback drains those queries before releasing the connection;
closing/closed contexts reject escaped work. A caught SQL error still fails the
transaction, preventing PostgreSQL's aborted transaction from appearing to commit.
Failed rollback discards the connection while preserving the original failure.
Nested transactions remain flattened; this does not introduce savepoints.

Four new fake-client tests assert physical query concurrency of one, nested and
parallel admission, draining on callback failure, late-context rejection, poisoned
transactions and rollback connection disposal. A live PostgreSQL regression
commits twenty parallel nested writes, catches a division-by-zero SQL failure,
checks that the earlier write rolled back, and verifies pool reuse afterward.

Focused transaction/regression/dispatcher/queue tests: 22 pass, zero failures or
skips, 80.95 seconds (`/tmp/source-transaction-focused.log`). Full regression:
327 tests across 47 test files, all pass, zero skips/failures/cancellations, 299.56
seconds (`/tmp/source-transaction-full.log`). The full run includes the Cloudflare
Worker suite and real PostgreSQL tests using a disposable local database. Each
test file used an owned temporary directory removed only after its process exited;
the disposable database was dropped after the run. No overlapping-query driver
deprecation warning appeared. Existing PostgreSQL notices and warnings from other
schema/transaction paths remain; their absence is not claimed.

These results supersede the earlier observed overlapping-query warning. They do
not establish live OCI isolation, database-primary failover, deployed staging,
real-project migration or the required staged concurrency benchmarks.

## Workcell execution bridge — 2026-11-10

An optional `WorkcellExecutor` connects Source's existing verification handler to
Workcell portable inspect/run/verify. Real-Git materialization tests prove exact
committed bytes, clean HEAD/index and absence of canonical remote configuration.
Controlled CLI fixtures verify candidate/command/attempt binding, resolved
provider/profile fingerprint matching, manifest verification, original log capture,
failed/truncated results, incomplete cleanup, cancellation-file delivery, preserved
worktree backing repositories and executor slot release. They do not run an
untrusted workload or prove container/provider isolation.

Focused executor, candidate exporter, control-adapter, action-runner and worker
regression: 56 tests pass, zero failures/skips/cancellations, 6.66 seconds
(`/tmp/source-workcell-focused.log`). Lint syntax-checks 102 JavaScript files;
diff checks pass. The last full 327-test regression predates this additive bridge.

Actual sibling Workcell 1.3.0 at
`189d7ab6e975301a0e5100b65e8ad3fe4a584573` accepted the example definition with
`bin/workcell validate --file <source>/examples/verification/workcell-definition.json`
and resolved the Docker profile with `inspect --file <definition> --profiles
<source>/examples/verification/workcell-profiles.json --profile docker --summary`.
Inspect returned `ok: true`, 23 accepted controls, zero rejected, and one unobserved
control. Inspection is not evidence that those controls operated in a live run.
The example's all-zero image digest is intentionally a placeholder and must be
replaced before execution. An actual CLI invocation against a temporary real Git
candidate failed closed without an inspectable receipt; no passing evidence was
returned. The owned temporary fixture was removed after invocation finished.
Docker info independently confirmed its daemon socket was absent.

The bridge retains Workcell run evidence and unconfirmed-cleanup source/control
material for Workcell-owned recovery. It does not implement a Source reaper,
certify worker-death resource cleanup, deliver remote provider credentials or
prove endpoint/browser staging. Those remain explicit mission requirements.

## Full-lifecycle benchmark validation — 2026-11-10

The reproducible benchmark now drives real HTTP Git clones/pushes and submit
records from independent client processes, then uses two separate PostgreSQL
workers for exact-candidate verification and normal broker acceptance/promotion.
Ten agents passed on one repository and on five repositories. Candidate ancestry,
content, evidence gating, coalescing/reuse, repeated promotion and equality with
conventional cumulative-merge final trees are asserted, not inferred from timing.
See `concurrency-results.md` and its raw reports for measurements and limitations.

A permanent checker regression rejects missing contributors, corrupted bytes
(including added whitespace) and unexpected files. A live two-agent/two-repository
regression validates the whole harness and report invariants. Benchmark, submit
and sync suites passed ten tests, zero failures/skips, in 28.73 seconds
(`/tmp/source-benchmark-tests.log`). Both recorded measurements' SHA-256 harness
identities match the checked-in script. The run databases and owned temporary
fixtures were removed after all child processes exited.

Three development smoke attempts exposed a harness-only connection setup issue:
workers inherited a deliberately minimal environment, and a socket DSN without
an explicit user lost PostgreSQL's ambient username default. The harness now
passes the actual connected database user as the worker's explicit PGUSER.
The subsequent two-agent smoke completed successfully. These failed development
attempts are not successful capacity measurements. No application authentication,
verification policy, rate limit or admission bound was weakened for the benchmark.

This increment adds harness/tests/results rather than changing the application.
The previous full 327-test regression predates the Workcell and benchmark additions;
no new full-regression result is claimed here. Runtime isolation, recovery under
load, larger stages and the real-project lifecycle remain open.

## Private secondary-remote submission — 2026-11-10

The private submission regression reproduced `missing credential` for both an
explicit credential and `SOURCE_CREDENTIAL`: Git authenticated correctly, but the
client omitted the bearer capability on the API POST. The client now uses the
same supplied credential for both transports, rejects a different API origin
before any fetch/push, and refuses API redirects. Server permissions are unchanged;
private submission still requires `submit_change` in addition to Git permissions.
The transport-only `git-cap` helper has not gained additional authority.

Final submit suite: eight tests pass, no skips/failures, 9.42 seconds
(`/tmp/source-private-submit-final.log`). Tests verify private authenticated
principal attribution, environment/argument credential paths, unchanged GitHub
origin, denial of transport-only capabilities and pre-push rejection of an
unrelated API override. The four related sync/API/Git/auth suites passed 46 tests
(`/tmp/source-private-submit-tests.log`); its initial submit assertions used the
wrong session field, corrected to the actual `session.principal` contract before
the final passing run. A final live benchmark regression passes both tests in
10.09 seconds (`/tmp/source-benchmark-final-tests.log`). Lint checks 104 JS files;
diff checks pass. No new full-suite claim is made.

The 25-agent pilot still fails at default shared-IP Git-read admission with
observed HTTP 429 responses; this authentication fix does not claim to resolve
that independent scaling limit. See concurrency-results for the failed records.

## Bounded client admission backoff — 2026-11-10

Source clients now retain server admission limits and wait on explicit throttling.
Git recognizes HTTP 429 without exposing remote stderr or credential-bearing argv;
submit shares a bounded retry count/deadline across Git and API calls. The API
marks only pre-lifecycle 429 responses retryable and supplies a conservative
Retry-After. Unknown mutation outcomes, authentication failures and 5xx errors
are not replayed. No capability or server-rate-limit change is included.

Five retry tests cover seconds/date/malformed Retry-After, shared limits/deadline,
Git HTTP classification, credential-safe errors, rejection of uncertain POST
replay, and a real server's mutation count before/after throttling. Together with
submit/sync/API/Git transport suites: 42 tests pass, zero failures/skips, 24.40
seconds (`/tmp/source-client-backoff-tests.log`). Lint checks 106 JS files; diff
checks pass. The benchmark client timeout now permits the documented ten-minute
retry budget rather than aborting a still-bounded client at three minutes.

## Compressed Git negotiation — 2026-11-10

The bounded-backoff hot 25-agent run submitted and verified all proposals, then
failed its post-promotion fetch with `expected 'acknowledgments'`. A real Git
backend reproduction showed compressed protocol-v2 input being interpreted as
packet lines because Source omitted Content-Encoding handling. Git's own
[v2.42 backend](https://github.com/git/git/blob/v2.42.0/http-backend.c) supports
encoded requests; Source now decodes gzip/x-gzip before delegation so it can also
enforce an explicit expanded-body limit. Both compressed and decoded input are
limited to the smaller Git body/chunked body bound, using the existing bounded
buffered-upload slots. Unsupported encodings return 415, malformed gzip 400,
and oversized compressed/decoded requests 413. Authentication remains first.

The regression fails before the fix (`/tmp/source-gzip-before.log`). Tests cover
valid compressed protocol-v2 requests, expansion limits, malformed input,
unsupported encodings, normal subsequent requests, and an ordinary Git fetch of
30 new heads that asserts Git actually sent gzip. Transport/API/submit/sync/retry
suites pass 44/44 with no skips in 10.65 seconds
(`/tmp/source-gzip-final-tests.log`). This is not a new full-suite result.


The post-fix hot25 real-process/PG lifecycle also passes all assertions, including
final HTTP fetch and exact baseline-tree comparison. See
[raw report](benchmarks/agents-25-repos-1-gzip.json) and concurrency-results for
measurements and scope. This resolves the observed fetch failure; it does not
certify production capacity.


## Live OCI endpoint and bounded termination — 2026-11-10

Starting the installed Docker Desktop enabled real container validation. The public
Node image was pulled without using private registry credentials, then pinned by
its returned digest. An initial mismatched tool-version assertion
failed; the actual image reports v26.13.0. The correct-version smoke passes.

The expanded reproducible smoke runs five cases: exact-candidate loopback endpoint
and isolation probes; command exit7 recorded as failed evidence; cancellation
after workload readiness; five-second timeout after readiness; and output overflow.
After each, successful runtime inventory proves the exact owned container names
are absent and the workspace/runner slots are released. A live inspect confirms
network none, read-only root, 1GiB memory, 2CPUs, 256PIDs, host numeric non-root
UID/GID and a sole workspace bind. Host working edits/untracked files/canary
environment are excluded; effective capabilities are zero and no-new-privileges
is set. Raw evidence: [five-case report](container/candidate-smoke.json).

This proves normal bounded termination on this running Docker Desktop, not worker
SIGKILL reconciliation, runtime-unreachable cleanup, browser checks or a security
escape assessment. Those remain separate gates.

Focused candidate-export and action-runner regression: 27/27 pass, zero skips,
1.57 s (`/tmp/source-container-focused.log`). Lint106 and diff checks pass.


## Workcell temporary boundary and live failure evidence — 2026-11-10

The first Docker-enabled Workcell attempt failed without a receipt because Source
supplied an absolute output path outside Workcell's allowed TMPDIR boundary.
The sanitized environment omitted TMPDIR. Source now explicitly sets it to the
private realpath-resolved attempt directory for inspect/run/verify. No ambient
value or broader filesystem access is inherited. The regression assertion failed
before the fix (`/tmp/source-workcell-tmp-before.log`).

The repeated live smoke now records an exact-candidate, integrity-verified failed
receipt with cleanup confirmed, preserving original diagnostics. Workcell refuses
rootful Docker without AppArmor on this daemon; no workload ran and no passing
evidence was issued. The new reproducible smoke exits nonzero for this outcome.
[Raw failed receipt](container/workcell-smoke-blocked.json) records the runtime
error and test-owned evidence path. Keep this distinct from the passing lower-level
OCI executor smoke. A compatible runtime is still required for the Workcell gate.

Workcell/export/control-adapter focused regression: 20/20 pass, no skips, 6.99 s
(`/tmp/source-workcell-tmp-tests.log`); syntax lint107 and diff checks pass.
No new full-suite or successful Workcell execution claim is made.

## Live semantic failures and ten-way conflicts — 2026-11-10

`tests/integration-semantic-live.test.js` uses independent Git clones and real OCI
execution through CandidateContainerExecutor, then records the actual outputs in
Source's broker. Two components change different files but share a capacity limit.
All component unit checks pass. In the interaction case, each proposal also passes
integration alone, while the merged candidate fails integration. In the faulty-
proposal case, fresh split checks identify the failing proposal. Both cases deny
acceptance of the combined candidate and reject a genuine passing singleton
execution submitted under the combined candidate's identity.

Split candidates require new evidence even when their tree matches a previously
verified singleton. When both split children pass, both may be accepted against
the original base, but only the first can land: the second is rejected after the
target advances. Thus a semantic interaction cannot be bypassed by independently
promoting both green halves. The final canonical content retains the safe half.
This fixture distinguishes an interaction from a single faulty change; splitting
is diagnostic, not a promise that every failure has one culpable proposal.

Two live scenarios pass, zero skips, 29.69 s (`/tmp/source-semantic-live.log`), with
Docker and the pinned Node v26.13.0 image from container/candidate-smoke.json.
Run explicitly using SOURCE_TEST_CONTAINER_IMAGE and
SOURCE_TEST_CONTAINER_NODE_VERSION; without them this live suite is skipped.
No untrusted candidate code executes on the host. The local JSON control store is
used serially; existing PostgreSQL multi-process queue tests cover that separate
boundary, not these application checks.

A further real-Git test starts ten concurrent incompatible edits to one file.
The planner deterministically retains one proposal, reports all nine excluded
conflicts with file diagnostics, preserves the selected contents and leaves main
unchanged. The first assertion used the wrong report field (`proposal` rather
than `id`); corrected before the passing run. Planner/broker/verification related
regression: 22/22 pass, zero skips, 48.17 s (`/tmp/source-semantic-related.log`).

## Main application regression after semantic cases — 2026-11-10

At revision `3c3fb18`, all 50 files under tests/**/*.test.js passed: 348 tests,
348 passes, zero failures/skips/cancellations, 395.241 seconds total. Real local
PostgreSQL and the pinned Docker Node v26.13.0 image were enabled, including the
new semantic cases and worker process-death/lease-recovery tests. Each test file
ran in a separate Node test process with a fresh owned TMPDIR, removed only after
the file completed. The owned disposable database was dropped at the end.

[Per-file machine-readable report](main-suite-2026-11-10.json) records revision,
environment, counts and durations. Full local log: /tmp/source-full-semantic.log.
Reproduce each listed file with `node --test --test-reporter=tap <file>`, setting
SOURCE_TEST_DATABASE_URL to a disposable database, PGUSER to its operator user,
SOURCE_TEST_CONTAINER_IMAGE and SOURCE_TEST_CONTAINER_NODE_VERSION as recorded,
and SOURCE_TEST_CONTAINER_RUNTIME=docker. Allocate a new temporary directory per
file, set TMPDIR to it, and delete that owned directory after its process exits.
The run imposed a 240-second per-file timeout; none was reached.

This is the main application suite, not a new run of separate Cloudflare package
checks, successful Workcell/AppArmor execution, deployed failover/restore,
100/250/1000 integration workloads, or a production-readiness certification.
