# 13 — MVP Scope

Status: **Constrained vertical slice.** Not a feature checklist.

## The loop to prove

```
Create Project → Connect/Create Git Repository → Create Work → Assign/Claim Work
→ Start Session → Modify Source → Submit Change → Attach/Generate Evidence
→ Evaluate Policy → Present Human-Readable Result → Inspect Detailed Evidence
→ Make Decision → Update Canonical Git State → Preserve Audit Trail
```

## In scope

| Area | What is built |
|---|---|
| Project | create, show (identity, repos, work, changes, health summary) |
| Repository | create bare repo, clone/fetch/push (local transport), default branch |
| Work | create, list, show, claim, assign |
| Session | start, complete (principal, environment, base commit, result) |
| Change | submit (base/head commits), inspect, list |
| Evidence | add (claim + artifact + producer), list, inspect (normalized + artifact) |
| Policy | required evidence, approval requirements; deterministic evaluation |
| Decision | accept / reject / request-revision (with evidence snapshot) |
| Canonical state | fast-forward default branch on accept (audited) |
| Audit | append-only log of every authorization/decision/state event |
| Agent interface | `/.well-known/source` + JSON API (no HTML required) |
| CLI | `source project/work/session/change/evidence/decision` |
| Web UI | minimal org/project/work/change/evidence views |
| Capability | bounded, expiring grants; server-enforced |
| Tests | unit, lifecycle, authorization, capability-expiry, tenant-isolation, git, API, evidence-integrity, policy, e2e |

## Out of scope (explicit non-goals)

Social feeds, stars, followers, boards, forums, marketplaces, org admin, SSO,
billing, geo-replication, global search, package registry, release marketplace,
mobile apps, analytics dashboards, full Git protocol optimization, SaaS control
plane, visual design system.

## MVP user types

1. **Human maintainer** — create Work, inspect Work/Change/evidence, make Decision.
2. **Agent** — discover project, claim Work, retrieve context, operate with
   bounded capability, submit Change + evidence.
3. **Verification service** — produce trusted structured Evidence without
   pretending to be human.

## Deliberate simplifications (documented, reversible)

- ~~Single Organization per Instance~~ — resolved: the org is now a first-class,
  server-enforced tenant boundary (see `21-multi-tenant-orgs.md`).
- Single-repository Changes (multi-repo schema present).
- Local `file://` Git transport (smart-HTTP is a documented next step).
- JSON-file store (swappable for SQLite/Postgres).
- In-process events (no queue).
- No LLM in the vertical slice (deterministic-first; LLM is only for semantic
  judgment, which the slice does not require).

## Cross-references

- `14-implementation-plan.md` — build order.
- `15-acceptance-tests.md` — pass/fail criteria.
- `16-mvp-results.md` — what was actually built and dogfooded.
