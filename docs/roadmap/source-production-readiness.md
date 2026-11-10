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

1. Ten compatible agents: actual concurrent Git clients pass; normal full Source
   lifecycle workload still required.
2. Ten same-file agents: compatible fixture passes; conflicting pair passes;
   ten-way incompatible workload remains.
3. Different files/shared dependency: risk report passes; executed semantic checks remain.
4–5. Concurrent promotion and branch moves after verification: new broker tests remain.
6–8. Assembly/promotion process death and lost acknowledgment: deterministic rebuild
   and existing Artifacts recovery exist; real new broker crash drills remain.
9–11. Duplicate jobs, stale dependency cache and forged evidence: existing queue
   dedupe is a foundation; exact-candidate integration tests remain.
12–13. Unit pass/integration fail and batch failure splitting: remain.
14. Unauthorized bypass: internal-ref push rejected; local canonical/legacy bypass
   tests remain.
15. Sustained push workload: representative benchmark remains.
16. Workflow/log secrets: existing action tests; new integrated execution tests remain.
17–18. Storage failure and competing instances/failover: existing store/writer tests;
   integration intent and multi-process broker tests remain.

## Deliverables and gates

Baseline report and partial integration architecture exist. Still required:
`docs/architecture/hosting-readiness.md`; `docs/validation/concurrency-results.md`;
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
