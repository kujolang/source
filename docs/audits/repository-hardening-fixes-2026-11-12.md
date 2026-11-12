# Source hardening fixes — 2026-11-12

## Boundary and compatibility

User authorized fixing H12-1, H12-2 and H12-3 from the [review](repository-hardening-2026-11-12.md). Starting SHA `80cd0d5`, branch `codex/agent-native-integration`, clean working tree. Only Source is changed. H12-4 artifact-read cost remains a measurement question; broader capacity work remains paused. No video or deployment changes.

## Implemented

| Finding | Root cause and fix | Regression / impact |
|---|---|---|
| H12-1 | Worker waited for all jobs in a batch. It now tracks active jobs, serializes claims for free slots, and wakes on a freed slot. A single slot-wakeup callback avoids attaching repeated race callbacks to a long-running job. Partial claims keep polling/notifications active. Shutdown stops further claim cycles and drains already claimed work. | Mixed-duration regression starts queued work while its slow peer remains active. Existing concurrency/timeout/lease/error tests retained; new in-flight-claim shutdown test verifies one claim, one completion and zero active jobs. Queue burst/fairness logic unchanged. No throughput multiplier claimed. |
| H12-2 | Default tests skip database-dependent cases and CI's older PostgreSQL command omitted new suites. Add `npm run test:integration` and invoke it in the PostgreSQL CI job. Runner requires DSN, sequentially executes five named files, checks child exit and TAP summary, and rejects any skipped/failed/cancelled tests or fewer than 25 executions. | Missing-DSN invocation must exit 1. Live execution must pass all 25 with zero skips. OCI/browser tests remain separate environment-specific gates. Floor updates require reviewed inventory changes. |
| H12-3 | Nonfinite constructor values became NaN and bypassed bounds/timeouts. Validate every numeric worker setting before initialization and validate stop timeout before changing state. | Tests reject NaN, infinities, malformed/empty strings, null, booleans and objects. Finite numeric strings, fractional truncation, clamping and intentional zero timeout/retry/jitter semantics remain supported. CLI fallback unchanged. |

Public HTTP APIs, persistence schemas, file formats, environment variable names and queue lease contracts are unchanged. Direct library callers passing invalid numeric settings now receive TypeError rather than silently disabled bounds. Existing finite coercion is preserved. No cross-repository changes required.

## Verification and baseline

Review baseline: 371 full-suite passes, 37 skips, no failures; 25 focused live passes. Original reproduction stays immutable and describes the old revision; it is not a current pass/fail gate. Practical behavioral regressions now live in tests/worker.test.js.

An initial fix verification passed all 25 live cases but default discovery failed because `scripts/test-live-integration.js` matched Node's test-file discovery. Renaming it `scripts/run-live-integration.js` corrects the root cause without suppressing tests. Both suites were rerun after this correction and the final bounded wakeup implementation. Detailed logs are retained under ignored `audit-results/hardening-fixes-2026-11-12/`.

Ending verified implementation: `824c68b` (worker fix `61219eb`). All final checks below passed; no known introduced regression remains.

| Exact command | Final result |
|---|---|
| `PATH="/usr/bin:$PATH" npm test` | 411 total: 374 passed, 37 conditional skips, zero failures; 374.384s. |
| `node --test tests/worker.test.js` | 16 passed, zero failures/skips. |
| `PATH="/usr/bin:$PATH" SOURCE_TEST_DATABASE_URL='postgresql:///source_hardening_fixes_20261112?host=/tmp' npm run test:integration` | 25 passed, zero failures/skips; 343.121s; gate exited 0. |
| `PATH="/usr/bin:$PATH" SOURCE_TEST_DATABASE_URL='postgresql:///source_hardening_store_20261112?host=/tmp' npm run test:postgres` | 23 passed, zero failures/skips; 80.167s. |
| `env -u SOURCE_TEST_DATABASE_URL node scripts/run-live-integration.js` | Expected refusal, exit 1; explicitly checked. |
| `npm run lint` | Syntax checked 128 JavaScript files. |
| `npm run test:cloudflare` | 6 passed, zero failures/skips. |
| `git diff --check` | Pass. |

Both owned disposable databases were dropped after their test processes exited. Logs overlap, so durations are not before/after performance measurements. Default-suite skips are recorded even when separate database gates exercise those cases. Docker-dependent checks remain unavailable as established in the review; hosted CI has not been claimed green by this local receipt. No new latency, memory, token or dependency savings are claimed. Existing non-cooperative generic handler cancellation, synchronous PostgreSQL transaction limitations and Docker availability are outside these three fixes.
