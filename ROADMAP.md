# Source roadmap

Updated October 14, 2026. This is the current product and engineering roadmap.
It supersedes the contest checklist and the delivery order in early design docs.
Those documents remain useful architectural references.

## Direction

Help developers and agents work on shared repositories without losing the link
between a task, its proposed code, the evidence and the decision to accept it.
Keep Git history, explicit review authority and recoverable failures at the core.
Build on the existing Node.js service, stores, queue and container runner.

The versions below are planning targets, not dates or claims of implemented
features. Ship when the exit criteria pass. Split milestones when needed, but
preserve their safety dependencies. Only 0.1.0 is released today.

## Starting point: 0.1.0 — released

- [Public MIT release](https://github.com/kujolang/source/releases/tag/v0.1.0),
  tagged at `9fe17b8c20db31a56853a4a10f94f28c2b9aef8c`.
- Project → Work → Session → Change → Evidence → Decision → canonical Git.
- Browser review, CLI, scoped HTTP/Git access, organization boundaries and Kujo
  evidence adapters.
- JSON, SQLite and PostgreSQL stores; bounded queues, leases, container execution,
  readiness, metrics and backup/recovery tooling.
- Cloudflare Worker bootstrap and accepted-change promotion to Artifacts,
  including stale-head rejection and lost-acknowledgment recovery.
- Deterministic tests, real PostgreSQL concurrency checks, container builds and
  two-container failover in CI.

The owner reports that the contest entry and announcement are submitted. The
release, ecosystem page, docs and MCP catalog are public. Installation uses Git
and npm; Source is not a Kennel-installable Kujo package.

**Current boundary:** experimental software for evaluation. The recorded live
Cloudflare profile runs Source and review data locally, with Workers and Git on
Artifacts. Contributors and review decisions are scripted. That demo does not
prove a hosted service, autonomous model execution, public contributor transport
at scale or production readiness.

Evidence: [release notes](docs/RELEASE_0_1_0.md),
[hardening audit](docs/audits/repository-hardening.md),
[live Cloudflare record](docs/contest/CLOUDFLARE_LIVE.md).

## Release sequence

| Target | Outcome | Depends on |
| --- | --- | --- |
| 0.1.1 | Clear installation, upgrade and support contracts | Released 0.1.0 baseline |
| 0.2.0 | Safer transactions, execution and recovery | Compatibility decisions and failure tests |
| 0.3.0 | One real agent workflow a maintainer can operate | 0.2 safety gates |
| 0.4.0 | A repeatable self-hosted team pilot | 0.3 workflow and measured operating limits |
| 1.0.0 | A supported self-hosted contract | Successful pilots and independent review |

### 0.1.1 — make the release easier to adopt

- [ ] **R01 · P1 · Upgrade guidance.** Turn the audit caveats into an operator
  checklist: historical requester credentials, evidence fidelity and in-flight
  dedupe keys. Verify detection and recovery using disposable legacy fixtures.
  Never print credentials or silently rewrite historical data.
- [ ] **R02 · P2 · Runtime support.** Reconcile the manifest's Node `>=18`
  declaration with the Node 22 quick start and CI. Choose a tested support range.
  Cover every advertised major version, or document a narrowed requirement and
  its upgrade impact.
- [ ] **R03 · P2 · Release maintenance.** Review pinned CI actions for supported
  runner runtimes. Keep clean-install instructions, release notes and a fresh
  tagged-clone rehearsal reproducible. Preserve immutable published tags.

**Done when:** a new operator can install the tag and follow the upgrade checklist
without unpublished setup knowledge. Runtime support matches CI. Applicable
legacy fixtures and release gates pass. Do not put an incompatible store or
execution redesign into a patch release.

### 0.2.0 — close the known reliability gaps

- [ ] **R04 · P1 · Real maintenance transactions.** Inventory synchronous
  PostgreSQL callers and design a migration or retirement path for that interface.
  It currently invokes separate `psql` processes, so `BEGIN` and subsequent writes
  do not share a transaction. Async serving already uses real transactions.
  Preserve supported consumers through explicit compatibility or deprecation;
  do not silently change synchronous calls into promises.
  **Proof:** a failure halfway through multi-record maintenance rolls back on real
  PostgreSQL. Verify text/binary fidelity, upgrade and migration recovery.
- [ ] **R05 · P1 · Cancellation and retry ownership.** Define one deadline and
  ownership contract across workers, handlers, containers and leases. An abort
  signal cannot force arbitrary JavaScript to stop. Define how built-in execution
  stops, how custom handlers cooperate and how uncertain non-idempotent work is
  reconciled before retry. Make lease-extension failures observable and actionable.
  **Proof:** timeout, shutdown, lease loss and worker death cannot let a stale
  attempt record success or automatically repeat an unresolved side effect.
  Test cooperative and non-cooperative handlers; document remaining limits.
- [ ] **R06 · P1 investigation · Git writer ownership.** Inject lease expiry,
  pauses, process death and independent writers during long Git operations,
  including Artifacts promotion. Git compare-and-swap already protects ref
  updates; lease expiry across an external operation remains an audit hypothesis,
  not a demonstrated exploit. Fix demonstrated gaps at the write boundary.
  **Proof:** stale ownership cannot bypass expected-head checks; interrupted
  promotion has a tested reconciliation path. Distinguish emulated fault tests
  from bounded live Cloudflare checks.

**Done when:** R04–R06 have reviewed contracts and regression evidence, with no
unresolved unsafe retry or data-integrity path in the supported operating mode.
Publish migration, rollback and limitation notes. R05 blocks enabling real-agent
side effects and automatic retries in the next milestone.

Primary code: [PostgreSQL store](src/postgres-store.js),
[worker](src/worker.js), [action runner](src/action-runner.js),
[Git integration](src/git.js). Audit references: O1, O2 and O3.

### 0.3.0 — support a real agent contribution end to end

- [ ] **R07 · P1 · One supported agent adapter.** Choose one model/provider or
  external-agent integration after defining its auth, execution, evidence and
  cancellation contracts. Start with a bounded task, isolated workspace and
  least-privilege capability. Record agent/model identity and attempt outcomes
  without retaining secrets. Keep approval authority outside model output;
  repository content and tool results remain untrusted input.
- [ ] **R08 · P1 · Human review and revision.** Run an actual model-backed task
  through proposal, executed checks, human rejection or requested changes,
  revision, acceptance and promotion. Make stale evidence and changed proposals
  visible. Keep the scripted demo as a deterministic CI fixture. Label live model
  runs separately; default CI must not require a paid provider.
- [ ] **R09 · P2 · Usable handoffs and failures.** Exercise the existing UI/API
  with developers outside the implementation team. Fix demonstrated friction in
  work context, evidence inspection, conflict recovery and failed-job handling.
  Operators should be able to tell what ran, what failed, what remains active and
  whether retry needs review without reading raw database records.

**Done when:** a second operator can reproduce a documented real-agent workflow,
including a rejected proposal and recovered failure. Unauthorized approval, secret
access and execution outside configured limits fail closed. Record actual usage
and cost for that run; one run does not prove scale or unrestricted autonomy.

Use the existing [agent protocol](docs/source/09-agent-protocol.md) and
[workflow/action boundaries](docs/source/27-workflows-actions.md). Any Kujo SDK or
provider changes need a separate compatibility review in their own repository.

### 0.4.0 — run a self-hosted team pilot

- [ ] **R10 · P1 · Repeatable deployment.** Test one complete profile: TLS,
  identity/capability lifecycle, PostgreSQL, durable Git storage, worker execution,
  secret rotation and Cloudflare setup where enabled. Exercise onboarding,
  least-privilege review and offboarding with real users. Extend existing controls;
  do not equate this profile with a managed SaaS.
- [ ] **R11 · P1 · Recovery and operating limits.** Run the existing backup,
  restore and failover tools against realistic data. Include database loss,
  interrupted promotion, revoked credentials and Worker/Artifacts outages.
  Define and measure recovery objectives. Verify restored Git, evidence and
  decisions agree before reopening writes.
- [ ] **R12 · P1 · Representative capacity.** Measure cold connections, sustained
  concurrency, queue saturation, large repositories/evidence, memory and p95/p99
  latency on a named deployment profile. Set capacity and regression budgets from
  measurements. The existing 5,000-request gate is not a promise of 5,000
  simultaneous agents or an internet-scale hosting service.
- [ ] **R13 · P2 · Efficient wakeups, if justified.** Measure idle polling load
  before wiring PostgreSQL notifications through the queue. If worthwhile, test
  disconnect/reconnect, missed notifications, bounded fallback polling and
  shutdown. Do not trade correct delivery for a smaller polling count.

**Done when:** pilot operators can deploy, upgrade, restore and diagnose the
supported profile from published instructions. Recovery and capacity limits have
receipts, runbooks and named operational ownership. Pilot failures become
regression tests before adoption expands.

### 1.0.0 — support the contract we have proved

- [ ] **R14 · P1 · Independent review.** Complete independent security and
  operations reviews of the supported profile. Resolve release-blocking findings
  and retain fix evidence. An internal audit is not an independent review.
- [ ] **R15 · P1 · Compatibility and support policy.** Publish supported runtime,
  database and Git versions; API/CLI error and schema contracts; migration and
  deprecation rules; backup compatibility; and the security reporting process.
- [ ] **R16 · P1 · Release evidence.** Fresh installation, upgrade from the
  previous supported version and restore drills pass. Pilot evidence supports
  the stated limits. Documentation and discovery surfaces match the tag.

**Done when:** the supported self-hosted profile has no known unresolved release-
blocking integrity, authorization or recovery defects. Stable means a supported
contract with stated limits, not unlimited scale or a claim of bug-free software.

## Not scheduled

Managed SaaS, billing, hosted identity federation, broad provider coverage,
marketplaces, a GitHub feature-for-feature replacement, drop-in GitHub Actions
compatibility and a language rewrite are not commitments in this plan. Revisit
these only with user demand, operating ownership and a separate scope decision.
Kennel enrollment would require a suitable reusable Kujo package; do not invent
one merely to list the current Node application.

## How to work this plan

1. Start with R01–R03. Prepare R04/R05 compatibility decisions before changing
   their interfaces. Safety fixes can ship sooner when they preserve contracts;
   the sequence must not delay a critical fix for a version label.
2. Give each implementation issue its roadmap ID, owner, supported behavior,
   failure reproduction, acceptance checks and dependencies. Owners are currently
   unassigned; listing work here does not assign or start it.
3. Land small changes with regressions. A checked box needs a linked PR or commit
   and verification receipt. Resolve investigations with evidence, including when
   the correct result is to retain the current implementation.
4. Before a tag, run lint, format, deterministic tests, local demos, Cloudflare
   contract tests and PostgreSQL/container CI gates. Run bounded live checks when
   a changed integration requires them; keep credentials out of receipts.
5. Publish changelog, upgrade notes and limits. Refresh website/docs/MCP records
   from released behavior; coordinate other repositories separately.
6. Review this file after each release or material pilot finding. Record scope
   changes and reasons here rather than maintaining competing roadmaps.

Documentation-only changes need link and whitespace checks, not fabricated
runtime benchmarks. Ordinary development must not require paid cloud access.
A future version number here does not authorize a deployment or release by itself.
