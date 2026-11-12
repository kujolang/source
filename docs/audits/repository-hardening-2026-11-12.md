# Source hardening review — 2026-11-12

## Repository and boundary

Source (`kujolang/source`), branch `codex/agent-native-integration`, initially clean. Starting and ending **implementation** SHA: `34b11f634271cae47163c8943e531f3a4be0a05d`. This is a fresh review, not a repetition of the October or November 10 fix reports. Bare skill invocation defaults to review: implementation, APIs, configuration, formats and schemas remain unchanged. Only this report and reproducible audit evidence are added. No video, deployment, tag, sibling repository or paused capacity campaign is changed.

Source brokers Git contributions, work, capability grants, durable verification and promotion. Important dependencies are Node, Git, pg/PostgreSQL, js-yaml, JSON/SQLite local stores, operator-configured OCI executors and Cloudflare Artifacts. Inspection concentrated on recent submit/integration/worker additions while covering every checklist area. This is a risk-directed review, not exhaustive security certification.

## Finding ledger

| ID | Priority / confidence | Area | Evidence and impact | Recommended action | Status |
|---|---|---|---|---|---|
| H12-1 | P1 / high | Worker throughput | `src/worker.js`, `_loop`, awaits `Promise.all` for the whole claimed batch before claiming again. The committed deterministic probe holds one job and completes another with concurrency=2: activeJobs=1, one queued job, but no refill while the slow job remains. Long checks leave otherwise available slots idle. | Refill only free slots as individual executions settle, preserving lease ownership, project fairness, shutdown and concurrency limits. Add a mixed-duration job regression. | Reproduced; not fixed in review mode. No measured throughput multiplier claimed. |
| H12-2 | P1 / high | CI coverage | `.github/workflows/ci.yml` runs ordinary `npm test` without a DSN; `package.json` test:postgres names only postgres-claims-live, postgres-live, postgres-regressions and store. Submission-recovery-live, verification-queue-live, verification-dispatch-live, integration-benchmark and workflow-comparison require a DSN and are absent from the live gate. Thus green CI can omit transaction rollback, cancellation fencing, dispatch and exact batch lifecycle regressions. | Add an explicit bounded integration PostgreSQL gate for these files; assert expected tests execute rather than skip. Keep OCI/browser requirements in a separate explicit gate. | Confirmed configuration gap; local checks do not repair CI. |
| H12-3 | P2 / high | Worker configuration | `SourceWorker` clamps several settings with Math.trunc/Math.min/Math.max without finite validation. Probe passes nonnumeric concurrency and handlerTimeoutMs: both become NaN; the conditional handler timeout is false. This affects direct library callers; CLI numberFlag falls back to defaults for nonfinite inputs. | Reject invalid numeric constructor settings before claiming jobs; distinguish supported zero values from malformed inputs. Test NaN, Infinity, fractional and string inputs against the documented contract. | Reproduced; not fixed. Not a remote-input exploit claim. |
| H12-4 | P2 / code-supported, impact unmeasured | Verification read amplification | `IntegrationBroker.evaluate` loads up to 1000 receipts and reads/hashes every referenced artifact before filtering superseded dispatch receipts. Repeat status/accept/dispatch evaluations repeat this work; repeated artifact hashes are not deduplicated within an evaluation. | Measure a realistic receipt history first. Consider per-evaluation hash deduplication or narrower reads while retaining required corruption checks and audit visibility. Do not install a persistent cache without invalidation semantics. | Needs workload measurement; no latency or memory saving claimed. |

No new P0 finding was established. Previously reported synchronous PostgreSQL pseudo-transactions and generic non-cooperative handler cancellation remain limitations; this review does not relabel them as new discoveries. The existing recording-under-load risk remains unresolved.

## Checklist coverage (0–16)

| Phase | Evidence / disposition |
|---|---|
| 0 Understand | Read package scripts, CI, prior audit, SECURITY, handoff and submit contract; traced remote selection, submit/recovery, broker, dispatcher, executor and worker implementation. Branch/SHA above. |
| 1 Baseline | Full existing suite, syntax lint, Cloudflare unit suite, root/Worker dependency audits, focused live integration checks and deterministic worker probes. Detailed receipts below. |
| 2 Complexity | API pagination helper, sync/async Git helpers and store transaction paths inspected. Divergence warrants contract caution; no broad rewrite recommended. |
| 3 Runtime | H12-1 reproduced; H12-4 code-supported. Candidate export batches Git object reads rather than spawning per file. No fresh capacity campaign or performance optimization claimed. |
| 4 Resources | Executor regular-file export capped at 10,000 files/256 MiB; subprocess response bound, workspace ownership journal, HTTP response cap and worker lease/timer lifecycle inspected. Constructor NaN remains a bound-validation gap. |
| 5 Agent context | No model invocation loop or repository MCP tool catalog to shrink. API fields/pagination, idempotent submit/recovery and evidence references provide progressive disclosure. CLI receipts and bounded diagnostics avoid replaying raw transport errors. Handoff is 10,837 bytes; submit guide 11,505 bytes; these are byte counts, not token estimates. |
| 6 Output | Detailed logs retained in ignored audit-results; committed concise probe receipt. Errors redact remote command output in authenticated Git. Optional unpaginated API lists preserve legacy contracts; do not silently truncate them. |
| 7 Failures | Submit distinguishes unknown transport outcomes from explicit retryable admission refusal; keyed recovery exists. Worker malformed constructor behavior reproduced. Original test failures/skips recorded separately below. |
| 8 Security | Read capability/guard call sites, same-origin API override restriction, disabled redirects, secret scanner redaction, candidate export path and blob integrity checks, lease fencing and recovery ownership checks. Dependency audit reported no advisories. Local Git authentication still constructs an extraHeader in subprocess argv; process visibility is an operator trust-boundary concern, not a newly demonstrated remote exploit. No credential values captured. |
| 9 Concurrency/state | Inspected dispatch epochs, cancellation transactions, job lease checks, promotion fences and worker batch scheduling. Deterministic worker probe uses deferred completion, not timing sleeps. Reviewed async transaction drain-before-rollback and historical sync transaction limitation. |
| 10 Contracts | Source remote remains additive; GitHub origin retained. Sync uses atomic explicit branches/tags, no deletion. No public interface changes in this review. Malformed constructor handling needs an explicit contract. |
| 11 Supply chain | Root runtime dependencies pg/js-yaml and pinned Worker Wrangler lock checked through installed dependency audits. CI actions/PG image pinned. No dependency replacement/removal justified. Audit results reflect registry responses at execution, not an enduring guarantee. |
| 12 Tests | Full existing suite and focused live checks; retained repeatable worker observation probe. Missing mixed-duration refill regression and constructor rejection coverage identified. |
| 13 CI | H12-2: new live tests are outside configured PostgreSQL command. Syntax lint is node --check, not semantic/static type analysis. No separate type-check/build stage for native JS core. |
| 14 Docs | Compared current submit/recovery docs and concurrency measurements with implementation; previous serial comparison remains a single scripted pair. Handoff preserves historical checkpoints; this report adds a dated current checkpoint rather than rewriting historical evidence. |
| 15 AI-native DX | Explicit focused tests, JSON reports and named evidence files help agents. A green default suite with skipped live guarantees is misleading without H12-2 disclosure. No new agent framework or schema expansion proposed. |
| 16 Dead weight | Historical raw benchmark/video assets support released claims; preserve. Optional adapters and release scripts lack evidence of disuse; no deletion justified. |

Phases 17–18 implementation/post-fix comparison are not applicable in review mode. Baseline verification is still required and recorded. Vendored frontend assets and external provider internals were not exhaustively inspected.

## Compatibility and impact

No implementation changes, speedup, memory reduction, token saving or dependency reduction are claimed. The worker observation measures slot utilization under a held job, not wall-clock throughput. Existing serial/concurrent benchmark results are not evidence that H12-1 is fixed. No cross-repository change is required for H12-1–3. H12-4 requires representative local evidence before choosing a fix. No release or external service change is needed for this review.

## Remaining work

- **P1:** work-conserving worker refill and CI execution of existing live regression tests.
- **P2:** explicit finite constructor validation.
- **Needs more evidence:** cost of repeated artifact integrity reads; actual OCI/browser execution and production environment behavior.
- **Already known:** synchronous PostgreSQL transaction semantics, non-cooperative generic handler cancellation and recording-under-load failures.
- **Not worth changing:** cosmetic module rewrites, removal of historical evidence, replacing dependencies without measured benefit.

## Verification receipt

| Exact command | Result |
|---|---|
| `PATH="/usr/bin:$PATH" npm test` | 408 tests: 371 passed, 37 skipped, zero failures; 283.285s. No DSN or container image in this baseline. |
| `npm run lint` | Pass: syntax checked 127 JavaScript files. |
| `npm run test:cloudflare` | 6 passed, zero failures/skips. |
| `npm audit --omit=dev --json` | Zero reported advisories; 16 dependencies in audit metadata. |
| `npm audit --prefix cloudflare/artifacts-bootstrap --json` | Zero reported advisories; 91 dependencies in audit metadata. |
| `node docs/audits/evidence/hardening-2026-11-12/worker-probes.mjs` | Pass: reproduces H12-1/H12-3 observations against unchanged source. Assertions describe defects, not repaired behavior. |
| `PATH="/usr/bin:$PATH" SOURCE_TEST_DATABASE_URL='postgresql:///source_hardening_20261112?host=/tmp' node --test --test-concurrency=1 tests/integration-benchmark.test.js tests/workflow-comparison.test.js tests/integration-semantic-live.test.js` | 6 passed, 2 OCI semantic cases skipped for absent image/version; zero failures; 92.514s. |
| Focused live fencing command below | 19 passed, zero failures/skips; 132.193s. |
| `docker info` | Unavailable: daemon socket not connected. No container build/failover/browser pass claimed. |
| `git diff --check` | Pass. |

Focused fencing command: `PATH="/usr/bin:$PATH" SOURCE_TEST_DATABASE_URL='postgresql:///source_hardening_20261112?host=/tmp' node --test --test-concurrency=1 tests/submission-recovery-live.test.js tests/verification-queue-live.test.js tests/verification-dispatch-live.test.js`.

The standard PostgreSQL fleet/store gate and hosted CI were not rerun. Full-suite skips remain explicit even where focused checks cover the same cases. Test commands overlapped, so elapsed times are verification receipts, not performance comparisons. No implementation changed between baseline and probes. Logs: `audit-results/hardening-2026-11-12/` (ignored). Reproducible finding probe: [worker-probes.mjs](evidence/hardening-2026-11-12/worker-probes.mjs), [result](evidence/hardening-2026-11-12/worker-probes.json).

Owned test database `source_hardening_20261112` was dropped after both live test processes exited. No baseline failures were observed; no implementation was changed.

## Local finding register

SignalBox: three captures, two high-value review signals; no duplicates found in targeted searches. Exact and concept retrieval passed for all stored items. H12-4 was not captured because measured impact remains unestablished; existing historical risks were not duplicated.

- H12-1: `cap_e2735662-26b4-4f77-861c-5029ee2967ca`, `sig_55b4bc48-5517-4cea-9916-6bd82787443b`.
- H12-2: `cap_0ad98e90-7d2a-4c3f-9bdb-6df2e85546fe`, `sig_dbbbd137-f3d9-4996-8b96-2937bb0f9443`.
- H12-3: `cap_4696cac1-b81b-4572-a973-a91042182ce3`; capture only.
