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
| 100 | Default failed admission; private-load lifecycle passed | Default failed admission; private-load passed (ten repos) |
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


### 100-agent private-load measurements

Both layouts pass all assertions at revision `5b4c01a`. Raw reports:
[hot](benchmarks/agents-100-repos-1-private.json) and
[ten repositories](benchmarks/agents-100-repos-10-private.json). All changes remain
in the landed ancestry, exact-candidate receipts gate promotion, unverified
acceptance is rejected, repeats are idempotent and final trees match the baseline.
Each job completed once; zero failed/abandoned jobs. All active duplicate dispatch
and completed exact-identity reuse probes passed. The anonymous Git probe returned
401. There were no 429 responses in this configured private workload.

| Measurement | 100 agents / 1 repo | 100 agents / 10 repos |
|---|---:|---:|
| Submission including clone/edit/submit | 44.988 s | 41.559 s |
| Submission proposals/second | 2.223 | 2.406 |
| Candidate assembly total | 324.555 s | 52.876 s |
| Verification phase elapsed | 4.123 s | 6.902 s |
| Source checks / baseline checks | 1 / 100 | 10 / 100 |
| Source checker execution total | 3.197 s | 6.921 s |
| Baseline checker execution total | 187.233 s | 39.940 s |
| Baseline sequential merge total | 11.624 s | 10.391 s |
| Promotion total | 0.551 s | 4.117 s |
| Final HTTP fetch total | 0.694 s | 4.535 s |
| HTTP received / sent bytes | 515,398 / 1,046,562 | 530,814 / 733,140 |
| Filesystem / PostgreSQL bytes | 22,585,344 / 3,358,720 | 27,877,376 / 4,218,880 |
| Entire harness including both workflows and cleanup | 596.123 s | 193.541 s |

Latency milliseconds, nearest-rank p50 / p95 / p99:

| Stage | Hot repo | Ten repos |
|---|---|---|
| Clone (100 samples) | 8,519 / 14,320 / 15,099 | 7,820 / 12,993 / 13,638 |
| Submit after commit (100) | 31,418 / 32,697 / 33,057 | 28,783 / 31,048 / 31,723 |
| Assembly (1 / 10) | 324,555 / 324,555 / 324,555 | 5,255 / 5,427 / 5,427 |
| Queue (1 / 10) | 752 / 752 / 752 | 3,289 / 4,002 / 4,002 |
| Verification execution (1 / 10) | 3,197 / 3,197 / 3,197 | 696 / 756 / 756 |

**Check reduction is not an overall speedup.** This fixture avoids 99 or 90
checker runs, but Source assembly plus verification-phase time is 328.678 s hot
and 59.778 s distributed, versus measured baseline merges plus checks of 198.857 s
and 50.331 s respectively. These components exclude differing submission,
approval and promotion work; they do not establish an end-to-end comparison.
Even within those components, the assembler overhead outweighs verification savings.

Source inspection identifies an all-pairs `merge-base --is-ancestor` loop in
IntegrationPlanner. At 100 proposals it invokes Git up to 9,900 times solely for
inferred dependencies, in addition to validation and real merge construction.
The next optimization must preserve real ancestry, dependency closure, deterministic
candidate identity and all semantic/conflict gates. These reports precede that
optimization. Repeated distributions, sustained load and larger stages remain
unmeasured; these single local runs are not production capacity certification.

Profile regression: three tests passed with no skips in 31.11 s
(`/tmp/source-benchmark-profile-tests.log`), including both default and private
end-to-end fixtures. An initial profile implementation shadowed the global fetch
function with a later timing array; corrected to globalThis.fetch before the
passing run. Product server code/defaults were not changed by this increment.

### Independent-head ancestry optimization: 100-agent reruns

Revision `d488cca` passed both unchanged private-load workloads. Raw reports:
[one repository](benchmarks/agents-100-repos-1-ancestry.json) and
[ten repositories](benchmarks/agents-100-repos-10-ancestry.json). Their harness
SHA-256 matches the preceding private-load runs. Only impossible ancestry
comparisons are pruned; real merges and exact-candidate gates remain enforced.

| Measurement | 100 agents / 1 repo | 100 agents / 10 repos |
|---|---:|---:|
| Assembly before | 324.555 s | 52.876 s |
| Assembly after | 24.784 s | 24.634 s |
| Submission | 47.965 s | 40.618 s |
| Verification phase | 5.140 s | 6.502 s |
| Source checker execution | 4.013 s | 6.584 s |
| Baseline checks | 192.217 s | 39.992 s |
| Baseline merges | 12.140 s | 10.413 s |
| Entire harness including both workflows | 306.322 s | 164.340 s |

All proposals remained in landed ancestry; unverified acceptance was rejected,
promotion was idempotent, and final trees matched the sequential baseline.
One / ten jobs completed once with zero failed or abandoned jobs, 99 / 90
checks avoided, and all coalescing/reuse probes passed. Anonymous reads returned
401; no request returned 429. This is the explicitly configured private profile,
not default server capacity.

Assembly declined about 92% hot and 53% distributed in these individual runs.
Source assembly plus verification phase measured 29.924 / 31.135 seconds versus
baseline merges plus checks of 204.358 / 50.405 seconds. These are component
comparisons with a fixed Git-content checker, not an end-to-end application CI
speedup. Dependent ancestry chains may still require quadratic comparisons.
Repeated sustained runs, 250/1000-agent stages, recovery under load, and complete
host resource accounting remain unproven. The harness elapsed time includes both
workflows and cleanup and must not be presented as Source application latency.

### First 250-agent attempts: submission failures

Revision `72bf924` adds a validated operator batch ceiling while retaining the
100-proposal default (hard maximum 1000). The harness now supports up to 1000
real client processes and records the selected ceiling. Focused API/planner/broker
validation passed 23/23 tests in 103.80 s, including 101 independent real Git
proposals. Default/private PostgreSQL lifecycle fixtures passed 3/3 in 30.42 s.

The first private-load 250-agent reports both failed:
[ten repositories](benchmarks/agents-250-repos-10-private.json) and
[one repository](benchmarks/agents-250-repos-1-private.json). Distributed failed
in `ls-remote` after 72.078 s; hot failed in clone after 36.164 s. The reports
contain 1040 / 374 HTTP 200 responses, respectively, plus the expected anonymous
401 probe. Neither recorded a 429 or a completed client result before the first
failure aborted the run. This does not prove that no server mutations occurred.
Assembly, verification, promotion and baseline assertions were not reached.
The sanitized client error did not preserve enough information to attribute
these failures to a particular host or transport constraint.

After each failure report was written, queued requests for disconnected clients
started Git backends and kept the harness process alive until the backend timeout
(up to about two additional minutes). Consequently the failed reports' elapsedMs
exclude that final process drain and are not total lifecycle durations. A focused
HTTP regression reproduces this admission bug: it observes two backend starts
instead of one when a queued client disconnects while a scan holds the shared
Git slot. The API now checks disconnection after admission and before starting
Git. A separate client diagnostic change retains only allowlisted process facts
and a fixed error category, never raw stderr, command arguments or credentials.
These fixes require reruns; the 250-agent milestone is not yet satisfied.

The diagnostic reruns at `37f240c` also failed during clone:
[hot](benchmarks/agents-250-repos-1-diagnostic.json) and
[distributed](benchmarks/agents-250-repos-10-diagnostic.json). Both report
`kind=transport`, Git exit code 128, no process error code or signal, and
`killed=false`. Hot recorded 448 HTTP 200 responses and 36.510 s; distributed
recorded 472 and 40.917 s. Each includes the expected anonymous 401 probe, no
HTTP 429, and no completed client result before abort. The diagnostics distinguish
these from local spawn errors, but do not yet identify the transport failure's
root cause; server backend exit/error counters and safe curl-code classification
are the next evidence needed. Do not infer a host process limit from these reports.

The wrapper measured full process lifetimes of 36.849 s hot and 41.192 s
distributed, compared with report times of 36.510 / 40.917 s. The prior two-minute
post-report drain did not recur. The admission regression fails before the fix
(two backend starts) and passes afterward (only the live request starts one).
Transport, client retry, sync and submit regression: 35/35 pass, zero skips,
33.02 s (`/tmp/source-stress-diagnostics-tests.log`); lint checks 108 JS files.
The 250-agent stress gate remains failed, and 1000 agents remain unmeasured.

### Transport cause isolation and bounded submission exchange

Additional 250-agent private-load failures are retained rather than replaced:

| Report | Revision | First failure | Report time |
|---|---|---|---:|
| [distributed backend counters](benchmarks/agents-250-repos-10-curl.json) | `7c12a9b` | HTTP submit fetch failed; cause not yet retained | 96.740 s |
| [hot cause codes](benchmarks/agents-250-repos-1-causes.json) | `3c710f0` | submit `UND_ERR_CONNECT_TIMEOUT` | 90.852 s |
| [distributed cause codes](benchmarks/agents-250-repos-10-causes.json) | `3c710f0` | submit `UND_ERR_CONNECT_TIMEOUT` | 101.085 s |
| [distributed single deadline](benchmarks/agents-250-repos-10-deadline.json) | `a70931f` | Git ls-remote HTTP 408 | 72.140 s |

The first three recorded respectively 2062, 2036 and 2050 successful Git backend
exits before/around the first submit failure and cleanup. Abort counts include
harness cleanup, so they are not independent root-cause evidence. None reached
candidate assembly or the equivalent baseline. Neither timeout report received
an HTTP response for its first failing submission; the mutation outcome remains
unknown and was not automatically retried.

The local Node v26.12.1 runtime bundles Undici 8.12.2. Inspecting that runtime's
connector source confirms a separate 10000 ms connect timeout; Source's outer
request budget could not extend it. Source now uses a single Node HTTP/HTTPS
JSON exchange whose connection, headers and body share the existing bounded
AbortSignal. No new dependency or server limit change is involved. Redirects
are rejected, the response is bounded to 1 MiB and headers to 16 KiB, and only
explicit pre-admission retryable 429 responses are replayed. See the upstream
[HTTP request AbortSignal contract](https://nodejs.org/api/http.html#httprequesturl-options-callback).

The post-change 250-agent attempt failed earlier in Git with HTTP 408, not in the
new JSON transport. It recorded 1076 successful Git backend exits, three aborts,
1074 HTTP 200 responses and the expected anonymous 401 probe. The 408 was not
in Source's request-handler status map. This is consistent with Node's automatic
header timeout response before the request listener, with Source's current
15-second headers timeout; the full request timeout is 120 seconds. See
[Node header timeout behavior](https://nodejs.org/api/http.html#serverheaderstimeout).
This does not prove the cause of every preceding clone failure, nor that the new
transport makes the 250-agent workload pass. Default timeouts are unchanged.

A contemporaneous macOS sample during the hot cause-code run reported 265 Node
processes with aggregate RSS 10,836,384 KiB, 982.25 MiB swap used and substantial
compressed memory. This includes unrelated Node processes and cumulative VM
statistics; it is evidence of host load, not a causal or peak-resource claim.
The benchmark still needs per-stage host/resource and event-loop accounting.

Validation: 24 HTTP/client-retry/submit/sync tests pass with zero skips in 23.09 s,
including stalled headers/body cancellation, redirect refusal, bounded/truncated
responses, no uncertain mutation replay, private credentials and real Git submit.
The earlier backend/curl diagnostic regression passed 24 tests; an additional
real truncated Git HTTP exchange proves numeric curl 18 capture without raw
stderr. Lint checks 110 JavaScript files. Large-load success remains unproven.

Post-change live PostgreSQL lifecycle fixtures pass 3/3 with zero skips in 32.29 s
(`/tmp/source-http-transport-live.log`). Both default/public and authenticated
private flows reach exact verification, acceptance, promotion and baseline tree
equality. The six direct HTTP transport tests also pass, including real HTTPS:
an untrusted self-signed certificate rejects before any HTTP request reaches the
server; a child configured with that test CA completes the authenticated exchange.
No certificate-verification bypass is enabled by the client.

### Per-phase telemetry (report version 2)

Revision `b94afc3` adds a 20 ms event-loop delay histogram and 1 s memory samples
in the API/harness process, separated into setup, submission, assembly,
verification, promotion, baseline and cleanup phases. Failed runs retain the
failed phase and cleanup measurements. Each phase reports CPU microseconds,
event-loop utilization and p50/p95/p99/max delay, sampled parent RSS peak, and
minimum observed host free bytes. Host free memory is not available memory or
memory attributable to Source; sampling may miss peaks.

Agent/worker processes report lifetime CPU and peak RSS at normal result, error
or stopped messages. A child killed before reporting has an explicit null resource
record. Summing these per-process peaks does not give simultaneous peak memory.
These fields exclude Git descendants, PostgreSQL and other host processes and
therefore do not constitute complete host accounting. No raw environment,
arguments or credentials are recorded. Reports include the telemetry helper hash,
source revision and actual HTTP timeout settings.

A real event-loop stall regression passes; both default/private PostgreSQL
lifecycle fixtures pass with complete phase/resource records (3 tests, zero skips,
30.23 s). Lint checks 112 JavaScript files. Instrumentation adds measurement
overhead; it does not change admission, authorization, verification or timeout
policy, and is not itself a fix for the intermittent load failures.

### First passing 250-agent distributed run

The [250-agent / ten-repository private-load report](benchmarks/agents-250-repos-10-telemetry.json)
at `b94afc3` passes every lifecycle assertion. All 250 proposals remain in landed
ancestry; exact verification gates acceptance; unverified acceptance is rejected;
repeat promotion is idempotent; baseline and Source final trees match. Ten jobs
completed once with zero failed/abandoned jobs, all ten coalescing and exact reuse
probes pass, and 240 checker executions are avoided. All 252 Node child resource
reports are present. HTTP outcomes: 2284 successful Git responses, 250 submissions,
and the expected anonymous 401; all 2284 recorded Git backend exits were zero.

| Measurement | 250 agents / 10 repositories |
|---|---:|
| Submission including clone/edit/submit | 104.540 s |
| Submission proposals/second | 2.391 |
| Assembly total | 62.785 s |
| Verification phase elapsed | 9.369 s |
| Source checks / baseline checks | 10 / 250 |
| Source checker execution total | 14.821 s |
| Baseline checker execution total | 169.222 s |
| Baseline sequential merge total | 26.400 s |
| Promotion calls total | 4.434 s |
| Final HTTP fetch total | 4.522 s |
| HTTP received / sent bytes | 1,284,309 / 1,960,804 |
| Filesystem / PostgreSQL bytes | 58,818,560 / 7,847,936 |
| Entire harness including both workflows and cleanup | 434.642 s |

Nearest-rank latency milliseconds, p50 / p95 / p99:

| Stage | Observed quantiles |
|---|---|
| Clone (250 samples) | 18,768 / 31,347 / 32,826 |
| Submit after commit (250) | 69,471 / 76,056 / 78,756 |
| Assembly (10) | 6,253 / 6,649 / 6,649 |
| Queue (10) | 3,750 / 4,954 / 4,954 |
| Checker execution (10) | 1,420 / 1,730 / 1,730 |

Submission-phase parent event-loop utilization measured 0.906, with delay
p50/p95/p99/max 28.131/99.287/447.480/881.852 ms. Parent CPU consumed 13.501 s user
and 8.129 s system during that 104.552 s telemetry phase. Event-loop utilization is
not CPU utilization; these observations do not establish why earlier runs timed
out. Sampled parent peak RSS was 189,820,928 bytes. Host free bytes reached a
sampled minimum 19,468,288 during submission and recovered above 4.8 billion during
assembly, but this is neither attributable nor available-memory accounting.

Agent lifetime peak RSS p50/p95/p99 was 54,628,352/55,492,608/55,820,288 bytes;
agent CPU totals 67.630 s user and 21.984 s system. The sum of per-process lifetime
RSS peaks is not a simultaneous physical-memory peak and can count shared pages
multiple times. Git/PG resource usage and recovery under load remain unmeasured.

Assembly plus verification-phase components total 72.154 s, versus baseline
merges plus checks 195.623 s. They exclude different submission/review/promotion
work and use the fixed Git-content checker, so this is not an application CI or
end-to-end speedup claim. Earlier timeout failures remain part of the evidence.
One passing distributed private run does not demonstrate sustained reliability,
default-profile capacity, a passing 250-agent hot repository, or 1000-agent support.
No server timeout, authentication or verification policy was loosened for this run.

### 250-agent hot-repository telemetry failure

The [250-agent / one-repository report](benchmarks/agents-250-repos-1-telemetry.json)
at `3a8f21e` failed during submission after 96.932 seconds including cleanup.
The client reported `ECONNRESET`, no response received, and an unknown submission
outcome; it did not replay the mutation. HTTP counters recorded three successful
submissions, 2244 successful Git responses and the expected anonymous 401. All
2244 recorded Git backend exits were zero. No assembly, verification, promotion
or baseline result is claimed for this run.

During the 77.825-second submission telemetry phase, parent event-loop utilization
was 0.876; delay p50/p95/p99/max was 26.673/145.359/246.022/670.564 ms. Sampled
parent peak RSS was 158,162,944 bytes and host free memory reached 19,271,680 bytes.
These parent-only observations do not identify the reset's cause or measure
client scheduling delays, Git descendants or available memory. Only five of 252
child resource reports were available after cleanup. A passing distributed run
does not establish hot-repository reliability; this failure remains an open
load milestone. Limits, timeouts and authentication were unchanged.
