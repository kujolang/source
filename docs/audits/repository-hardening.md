# Source repository hardening — 2026-10-13

## Repository and scope

- Repository: https://github.com/kujolang/source; branch: `main`.
- Starting revision: `71b2d9574962d26cdcd415574f5158a7afd6914d`.
- Ending implementation revision: `d94a2e8` (this report and accompanying operational documentation follow it).
- Purpose: Git-backed Work → Session → Change → Evidence → Decision → Canonical State collaboration, through HTTP, browser and CLI interfaces.
- Integrations: Node.js, Git smart HTTP, JSON/SQLite/PostgreSQL storage, `pg`, `js-yaml`, Kujo Eval artifacts, isolated workflow containers, a secret-provider adapter, Cloudflare Workers and Artifacts.
- Environment: macOS, Node 26.7.0, PostgreSQL 14 on an isolated local test port. CI uses Node 22 and PostgreSQL 16. No live deployment, credentials or external repositories were changed.

Inspected the implementation and tests for HTTP authentication/authorization, Git transport and revision handling, project mutations, stores and migrations, queue claims/dependencies, workers, action execution and secrets, leases, Artifacts promotion, Eval ingestion, backups/replication, CLI configuration, CI and documentation. The starting inventory contained 184 tracked files. Review was risk-directed, not a claim that every line or external dependency was independently audited. Vendored UI assets and remote platform internals received no exhaustive security review. Existing behavior tests cover HTML, CLI, JSON, SQLite, HTTP, Git and hybrid promotion.

Security work used an independent baseline reviewer and a focused architecture/resource reviewer. Standard scan ID: `2ea82a5a-76cf-430b-9b13-b54b7c52da98`, targeting the starting revision. Its findings describe defects in that revision, even though this pass fixes them. This is not a production certification or a live penetration test.

## Baseline

| Check | Starting result |
|---|---|
| `npm run lint` | Pass; 12.108 s |
| `npm run format:check` | Pass |
| `npm test` | 227 tests: 223 passed, 4 skipped; 76.542 s |
| `npm run test:cloudflare` | Pass |
| `npm run demo:contest` | Pass |
| `npm run demo:hybrid` | Pass |
| Live PostgreSQL gate, 5,000 clients | 2 tests passed; 5,000 HTTP 200s, zero errors |
| Optional PostgreSQL store/migration tests | Two existing failures: invalid evidence alias and incomplete migration |
| Root and Worker dependency audits | Initially blocked by registry ETIMEDOUT; final retries succeeded |

New contained regressions demonstrated the pre-fix failures before correction: tenant/body override, encoded Git write authorization, bearer retention, member escalation, session path traversal, forged decision identity, global dedupe collision, default listener exposure, malformed Host crash, abandoned admission grant, Git option injection, artifact/JSON corruption, dependency pruning, concurrent evidence loss, retained capability cache, duplicate credential hashing, cleanup after revocation failure, unbounded/stalled secret responses and inconsistent Eval reads. Baseline logs are retained locally under ignored `audit-results/hardening/`.

## Findings and disposition

| ID | Priority | Area | Finding / evidence | Action | Status |
|---|---|---|---|---|---|
| S1 | P0 | Authorization | Evidence body replaced URL-authorized tenant/change IDs, `api.js` | Apply authoritative IDs last | Fixed; regression |
| S2 | P0 | Git authorization | Write detection preceded decoding of service path | Authorize decoded, allowlisted service | Fixed; regression |
| S3 | P0 | Credentials | Web Work requester retained bearer in records/audit | Persist authenticated principal | Fixed for new records; existing deployments need review |
| S4 | P0 | Membership | Project manager could grant organization membership | Require org authority; preserve actual org-admin project sessions | Fixed; negative and positive tests |
| S5 | P1 | Queue isolation | Caller dedupe key shared global namespace | Hash tenant/project/work plus caller key under client namespace | Fixed; upgrade caveat below |
| S6 | P0 | Sessions | Cookie ID could traverse into capability records | Validate opaque session format before read/revoke | Fixed; regression |
| S7 | P0 | Git arguments | Revision strings could become command options, including output paths | Validate revision inputs before invoking Git | Fixed; regression |
| S8 | P1 | Decision identity | Body-selected actor affected policy/audit | Use authenticated principal | Fixed; regression |
| S9 | P1 | Exposure | Omitted host bound all interfaces despite local assumptions | Default to IPv4 loopback | Fixed; regression |
| S10 | P1 | Availability | Malformed Host escaped handler catch and terminated process | Parse inside error boundary | Fixed; subprocess regression |
| S11 | P1 | Admission | Disconnected queued requests leaked late grants | Release on late admission after close | Fixed; deterministic regression |
| C1 | P0 | Shared state | Parallel evidence updates lost relationship links | Lock before read/modify/write; PG project-row transaction | Fixed; 20-way JSON and two-instance PG tests |
| D1 | P0 | PostgreSQL bytes/text | Literal escaping corrupted backslashes/binary; async artifact reads used wrong return shape | Explicit SQL escape literals, hex decode, structured query rows, empty-byte handling | Fixed; sync/async round trips |
| D2 | P1 | Migration | Org directories skipped; FK order and evidence alias failed | Include directories; principals first; defer relation arrays; restore memberships/workflows/sessions | Fixed; real PG migration/query tests |
| D3 | P1 | Retention | Pruning successful parents blocked queued dependents | Retain referenced terminal jobs; fail missing dependencies | Fixed; live PG regression |
| R1 | P1 | Capabilities | Indexed reads also accumulated unbounded secret-keyed cache; revoke double-hashed grants | Trust indexed store; retain no redundant cache; persist existing hash | Fixed; regression |
| R2 | P2 | Worker | Idle/outage timers delayed shutdown | Cancellable waits, released on stop | Fixed; timing and state tests |
| R3 | P1 | Secret provider | Timeout stopped at headers; body allocated before size check | Stream under byte/time bounds; reject redirects | Fixed; oversized and stalled body tests |
| R4 | P1 | Resources | Revocation failure skipped workspace release; rejected env leaked runner slot | Nested cleanup; validate env before admission | Fixed; regression |
| R5 | P1 | Git subprocess | stdin errors unhandled; stderr unbounded; abort listeners retained | Error handling, 1 MiB stderr cap, listener/input cleanup | Fixed; real transport + injected failure tests |
| E1 | P2 | Evidence I/O | Eval files reread for raw proof, allowing parsed/raw mismatch | One read per artifact, shared bytes | Fixed; read-count and consistency test |
| O1 | P1 | Maintenance | Synchronous PG transaction launches separate psql processes | Document non-atomic contract; use async serving path | Open; requires compatibility design |
| O2 | P1 | Action cancellation | Custom handler can continue after worker timeout; built-in runner has its own timeout | Preserve explicit limitation; align deadlines, require cooperative cancellation | Open; needs cancellation/lease ownership design |
| O3 | Needs evidence | Writer fencing | Lease assertion before a long external Git operation is not an atomic filesystem fence | Existing Git compare-and-swap protects ref updates; investigate lease-expiry fault injection | Open hypothesis, not a proved exploit |

## Changes implemented

### HTTP and project consistency (`3e59603`)

`src/api.js`, `src/source.js`, `src/git.js`, `tests/hardening.test.js`, `tests/git.test.js` change the point at which authority, identity, path decoding and locks are applied. Validation at a URL or before acquiring a lock is insufficient when later code replaces arguments or uses a stale record. The new project mutation helper bounds local admission and holds the PostgreSQL row lock across reading, validation and writes. Canonical promotion rechecks acceptance after locking. Tests exercise attacker-selected fields, allowed admin behavior, malformed transport input and concurrent relationships. Existing promotion, Git cloning/pushing and browser tests still pass.

### Persistence (`0e16bac`)

`src/postgres-store.js` fixes SQL literal representation, asynchronous artifact decoding, empty artifact handling, evidence query projection, dependency-aware pruning and migration ordering. `tests/postgres-regressions.test.js` uses disposable schemas for byte/text fidelity, retention and independent-instance concurrent evidence. `tests/store.test.js` now keys destructive test setup exclusively from `SOURCE_TEST_DATABASE_URL` and drops its test schemas. `tests/concurrency.test.js` retains exact SQL expectations with the corrected escape prefix. `package.json` includes real store/migration tests in `test:postgres`, so the existing CI PostgreSQL gate cannot silently omit them.

### Resource lifetime and evidence (`d94a2e8`)

`src/capability.js` removes redundant cache retention only when an authoritative indexed store exists; JSON/SQLite fallback behavior remains. `src/worker.js` wakes idle waits on shutdown. `src/action-runner.js` enforces streaming response budgets, cleans workspaces even after revocation failure, ignores output after settlement and validates environment before occupying a slot. `src/git-http.js` handles pipe failures, bounds stderr and detaches input/abort listeners. `src/integrations/kujo.js` derives parsed and raw proof from the same read. Each area has behavior-oriented regression coverage in its corresponding test file.

## Performance and efficiency

These are local measurements, not general throughput promises.

| Dimension / workload | Before | After | Interpretation |
|---|---|---|---|
| Idle worker shutdown, three samples, 1 s polling | 996.952 / 1000.826 / 1001.119 ms | 0.353 / 0.043 / 0.053 ms | Stop interrupts idle wait |
| 10,000 indexed capability lookups | 10,000 retained cache entries | 0 | Removed redundant retention |
| Serialized representation of that cache | 2,100,001 bytes | 2 bytes | Representation size, **not heap/RSS** |
| Eval artifact reads per ingestion | 8 | 5 | Same artifact bytes feed parsed and retained proof |
| 20 simultaneous evidence additions | 1 retained relationship in baseline JSON reproduction | 20 | Correctness under concurrency |
| HTTP fleet, 5,000 requests / concurrency 256 | 5,000 successes, 0 errors; p50 122.334 / p95 263.093 / p99 704.600 ms | 5,000 successes, 0 errors; p50 74.185 / p95 297.104 / p99 563.134 ms | Mixed latency; no throughput improvement claimed |

Final HTTP test overlapped other local verification, so latency is not a controlled optimization comparison. Full-suite duration increased with added tests and overlapping PostgreSQL work; no build-time speedup is claimed. No new dependencies, runtime cache, schemas or benchmark-only shortcuts were introduced.

No model runtime, prompt library or MCP tool catalog exists in this repository. HTTP field selection, pagination, bounded queue batches and existing concise demo receipts remain the agent-efficiency controls; field-selection tests pass. No token savings are claimed. Detailed test output stays in log artifacts, while normal demo receipts remain concise. PostgreSQL bootstrap still prints repetitive NOTICE messages; suppressing diagnostics merely to shorten logs was not part of this pass.

## Security and compatibility

Reviewed boundaries include cookies/bearers, tenant/work authorization, form/JSON input, Git service decoding and arguments, SQL/byte serialization, secret HTTP responses, container configuration, signed action registries, subprocess output, backup/restore paths, project locks, queue leases, Artifacts promotion and CI dependencies.

- HTTP routes and successful response schemas remain compatible. Malicious overrides no longer control scope or actor identity.
- Default listening address changes to `127.0.0.1`; deployments requiring external access must supply an explicit host and production safeguards.
- Membership mutation requires organization authority. Actual org admins using project sessions retain access.
- Session cookies must match the existing generated 48-character lowercase hexadecimal format. Traversal strings are invalid.
- Git revisions beginning with `-`, containing NUL, empty or exceeding 4,096 characters are rejected. Ordinary refs, commit IDs and supported ranges continue working.
- Caller-supplied job dedupe keys are now tenant/project/work scoped. **A retry spanning this upgrade may create a new job if the original used the old raw key.** Drain/reconcile in-flight externally keyed submissions during upgrade. Internally generated workflow keys remain separate.
- Project mutations have bounded admission (one active per project per Source instance, up to 256 queued); saturation uses the existing retryable 503 contract.
- Secret-provider fetch injection now expects standard Response body streaming. The 1 MiB limit and timeout apply while reading. Redirects fail closed.
- Git stderr now fails explicitly above 1 MiB rather than allocating indefinitely; details below that limit remain available.
- No persisted schema, public JSON field layout, configuration file format or environment-variable name changed. The PostgreSQL test harness now requires the dedicated test DSN variable.
- No sibling implementation or external consumer was modified. No new dependencies were added.

### Upgrade and historical data

The fixes do not repair past production data automatically. If an older deployment created Work through the web form, inspect its requester fields and audit copies for retained credentials; revoke affected grants and redact records through a controlled maintenance process. Avoid copying those values into bug reports. Existing PostgreSQL artifact/text corruption requires checking original evidence or backups and re-ingesting verified bytes; do not blindly unescape historical JSON. There is no evidence here that any particular deployed instance was exploited or contains damaged records. Live operational remediation was outside this repository-only pass.

## Remaining work and cross-repository follow-ups

- **P1:** Replace or formally retire synchronous PostgreSQL pseudo-transactions without silently breaking sync consumers. Async HTTP transactions are real; maintenance migration still needs backup/rollback planning.
- **P1:** Define end-to-end action cancellation and lease ownership before permitting retries of timed-out non-idempotent handlers. Align worker and runner deadlines meanwhile. A worker AbortSignal does not force arbitrary JavaScript to stop.
- **P1, conditional operational review:** Check historical bearer retention and evidence fidelity when upgrading an affected deployment, as described above.
- **P2:** PostgreSQL notification waits are not wired through the current JobQueue interface; workers correctly poll. Adding notifications needs disconnect/backoff tests to avoid a busy loop.
- **Needs more evidence:** Lease expiry during a long external Git write; exhaustive vendored UI and remote Artifacts platform review; deployment-specific load and failure testing.
- **P3 / not worth changing:** Broad module rewrites, stylistic changes, dependency replacement and arbitrary token budgets have no demonstrated benefit. Existing fixtures, examples and release scripts were retained because tests/documentation use them.
- **Cross-repository requirements:** None required for these changes. Eval producer output format and Cloudflare Artifacts contracts remain unchanged. No sibling changes are proposed without further evidence.

## Verification receipt

Commands run from the Source checkout; logs under ignored `audit-results/hardening/` preserve verbose evidence.

| Exact command / group | Result |
|---|---|
| `npm run lint` | Pass |
| `npm run format:check` / `git diff --check` | Pass |
| `npm test` | 253 tests: 245 passed, 8 skipped, zero failures; final run 53.131 s (not a controlled timing comparison) |
| `node --test tests/action-runner.test.js` | 20 passed after the final runner admission fix |
| `node --test tests/hardening.test.js` | 12 passed |
| `node --test tests/git-http.test.js` | 14 passed |
| `node --test tests/kujo-integration.test.js` | 12 passed, optional sibling Eval fixture skipped |
| `SOURCE_TEST_DATABASE_URL=postgres://robertdevore@127.0.0.1:55433/postgres SOURCE_LIVE_AGENTS=5000 npm run test:postgres` | 19 passed, zero skipped; disposable local database |
| `npm run test:cloudflare` | Pass |
| `npm run demo:contest` | Pass; local review/promotion lifecycle |
| `npm run demo:hybrid` | Pass; real Git and Worker handlers, emulated Artifacts binding |
| `node bin/source.js help` | Pass |
| `npm audit --omit=dev --json` | Zero reported vulnerabilities; 16 dependencies |
| `npm audit --prefix cloudflare/artifacts-bootstrap --json` | Zero reported vulnerabilities; 91 dependencies including development/optional packages |
| `node audit-results/hardening/measure.mjs` | Local resource measurements above; ignored experiment, deterministic count/shutdown regression tests committed |
| `docker info` | Blocked locally: Docker daemon not running; no local container-pass claim |

The eight default-suite skips are six PostgreSQL-gated tests (covered by the live gate) and two optional sibling fixtures (Spec dogfood and Eval output). The separate live gate exercises PostgreSQL explicitly. CI also builds the pinned container and runs the two-container failover gate; its result must be checked on the pushed revision. No known regression from these changes remains in the checks completed here.
