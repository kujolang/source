# Integration concurrency measurements

Measured 2026-11-10 on local macOS x64: 12 logical CPUs, 16 GiB RAM,
Node v26.12.1, Git 2.42.0, local PostgreSQL 14.20. This bounded synthetic
correctness/measurement workload is not production capacity certification.

## Reproduce

Use a disposable PostgreSQL database and a nonexistent absolute output path.
The script creates/drops only its uniquely named schema and removes owned Git
fixtures after child processes exit. It does not create/drop the database.

```bash
SOURCE_TEST_DATABASE_URL='postgresql:///YOUR_DISPOSABLE_DB?host=/tmp' \
node scripts/benchmarks/integration.js \
  --agents 10 --repos 1 --output /absolute/agents-10-hot.json

SOURCE_TEST_DATABASE_URL='postgresql:///YOUR_DISPOSABLE_DB?host=/tmp' \
node scripts/benchmarks/integration.js \
  --agents 10 --repos 5 --output /absolute/agents-10-distributed.json
```

The current harness accepts 1–100 agents. Source's integration planner accepts
at most 100 proposals per candidate. Larger stages require explicit multi-batch
and stale-proposal orchestration; the harness does not lower requested concurrency
or bypass that limit. Server rate/admission/authentication defaults are unchanged.
A same-address burst above ten submissions can encounter the default rate limit;
a failed run records failure, not capacity.

Raw reports contain application revision, harness SHA-256, host/runtime versions,
per-proposal identities/timings, worker execution records, timing samples,
storage/network observations and correctness assertions:

- [10 agents, one repository](benchmarks/agents-10-repos-1.json).
- [10 agents, five repositories](benchmarks/agents-10-repos-5.json).

Runs were sequential, with independent schemas in a disposable database. Fixture
data and capabilities were removed. Application revision identifies the source
under test; harness digest identifies the script used before its commit. There
were no uncommitted application changes.

## Workload and assertions

Ten independent Node clients wait at a start barrier, clone Source over smart
HTTP, commit unique files from the same base, and call the real submit client.
GitHub remains an unchanged synthetic `origin`; Source is remote `source`.
Each push uses a distinct service principal's project-scoped capability. Actual
Work/Session/Change/Evidence records are created. The server runs in the
coordinator process. Distributed runs use separate projects and repositories.

The operator API assembles candidates and rejects acceptance before verification.
Two separate Source worker processes compete for durable PostgreSQL jobs using
normal leases and the verification handler. Each executes the same fixed checker
in another Node process. It reads exact Git blobs, validates all expected
contributor files and the preserved base, and rejects missing/corrupted/unexpected
files. It never evaluates repository code. Policy binds its command, Node/Git
versions and script digest to the exact candidate.

Duplicate dispatch must coalesce onto the same job ID. Dispatch after success
must reuse valid exact deterministic receipts. The harness then acts as the
configured human maintainer for acceptance/promotion, repeats promotion to check
idempotency, checks every proposal's ancestry and fetches the landed branch over
HTTP. This is automated authorization under a human test identity, not measured
human review time. There were no manual interventions.

## Observed results

Both runs passed all assertions. Each job completed in one attempt, with no
failed/abandoned jobs or worker errors. Changes were compatible by design;
zero conflicts does not estimate real repository conflict frequency.

| Measurement | 10 agents / 1 repo | 10 agents / 5 repos |
|---|---:|---:|
| Submission phase including clone/edit/submit | 4.608 s | 4.217 s |
| Proposals per second during submission phase | 2.170 | 2.372 |
| Candidate assembly total | 4.417 s | 2.761 s |
| Verification phase including dispatch/worker drain | 1.093 s | 2.601 s |
| Completed checks | 1 | 5 |
| Exact-candidate reuse probes / hits | 1 / 1 | 5 / 5 |
| Active equivalent dispatches coalesced | 1 | 5 |
| Promotion total, excluding acceptance/repeat probe | 0.348 s | 1.612 s |
| Server HTTP bytes received / sent | 52,067 / 70,703 | 56,909 / 74,612 |
| Fixture filesystem allocated bytes including baseline clones | 2,777,088 | 3,973,120 |
| PostgreSQL relation bytes including indexes | 1,277,952 | 1,867,776 |
| Harness elapsed including setup/baseline/cleanup | 22.942 s | 28.856 s |

Timings below are milliseconds, nearest-rank p50 / p95 / p99. These are one run
per layout, with very small samples. Equal percentiles in a one-candidate run
represent one observation, not a measured tail distribution.

| Stage | Hot repo p50 / p95 / p99 (samples) | Distributed p50 / p95 / p99 (samples) |
|---|---|---|
| HTTP Git clone | 766 / 860 / 860 (10) | 612 / 777 / 777 (10) |
| Submit client after commit | 3,327 / 3,400 / 3,400 (10) | 3,000 / 3,091 / 3,091 (10) |
| Candidate assembly | 4,417 / 4,417 / 4,417 (1) | 550 / 562 / 562 (5) |
| Queue creation to checker start | 481 / 481 / 481 (1) | 1,115 / 1,720 / 1,720 (5) |
| Checker execution | 454 / 454 / 454 (1) | 282 / 283 / 283 (5) |
| Promotion | 348 / 348 / 348 (1) | 328 / 335 / 335 (5) |
| Post-promotion HTTP fetch | 421 / 421 / 421 (1) | 345 / 366 / 366 (5) |

Workers start processing after all dispatch/coalescing probes. Queue times include
that barrier; they are not steady-state scheduler latency. Assembly/promotion run
serially across repositories. Network counts include all server HTTP/Git traffic,
not only pack bytes. Raw CPU/RSS values are coordinator-only and must not be
presented as total host or all-worker utilization.

## Conventional verification comparison

The baseline uses the same proposals and checker on the same host. It starts at
the original base, merges one proposal at a time and verifies each cumulative
merge exactly once. Its final tree must equal Source's promoted tree. It does not
add speculative per-PR checks or assume all remaining proposals rerun after every
merge.

| Layout | Baseline checks | Source checks | Checks avoided | Baseline checker time total | Source checker time total |
|---|---:|---:|---:|---:|---:|
| One hot repo | 10 | 1 | 9 | 3,289.52 ms | 454 ms |
| Five repos | 10 | 5 | 5 | 2,198.83 ms | 1,390 ms |

These are actual checker counts and accumulated process wall times, not real
application CI, cloud billing or end-to-end platform speedup. The baseline does
not operate another hosting service or persist Source review records; only
verification work and final Git content are comparable. Source assembly overhead
is material in this small fixture. Reuse probes deliberately request identical
candidates: their 100% hit result proves correctness, not an expected cache rate.

## Stage ledger and remaining evidence

| Stage | Hot repository | Distributed repositories |
|---|---|---|
| 10 | Passed this compatible-file lifecycle | Passed, five repos |
| 25 | Failed during submission: HTTP 429 | Failed during submission: HTTP 429 |
| 100 | Not measured | Not measured |
| 250 | Not measured; beyond harness bound | Not measured |
| 1,000+ | Not measured; multi-batch orchestration required | Not measured |

Still required: repeated/sustained workloads; ten-way conflicts and semantic
shared-dependency cases; isolated application/unit/integration/browser checks;
worker crash/recovery timing under load; full host/network utilization;
real-project lifecycle; larger stages; deployment capacity and security gates.
Existing crash tests are in [failure recovery](failure-recovery.md), not folded
into these measurements. Recovery duration is null, not zero, in raw reports.

## 25-agent pilot: default admission limit reached

The 25-agent hot and five-repository attempts failed before any client completed
the submit lifecycle. Instrumented reports observed HTTP 429 responses:

| Layout | HTTP 200 responses | HTTP 429 responses | Completed clients before abort | Elapsed including cleanup |
|---|---:|---:|---:|---:|
| One repo | 119 | 7 | 0 | 11.438 s |
| Five repos | 119 | 4 | 0 | 13.290 s |

The failed operation was `ls-remote` in the hot run and `fetch` in the distributed
run. Source's public Git-read limiter is keyed by client address, with a default
120 requests per minute. All benchmark clients share one loopback address.
Repeated Git discovery/fetch requests reach that bounded admission policy before
proposal verification. The explicit 429 counts establish throttling; this is not
a database/merge-capacity result. No rate limits were raised and no retry behavior
was added to make the runs pass. The harness stops after the first client failure,
so counts describe an aborted burst, not every attempted operation's final outcome.

- [Instrumented 25-agent hot failure](benchmarks/agents-25-repos-1.json).
- [Instrumented 25-agent distributed failure](benchmarks/agents-25-repos-5.json).
- [Initial hot failure before status instrumentation](benchmarks/agents-25-repos-1-initial.json).
- [Initial distributed failure before status instrumentation](benchmarks/agents-25-repos-5-initial.json).

The ten-agent reports retain the harness digest from commit `4887aa5`.
The pilot adds response-status counts, phase and completed-client diagnostics;
its separate digest records that instrumentation change. Default-rate shared-IP
agent bursts need bounded retry/backoff or a reviewed authenticated admission
policy before repeating the pilot. Completion at 25 and higher is unproven.
