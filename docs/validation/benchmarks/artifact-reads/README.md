# Artifact-read amplification — 2026-11-12

## Result and scope

The remaining H12-4 issue is meaningful when receipts share content-addressed output. Source now reads and hashes each distinct artifact once **per evaluation**. It stores only hashes in a local Set (bounded by the existing 1000-receipt limit), retains no artifact bytes in a cache, and does not reuse integrity results across calls.

Every distinct artifact still undergoes the same missing/content-integrity checks, including artifacts from receipts later excluded by dispatch selection. This deliberately preserves historical-corruption failure behavior. No receipt, artifact, provenance, expiry, policy, dispatch or acceptance check is removed. Also corrected the misleading comment that all stores verify hashes on reads: JSON/SQL store reads do not uniformly do so; broker hashing remains necessary.

## Paired local measurement

Seven measured evaluations per implementation/case, after one warmup each; old broker from commit `0d38f8e`, current broker loaded in the same Node process. Execution order alternates baseline-first/current-first on the **same fixture and store**. Actual filesystem reads, no injected delays. JSON/local filesystem backend; three cases with 1 MiB output artifacts. Repeated case has 32 distinct valid execution receipts sharing identical output; unique case has 32 distinct outputs. This models repeat verification logs, not a measured production distribution.

| Case | Before median ms | After median ms | Artifact reads/evaluation |
|---|---:|---:|---|
| single | 78.972 | 76.506 | 1 → 1 |
| repeated | 198.135 | 90.248 | 32 → 1 |
| unique | 176.180 | 173.551 | 32 → 32 |

Repeated case: **54.45% lower median elapsed time**, 32 MiB → 1 MiB read/hashed per evaluation (**96.875% reduction**). Baseline range 156.319–387.249ms; optimized range 76.977–126.059ms. Control medians changed only 1.49–3.12%, with overlapping ranges; no improvement claim for unique/single output. Every paired evaluation returned the same complete result, not merely the same pass boolean. No memory-allocation or production PostgreSQL latency claim.

Initial separate before/after runs showed large shifts even in controls; they are retained as pilot evidence, not used for the headline. The alternating comparison reduces that confound but is still a local warm-cache microbenchmark, not production capacity certification. Timing ran before tests, without other task-started test suites in parallel. No cache flush, hardware isolation or statistical confidence interval claimed.

## Evidence and reproduction

- [Paired raw evidence](paired.json) — authoritative timing comparison and read counts.
- [Initial baseline](before.json), [initial after](after.json) — pilot observations.
- Runner: `scripts/benchmarks/artifact-reads.js`.

From Source root:

```sh
PATH="/usr/bin:$PATH" node scripts/benchmarks/artifact-reads.js /absolute/new-report.json 0d38f8e
```

Output refuses overwrite. Temporary Git/store fixtures are removed in finally blocks. The optional final argument loads only the archived broker implementation, resolving its imports to unchanged dependencies in the current checkout; this comparison is valid for this narrowly scoped broker change, not arbitrary future dependency revisions. Exact broker content hash and baseline revision are in the paired report. Baseline store/Git/verification dependencies were unchanged during measurement.

## Regression and compatibility

New synchronous/asynchronous store-path tests first failed on the original implementation (3 reads versus expected 2). After deduplication, they require identical evaluations, one read per distinct artifact, fresh reads on a subsequent call, rejection of missing/shared corrupted output and rejection of a corrupted distinct superseded artifact. Full and live integration checks cover authorization, receipt persistence, dispatch, retirement and promotion.

Public APIs, schemas, configuration and file formats unchanged. Semantic boundary: a successful content-address integrity check is reused only within one evaluation; mutation/removal after that read is detected on the next evaluation. This introduces no stronger snapshot or concurrent-write guarantee than existing store reads. No persistent cache or invalidation protocol added. No cross-repository follow-up required.

## Final verification

Implementation `57032c6`; starting revision `0d38f8e`. Exact commands from Source root:

| Command | Result |
|---|---|
| `PATH="/usr/bin:$PATH" node --test --test-name-pattern='evaluation reads each distinct artifact' tests/integration-broker.test.js` against original broker | Expected two regression failures: 3 reads rather than 2. |
| `PATH="/usr/bin:$PATH" node --test tests/integration-broker.test.js` after fix | 12 passed, zero failures/skips. |
| `PATH="/usr/bin:$PATH" npm test` | 413 total: 376 passed, 37 conditional skips, zero failures; 399.326s. |
| `PATH="/usr/bin:$PATH" SOURCE_TEST_DATABASE_URL='postgresql:///source_artifact_reads_20261112?host=/tmp' npm run test:integration` | 25 passed, zero skips/failures; 326.549s. |
| `npm run lint` | 129 JavaScript files syntax checked. |
| `git diff --check` | Pass. |

Raw verification logs remain under ignored `audit-results/artifact-reads/`; [checksums and concise receipts](verification.json) are committed. Tests ran after timing, with some test suites overlapping; test durations are not performance measurements. Owned database was dropped after the live process exited. No Docker/browser run or hosted CI pass is claimed. No known introduced regression remains.

 Historical H12-4 is resolved for repeated artifacts; distinct-history reads remain intentional integrity checks rather than an unresolved promised optimization.
