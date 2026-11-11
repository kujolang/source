# Keyed submission recovery

Scope: local real Git and PostgreSQL, optional authenticated contribution keys.
The previous secondary-remote turn made progress through verified behavior and
committed onboarding clarification; this increment resumes the full platform
mission's interruption/recovery and hosting ergonomics work.

## Invariants and evidence

`tests/submission-recovery-live.test.js` exercises:

- Ten concurrent requests through two Source/store instances return one identical
  result and create one Work/Change. Payload conflicts fail; later Change updates
  do not alter the original receipt; another principal cannot read it.
- An exception after real evidence insertion rolls back Work, Session, Change,
  evidence, artifacts, audit, generic records and replication-event row counts.
- A forked process is SIGKILLed after actual evidence insertion inside the open
  transaction. A peer observes no partial lifecycle or receipt, and retries once.
- Public keyed POST requires authentication; body keys cannot override the header;
  HTTP recovery checks principal scope and current credential revocation.
- Normal keyed client submission and actual CLI recovery succeed. Recovery still
  works after deleting local HEAD, without fetching or pushing Git objects.
- A real committed POST loses its socket before the response. The client reports
  unknown outcome, GET retrieves the committed response, and same-key POST returns
  it without creating another lifecycle.
- Two independently launched Node processes race the same submission; both return
  the same result. A third fresh process reads that durable receipt.

`tests/submission-recovery.test.js` checks unsupported-store rejection before
writes, key validation, and expired/cross-project mutation context rejection.
The existing submit/sync suite covers legacy public/private behavior and origin
preservation. PostgreSQL regression tests cover concurrent evidence relationships,
transaction query drainage/rollback and exact artifact bytes.

The local project admission gate remains bounded. PostgreSQL project row locking
provides cross-process serialization. A scoped async context allows the sequential
steps of the composite transaction to reuse that gate/transaction; it rejects a
nested different project or use after its owner callback completes.

## Reproduction

Use a disposable PostgreSQL database owned by the test operator:

```bash
SOURCE_TEST_DATABASE_URL='postgresql:///source_submission_validation?host=/tmp' \
  node --test --test-concurrency=1 tests/submission-recovery-live.test.js \
  tests/submission-recovery.test.js tests/postgres-transactions.test.js \
  tests/postgres-regressions.test.js tests/client-retry.test.js
node --test --test-concurrency=1 tests/submit.test.js tests/sync.test.js
```

Tests use unique schemas, disposable Git repositories and owned child processes.
The local macOS validation used `/usr/bin/git` through PATH. The live tests skip
without the database environment variable; skips are not successful live proof.

## Limits

This is process interruption and lost-response proof, not host/power-loss,
network-partition or deployment failover proof. It does not solve hot-repository
load failures or establish an SLO. PostgreSQL is required. Git upload occurs first
and can leave a contribution ref after rollback. Unkeyed requests have no new
atomicity guarantee. No receipt expiry or automatic uncertain-mutation replay is
introduced. A recovery 404 can race an in-flight transaction and is not proof that
it will never commit. The receipt contains original lifecycle/evidence metadata,
so reads continue to require current authenticated principal scope.

## Local results (2026-11-10)

- Combined submission recovery plus existing submit/sync run: **20 passed, zero
  skips/failures**, 89.709 seconds.
- Final strengthened rollback, credential revocation, actual CLI recovery,
  PostgreSQL regressions/transaction tests and client retry run: **27 passed,
  zero skips/failures**, 78.378 seconds.
- Syntax lint: **125 JavaScript/MJS files**; `git diff --check` passed.
- Exact test names and timings: [verification output](submission-recovery-tests.txt).

These are local fixture durations, not throughput or latency claims. The owned
validation database was removed after the test processes exited.

## Full lifecycle benchmark mode

`scripts/benchmarks/integration.js --keyed-submissions` assigns an authenticated
submission key to each real agent process. After an unknown HTTP outcome, the
benchmark performs a read-only recovery lookup; it never replays the POST or
creates a replacement key. A failed/missing recovery still fails the run. The
original transport diagnostic and recovery duration remain in the proposal report.
Successful reconciliation is not counted as an error-free transport exchange.

`--lose-submit-response INDEX` requires keyed mode and an existing agent index.
The harness destroys that agent's response socket only after the real submission
transaction commits. It then requires that agent's recovery to succeed, checks
exact Work/Change counts, and continues through assembly, separately executed
verification, exact promotion, authenticated fetch and identical-tree baseline
comparison. Unkeyed/default benchmark behavior remains available for comparison.

Example (an operator-owned disposable PostgreSQL database is required):

```bash
SOURCE_TEST_DATABASE_URL='postgresql:///source_keyed_bench?host=/tmp' \
  node scripts/benchmarks/integration.js --agents 10 --repos 1 \
  --profile private-load --keyed-submissions --lose-submit-response 3 \
  --output /absolute/keyed-recovery-report.json
```

Submission timing includes any recovery lookup; `submissionRecovery.lookupMs`
also reports that lookup separately. Default request/admission deadlines are not
changed. `private-load` retains its explicitly declared 1000/minute per-address
push/submit profile and is not evidence for default-profile capacity. This mode
measures recovery within the controlled content-checking benchmark, not arbitrary
application CI or deployed network partitions.
