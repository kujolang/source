# Source platform handoff — 2026-11-10

## Video checkpoint — 2026-11-11

The user separately requested a real-time recording of 100 contributors changing
the same files for a HyperFrames release film. That bounded recording is complete:
one shared-file run passed through exact verification/promotion and tree equality;
the first heavier-recording attempt failed and remains preserved. See the
[video handoff](videos/source-100-agents/README.md) for artifacts, reproducibility,
voice provenance and limitations. Benchmark extension: `08b20ee`. Source v0.2.0
was previously published at `e1230df`; the video does not change that tag.
The full platform mission and wider capacity campaign remain paused.

## User direction and current state

The user asked to pause this work, avoid spending more time on 100/250/1000-agent
capacity now, and leave a handoff for a later agent. Do not automatically launch
more capacity runs. Resume only when the user asks. The full platform mission is
unfinished; the pause does not narrow its definition of done.

- Repository: `/Users/robertdevore/2026/Kujolang/kujo-repos/source`
- Branch: `codex/agent-native-integration`; push increments here, do not merge main.
- Mission: `/Users/robertdevore/.codex/attachments/2d173243-8b43-49df-a93e-c26dc98d5712/pasted-text-1.txt`
- Latest implementation: `f16dfbd` (benchmark recovery); preceding implementation
  `b6f3638` (atomic keyed submission) and documentation `68b871b`.
- No active test/benchmark processes at handoff. Owned disposable database
  `source_keyed_bench_20261110` was dropped after every process exited. No actual
  user repository was configured, uploaded, migrated or had its remotes changed.
- Prior turn was concrete progress: implemented/verified/committed crash and
  lost-response submission recovery. This turn added lifecycle benchmark evidence.

## What is implemented and proven locally

1. **GitHub coexistence.** Source secondary remote, explicit atomic local-branch/tag
   sync, origin/upstream preservation, private Git/API capabilities. It is manual
   synchronization, not bidirectional mirroring or GitHub metadata migration.
   [Setup](../README.md#keep-github-as-origin), [submit contract](source/18-source-submit.md).
2. **Integration and controlled promotion.** Real Git candidate assembly,
   compatibility/conflict/dependency handling, proposal provenance, exact-candidate
   verification and acceptance, protected canonical promotion, stale-evidence
   rejection, idempotency and recovery. See [architecture](architecture/agent-native-integration.md),
   [evidence-bound promotion](architecture/evidence-bound-promotion.md).
3. **Verification.** Policy/impact selection, validity-bound reuse, PostgreSQL
   durable jobs, coalescing, dependencies, separate workers, leases and recovery.
   Tool adapters are not ten independent live tool certifications.
4. **Actual project lifecycle.** Source's real history has traversed private
   submit, isolated OCI component tests, exact promotion and fresh authenticated
   clone. Actual Chromium/Lens bridge staging captures desktop/mobile screenshots;
   a deliberate UI regression fails verification/promotion. Coordinated restore
   retains Git, evidence and promotion agreement in a fresh process with the
   original filesystem offline. Worker SIGKILL, orphan cleanup and lease recovery
   have local proofs. See [lifecycle](validation/real-project-lifecycle.md),
   [browser](validation/browser-staging.md), [restore](validation/real-project-restore.md),
   [worker crash](validation/real-project-worker-crash.md).
5. **Submission recovery.** Opt-in `submit --submission-key KEY` commits lifecycle,
   artifacts, audit and original-response receipt together in PostgreSQL.
   `--recover` reads it without Git fetch/push or local HEAD. Principal-scoped auth,
   conflicting-key rejection, rollback after evidence insertion, real SIGKILL,
   independent-process deduplication and post-commit socket loss are tested.
   Git upload remains separate; unkeyed submission is unchanged.
   [Recovery evidence and limits](validation/submission-recovery.md).

These are local correctness demonstrations. They do not certify production,
full GitHub replacement, host/power-loss recovery or deployment capacity.

## Capacity: exactly what is proven

All rows are controlled local content-checking lifecycle fixtures, not application
CI or a production SLO. Private-load explicitly allows 1000 push/submit requests
per minute per address; it is not the default admission profile.

| Concurrent agents | One hot repository | Distributed repositories |
|---|---|---|
| 10 | Passed | Passed |
| 25 | Passed | Passed |
| 100 | Private-load passed, 306.322 s including baseline | Private-load passed, ten repos, 164.340 s including baseline |
| 250 | Failed; native HTTP header deadlines observed, underlying cause unresolved | One private-load run passed, ten repos, 434.642 s including baseline |
| 1000 | End-to-end unmeasured | End-to-end unmeasured |

The 1000-agent PostgreSQL/API tests and a harness accepting 1000 are **not** proof
of 1000-agent Git/submission/assembly/verification/promotion capacity. Passing runs
check retained proposal ancestry, exact promotion, rejected unverified acceptance,
idempotent promotion and final-tree equality with the sequential baseline.

Authoritative records: [concurrency ledger](validation/concurrency-results.md),
[100 hot](validation/benchmarks/agents-100-repos-1-ancestry.json),
[100 distributed](validation/benchmarks/agents-100-repos-10-ancestry.json),
[250 distributed](validation/benchmarks/agents-250-repos-10-telemetry.json),
[250 hot failure](validation/benchmarks/agents-250-repos-1-header-timeouts.json).

Latest keyed-recovery runs at `f16dfbd` deliberately lose one committed response:

| Workload | Whole harness | Receipt lookup | Outcome |
|---|---:|---:|---|
| 10 agents / 1 repo | 32.826 s | 201.813 ms | Passed |
| 25 agents / 1 repo | 72.297 s | 201.910 ms | Passed |
| 25 agents / 5 repos | 73.196 s | 252.393 ms | Passed |

Each retained the original unknown-outcome diagnostic, recovered by GET without
replaying POST, created exactly one Work/Change per agent, and completed exact
promotion and baseline tree equality. All sockets closed. Reports:
[keyed 10 hot](validation/benchmarks/keyed-10-hot.json),
[keyed 25 hot](validation/benchmarks/keyed-25-hot.json),
[keyed 25 distributed](validation/benchmarks/keyed-25-distributed.json).
This is incremental recovery evidence, not renewed certification of 100/250.

## Work still open

- Deployed primary-loss/failover and partial Git/database loss; host/daemon/power
  loss; representative recovery load; independently reviewed deployment security.
- Workcell successful execution requires compatible host isolation infrastructure.
  Local OCI success is not Workcell certification. Multi-service staging remains open.
- Migration target requirements: SSH (absent), general branch/tag policies,
  team/SSO needs, LFS/submodules, human review/issue workflows, external integrations,
  credentials, operational ownership and rollback. Prioritize what the chosen
  project actually requires, not broad superficial GitHub parity.
- Representative application-CI comparison and sustained mixed/conflict workloads;
  the existing speed/count comparisons use an identical synthetic Git-content checker.
- Capacity investigation is deferred by user direction. When authorized later,
  diagnose 250 hot client connect/first-byte timing with independently resourced
  load generation. The current 16-GiB host cohosts hundreds of Node/Git processes,
  API and PostgreSQL. Do not raise security deadlines, weaken auth/isolation,
  lower requested concurrency or replay unknown mutations to make a run green.
- Audit the complete mission requirement by requirement before claiming completion.
  The ordered roadmap retains historical entries; use dated evidence and source
  over old statements. [Hosting inventory](architecture/hosting-readiness.md),
  [work ledger](roadmap/source-production-readiness.md).

## Restart instructions

1. Read this handoff, mission, current git status/log, and relevant evidence. Confirm
   user priorities before restarting expensive capacity work.
2. Preserve branch and existing changes; no automatic main merge or live cutover.
3. Pick the next unproven requirement. Prefer deployment/recovery or concrete
   migration workflow gaps if the user continues to defer capacity.
4. Use focused tests with real Git/PostgreSQL for critical integration boundaries.
   Never edit source/tests/harness while their test or benchmark processes are live.
   An observation timeout is not process termination; poll the same tool handle.
5. Commit/push small verified increments; update Strata with provenance and retrieval
   checks. SignalBox only for qualifying unresolved human-review items, not this handoff.

Environment: macOS x64, Node 26.12.1, PostgreSQL 14.20 on `/tmp:5432`, role
`robertdevore`, Docker Desktop 29.6.2. Use `PATH="/usr/bin:$PATH"` for Apple Git
2.50.1; `/usr/local/bin/git` 2.42.0 previously failed full-history HTTP imports.
Do not alter global Git configuration. Disk free space was approximately 11 GiB;
recheck before creating large fixtures. Do not delete unrelated resources.

Reproduce small keyed recovery only when needed (create your own disposable DB):

```bash
SOURCE_TEST_DATABASE_URL='postgresql:///YOUR_DISPOSABLE_DB?host=/tmp' \
PATH="/usr/bin:$PATH" node --test --test-concurrency=1 tests/integration-benchmark.test.js

SOURCE_TEST_DATABASE_URL='postgresql:///YOUR_DISPOSABLE_DB?host=/tmp' \
PATH="/usr/bin:$PATH" node scripts/benchmarks/integration.js \
  --agents 10 --repos 1 --profile private-load --keyed-submissions \
  --lose-submit-response 3 --output /absolute/new-report.json
```

Latest verification: four benchmark tests passed with zero skips in 58.385 s;
syntax lint checked 125 JS/MJS files; three additional keyed lifecycle runs above
passed. Previous recovery increment: 27 final tests passed, zero skips, plus
legacy submit/sync verification. No full-suite rerun is implied by these counts.
