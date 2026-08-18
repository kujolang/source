# 05 — Work Lifecycle

Status: **Formal state machine.**

## States

```
open ──► claimed ──► in_progress ──► submitted ──► in_review
                                                    │
                          ┌─────────────────────────┼──────────────────────┐
                          ▼                         ▼                      ▼
                      accepted                 revision_requested      rejected
                          │                         │                      │
                          ▼                         ▼                      ▼
                       closed ◄────────────────── in_progress            closed
```

## Transitions

| From | To | Trigger | Who may |
|---|---|---|---|
| (create) | `open` | Work created | requester |
| `open` | `claimed` | assignee claims | assignee (human/agent) |
| `claimed` | `in_progress` | Session started | assignee |
| `in_progress` | `submitted` | Change submitted | assignee (with capability) |
| `submitted` | `in_review` | policy evaluation begins | system (deterministic) |
| `in_review` | `accepted` | Decision accepted | maintainer (with capability) |
| `in_review` | `rejected` | Decision rejected | maintainer |
| `in_review` | `revision_requested` | Decision requests changes | maintainer |
| `revision_requested` | `in_progress` | assignee resumes | assignee |
| `accepted` | `closed` | canonical state updated | system |
| `rejected` | `closed` | terminal | system |

## Invariants

1. A Work may have **many** Sessions (multiple attempts).
2. A Work may have **many** Changes (one per attempt, or revisions).
3. A Change is **submitted** only from a Session with a valid capability.
4. `in_review` is entered **only** after policy evaluation has run and its
   result (satisfied/missing evidence) is recorded.
5. `accepted` requires a Decision whose `evidence_snapshot` satisfies policy.
6. `closed` is terminal and immutable.

## Required evidence vs acceptance conditions

- `required_evidence[]` — what policy demands before a Decision may accept.
- `acceptance_conditions[]` — human-readable definition of done.

Both are evaluated at `in_review`. Missing evidence is **visible**, not hidden.
See `07-evidence-model.md` and `13-mvp-scope.md`.

## Cross-references

- `06-change-model.md` — how Changes move through review.
- `04-domain-object-model.md` — field definitions.
