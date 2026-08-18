# 14 — Implementation Plan

Status: **Executed plan.** Phases below were followed; see `16-mvp-results.md`
for outcomes.

## Phase 0 — Inspect (done)

- Read the Kujo ecosystem repos (spec, eval, runledger, changebucket,
  patchbrief, shipcheck, scent, fence, watchdog, leash, muzzle, concord,
  scout, dispatch, agents-sdk, ai-sdk, mcp, rag, kennel, packwrite, casefile).
- Established environment facts: Node.js v23 runnable via `npm`; git 2.42;
  Kujo runtime binary present but not executable in the build shell.

## Phase 1 — Documents (done)

Produce `docs/source/01..15` before implementation, per the MEGA_PROMPT.

## Phase 2 — Storage + domain core

- `src/storage/store.js` — JSON-file store with atomic writes.
- `src/ids.js` — deterministic, collision-resistant IDs.
- `src/domain/*.js` — Project, Work, Session, Change, Evidence, Decision,
  Principal, Capability with state machines.

## Phase 3 — Git integration

- `src/git/repo.js` — bare repo init, clone/fetch/push via `git` CLI,
  fast-forward update, ref inspection.

## Phase 4 — Policy + capability

- `src/policy/evaluate.js` — deterministic required-evidence evaluation.
- `src/identity/capability.js` — issue/verify/expire capabilities.

## Phase 5 — API + discovery

- `src/api/server.js` — HTTP server, `/.well-known/source`, JSON endpoints.
- `src/api/routes.js` — resource routes with field selection + pagination.

## Phase 6 — CLI

- `bin/source.js` + `src/cli.js` — `source project/work/session/change/
  evidence/decision` using the same domain services as the API.

## Phase 7 — Web UI

- `src/web/` — minimal static views (project, work, change, evidence).

## Phase 8 — Tests

- `tests/*.test.js` — unit, lifecycle, authorization, capability-expiry,
  tenant-isolation, git, API, evidence-integrity, policy, e2e.

## Phase 9 — Dogfood

- Host a real Kujo repository (see `16-mvp-results.md`), run the full loop,
  document friction.

## Phase 10 — Report

- `16-mvp-results.md` + architecture self-review.

## Cross-references

- `13-mvp-scope.md` — what each phase builds.
- `15-acceptance-tests.md` — how each phase is verified.
