# 02 — Kujo Capability Audit

Status: **Evidence-backed.** Based on direct inspection of each repository's
`README.md`, `*.spec.yml`, and (where relevant) source layout, not on marketing
claims. Inspection date: 2026-08 (repo mtimes observed).

## Method

Each Kujo tool was classified against Source's needs using one of:

- **REUSE** — Source directly consumes the existing implementation.
- **INTEGRATE** — separate component with a defined Source adapter.
- **REFERENCE** — concept informs Source; no runtime dependency.
- **REPLACE** — Source needs a native responsibility that supersedes part of it.
- **OUT OF SCOPE** — no meaningful Source relationship.

The decisive question for each tool: *does Source need this capability as a
native, server-side responsibility, or can it remain a local CLI that Source
merely ingests artifacts from?*

## The ecosystem in one paragraph

Every Kujo tool is a **local-first, deterministic, zero-network CLI** written in
the Kujo language, emitting JSON + Markdown, storing plain JSON on disk, MIT
licensed. None of them is a hosted, multi-tenant platform. Source is the hosted
platform. Therefore the dominant relationship is **INTEGRATE** (Source ingests
their structured artifacts as Evidence) or **REFERENCE** (their concepts inform
Source's native model), not REUSE (Source does not link their code).

## Classification table

| Tool | Classification | Evidence | Source relationship |
|---|---|---|---|
| **Spec** | INTEGRATE | `.spec.yml` task contracts: goal, scope, acceptance criteria, eval requirements, risks, approval points. Exports agent-context and eval suites. | Work can be authored/imported from Spec; acceptance criteria → required assertions. |
| **Eval** | INTEGRATE | 27 deterministic checks, JSON suites, `summary.json` + `artifact-manifest.json` with SHA-256. | Primary **Evidence producer**. Source ingests Eval run artifacts as structured Evidence. |
| **RunLedger** | INTEGRATE | Agent-run receipts: model, repo, start/end commit, changed files, verdict, cost. | Session receipts. Source's Session is the server-side superset; RunLedger runs are one Session event source. |
| **ChangeBucket** | INTEGRATE | Change footprint: files/churn/risk_level, read-only git. | Change risk evidence. Source computes its own footprint natively but can ingest ChangeBucket JSON. |
| **PatchBrief** | INTEGRATE | Diff summarizer (markdown/json). | Change summary evidence. |
| **ShipCheck** | INTEGRATE | Release-readiness gate (16 checks, gate exit code). | Release Decision evidence. |
| **CaseFile** | INTEGRATE | Evidence bundle capture + redaction, `.casefile` bundles. | Evidence capture/handoff. |
| **Scent** | REFERENCE | Context packaging with redaction + token budget. | Informs Source's token-conscious context retrieval. No runtime dep. |
| **Scout** | INTEGRATE | Repo intelligence: structure, deps, routes, security smells, `intelligence.json`. | Project/repository context for agents. |
| **Concord** | INTEGRATE | Artifact drift checks (cli-docs, spec-eval, versions). | Drift Evidence. |
| **Fence** | INTEGRATE | Architecture-boundary enforcement (`fence.toml`, SARIF). | Policy/Evidence: architecture constraints as required assertions. |
| **Watchdog** | REFERENCE | Observability proxy + SQLite telemetry. | Informs Source's observability. Source needs its own server-side audit log. |
| **Leash** | REFERENCE | Policy-as-code + JWT + approval gates + audit trail. | Informs Source's capability/approval model. Source needs native capability issuance. |
| **Muzzle** | REFERENCE | Quiet workflow runner, log spooling, redaction. | Informs Session execution + token efficiency. |
| **Dispatch** | REFERENCE | Workflow orchestration, approval gates, run state, traces. | Informs Source's Workflow concept. Source's Workflow is server-side. |
| **Kennel** | OUT OF SCOPE | Package/dependency manager. | Separate concern (dependency resolution), not Source's core. |
| **Agents SDK** | REFERENCE | Agent workflow primitives (runner, tools, security, memory, tracing). | Informs Source's agent runtime boundary. Source does not embed an agent runtime in MVP. |
| **AI SDK** | REFERENCE | Provider-gated LLM calls. | Source invokes LLMs only for semantic judgment; adapter boundary, not a dependency. |
| **MCP** | INTEGRATE | MCP server framework, bounded file tools. | Source can expose an MCP server as one agent interface. |
| **RAG** | REFERENCE | Local retrieval. | Informs context retrieval; not required for MVP. |
| **PackWrite** | REFERENCE | Prompt→pack compiler. | Informs how Source packages agent context. Not a runtime dependency. |

## What Source must OWN natively (REPLACE/own)

None of the Kujo tools provide these, so Source owns them:

1. **Multi-tenant hosting** — Instance/Organization/Project boundaries, custom
   domains, tenant isolation. No Kujo tool is multi-tenant.
2. **Git server** — bare repository storage, clone/fetch/push, auth. No Kujo
   tool serves Git.
3. **Work/Session/Change/Decision lifecycle** — the server-side collaboration
   model. Kujo tools are local CLIs; they have no shared Work state.
4. **Capability issuance & expiration** — bounded, expiring grants. Leash has
   JWT + approval but is a local mobile control plane, not a hosted capability
   authority.
5. **Policy evaluation** — server-side deterministic policy over required
   assertions. Fence/Eval/ShipCheck are local; Source evaluates their *results*.
6. **Evidence store** — normalized evidence + original artifacts + provenance.
   Kujo tools emit artifacts; Source stores and links them.
7. **Audit trail** — append-only record of who/what/when/why. RunLedger is
   per-run local; Source needs a global, tenant-scoped audit log.

## Key architectural consequence

Source's integration surface with Kujo tooling is **artifact ingestion**, not
code linking. A Kujo tool runs (locally or on Source-managed compute), emits a
versioned JSON artifact, and Source ingests it as Evidence with provenance
(producer, environment, source revision, artifact hash). This keeps Source
decoupled from Kujo's implementation while making Kujo's evidence first-class.

See `07-evidence-model.md` for the normalization contract and
`09-agent-protocol.md` for how agents discover and submit evidence.
