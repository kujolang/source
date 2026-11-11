# Actual-project worker crash, queue recovery and restore

Validated on 2026-11-10 local time at `bac2a46`. The
[original report](real-project-worker-crash.json) binds the harness, recovery
helper, policy, dependency image, actual test outputs and receipts. This is one
local crash/recovery demonstration, not production failover or recovery under load.

The private disposable instance imported actual Source history at `299ec60` and
submitted `bac2a46` through the normal CLI. It assembled candidate
`804d2934461c1a9ed07e5a3b2748166299eedfae`, tree
`2c1e0dc544c51fc52d9dbbe2cda5ec0ea873349d`. A separate CLI worker used PostgreSQL
leases and the pinned OCI dependency image to execute the required checks.

## Injection and correctness

The explicit `--crash-worker` fixture policy permits two attempts and orders
preflight, runtime, then Git/API checks with dependencies. Product policy defaults
are unchanged. The drill observes both a leased Git/API job and its host-owned
journal, confirms the matching Docker container is running, and waits for actual
TAP test output before killing the owning CLI worker with SIGKILL.

The resulting orphan remains running. With the worker confirmed dead, the
operator recovery CLI removes the exact owned container and workspace. A repeated
recovery finds nothing. A fresh CLI worker uses the same worker ID, allowing the
drill to specifically test lease-token fencing. It reclaims the same job only
after its real 60-second lease expires; no SQL updates simulate expiry.

Assertions prove:

- Missing interrupted-check evidence prevents acceptance.
- Stale completion, heartbeat, failure and receipt-lease acquisition are rejected.
- The two completed job records and receipt IDs remain unchanged.
- Exactly three jobs complete: preflight/runtime once, Git/API on attempt two.
- Original output hashes match receipts bound to the exact candidate.
- Evidence reuse, authorized acceptance and idempotent promotion succeed.
- A fresh authenticated clone matches the candidate and preserves proposal ancestry.
- The final workspace root is empty.

The same run then quiesces the API/worker/database pool, backs up Git and the
custom PostgreSQL schema, takes the original filesystem path offline, and restores
into independent paths/database. A fresh process validates candidate/landed refs,
policy/acceptance/outcome, all three receipts and output hashes, completed jobs
including attempt two, private clone authorization and idempotent promotion.
Original offline state remains unchanged. Successful drill resources and backup
payloads are removed; the report retains checksums, not a reusable backup.

## Measurements and scope

| Observation | Measured result |
|---|---:|
| SIGKILL to confirmed orphan cleanup | 547 ms |
| Recovery CLI internal duration | 197 ms |
| SIGKILL to observed replacement lease | 59,507 ms |
| Preflight (121 JavaScript files) | 5,882 ms |
| Runtime (43 passed, 1 excluded nested-container case) | 3,434 ms |
| Retried Git/API (36 passed, 1 PostgreSQL-only skip) | 61,955 ms |
| Backup/restore portion | 6,729 ms |
| Complete lifecycle, crash and restore | 153,506 ms |

These are local fixture timings, not SLOs. Containers have neither the Docker
socket nor PostgreSQL credentials, explaining the two deliberate exclusions.
The focused PostgreSQL dispatcher, worker and ownership-recovery regressions
passed **29/29, zero skipped**, in 59.424 seconds; their
[result lines](real-project-worker-crash-regressions.txt) record the exact command.
Syntax lint checked 121 JavaScript files and whitespace checks passed.
The initial `37928f0` drill reached replacement attempt two but failed its own
assertion: stale queue failure correctly returned `null`, not the expected
`false`. `bac2a46` fixes that harness expectation. Its remaining owned container
was recovered explicitly before rerunning; that failed run is not a passing proof.

## Reproduction and remaining boundaries

```sh
SOURCE_TEST_DATABASE_URL='<disposable PostgreSQL DSN>' \
  node scripts/real-project-lifecycle.js \
  299ec60 bac2a46 docs/validation/container/source-dependency-image.json \
  /absolute/new-report.json --crash-worker --restore
```

Provision the report's immutable dependency image first using
`scripts/build-self-verification-image.js bac2a46`; this requires an operator
build with network access. On this macOS host use `PATH="/usr/bin:$PATH"` to
select Apple Git 2.50.1. The database role must create/drop disposable databases.
On failure, inspect retained paths/schema and recover only owned execution
journals before deleting a workspace. Do not modify the tested checkout during a run.

The worker crash is local process death during an actual check, not daemon/host
loss, power failure, a crash during assembly/promotion, or a post-receipt crash.
Separate existing tests cover some of those boundaries; this run does not extend
their scope. Deployed recovery, sustained/hot-repository load, 1,000-agent scale,
Workcell host compatibility, staging and migration-specific workflows remain open.
