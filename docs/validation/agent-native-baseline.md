# Agent-native integration baseline — 2026-11-10

Baseline revision: `1891ace0a20fb0541f5974d9410c7882e4e3f465`.
Work branch: `codex/agent-native-integration`. This report precedes implementation.
Mission: implement the attached agent-native integration platform assignment;
this baseline is not the completed milestone or a production certification.

## Architecture and capability inventory

| Boundary | Current implementation/evidence | Classification / gap |
| --- | --- | --- |
| Git hosting | `git-http.js`, API Git routes, `git.js`, git-http/git/tls tests | Implemented; authenticated smart HTTP, TLS; SSH missing |
| Lifecycle | `domain.js`, `source.js`, domain/decision/e2e tests | Implemented Work/Session/Change/Evidence/Decision; no batch candidate |
| Authorization | `auth.js`, `capability.js`, org/capability/auth tests | Implemented scoped capabilities, human approval policy |
| Promotion | `GitRepo.fastForward[Async]`, source canonical update, artifacts tests | CAS implemented; local Git transport lacks protected branch guard; no general durable promotion intent |
| Evidence | `createEvidence`, `evaluateEvidence`, Kujo adapters/tests | Artifact integrity, provenance fields and validity exist; policy matching does not require exact revision, expiry or trusted execution |
| Workflow | `source.js` workflows; github-actions/workers tests | Implemented immutable definitions, dependencies, idempotent event dispatch |
| Queue | `postgres-store.js`, `job-queue.js`, `worker.js` | Leases, tokens, dedupe, bounded queues/retries, dependency scheduling and notifications exist; candidate-aware priorities/cancellation/cache not implemented |
| Isolation | `action-runner.js`, action-runner tests | Container boundary, no network default, resource bounds, secret broker/redaction exist; live runtime unavailable locally |
| Storage | JSON/SQLite/Postgres stores and store tests | JSON single-process, SQLite transactions, async Postgres transactions/advisory locks; synchronous Postgres pseudo-transactions remain unsafe for new multi-record protocols |
| Recovery | writer-lease/replication/backup scripts/tests | Existing fencing, restore checks and lost Artifacts acknowledgment recovery; combined-candidate recovery missing |
| Cloudflare | integrations/artifacts.js and Worker | Implemented protected remote binding; historical live evidence is not fresh validation |
| Kujo | integrations/kujo.js and fixtures | Eval/Spec/ShipCheck normalization; other tool names in docs are not implemented contract adapters |
| UI/ops | web.js, api health/metrics, web-ui/http-load tests | Browsing/history/review, readiness and counters exist; batch/conflict/verification-cost views missing |
| Import/mirroring | remote.js, sync.js, submit/sync tests | Local branches/tags to secondary remote; no GitHub issues/PR or LFS migration |

Evidence from source takes precedence over early docs which describe future hooks,
authentication and other behavior as if shipped. Existing concurrency tests model
HTTP/job workloads, not assembled overlapping agent proposals.

## Baseline validation profile

Node v26.12.1; Git 2.42.0; macOS local workspace. `npm test` completed: 265 tests, 258 passed, seven PostgreSQL-only tests
skipped, zero failures. Log: `/tmp/source-agent-native-baseline.log` (local,
transient; reproduce with `npm test`).
PostgreSQL responds on the local socket. Docker CLI exists but its daemon socket
is absent. Live containers, independent security review, representative production
load and external deployments have not been validated in this cycle.

## Priority and acceptance plan

1. Deterministic Git merge-tree assembly, proposal/dependency eligibility,
   structural conflicts and provenance; real Git tests before integration APIs.
2. Protected refs plus exact-candidate broker, durable intents, CAS and crash
   reconciliation; preserve existing storage and queue interfaces.
3. Policy-bound verification identity, trusted producer receipts, expiry and
   conservative impact selection; adapt actual Kujo contracts, not guessed JSON.
4. Existing durable queue extension, separate isolated execution and staging
   lifecycle; no new broker service unless measurement establishes a need.
5. Operator visibility, recovery/backup and one real repository lifecycle.
6. Reproducible 10/25/100/250/1000-agent hot/distributed benchmarks, comparing
   equivalent verification policies. Report only measured results.

## Initial readiness assessment

Source can host Git and review individual proposals locally. It cannot yet prove
the requested ten-agent exact-candidate integration milestone. A primary-hosting
pilot must first close protected-ref bypass and evidence binding, validate
recovery, provision isolated execution and select a migration target. Production
and GitHub-replacement gates remain separate. Existing EXTERNAL-BLOCKERS remain
applicable; no historical evidence is relabeled as a new certification.
