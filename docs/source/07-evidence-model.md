# 07 — Evidence Model

Status: **Formal model.**

## The claim chain

```
Requirement ──► Assertion ──► Evidence ──► Artifact ──► Producer ──► Environment
```

Evidence is **not** a comment, an attachment, or a green status indicator. It is
structured data connecting a claim to the artifact that proves it.

## Canonical fields

```
id
subject        — what the evidence is about (e.g. "parser regression fix")
claim          — the assertion being proven (e.g. "all parser tests pass")
type           — test|eval|spec|scent|shipcheck|runledger|casefile|patchbrief|
                 changebucket|static_analysis|security|benchmark|human_review|
                 agent_review|runtime|reproduction|policy_check|external
producer       — principal or service that produced it
artifact_ref   — content-addressed pointer to the original artifact (immutable)
result         — normalized summary (e.g. {status:"pass", checks:27, failed:0})
provenance     — chain: producer → tool → command → inputs
environment    — where it ran (host, image, tool versions)
validity       — valid|expired|superseded|disputed
expires_at     — optional
relationships[]— links to other evidence / claims / requirements
integrity      — SHA-256 of the artifact
created_at
```

## Normalization without destruction

The rule: **normalize for understanding, never discard the original.**

```
Normalized Evidence (result)
        │
        └── Original Artifact (artifact_ref, content-addressed)
```

A viewer can move from "No blocking security findings" down to:

```
security evidence → tool result → specific finding → artifact
→ execution environment → source revision
```

without leaving the Source truth model. `result` is a compact summary for
token-efficient consumption; `artifact_ref` is the full, immutable original.

## Evidence from Kujo tooling

Each Kujo tool emits a versioned JSON artifact. Source ingests it as Evidence
with a **normalization adapter** that maps tool-specific fields to the
canonical shape while preserving the original artifact:

| Tool | `type` | `claim` (example) | `artifact` |
|---|---|---|---|
| Eval | `eval` | "deterministic checks pass" | `summary.json` + `artifact-manifest.json` |
| Spec | `spec` | "acceptance criteria defined" | `.spec.yml` |
| ShipCheck | `shipcheck` | "release gate passes" | `shipcheck-report.json` |
| ChangeBucket | `changebucket` | "change footprint within budget" | changebucket JSON |
| PatchBrief | `patchbrief` | "diff summarized" | patchbrief summary |
| RunLedger | `runledger` | "agent run recorded" | run receipt JSON |
| CaseFile | `casefile` | "evidence bundle captured" | `.casefile` bundle |
| Scent | `scent` | "context packaged with redaction" | `context.json` |
| Fence | `static_analysis` | "no architecture boundary violations" | fence report/SARIF |
| Concord | `policy_check` | "no artifact drift" | concord report |

The adapter is a **boundary**, not a hard dependency: Source ingests the JSON
artifact; it does not link Kujo code.

## Integrity and provenance

- `integrity` = SHA-256 of the stored artifact, computed at ingestion.
- `provenance` records producer, tool, command, and inputs so an auditor can
  reconstruct *how* the evidence was produced.
- Artifacts are content-addressed and immutable; re-ingesting the same bytes
  yields the same `artifact_ref`.

## Validity lifecycle

Evidence may expire (e.g. a benchmark against a stale source revision) or be
superseded. `validity` and `expires_at` capture this without deleting the
original. A Decision's `evidence_snapshot` pins the exact hashes evaluated, so
later invalidation does not rewrite history.

## Cross-references

- `04-domain-object-model.md` — Evidence field definitions.
- `06-change-model.md` — how Evidence attaches to Changes.
- `11-storage-model.md` — artifact storage and immutability.
- `12-threat-model.md` — poisoned/forged evidence threats.
