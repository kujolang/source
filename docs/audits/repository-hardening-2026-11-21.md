# Source hardening — 2026-11-21

## Repository

- Repository `kujolang/source`, branch `codex/agent-native-integration`.
- Starting revision `7fb0ac7c047a1be9e174aa69e468a41ff45ff3fe`, clean checkout.
- Implementation revision `18fcb845b1098fb8e2d8db574587bd12d3b4c3e8`. This report and its evidence follow in a separate commit.
- Source coordinates Git contributions, evidence, decisions, integration, and canonical promotion. It uses Node, Git, PostgreSQL and `pg`, local JSON and SQLite stores, `js-yaml` for workflow import, and optional Cloudflare Artifacts and OCI execution.

## Findings and implementation

| ID | Priority | Area | Finding and evidence | Action and verification |
|---|---|---|---|---|
| H21-1 | P0, high confidence | Writer fencing | PostgreSQL deleted a released lease row, allowing a later acquisition to reuse the previous token. A controller could also accept an assertion after stop or let a stale failure invalidate a newer generation. | Expire the row and keep its token. Revalidate the controller generation after the database assertion. Live PostgreSQL tests cover token monotonicity and stale renew/release. Controlled promises cover both outcomes of an assertion spanning restart. `8375b38` |
| H21-2 | P0, high confidence | Git evidence | Bare-repository diffs mapped command errors to empty results. An omitted base tried to diff against the working tree, and contribution lifecycle writes preceded the diff. | Compare an omitted base to the repository's empty tree. Use bounded Git reads without external diff or text conversion. Propagate sanitized failures and preflight scans and footprint size before writing records. Tests cover genuine empty changes, empty-base diffs, missing revisions, and rejection without partial Work creation. `addb081` |
| H21-3 | P0, high confidence | Canonical promotion | Asynchronous multi-repository promotion checked the policy within each write lane. A rejected lane could release the lock while sibling Git work was still running. The async path also fetched metadata twice, once through the synchronous store. | Preflight policies and binding consistency before starting writes. Stop scheduling targets on the first exception and drain started writes before releasing admission. Reuse the asynchronously loaded metadata. Regressions cover protected targets, in-flight draining, and concurrent project updates. `addb081` |
| H21-4 | P1, high confidence | HTTP resource ownership | A disconnected waiter occupied the queue until its turn. An active disconnect freed the request slot while the handler could still run. Artifact admission released after handing bytes to the socket while buffered bytes could remain. | Cancel pending admission on disconnect, make permit release idempotent, and retain permits through handler exit and response completion. Tests cover queue reclamation, disconnected handlers, slow artifact responses, and Git backend admission. `ba7ffa4`, `8c96b0f` |
| H21-5 | P1, high confidence | Worker scheduling | `JobQueue` omitted the PostgreSQL notification seam. An unavailable listener can return false before the intended poll delay. Idle notification waits and an in-progress listener connection also had incomplete shutdown handling. | Forward committed PostgreSQL notifications, bound polling and lease timers, retain the delay on listener failure, and cancel idle waits. Restrict handler lookup to registered properties. Live regression and paired benchmark verify wakeups. `5b6b0c7` |
| H21-6 | P1, high confidence | Local evidence integrity | JSON store artifact bytes were written directly to their final address. A reader could observe a partial artifact, and failed metadata renames could leave staging files. | Publish complete bytes using an exclusive temporary file and atomic rename. Reuse publication for JSON records and counters. Tests hold an artifact mid-write and verify cleanup and subsequent writes after a failed rename. `e856825` |
| H21-7 | P1, high confidence | Webhook integrity | The webhook computed its MAC after UTF-8 decoding the body, violating the wire-byte signature contract. Text and binary readers duplicated the same admission logic. | Authenticate the exact bounded bytes and then decode strict UTF-8. Reuse the byte reader. Tests cover signed non-ASCII JSON and rejection of authenticated malformed encoding. `8c96b0f` |
| H21-8 | P1, high confidence | Client credential handling | The CLI sent the URL-scoped authorization header in Git process arguments. | Use Git's environment-backed configuration for the same scoped header. Retain disabled redirects and sanitized failure diagnostics. Tests check argument/environment separation and exercise actual Git submit/sync. `18fcb84` |

## Baseline and performance

The verification table records the clean detached baseline and the verified implementation. Default checks exclude PostgreSQL, browser, and OCI cases unless explicitly configured. The two live groups used disposable local PostgreSQL 14.20 databases. The dedicated final PostgreSQL run used the 5,000-agent CI setting, while the baseline used the default 1,000-agent setting. Suite timing overlaps other checks and is a verification receipt.

The [paired worker benchmark](evidence/hardening-2026-11-21/worker-wakeup.json) alternated baseline and current against the same local PostgreSQL server, with warm listeners and one enqueue to an idle worker using a 250 ms poll. Each sample performed one empty claim and handled the same payload once. Across seven samples per revision, median enqueue-to-handler latency was **261.3 ms → 29.5 ms**, with ranges of 256.4–446.6 ms and 9.3–32.1 ms. Each sample starts just after an empty claim and measures the idle-worker scenario. Use [the benchmark script](evidence/hardening-2026-11-21/worker-wakeup.mjs) with a disposable database and a dependency-installed baseline checkout. No throughput, RSS, build-size, or token improvements were measured.

## Checklist coverage

| Phase | Evidence and disposition |
|---|---|
| 0. Repository | Read package/CI/spec, prior audits and security policy. Traced HTTP/Git/CLI, service mutations, evidence, verification, stores, workers, writer fencing and backup verification. |
| 1. Baseline | Detached full-suite rerun plus CI scripts, PostgreSQL gates and paired wakeup fixture. Counts below. |
| 2. Complexity | Consolidated HTTP byte readers, JSON publication and bounded multi-repository loops. Retained backend-specific transactions and Git subprocess adapters for their distinct contracts. |
| 3. Runtime | Measured idle worker wakeup. Async Git paths avoid synchronous metadata reads. The existing broker artifact read deduplication remains covered by its original paired receipt. |
| 4. Resources | Traced request/tenant/global/body/artifact admissions, database listener lifecycle, Git subprocess output bounds and OCI cleanup. Added regressions for permit lifetime and cancellation. |
| 5. Agent context | Discovery, field selection, pagination, evidence references, scoped idempotency and keyed recovery provide progressive disclosure and replay control. Source hosts no model loop or MCP tool-registration schema. |
| 6. Output | Git errors carry sanitized diagnostics; benchmark evidence is a small committed JSON receipt. Test logs are outside the tracked tree. |
| 7. Error semantics | Git failures propagate, active ref work drains, signed malformed JSON fails, atomic writes clean staging on handled errors, and notification failures retain polling. |
| 8. Trust boundaries | Reviewed server capability scope and Git routing, webhook MAC, Git diff invocation and client credential transport, writer fencing, backup integrity checks and runner configuration. See security and remaining work below. |
| 9. Concurrency | Reviewed database transaction draining, project locks, writer restart, notification shutdown and request disconnects. Regression tests control ordering with promise barriers and fake timers where appropriate. |
| 10. Contracts | Checked HTTP statuses and payloads, queue fallback behavior, store formats, and explicit compatibility differences below. |
| 11. Supply chain | Reviewed lockfiles, pinned CI actions and image, and ran registry audits on root runtime and Cloudflare Worker dependencies. Preserved current dependencies. |
| 12. Tests | New regressions cover observed failure paths and fit existing default or live CI suites. |
| 13. CI | Live PostgreSQL regression tests are in the existing `test:postgres` file list. Benchmark uses fixed work and reports variation, with no timing threshold in CI. |
| 14. Documentation | Updated multi-repository behavior, contribution scanning, worker wakeups, and the writer lease release contract. |
| 15. Agent developer experience | Kept exact verification commands, compact benchmark evidence, structured HTTP errors and stable replay interfaces. |
| 16. Dead weight | Removed duplicated implementations where behavior was covered. Kept optional integrations, release scripts and historical benchmark evidence. |
| 17. Implementation | Seven small implementation commits listed in the finding ledger. |
| 18. Verification | Final checks and limitations recorded below. |

## Security and compatibility

HTTP routes, response shapes, public CLI flags, schemas, environment variable names and artifact paths are retained. Incomplete Git scans now return an error. An absent base uses the empty tree, and malformed webhook encodings return `400` after successful authentication. The existing `WRITER_LEASE_LOST` response applies to stale assertions. Direct worker configuration now caps polling at five minutes and leases at one day. Writer-lease rows survive release to support monotonic tokens. Authenticated contributor Git calls use `--config-env`, which is available on the Git versions exercised here (2.42 and 2.50). Operators should retain those rows during routine maintenance and roll forward writer nodes together to preserve token semantics.

Canonical updates keep Git compare-and-swap. Git ref writes across repositories can partially succeed on operational failure, then reconcile when retried. Metadata transaction rollback cannot rewind Git. File-backed evidence publication is atomic for readers and still uses the documented single-node store. No external service or sibling repository changes are required.

Previously recorded work remains on synchronous PostgreSQL transaction semantics and arbitrary JavaScript handlers that ignore cancellation. Full fencing of external Git side effects still needs deployment-level evidence. Optional provider internals and vendored assets were outside source-level verification. No new open finding was admitted in this pass.

## Verification receipt

Host tests ran on Node 26.12.1 with Apple Git 2.50.1 for the full verification. Focused tests also ran on Node 22.23.4, the version pinned by CI. For host commands below, `PATH="/usr/bin:$PATH"` selects Apple Git. PostgreSQL commands use a disposable local database and the `SOURCE_TEST_DATABASE_URL=postgresql:///<database>?host=/tmp` environment variable.

| Command | Baseline | Final |
|---|---|---|
| `PATH="/usr/bin:$PATH" npm test` | 373 passed, 39 skipped, one cancellation. The 101-proposal planner test reached the 120-second limit while checks overlapped. | 388 passed, 39 skipped, zero failures or cancellations. The planner case passed. Default run began before the final client-only commit. |
| `PATH="/usr/bin:$PATH" node --test --test-name-pattern='explicit larger batch' tests/integration-planner.test.js` | Detached rerun passed in 97.4 seconds. | Passed in the full suite in 109.7 seconds. Suite timings are affected by concurrent checks. |
| `npm run test:scale` | 42 passed. | 43 passed. |
| `npm run test:postgres` | 23 passed, zero skips, 1,000-agent configuration. | 27 passed, zero skips, with `SOURCE_LIVE_AGENTS=5000`. |
| `npm run test:integration` | 25 passed, zero skips. | 25 passed, zero skips. The keyed-submit and full Git workflow paths exercised the updated client. |
| `npm run lint`, `npm run format:check`, `git diff --check` | Passed. | Passed. |
| `npm run demo:contest`, `npm run demo:hybrid`, `node bin/source.js help` | Both demos passed. | Both demos and CLI help passed. |
| `npm run test:cloudflare` | 6 passed. | 6 passed. |
| `npm audit --omit=dev --audit-level=high --json`, `npm audit --prefix cloudflare/artifacts-bootstrap --audit-level=high --json` | Dependency files at the baseline and final revisions are identical. | Both passed with zero reported advisories. |
| `node --test tests/client-retry.test.js tests/client-http.test.js tests/submit.test.js tests/sync.test.js tests/submission-recovery.test.js` | — | 29 passed on the final revision. |
| Node 22.23.4, `node --test tests/api.test.js tests/decision.test.js tests/git.test.js tests/worker.test.js tests/store.test.js tests/hardening.test.js` | — | 77 passed. |
| Node 22.23.4, `node --test tests/client-retry.test.js tests/client-http.test.js` | — | 15 passed on the final revision. |
| `docker build --tag source:hardening-20261121 .` (Colima socket, disposable anonymous Docker config) | — | Build passed. Image digest `sha256:30ecbe7513eee7c5fa78ae8083f74746f92c4da7dee4d82d01f136a09e5a2938`. |
| `docker run --rm --entrypoint psql source:hardening-20261121 "$SOURCE_CONTAINER_DSN" -Atc "select 1"` (Colima) | — | Blocked before container startup by a local snapshotter metadata I/O error. The two-container gate and optional live OCI/browser checks are unverified. |
| `node --check docs/audits/evidence/hardening-2026-11-21/worker-wakeup.mjs` | — | Passed. The paired run verified equivalent jobs and published the raw samples. |

Separate Kujo release wrappers were outside this hardening run. Raw test, build and benchmark logs are retained under the ignored `audit-results/hardening-2026-11-21/` directory. The temporary databases and detached baseline checkout were removed.
