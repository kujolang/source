# Source hardening — 2026-11-10

## Repository and scope

- Repository: `https://github.com/kujolang/source`, branch `main`.
- Starting SHA: `a7a5a0bda9158290e98750984dc8c6c70856b097`; initially clean.
- Ending implementation SHA: `0f0b204a30f9694e40bca98a5cabad14534ea497`; this report and contract documentation follow in a documentation commit.
- Fix-mode, repository-wide, risk-directed follow-up to the [2026-10-13 audit](repository-hardening.md). That historical report and its baseline remain unchanged.
- Source connects Git changes with work, sessions, capability grants, evidence and authorized promotion. Dependencies/integrations include Node, Git, JSON/SQLite/PostgreSQL, pg, js-yaml, isolated action runtimes, Kujo evidence, and the Cloudflare Worker/Artifacts bridge.
- Environment: macOS, Node v26.12.1, isolated local PostgreSQL on port 55439. No deployment, remote repository creation, credentials, or sibling source changes.

## Baseline

The first `npm test` attempt failed to load dependencies because this checkout had no installed root packages. `npm ci` and `npm --prefix cloudflare/artifacts-bootstrap ci` restored the locked dependencies. This is an environment prerequisite, not a source regression.

An initial installed baseline overlapped the addition of regression tests; it is not used as the immutable baseline. The clean baseline was rerun from `git archive a7a5a0b` in `/tmp/source-hardening-baseline-a7a5a0b`, using the same root dependency installation. The regression-before log separately proves two shutdown races, missing-cursor restart, SQLite wildcard prefix leakage, and trimmed file contents against the original implementation. The short-lease and PostgreSQL pagination tests extend these cases.

Before dependency changes, the root install audit reported zero vulnerabilities. The Worker development dependency tree reported three affected packages: undici (high), miniflare and wrangler (moderate). These are package audit results, not a demonstrated production exploit.

## Finding ledger

All fixed findings below are high confidence, supported by source and behavioral tests.

| ID | Priority | Area | Evidence and impact | Action | Status |
|---|---|---|---|---|---|
| N1 | P1 | Writer lifecycle | `writer-lease.js`: a renewal resolving after stop restored `lease`; acquisition resolving after stop installed a timer; repeated starts could create multiple timers | Guard asynchronous results by lifecycle generation and stopped state; make starts idempotent | Fixed |
| N2 | P1 | Lease scheduling | Minimum 1,000 ms lease had its first renewal scheduled at 1,000 ms, leaving no margin before expiration | Renew at one-third of the configured lease, including short leases | Fixed; mock-clock regression |
| N3 | P1 | Storage listing | JSON/SQLite restarted at the beginning when cursor ID was absent; synchronous PostgreSQL applied LIMIT before direct-child projection, deduplication and cursor filtering | Exclusive lexical lower bounds; shared PostgreSQL query filters/projects before LIMIT | Fixed; JSON, SQLite and live PostgreSQL tests |
| N4 | P1 | Storage scope | SQLite and async PostgreSQL interpreted `_`/`%` in a logical path as LIKE wildcards; SQLite also used case-insensitive LIKE | Literal prefix matching; deterministic PostgreSQL C collation; Unicode-aware prefix length | Fixed; live backend regression |
| N5 | P1 | Source fidelity | `showFileAsync` reused a command helper that trimmed leading/trailing whitespace | Preserve exact UTF-8 text for file reads while retaining normalized command metadata | Fixed; real Git regression |
| N6 | P1 | Dependency surface | Worker lockfile pinned Wrangler 4.149.0 with an audit-flagged undici dependency | Pin Wrangler 4.160.0; regenerate lockfile; install/audit Worker tooling in CI | Fixed; zero reported advisories after update |
| N7 | P2 | Contract docs | `.spec.yml` still said Node >=18 although imports/runtime and package engines require newer supported branches | Align spec with package engines; document corrected listing/file/lifecycle behavior | Fixed |

## Coverage, phases 0–18

| Phase | Evidence and disposition |
|---|---|
| 0 Repository | Read README, package scripts/locks, SECURITY, spec, CI, previous audit, deployment blockers; traced API, stores, Git, workers, leases and adapters. |
| 1 Baseline | Clean archived baseline, root/Worker installs, syntax check, Worker tests, package audit and explicit failed-regression evidence. |
| 2 Complexity | Removed divergent PostgreSQL sync/async list implementations using one query builder. Retained broader service/store seams for compatibility. |
| 3 Runtime | Inspected bounded admission, async Git, bulk reads and cursor queries. Corrected list-query work ordering; no latency/throughput claim. |
| 4 Resources | Inspected semaphores, request body limits, Git pipes, secret streaming, worker timers and container cleanup. Fixed writer timer lifecycle. |
| 5 Agent context | No model loop or repository MCP registry. Discovery/field selection/pagination are the relevant boundaries; corrected cursor restarts that could repeat context. No token estimates or savings claimed. |
| 6 Output | Preserve detailed test/audit logs locally; keep CLI/demo receipts and field selection. File content must remain complete, including whitespace. |
| 7 Failure semantics | Deferred promises reproduce shutdown races without sleeps. Real-store listing tests cover missing cursors and empty pages. Existing error-path tests retained. |
| 8 Security | Reviewed capability scope, Git authorization/revision validation, API body bounds, secret response bounds, Artifacts URL/token handling, and storage prefix boundaries; fixed literal scoping and audited dependencies. No certification claim. |
| 9 Concurrency/state | Generation guards reject late results; repeat starts are idempotent; short-lease scheduling tested with a mock clock. Existing project-lock, queue and Postgres concurrency tests retained. |
| 10 Contracts | Method signatures, record formats and config unchanged. Invalid/missing cursor now means exclusive lower bound; source text retains whitespace; literal namespace matching is stricter. |
| 11 Supply chain | Exact Worker tooling pin/lock refresh; root dependencies unchanged. CI now audits Worker dev tooling too. Docker runtime is version/checksum pinned; build execution unavailable locally. |
| 12 Tests | Added lifecycle, Git text fidelity, JSON/SQLite list regressions and live PostgreSQL sync/async list coverage. Full-suite and live-store receipts below. |
| 13 CI | Existing tests automatically cover new cases; add a high-severity Worker dependency audit gate. Future upgrades update the exact Wrangler pin and lockfile, then run Worker tests and dry-run build. |
| 14 Docs | Correct runtime spec; document cursor/literal-prefix/renewal/source-text contracts; retain historical audit. |
| 15 Agent experience | Shared listing semantics and precise docs reduce backend-specific surprises. Full result evidence remains available without copying logs into chat or memory. No new agent-only framework. |
| 16 Dead weight | No safe unused release assets, adapters or fixtures proved removable. Retain them; remove only redundant list implementation. |
| 17 Implementation | Findings N1–N7 implemented with focused regression coverage. |
| 18 Verification | Full local and live PostgreSQL checks, demos, syntax, whitespace, dependency audits, Worker dry-run and release metadata gate; limits recorded below. |

## Compatibility and efficiency

Public method signatures, HTTP schemas, persisted file formats, configuration and environment names are unchanged. A missing/deleted cursor now continues after its lexical value rather than restarting. PostgreSQL C collation stabilizes ordering of generated ASCII IDs; clients should treat cursors as opaque IDs. Literal scope matching no longer admits neighboring paths through SQL wildcards. File reads now preserve whitespace, so consumers that relied on trimming must normalize explicitly. Repeated writer starts no longer reacquire ownership or create extra timers.

For the minimum lease, the deterministic renewal schedule changes from 1,000 ms to 333 ms. Shutdown-after-acquire leaves zero timers instead of one; shutdown-after-renew reports inactive instead of active. The fixture `cursor=B, limit=1` with A/C records returns C instead of A. Worker dependency audit count changes from three affected packages to zero. These are correctness/resource-count measurements, not runtime benchmarks. No memory, throughput, build-time, binary-size or token savings are claimed. Root runtime dependency surface is unchanged.

## Remaining work and cross-repository requirements

No sibling changes are required. No newly discovered unresolved item was admitted during this pass. Existing items from the October audit remain: **P1** synchronous PostgreSQL pseudo-transactions and end-to-end arbitrary handler cancellation; **needs more evidence** deployment-specific fencing during external Git writes, independent capacity/security validation and regional recovery. These require compatibility or operational design; the current changes do not claim to solve them. **Not worth changing:** broad module rewrites, dependency substitution and cosmetic cleanup without behavior evidence. Vendored UI assets and remote platform internals were not exhaustively audited.

Local Docker build/failover remains unavailable because the daemon is not running. Hosted CI on this revision is separate evidence; earlier successful CI is not a pass for this revision. No live Cloudflare deployment was attempted.

## Verification receipt

All locally executable checks below passed. No known introduced regression remains. Detailed logs are retained in ignored `audit-results/hardening-2026-11-10/`; they are not committed or copied into Strata.


| Exact command (Source root unless specified) | Result |
|---|---|
| `npm test` in clean archived starting revision | 253 tests: 245 passed, 8 skipped, zero failures; 76.254 s |
| `node --test tests/concurrency.test.js tests/git.test.js tests/store.test.js` against original source with new tests | Expected 5 regression failures; log `source-regressions-before.log` |
| `SOURCE_TEST_DATABASE_URL=postgresql://robertdevore@127.0.0.1:55439/postgres node --test --test-name-pattern='Postgres listing\|minimum-duration writer' tests/postgres-regressions.test.js tests/concurrency.test.js` in archived source with new tests | Expected 2 regression failures; log `source-additional-before.log` |
| `npm test` after fixes | 260 tests: 253 passed, 7 PostgreSQL skips, zero failures; 80.227 s |
| `SOURCE_TEST_DATABASE_URL=postgresql://robertdevore@127.0.0.1:55439/postgres npm run test:postgres` | 22 passed, zero skipped/failures; includes concurrency, fleet, byte fidelity, pagination and migration |
| `npm run test:scale` | 42 passed, zero skipped/failures |
| `npm run lint` | 79 JavaScript files syntax checked |
| `npm run format:check` / `git diff --check` | Pass |
| `npm run test:cloudflare` | 6 passed |
| `npm run demo:contest` | Pass |
| `npm run demo:hybrid` | Pass; emulated Artifacts binding, real Git/Source/Worker handlers |
| `node bin/source.js help` | Pass |
| `npm audit --omit=dev --json` | Zero reported vulnerabilities |
| `npm audit --prefix cloudflare/artifacts-bootstrap --json` | Zero reported vulnerabilities, including dev tooling |
| `npm exec --prefix cloudflare/artifacts-bootstrap -- wrangler deploy --dry-run --config cloudflare/artifacts-bootstrap/wrangler.jsonc` | Pass; 3.69 KiB / gzip 1.54 KiB bundle, no deployment |
| `kujo run ../shipcheck/shipcheck.kujo gate --dir . --format json` | Pass; zero error findings, 3 heuristic warnings (README usage, no Kennel manifest, no recognized entry point) |
| `kujo doctor --deep --json` | Zero failures; host Composer output and dirty-worktree notices are not Source failures |
| `docker info` | Unavailable: local daemon socket absent; no local container build/failover pass claimed |

The clean archive lacks optional sibling fixtures; its eight skips comprise six
PostgreSQL cases and two optional Kujo fixtures. The current checkout exercises
the sibling fixtures; its seven skips are all PostgreSQL cases covered by the
separate live gate. Timings overlap other verification and are not a performance
comparison. The full Kujo Eval wrapper was not separately rerun: its commands
(test, scale, lint, whitespace, help, production audit, doctor) were executed
individually. A first Worker dry-run used a nonexistent `.toml` path; rerunning
with the actual `wrangler.jsonc` passed.

Commits: `ac091dc` writer lifecycle; `7a5b8af` storage listing; `420def1` file
fidelity; `0f0b204` Worker tooling and CI audit gate. The tests are stable behavioral
ratchets; no benchmark budgets need manual adjustment.
