# 15 — Acceptance Tests

Status: **Pass/fail criteria for the vertical slice.** Each criterion maps to a
test in `tests/`.

## Acceptance criteria (from MEGA_PROMPT §33)

| # | Criterion | Test |
|---|---|---|
| 1 | Git clone works | `tests/git.test.js` |
| 2 | Git fetch works | `tests/git.test.js` |
| 3 | Git push / contribution transport works | `tests/git.test.js` |
| 4 | A Project can contain a Repository | `tests/domain.test.js` |
| 5 | Work can be created | `tests/domain.test.js` |
| 6 | Work can be assigned or claimed | `tests/domain.test.js` |
| 7 | A Session can be started | `tests/domain.test.js` |
| 8 | A principal can operate with bounded capability | `tests/capability.test.js` |
| 9 | A Change can be submitted | `tests/domain.test.js` |
| 10 | The Change is tied to an exact base source state | `tests/change.test.js` |
| 11 | Evidence can be produced | `tests/evidence.test.js` |
| 12 | Evidence retains its underlying artifact/provenance | `tests/evidence.test.js` |
| 13 | Policy can determine required evidence | `tests/policy.test.js` |
| 14 | Missing evidence is visible | `tests/policy.test.js` |
| 15 | Satisfied evidence is visible | `tests/policy.test.js` |
| 16 | Human-readable interpretation is available | `tests/policy.test.js` |
| 17 | Technical evidence can be inspected | `tests/evidence.test.js` |
| 18 | A Decision can be recorded | `tests/decision.test.js` |
| 19 | A Decision is tied to the evidence/source state it evaluated | `tests/decision.test.js` |
| 20 | Accepted work can update canonical source safely | `tests/decision.test.js` |
| 21 | The full Work→Session→Change→Evidence→Decision chain can be reconstructed | `tests/e2e.test.js` |
| 22 | An agent can perform its side without HTML | `tests/api.test.js` |
| 23 | A human can understand the result without machine protocol | `tests/web.test.js` (smoke) |
| 24 | No LLM is required for deterministic operations | (by construction; asserted in `tests/e2e.test.js`) |
| 25 | The system works against a real Kujo repository | `tests/dogfood.test.js` |

## Security tests (MEGA_PROMPT §38)

- Authorization: denied actions fail (`tests/capability.test.js`).
- Capability expiration: expired grants are refused (`tests/capability.test.js`).
- Tenant isolation: cross-tenant access is refused (`tests/tenant.test.js`).
- Evidence integrity: tampered artifact is detected (`tests/evidence.test.js`).
- TOCTOU: non-fast-forward update is refused (`tests/decision.test.js`).

## Token-efficiency measurement

`tests/api.test.js` records response byte sizes for the common agent workflow
(discover → project → work → context → submit). Reported in `16-mvp-results.md`.

## Cross-references

- `13-mvp-scope.md` — scope.
- `16-mvp-results.md` — results.
