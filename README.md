# Source

> **Git stores the source. Source understands the work required to change it,
> the actors that performed it, the evidence that proves it, and the decisions
> that made it canonical.**

Source is an **agent-first software-development and collaboration platform built
around Git**. Work is fundamental, Evidence is first-class, autonomous
participants receive bounded capabilities, and the complete truth of how
software changes remains inspectable.

This repository contains the **MVP vertical slice**: a working implementation of
the full `Project → Work → Session → Change → Evidence → Decision → Canonical
Git State` lifecycle, validated against a real Kujo repository, plus the first
five next-phase increments (real Kujo evidence integration, smart-HTTP Git
transport, the `source submit` contribution flow, capability-gated API auth,
and a SQLite store backend).

## Status

- **68/68 tests pass**, including a dogfood test against the real `spec` Kujo
  repository, Kujo evidence-integration tests against real Eval/Spec/ShipCheck
  artifacts, smart-HTTP clone/fetch/push tests, `source submit`
  contribution-flow tests, capability-gated API auth tests, and SQLite store
  transaction/contract tests.
- Zero runtime dependencies (Node.js ≥ 18, `git` on PATH). The SQLite backend
  requires Node ≥ 22.5 (`node:sqlite`); the JSON store works on Node ≥ 18.
- Deterministic-first: no LLM is required for any operation in the slice.

## Quick start

```bash
# Run the test suite (includes the dogfood test against ../spec)
npm test

# Exercise the CLI
node bin/source.js help
node bin/source.js init --name source.kujolang.ai
node bin/source.js org create --name kujolang --slug kujolang
node bin/source.js project create --org O1 --name spec --slug spec
node bin/source.js principal create --type human --name maintainer
node bin/source.js work create --org O1 --project P1 --intent "fix parser regression"
node bin/source.js work claim --org O1 --project P1 W1 --principal U1

# Issue a bounded capability for an agent (operator/CLI, out-of-band)
node bin/source.js cap issue --principal U2 --project P1 \
  --allowed read_source,read_context,submit_change,submit_evidence \
  --denied accept_change,modify_policy,publish_release

# Serve the HTTP API + minimal web UI + smart-HTTP Git transport
node bin/source.js serve --port 8787
#   GET /.well-known/source          (agent discovery)
#   GET /                            (human project index)
#   GET /api/v1/projects/P1/work     (machine interface, requires capability)
#   git clone http://localhost:8787/git/P1/R1.git   (smart-HTTP)

# Contribute as a Git-only developer (no Source concepts required)
git clone http://localhost:8787/git/P1/R1.git
# ... make changes ...
node bin/source.js submit --url http://localhost:8787
```

The machine interface (`/api/v1/…`) is capability-gated: send
`Authorization: Bearer <credential>` on every request. See
`docs/source/19-capability-auth.md`.

### Storage backend

The default store is JSON files on disk. Select the SQLite backend (ACID
transactions across records) with `--store sqlite` or `SOURCE_STORE=sqlite`:

```bash
node bin/source.js --store sqlite init --name source.kujolang.ai
```

See `docs/source/20-sqlite-store.md`.

## Architecture

A **modular monolith** in Node.js (ESM), zero dependencies:

```text
src/
  domain.js      — object model + lifecycle state machines (pure)
  source.js      — application service (wires store/git/policy/capability)
  store.js       — JSON-file store, content-addressed artifacts, audit log
  sqlite-store.js— SQLite store (node:sqlite), ACID transactions
  git.js         — bare-repo storage, clone/fetch/push, fast-forward guard
  git-http.js    — smart-HTTP transport via `git http-backend`
  policy.js      — deterministic required-evidence evaluation
  capability.js  — bounded, expiring capability grants
  auth.js        — capability-gated API authorization (actions + scope)
  api.js         — HTTP API + /.well-known/source discovery + /git/ transport
  web.js         — minimal human-facing HTML views
  cli.js         — CLI (same services as the API)
  submit.js      — `source submit` contribution client
  integrations/
    kujo.js      — Eval/Spec/ShipCheck artifact normalizers + KujoRunner
bin/source.js    — CLI entry
```

## Documentation

The full architecture, domain model, threat model, and MVP scope are in
`docs/source/`:

- `01-product-interpretation.md` — frozen principles
- `02-kujo-capability-audit.md` — reuse vs own (evidence-backed)
- `03-system-architecture.md` — boundaries + technology selection
- `04-domain-object-model.md` — the formal model
- `05-work-lifecycle.md` / `06-change-model.md` / `07-evidence-model.md`
- `08-identity-capability-model.md` / `09-agent-protocol.md`
- `10-git-integration.md` / `11-storage-model.md` / `12-threat-model.md`
- `13-mvp-scope.md` / `14-implementation-plan.md` / `15-acceptance-tests.md`
- `16-mvp-results.md` — what was built and dogfooded
- `17-kujo-evidence-integration.md` — real Eval/Spec/ShipCheck evidence ingestion
- `18-source-submit.md` — the `source submit` contribution flow
- `19-capability-auth.md` — capability-gated API auth
- `20-sqlite-store.md` — the SQLite store backend and transactions
- `decisions/` — architecture decision records

## License

Licensing is intentionally undecided (see `01-product-interpretation.md`).
