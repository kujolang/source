# Git hosting and migration readiness

Assessment date: 2026-11-10. Scope: the local implementation on
`codex/agent-native-integration`. This is a capability inventory, not production
certification. Historical hosted results in `EXTERNAL-BLOCKERS.md` do not validate
this branch. See [baseline](../validation/agent-native-baseline.md) and
[recovery evidence](../validation/failure-recovery.md) for dated test results.

## Capability inventory

| Area | Current implementation and evidence | Remaining boundary |
|---|---|---|
| Repository management | Local canonical bare repositories, project-scoped API/CLI; `src/source.js`, `tests/git.test.js` | No complete GitHub/GitLab account migration |
| Clone, fetch, push | Standard smart HTTP; capability auth before Git backend; `tests/git-http.test.js` | SSH absent; public reads intentionally anonymous |
| HTTPS | In-process TLS and reverse-proxy mode; `tests/tls.test.js` exercises HTTPS clone | Operator owns certificates, proxy configuration and renewal |
| Branch protection | Internal refs reserved; opted-in default branch accepts only broker promotion; broker and Git HTTP tests | General branch-pattern/tag policies absent; activation requires drained writers |
| Review | Work/Session/Change/Evidence/Decision and exact-candidate human acceptance; `tests/integration-broker.test.js` | GitHub review threads, issue links and review-history import absent |
| Identities and permissions | Human/service principals, organization roles and scoped capabilities; auth/org tests | No demonstrated SSO or team-directory migration |
| Browse/history | Existing browser UI and Git history; `tests/web-ui.test.js` | No complete integration-batch/cost dashboard |
| Webhooks | Signed dispatch, bounded request handling, delivery IDs and event deduplication in `src/api.js` | External integration compatibility must be exercised per provider |
| Workflow execution | PostgreSQL jobs, dependencies, retries, leases, cancellation, worker separation and logs; worker/queue tests | No distributed admission/cost certification at target agent counts |
| Candidate verification | Policy-bound identities, trusted service receipts, immutable outputs and broker gates; dispatcher/broker tests | Seven tool gates and three context adapters are not ten live end-to-end tool certifications |
| Isolated execution | Pinned OCI execution, actual Source component tests and managed worker-SIGKILL recovery demonstrated locally; optional Workcell adapter | Workcell success requires a compatible host; multi-service/browser staging and daemon/host-loss recovery remain unverified |
| Secrets/artifacts | Existing secret broker, redaction and artifact stores; action/workflow tests | Integrated untrusted candidate execution and deployed secret lifecycle need validation |
| Backup/restore | Archive/hash verification, PostgreSQL dump and restore-drill scripts; `tests/backup.test.js` | No consistent online Git/database snapshot established; quiesce writers for a coordinated backup |
| Replication/recovery | Git replication, PostgreSQL replication checks and writer fencing; replication/failover scripts and tests | Current branch lacks full primary-loss and partial Git/database-loss deployment proof |
| Import/export/mirroring | Git-compatible local refs and `source sync`; `tests/sync.test.js`; repeatable Git replication test | No automatic bidirectional sync, LFS data migration, issue/PR migration or provider metadata import |
| Operations | Health/readiness, counters, audit, bounded queue and worker settings | Representative load, alerting/retention policy and independently reviewed deployment remain required |

Test filenames identify supporting contracts, not proof of every deployment
configuration. The integration broker currently targets local canonical Git;
existing Artifacts behavior must not be treated as equivalent protected promotion.

## Start as a secondary remote

Keep GitHub as `origin`. Use the [README secondary-remote walkthrough](../../README.md)
and [submit guide](../source/18-source-submit.md) for exact commands:

1. Run a Source instance with durable storage, HTTPS, and a separately backed-up
   Git root. Create the organization/project and an empty repository whose default
   branch matches the local repository.
2. Obtain project-scoped API and Git capabilities. Use the documented credential
   environment/helper mechanism; do not put secrets in remote URLs.
3. Add the Source URL under remote name `source`. Select that remote for
   `source submit` (automatically preferred when present), preserving `origin`.
4. Preview `source sync --dry-run`, inspect the refs, then sync. Sync atomically
   pushes local branches and tags; it neither force-pushes nor deletes destination
   refs. It does not automatically fetch GitHub or mirror unfetched remote branches.
5. Verify refs on Source, clone into a separate directory, and exercise one normal
   work/submission/review/promotion cycle before relying on the copy.

Sync is an explicit snapshot operation, not continuous replication. After broker
protection is enabled, do not use raw sync to update the default branch: submit and
promote through the broker first. A protected-ref rejection aborts the atomic sync.
Large-file storage and submodules need independent availability checks.

## Migration gate for one real project

Name the migration target and inventory its branches, tags, LFS/submodules,
contributors, required checks, deployment integrations, secrets and issue/review
history. Missing dependencies are migration blockers for that project, not reasons
to claim generic GitHub parity.

Before changing the primary remote, demonstrate on that project:

- A fresh authenticated clone; branch fetch/push; rejected unauthorized access.
- Concurrent submissions, combined verification, inspectable failure/review,
  authorized exact-candidate promotion and rejection of stale evidence.
- Worker restart and promotion recovery using persistent PostgreSQL/Git storage.
- A coordinated backup, isolated restoration, Git integrity and agreement between
  restored canonical refs, evidence and promotion records.
- Required human workflows and integrations, documented operator access and an
  agreed rollback procedure.

Source's own repository completed a [private development lifecycle](../validation/real-project-lifecycle.md)
with real history, CLI submission, a separate PostgreSQL worker, isolated component
tests, exact-evidence promotion and a fresh authenticated clone. No real-project
migration is certified: project-specific checks, coordinated restore,
restart/failover and human workflow gates above still apply.

## Cutover and rollback procedure

During the secondary-remote phase, rollback simply means stopping Source writes
and continuing to use the unchanged GitHub `origin`. Retain Source evidence and
backups; do not delete Source-only branches or accepted changes.

For a later primary cutover, first freeze writers, compare explicit branch/tag OIDs,
export any Source-only history, take and restore-test a coordinated backup, and
record the last agreed revision. Change remote configuration only after target
workflows pass. Preserve the former GitHub remote under a distinct name.

If rollback is needed after Source accepted new commits, freeze both destinations,
collect and compare their refs, and reconcile Source-only commits through the
normal GitHub review policy. Restore the prior remote configuration only after
history is accounted for. Never use force mirroring as an implicit rollback: it
can discard work. Keep Source audit/evidence available for inspection.

## Separate release gates

The initial usable gate requires the full lifecycle and recovery invariants in the
[roadmap](../roadmap/source-production-readiness.md). Production additionally
requires deployed isolation, backup/restore/failover, capacity measurements and
security/operational review. GitHub replacement additionally requires the named
migration target's actual workflows. Passing unit tests or supporting HTTPS alone
does not close any of these gates.
