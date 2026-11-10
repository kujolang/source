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
or bypass that limit. The default benchmark profile keeps server settings unchanged;
the separately named private-load profile below declares its operator configuration.
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
| 25 | Passed after bounded backoff and gzip fix | Passed with bounded backoff, five repos |
| 100 | Default profile failed during clone: HTTP 429 | Default profile failed during clone: HTTP 429 (ten repos) |
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
a database/merge-capacity result. In those initial runs, no rate limits were raised and no retry behavior
was added. The harness stops after the first client failure,
so counts describe an aborted burst, not every attempted operation's final outcome.

- [Instrumented 25-agent hot failure](benchmarks/agents-25-repos-1.json).
- [Instrumented 25-agent distributed failure](benchmarks/agents-25-repos-5.json).
- [Initial hot failure before status instrumentation](benchmarks/agents-25-repos-1-initial.json).
- [Initial distributed failure before status instrumentation](benchmarks/agents-25-repos-5-initial.json).

The ten-agent reports retain the harness digest from commit `4887aa5`.
The pilot adds response-status counts, phase and completed-client diagnostics;
its separate digest records that instrumentation change. Default-rate shared-IP
agent bursts need bounded retry/backoff or a reviewed authenticated admission
policy before repeating the pilot. At that point completion at 25 and higher was unproven; subsequent pilot results follow.


## 25-agent pilot with bounded client backoff

Commit `71dfa00` adds bounded retries for explicit admission throttling while
preserving server limits and permissions. Raw results:

- [Hot repository](benchmarks/agents-25-repos-1-backoff.json): all 25 submitted in
  224.015 s, assembled in 15.533 s, one verification completed in 614 ms.
  Final post-promotion fetch failed with `expected 'acknowledgments'`. This is
  a failed lifecycle, not a passing capacity result. The compressed Git request
  regression and fix are recorded in failure-recovery.md.
- [Five repositories](benchmarks/agents-25-repos-5-backoff.json): passed all
  assertions in 244.118 s including setup/cleanup. Submission 219.559 s
  (0.114 proposals/s); assembly 5.617 s total; five checks completed in 1.179 s
  versus 25 equivalent baseline checks in 4.509 s, avoiding 20 checks.
  Promotion 1.148 s total; final fetch 1.264 s. Queue p50/p95/p99
  692/1,079/1,079 ms; submit 67,684/147,278/217,621 ms. All five jobs completed
  once with no failed/abandoned jobs; five active dispatches coalesced and five
  exact-candidate reuse probes passed. HTTP statuses: 245 success-200,
  25 success-201, 33 throttled-429. Backoff dominates elapsed time.

These single runs still use a fixed checker, synthetic compatible changes and
one shared-IP host. They do not establish application CI savings or sustained
production capacity. Earlier failed reports remain immutable.


### Hot-repository rerun after gzip fix

[25-agent hot rerun](benchmarks/agents-25-repos-1-gzip.json), application revision
`7ab7acb`, passed all lifecycle assertions in 182.802 s including setup/baseline/
cleanup. All 25 proposals submitted in 148.163 s (0.169/s), assembly took
15.527 s, the single job completed once in 680 ms with no failed/abandoned jobs,
and exact-candidate coalescing/reuse probes passed. Promotion took 275 ms and
post-promotion HTTP fetch 325 ms. The equivalent baseline ran 25 checks in
9,973.649 ms: 24 fixed-checker runs avoided. HTTP statuses were 235 success-200,
25 success-201 and 26 throttled-429. Submit p50/p95/p99 was
66,022/146,062/146,069 ms; queue latency 357 ms. Limits were unchanged.

The earlier failure remains in the record. Both pilot layouts now have passing
runs, but the distributed run predates the gzip fix and neither run demonstrates
sustained load or application CI. Different throttle timing and jitter prevent
attributing the elapsed-time difference between hot runs solely to the fix.


## 100-agent default-profile admission result

At application revision `1c74c3d`, both requested 100-agent layouts failed during
initial HTTP cloning, before any client completed submission:

| Layout | HTTP 200 | HTTP 429 | Elapsed including cleanup |
|---|---:|---:|---:|
| One hot repo | 120 | 16 | 16.931 s |
| Ten repos | 118 | 4 | 21.786 s |

Raw reports: [hot](benchmarks/agents-100-repos-1.json) and
[distributed](benchmarks/agents-100-repos-10.json). Ordinary Git clone does not use
the submit client's bounded backoff. All clients share one address, so the default
120/min public-read limit stops this onboarding burst. The harness aborts after
the first error; these counts are not eventual outcomes for all clients. No
candidate, queue, promotion or verification throughput is established by the runs.

## Explicit private-load profile

`--profile private-load` is a separate operator-configured workload. It uses only
private repositories and distinct project-scoped read_source/git_push/submit_change
capabilities, including authenticated clone, submit and final fetch. An anonymous
Git probe must be rejected, and returned sessions must preserve the authenticated
principal. Credentials stay in IPC/memory and are not written into reports or
remote URLs. Verification and promotion policy are unchanged.

For this profile only, the harness configures the existing bounded per-address
push and submit limits to 1,000/min each. Git/API concurrency, queue sizes,
worker concurrency and all other server limits retain defaults. This lets the
100-agent test measure storage/assembly/queue contention instead of terminating
at anonymous onboarding admission. It is not a change to Source's product defaults
or evidence that the default profile supports that burst. Rate-policy selection
is deployment-specific; the synthetic profile is not a recommended public-server
configuration. Passing results, if any, must always be labeled private-load.

Example (use an owned disposable PostgreSQL database):

```bash
SOURCE_TEST_DATABASE_URL='postgresql:///YOUR_DISPOSABLE_DB?host=/tmp' \
node scripts/benchmarks/integration.js --profile private-load \
  --agents 100 --repos 1 --output /absolute/private-100-hot.json
```
