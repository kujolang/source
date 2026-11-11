# Agent-native integration work ledger

Mission: user attachment `2d173243-8b43-49df-a93e-c26dc98d5712/pasted-text-1.txt`,
2026-11-10. Branch: `codex/agent-native-integration`. The full attached mission
remains active. This ledger does not narrow the definition of done.

## Proven increments

- Baseline source audit and 258 passing tests (seven PostgreSQL skips): `9b414af`.
- Deterministic real-Git candidate assembly: `19ef4cb`; ten concurrent clients,
  full proposal ancestry, compatible same-file edits, binary/rename/delete
  conflicts, dependency inference and stale/cyclic rejection.
- Scoped planning/readback service, source-owned proposal snapshots, policy hash,
  audit and reserved internal ref protection: verified. Root suite plus Worker
  tests: 265 pass, seven PostgreSQL skips, zero failures; final CLI readback passes.

## Ordered remaining implementation

1. Broker foundation implemented: exact-candidate service receipts, human
   acceptance, Git target plus landed-ref transaction, repeat/lost-ack recovery,
   HTTP and legacy-path protection and status/CLI. Seven broker fixtures include
   independent promoters and a post-Git process exit. Clean regression: 282 tests,
   275 pass, seven PostgreSQL skips, zero failures (41 files, 128.91 seconds). Still required: live
   drained activation, tag protection and actual PostgreSQL/failover validation.
   Extend the authoritative merge broker and protected local canonical branches/tags;
   explicit capabilities and acceptance, durable intents/outcomes, CAS, stale
   candidate rejection, lost-ack reconciliation and multi-process recovery.
   Prevent legacy canonical routes bypassing the broker. Retain Artifacts guards.
2. Exact-candidate evidence under current policy: trusted producer/command/input/
   environment/output/expiry, immutable artifacts, verification identity covering
   config/dependencies/tool versions/external state/security policy; reject forged
   or substituted evidence. Artifact hashes do not prove execution authenticity.
3. Dependency-preserving batch splitting after failed combined verification,
   bounded interrupted-assembly recovery and full proposal eligibility lifecycle.
4. Conservative impact tiers, always-required checks, safe reuse explanations;
   inspect actual ChangeBucket, Eval, Spec, ShipCheck, Fence, Concord, RunLedger,
   CaseFile, Lens and Workcell contracts before adding adapters.
5. Extend existing PostgreSQL leased/deduplicated/dependency-aware dispatcher:
   priorities, coalescing, supersession/cancellation, retries, execution receipts,
   costs and queue visibility. Execution remains separate from the API.
6. Isolated exact-revision staging/deployment, endpoint/browser checks, artifacts,
   cleanup/preservation/recovery through a provider-neutral interface.
7. Operational views, backup/restore/failover, hosting/auth/SSH/HTTPS assessment,
   migration/export/mirroring/rollback and one controlled real-repository lifecycle.
8. Real-process hot/distributed benchmarks at 10/25/100/250/1000+ agents: correctness,
   p50/p95/p99, Git/storage/queue/verification/recovery/cost metrics; compare to
   conventional per-PR CI using equivalent policy. No extrapolated claims.

## Adversarial test ledger

1. Ten compatible agents: actual concurrent Git clients and full HTTP submission → PostgreSQL
   verification → acceptance/promotion pass in the fixed-checker benchmark; live
   isolated application verification remains required.
2. Ten same-file agents: compatible fixture passes; conflicting pair passes;
   ten-way incompatible workload remains.
3. Different files/shared dependency: risk report passes; executed semantic checks remain.
4–5. Concurrent promotion and branch moves after verification: broker tests pass,
   including independent CLI promoters and exact-evidence/target rechecks.
6. Assembly process death: SIGKILL after commit-tree and retained-ref update
   recovers deterministically in competing fresh processes; target remains intact.
7–8. Promotion death/lost acknowledgment: independent promoter exit and fresh
   reconciliation pass; injected PostgreSQL outcome rollback retains landed Git
   proof. Machine/power loss and database-primary failover remain unverified.
9. Duplicate/recovered verification: real CLI SIGKILL before/after receipt storage
   and two competing replacement workers pass using natural lease expiry. A
   missing receipt reruns; a persisted deterministic receipt is reused once.
10–11. Stale dependency cache and forged evidence: exact-identity contract and
   HTTP producer rejection pass; live changing external-service contracts remain.
12. Required-check failure blocks acceptance; real unit-pass/integration-fail
   workload execution remains to be demonstrated in isolation.
13. Failed-batch splitting and dependency closure pass without transferring
   evidence or approval; real workload diagnostic effectiveness remains.
14. Unauthorized bypass: internal/canonical smart-HTTP ref push and local
   legacy promotion denial pass for opted-in protected repositories.
15. Sustained push workload: representative benchmark remains.
16. Workflow/log secrets: existing action tests; new integrated execution tests remain.
17–18. PostgreSQL rollback, lost Git acknowledgment, competing instance retirement/
   promotion, and real multi-process verification recovery pass. Full primary
   failover and restoration after partial Git/database loss remain unverified.

## Deliverables and gates

Baseline report and partial integration architecture exist. Still required:
`docs/validation/concurrency-results.md` now records 10-agent hot/distributed
measurements and a fixed-checker conventional baseline;
`docs/architecture/hosting-readiness.md` now records the capability inventory and
secondary-remote, migration and rollback gates;
verification-planner, evidence-bound-promotion and failure-recovery now document
implemented foundations and their remaining gates; benchmark scripts, configuration examples, operator and
migration/rollback guidance, final limitation inventory and A–G mission report.

Initial usable gate requires every invariant in attachment section 9, including
verified exact-candidate promotion, recovery and a real repository lifecycle.
Production gate separately covers deployment security, backup/restore and measured
load. GitHub-replacement gate must match the migration target's actual workflows.
Do not mark the goal complete while required work or verification remains missing.

## Environment constraints

Local PostgreSQL answers on its socket; disposable-database validation remains to
be run. Docker CLI exists but daemon socket is absent. During the first regression
run the host filled its disk: 12 tests failed with ENOSPC, not a successful run.
Only session-log-identified temporary fixtures were removed (143 directories).
A new regression runs each test file with its own TMPDIR and deletes only that
owned directory after process exit, reducing accumulated test storage. Preserve
all user repositories and unrelated disk contents. External production/security
certification remains unproven and is not substituted with local tests.

## Verification intelligence increment — 2026-11-10

Dependency-preserving failed-batch splitting now exists through API/CLI and
creates child candidates without inherited evidence/approval. Conservative impact
selection now retains all mandatory checks, requires explicit complete coverage,
and accounts for renamed paths, dependency closure and sensitive/failure paths.
Ten source-inspected tool adapters classify reports; seven can gate trusted
service attestations, while Spec/RunLedger/CaseFile remain context-only. See the
verification planner for pinned source revisions and compatibility limits.

This supersedes the corresponding missing portions of items 3–4 above. It does
not complete interrupted-assembly drills, isolated execution, durable dispatch,
real-tool lifecycle validation or benchmarks. The full mission remains active.

## Queue foundation increment — 2026-11-10

The original impact/broker regression is now clean after freeing disk capacity:
293 tests, 286 pass, seven PostgreSQL skips. A separate disposable PostgreSQL
baseline passed 22 tests without skips. See failure-recovery for actual evidence.

The existing queue now supports bounded operator priority, scoped
terminal cancellation, expired-lease rejection and worker/runner abort propagation.
Ephemeral workspace cleanup is fenced by the job's lease-attempt identity.
This supplies primitives for item 5; it does not yet connect candidate identities,
reuse, coalescing, supersession or execution receipts to the queue. The full
attached mission remains active and all later environment/hosting/scale gates
remain required.

## Candidate dispatcher increment — 2026-11-10

The PostgreSQL queue is now connected to exact-candidate verification through a
durable per-check generation ledger. Dispatch uses valid deterministic receipts,
coalesces active equivalent jobs, schedules prerequisites, propagates required
reruns to descendants, and preserves reasons in audit records. API dispatch has
its own capability; the operator CLI exposes the same operation. Worker handler
modules receive Source and can use a service-authenticated verification handler.
Queued receipts are fenced by live lease and ledger generation. Requested reruns
invalidate prior-generation evidence for acceptance and promotion. Lost job
acknowledgment after receipt persistence can reuse the saved deterministic result.

This supersedes the earlier statement that candidate identities, coalescing and
receipts are not connected to the queue. It does not establish isolated execution:
the current live lifecycle tests use a controlled Git-reading executor. Next work
must supply a provider-neutral isolated executor/staging lifecycle, cancellation
of replaced candidates, broader worker-process crash/failover validation, and the
remaining hosting, real-project lifecycle and benchmark gates. Historical test
records remain in failure-recovery; no production-readiness claim is made.

## Exact-candidate executor increment — 2026-11-10

An optional OCI executor now exports bounded regular-file Git trees without
checkout filters or Git metadata, verifies blob bytes, requires a digest-pinned
image/environment/tool manifest, and runs through the existing bounded isolated
runner. Worker configuration and an explicit live smoke command are documented
in `docs/architecture/candidate-execution.md`. Controlled tests verify the export
and cleanup contract. Docker's daemon is still absent, so runtime isolation,
UID mapping and teardown are unverified. Networked/provider-neutral staging,
Workcell lifecycle execution, crash orphan reconciliation and all later mission
gates remain required. Symlinks, submodules and external inputs currently fail
closed rather than being silently omitted from the tested candidate.

## Candidate retirement increment — 2026-11-10

Explicit cancellation/replacement now retires a candidate terminally, cancels its
queued/leased jobs, and optionally dispatches a same-repository replacement in
one project transaction. Failed replacement admission rolls back cancellation.
Late evidence and promotion of retired candidates are rejected; a landed Git
receipt, including a lost-acknowledgment receipt, prevents retirement. API
authorization, audit, CLI and status expose the distinction. This completes the
explicit replaced-candidate cancellation portion of the earlier work list;
automatic replacement inference is not enabled. Live PostgreSQL contract/race
results are recorded in failure-recovery. Runtime teardown, staging and the
remaining full-mission gates are still open.

## Workcell bridge increment — 2026-11-10

An optional Workcell executor now connects exact candidate export and the durable
verification handler to Workcell's portable CLI. It binds command/commit/attempt,
verifies the evidence manifest, captures receipt/logs, rejects incomplete cleanup
as passing evidence, and retains recovery/preservation material. Operator examples
and limitations are in `../architecture/workcell-execution.md`. Actual Workcell
1.3.0 validates the definition and resolves the built-in Docker profile; a runtime
invocation failed closed without an inspectable receipt. Docker remains unavailable.

This is a working orchestration bridge, not live isolated staging certification.
Single-environment endpoint/browser fixtures, provider credential delivery,
orphan recovery drills, external-service inputs, real-project lifecycle and all
staged benchmarks remain open mission requirements. The full goal stays active.

## Lifecycle benchmark increment — 2026-11-10

Ten independent HTTP/Git submit clients complete the actual Work/Session/Change/
Evidence lifecycle, candidate assembly, separate-process PostgreSQL verification,
exact-receipt reuse, human-identity acceptance, promotion and fetch. One hot repo
and five-repo layouts pass all assertions, including full ancestry, rejection of
unverified acceptance, idempotent promotion and identical final trees versus the
conventional sequential-merge baseline. Raw reports and reproducible harness are
linked from `../validation/concurrency-results.md`.

This closes the missing compatible ten-agent full control-plane lifecycle proof.
It does not certify isolation, application CI speedup, sustained traffic, crash
recovery under load, larger stages or one real project's normal lifecycle. The
benchmark checker only inspects test-owned Git data, never repository code. The
full mission stays active.


## Live OCI validation increment — 2026-11-10

Docker Desktop now runs locally. The exact-candidate OCI executor passes a live
loopback service check plus non-root/no-ambient-env/no-host-file probes, runtime
resource-profile inspection and cleanup after success, command failure,
cancellation, timeout and output overflow. Evidence: validation/container/
candidate-smoke.json and scripts/candidate-container-smoke.js. This supersedes
the unavailable-Docker limitation for this local executor, not other deployment
profiles. Worker-death orphan recovery, browser/multi-service staging, Workcell
live validation, real-project lifecycle and larger load stages remain open.

Workcell follow-up: the bridge now supplies an attempt-owned TMPDIR so absolute
output is accepted and original failure evidence is retained. The live run reaches
the Docker policy gate but refuses execution because this daemon lacks AppArmor.
A compatible approved runtime remains necessary; the requirement was not relaxed.
See validation/container/workcell-smoke-blocked.json and the reproducible
scripts/workcell-candidate-smoke.js command.

## Semantic adversarial validation increment — 2026-11-10

Live OCI checks now demonstrate unit-pass/integration-fail for clean Git merges
that touch different files sharing a semantic constraint. Split verification
identifies either a single faulty proposal or a pairwise interaction, requires
fresh exact-candidate evidence, and cannot bypass combined failure by landing
both individually green children against a stale base. Ten concurrent conflicting
same-file proposals are also accounted for deterministically. Reproduction and
limitations are in failure-recovery.md and integration-semantic-live.test.js.
These close those specific adversarial fixtures; they do not replace remaining
staging, orphan recovery, real-project, scale or production validation gates.


## 100-agent measurements — 2026-11-10

Default public/shared-IP hot and ten-repository runs fail during clone admission
with HTTP429, before completed submissions. A separately declared private-load
profile (private scoped credentials, bounded1000/min push/submit, other server
limits unchanged) passes both complete100-agent lifecycles. Raw reports and full
profile differences are in validation/concurrency-results.md. No default-capacity
claim is made. Source reduces checker count but all-pairs Git ancestry discovery
makes assembly expensive enough to outweigh measured verification savings. Next:
optimize that graph operation without altering candidate semantics, then repeat
measurements. 250/1000 and all other unresolved gates remain open.

## Stress-stage checkpoint — 2026-11-10

The independent-head optimization is now implemented and both 100-agent private
layouts passed with assembly totals of 24.784 s hot / 24.634 s distributed.
Source now exposes a validated operator batch ceiling from 1 through 1000,
default 100; a real-Git 101-proposal assembly regression passes. This replaces
the earlier hardcoded service ceiling, not the outstanding stress acceptance gate.

Four 250-agent private-load attempts are recorded in concurrency-results: both
layouts failed during submission. Diagnostic reruns identify clone transport
failures (Git exit 128), not a proven local spawn or HTTP admission rejection.
No assembly/promotion capacity claim follows. Investigation also reproduced and
fixed admission of disconnected queued clients; 35 focused regressions pass and
the long post-report process drain no longer recurs. Next: classify safe client
curl failures and backend exits, resolve the observed transport failure, rerun
250 hot/distributed, then attempt 1000. Sustained/recovery load and the independent
hosting, isolation and production gates remain open.

## Transport diagnosis checkpoint — 2026-11-10

The 250-agent failures now have stronger evidence: both hot/distributed runs
reached an HTTP submission connection timeout (`UND_ERR_CONNECT_TIMEOUT`) after
more than 2000 successful Git backend exits. Replaced the single submission
fetch exchange with bounded Node HTTP/HTTPS using the existing shared deadline;
no redirect or uncertain-mutation replay is permitted. A subsequent distributed
run failed earlier at Git ls-remote with HTTP408, consistent with pre-handler
header timeout under this local burst. No server timeout or auth/verification
policy was relaxed. Raw failures and evidence limitations are in concurrency-results.
Next work remains measurement and transport/admission reliability at250, including
per-stage resource/event-loop data and timeout policy evaluation, then1000 and the
separate sustained/recovery, isolation, real-repository and production gates.

## Distributed stress evidence — 2026-11-10

At `b94afc3`, 250 real agent processes across ten repositories pass the complete
private-load lifecycle, including baseline tree equality, all proposal ancestry,
exact verification, acceptance/promotion, idempotency and cleanup. Submission
104.540 s; assembly 62.785 s; verification phase 9.369 s; 10 completed jobs versus 250
baseline checks. Per-stage parent event-loop/CPU/sampled-memory telemetry and all 252
Node child resource reports are retained. No timeout/auth/verification limit was
relaxed. This supersedes the blanket status that no 250-agent run has passed;
it does not invalidate prior intermittent failures. 250 hot, repeated/sustained
load, 1000 agents, recovery and complete host-resource accounting remain open,
alongside the independent real-project/isolation/production gates.

## Confirmed OCI cleanup — 2026-11-10

The runner now confirms exact named-container teardown before reporting success
or deleting a managed workspace. Unconfirmed cleanup retains the workspace and
a durable recovery record and blocks new execution, including restarted runners
using that root. The candidate environment hash includes the new cleanup contract;
policy update, replanning and fresh evidence are required. Local real-container
fault injection proves retention and explicit recovery while the container is
still running. This advances runtime-unreachable handling; it does not complete
worker-SIGKILL orphan reconciliation, actual daemon restart, multi-service staging,
Workcell compatibility, or the other load/real-project/production gates.

## Managed worker crash recovery — 2026-11-10

Candidate and managed workflow execution now journal ownership before OCI launch.
The operator reaper admits only dead local owners in the recorded PID namespace,
verifies labels/image/bind, removes by immutable container ID, and retains every
ambiguous case. Root locks serialize reapers; live attempts are protected even
with identical job IDs. Actual SIGKILL and concurrent live-attempt preservation
are demonstrated through the recovery CLI. This advances the worker-death gate
for running managed containers; export/pre-launch ambiguity, reaper death, actual
daemon/host loss, queue-integrated restart and production deployment drills remain
open alongside the real-project, staging and load requirements.

## Actual Source development lifecycle — 2026-11-10

An isolated private instance now demonstrates actual Source history and feature
commits through CLI sync/submit, HTTP planning and authorization, separate CLI
PostgreSQL worker execution, 66 passing component tests plus syntax validation,
evidence reuse, acceptance, idempotent promotion and a fresh clone matching the
verified candidate. One nested Docker test is explicitly excluded from the
container and tested separately on the host. See the
[raw evidence and reproduction guide](../validation/real-project-lifecycle.md).
The operator dependency image uses immutable local IDs, locked npm dependencies
and Git's HTTP backend. This advances the real-project normal-lifecycle milestone;
multi-proposal project workflows, queue restart, coordinated restore, staging,
production deployment and remaining load/migration gates are still open.

## Actual-project coordinated restore — 2026-11-10

The Source development lifecycle now includes a quiesced backup, verified private
snapshot, relocated filesystem and temporary PostgreSQL database. With the
original path offline, a fresh process confirms canonical/candidate/landed Git,
policy acceptance and outcome, receipts/artifact hashes, completed jobs, private
clone and idempotent promotion. See [restore evidence](../validation/real-project-restore.md).
This closes the local coordinated-restore demonstration for this project; it does
not close deployed failover, online consistency, partial storage loss or recovery
under representative load. Queue-integrated OCI restart, staging, Workcell host
compatibility and remaining scale/migration gates still require work.

## Actual-project queue-integrated OCI restart — 2026-11-10

At `bac2a46`, an actual CLI worker is killed during Source's real Git/API test
suite. Ownership-based operator cleanup removes the running orphan; a fresh CLI
worker naturally reclaims the PostgreSQL lease with a new token. Stale writes
are rejected, completed evidence is preserved, only the interrupted check reruns,
and exact promotion plus independent restore succeed. See
[raw evidence and reproduction](../validation/real-project-worker-crash.md).
This closes the single local queue-integrated crash demonstration. It does not
close deployed failover, sustained recovery load, host/daemon loss, staging,
Workcell host compatibility or the outstanding hot-repository/1,000-agent gates.

## Hot-repository capacity diagnosis — 2026-11-10

Two additional 250-process hot-repository runs failed before submission. Passive
HTTP diagnostics at `357ffa0` identify 15 native header deadlines on connections
with zero bytes received after 15–16.5 seconds; all sockets are accounted for at
cleanup. This narrows the newly reproduced failure to pre-handler connection
progress and does not establish the earlier submission reset's cause. Keep
admission/security timeouts unchanged. Client connect/first-byte timing and an
independently resourced load generator are needed to distinguish service limits
from cohosted process pressure. See [measurements and boundaries](../validation/concurrency-results.md).
The hot-repository stress gate remains failed; 1,000 agents remain unmeasured.
