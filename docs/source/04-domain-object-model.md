# 04 — Domain Object Model

Status: **Formal model.** This is the canonical shape of Source's truth.

## The hierarchy

```
INSTANCE
   └── ORGANIZATION
          └── PROJECT
                 ├── REPOSITORY (1..n)
                 └── WORK (1..n)
                        ├── SESSION (0..n)
                        │      └── CHANGE (0..n)
                        │             ├── SOURCE (base→head)
                        │             └── EVIDENCE (0..n)
                        └── DECISION (0..1 per Change)
```

## Object definitions

### Instance
A running Source environment. Fields: `id`, `name`, `hosted|self_hosted`,
`domains[]`, `api_version`, `created_at`. One Instance per deployment. Tenant
boundaries are enforced at the Organization level.

### Organization
A grouping of principals and projects. Fields: `id`, `name`, `slug`,
`visibility`, `created_at`. The Organization is the tenant boundary: it is
explicit in every route and enforced server-side (see
`21-multi-tenant-orgs.md`).

### Project
The primary human-facing unit. Fields: `id`, `slug`, `name`, `description`,
`visibility` (`public|private`), `owner_org`, `repositories[]`, `policy_ref`,
`created_at`. A Project may contain multiple repositories. Work, Changes,
Evidence, Agents, Skills, Workflows, Releases, and Policy all hang off Project.

### Repository
A Git repository connected to a Project. Fields: `id`, `project_id`, `name`,
`bare_path`, `default_branch`, `visibility`, `created_at`. Git remains
authoritative for source history; Source stores only the association and
metadata, plus the mapping from Git state to Work/Session/Change/Evidence.

### Work
The primary collaboration object. Fields:

- **Immutable:** `id` (e.g. `W184`), `type`, `created_at`, `requester`,
  `intent` (the statement of what must happen).
- **Mutable:** `requirements[]`, `constraints[]`, `context`, `priority`,
  `dependencies[]`, `assignee`, `required_evidence[]`, `acceptance_conditions[]`,
  `status`, `sessions[]`, `changes[]`, `decisions[]`.

Work is **not** a renamed Issue: it carries required evidence and acceptance
conditions as first-class fields, and its lifecycle is driven by Sessions and
Changes, not by comment threads.

### Session
An execution attempt against Work. Fields: `id`, `work_id`, `principal`
(human or agent), `environment`, `started_at`, `ended_at`, `base_commit`,
`tools[]`, `skills[]`, `workflow`, `model` (optional), `events[]`,
`artifacts[]`, `result`, `evidence[]`, `changes[]`. Sessions support humans and
agents symmetrically.

### Change
A proposed modification to source. Fields: `id`, `work_id`, `session_id`,
`base_commit` (exact base state), `head_commit` (resulting state),
`repositories[]` (multi-repo support), `diff_ref`, `evidence[]`, `review_state`,
`conflict_state`, `decision_state`, `created_at`.

A Change is **not** a renamed pull request: it is anchored to an exact base
commit, tied to Work and Sessions, and its acceptance is a Decision over
Evidence, not a merge of a branch.

### Evidence
A structured proof object. Fields: `id`, `subject` (what it proves),
`claim` (the assertion), `type` (test|eval|spec|scent|shipcheck|runledger|
casefile|patchbrief|changebucket|static_analysis|security|benchmark|human_review|
agent_review|runtime|reproduction|policy_check|external), `producer`
(principal or service), `artifact_ref` (content-addressed), `result`
(normalized), `provenance` (chain), `environment`, `validity`, `expires_at`,
`relationships[]`, `integrity` (hash), `created_at`.

Normalization never destroys the original artifact: `result` is a summary;
`artifact_ref` points to the full original. See `07-evidence-model.md`.

### Decision
A durable record of why Source state changed. Fields: `id`, `change_id`,
`decision` (`accepted|rejected|revision_requested|superseded|deferred|released`),
`decider` (principal), `authority` (capability that authorized it), `policy_ref`,
`evidence_snapshot` (hashes of evidence evaluated), `reasoning`, `source_state`
(commit), `timestamp`.

### Principal
The common identity abstraction. Types: `human`, `agent`, `service`,
`organization`. Fields: `id`, `type`, `name`, `created_at`. Username/password is
**not** the fundamental identity model; a Principal is a stable identity that
Capabilities are issued to.

### Capability
A bounded grant of authority. Fields: `id`, `principal_id`, `scope`
(`org|project|repository|work|action`), `allowed[]`, `denied[]`, `expires_at`,
`issued_at`, `token` (opaque, HMAC-signed). Example scope: read source, read
context, submit change, submit evidence; denied: accept change, modify policy,
publish release. See `08-identity-capability-model.md`.

### Policy
Deterministic rules controlling Source behavior. Fields: `id`, `scope`,
`required_evidence[]`, `approval_requirements[]`, `agent_restrictions[]`,
`change_boundaries[]`, `release_rules[]`, `security_requirements[]`,
`escalation_rules[]`. Policy is evaluated deterministically; it never invokes
an LLM.

### Agent / Skill / Workflow
- **Agent** — an autonomous participant definition (persistent) or a temporary
  session identity. See `08-identity-capability-model.md`.
- **Skill** — a reusable capability/instruction set available to agents.
- **Workflow** — a structured process connecting events, deterministic tools,
  policy, and agents. See `09-agent-protocol.md`.

## Immutable vs mutable

| Immutable (append-only) | Mutable (versioned) |
|---|---|
| Work `id`, `type`, `intent`, `requester`, `created_at` | Work `status`, `assignee`, `requirements` |
| Change `base_commit`, `head_commit`, `created_at` | Change `review_state`, `decision_state` |
| Evidence `id`, `artifact_ref`, `integrity`, `producer`, `created_at` | Evidence `validity`, `expires_at` |
| Decision (entire record) | — |
| Audit log entries | — |

The rule: **once a Decision is recorded, it is immutable.** Evidence artifacts
are content-addressed and immutable; their *interpretation* (validity) may be
updated but the original is never destroyed.

## Cross-references

- `05-work-lifecycle.md` — Work state machine.
- `06-change-model.md` — Change state machine and multi-repo.
- `07-evidence-model.md` — Evidence normalization.
- `08-identity-capability-model.md` — Principal/Capability.
