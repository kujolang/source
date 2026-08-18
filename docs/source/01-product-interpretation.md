# 01 — Product Interpretation

Status: **Frozen product decisions restated; no reinterpretation.**

## The one-sentence product

> **Git stores the source. Source understands the work required to change it,
> the actors that performed it, the evidence that proves it, and the decisions
> that made it canonical.**

## What Source is not

Source is **not** a re-skin of GitHub/GitLab. The following are explicit
anti-goals that must not silently creep back in:

| Anti-pattern | Source's answer |
|---|---|
| Repository is the top-level abstraction | **Project** is top-level; a Project may hold many repositories |
| Issue is the collaboration primitive | **Work** is the collaboration primitive; Issue is a human-facing view |
| Pull request = branch + diff + comments | **Change** = base state + resulting state + evidence + decision, tied to Work and Sessions |
| CI = a YAML pipeline primitive | **Policy → Required Assertions → Execution → Evidence → Decision** |
| Agents are fake human accounts | Agents are first-class **Principals** with bounded **Capabilities** |
| Evidence = a green checkmark | Evidence is structured, first-class, and traceable to artifacts |

## Frozen principles (verbatim intent)

1. **Work is fundamental.** Software development begins with intent and required
   work, not with a branch.
2. **Evidence is first-class.** Evidence is structured data connected to the
   claims it proves, never reduced to PASS/FAIL.
3. **Agents get the better interface.** No critical capability exists only in
   the browser. The browser, CLI, and agents are all clients of the same truth.
4. **Truth is progressively disclosed.** One underlying truth, many resolutions
   (nontechnical summary → technical lead → developer → auditor → agent). Never
   evidence hiding.

## Engineering principles (frozen)

- **Git-compatible** — Git owns objects, commits, refs, history, clone/fetch/push.
- **Project-oriented** — Project ≠ repository.
- **Agent-first** — agents are real principals.
- **Human-readable** — nontechnical viewers understand without losing resolution.
- **Deterministic-first** — LLM only where semantic judgment is required.
- **Token-conscious** — compact, scoped, progressive machine responses.
- **Capability-secured** — minimum authority, no broad permanent credentials.
- **Evidence-complete** — relevant evidence stays connected and inspectable.
- **Extensible** — third parties build against Source without server internals.
- **Self-hostable** — customer-controlled infrastructure is a first-class path.
- **Commercially sustainable** — do not give away server-side value casually.

## The vertical slice (definition of done)

The MVP must prove this loop end-to-end against a **real Kujo repository**:

```
Create Project → Connect/Create Git Repository → Create Work → Assign/Claim Work
→ Start Session → Modify Source → Submit Change → Attach/Generate Evidence
→ Evaluate Policy → Present Human-Readable Result → Inspect Detailed Evidence
→ Make Decision → Update Canonical Git State → Preserve Audit Trail
```

See `13-mvp-scope.md` for the constrained scope and `15-acceptance-tests.md`
for the pass/fail criteria.

## Cross-references

- `02-kujo-capability-audit.md` — what to reuse vs own.
- `03-system-architecture.md` — boundaries and technology.
- `04-domain-object-model.md` — the formal model.
