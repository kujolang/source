# 20 — SQLite Store

Status: **Implemented.** The JSON-file store is now swappable for a SQLite
backend behind the existing `storage` boundary, providing ACID transactions
across records — the JSON store's documented gap.

## What changed

`src/sqlite-store.js` adds `SqliteStore`, a zero-dependency backend built on
`node:sqlite` (Node ≥ 22.5). It implements the exact same interface as the JSON
`Store` (`readJson`, `writeJson`, `listJson`, `getMeta`, `setMeta`,
`putArtifact`, `getArtifact`, `audit`, `readAudit`) plus `transaction(fn)`.

The `Source` constructor now accepts an optional store:

```js
import { Source } from './source.js';
import { SqliteStore } from './sqlite-store.js';

const src = new Source(dataRoot, { store: new SqliteStore(dataRoot) });
```

The CLI selects the backend with `--store sqlite` (or `SOURCE_STORE=sqlite`):

```bash
node bin/source.js --store sqlite init --name source.kujolang.ai
```

The JSON store remains the default (and the only option on Node < 22.5).

SQLite enables WAL mode with `synchronous=FULL` and a five-second busy timeout.
The counter and rate-limit tables use atomic upserts so multiple Source
processes can share the database without duplicating IDs or resetting limits.
Run `npm run test:scale` to exercise concurrent-process coordination.

## Why this matters

The JSON store writes each record independently. A `submitChange` writes the
Change, then the Work, then the Session as three separate files; a crash
between them leaves a partial state. SQLite makes those writes atomic.

The multi-record operations in `source.js` are now wrapped in
`store.transaction(...)`:

| Operation | Records written atomically |
|---|---|
| `createProject` | project + policy |
| `createRepository` | project + repository |
| `startSession` | session + work |
| `submitChange` | change + work + session |
| `addEvidence` | evidence + change |
| `makeDecision` | decision + change + work |

Git operations (bare-repo init, fast-forward) remain outside the transaction —
Git owns source and is not part of the SQLite database.

## Schema

A single `source.sqlite` file (WAL mode) with four tables:

```text
records    (path TEXT PRIMARY KEY, json TEXT)   — domain records, keyed by path
meta       (key TEXT PRIMARY KEY, value TEXT)   — ID counters
artifacts  (hash TEXT PRIMARY KEY, bytes BLOB)  — content-addressed evidence
audit      (seq INTEGER PRIMARY KEY, line TEXT) — append-only audit log
```

The `path` key is the same logical path the JSON store uses on disk
(`orgs/O1/projects/P1/work/W1.json`), so the domain model and on-disk shape are
unchanged — this is a swap behind the boundary, not a redesign.

## Transactions

`transaction(fn)` is re-entrant: nested calls are no-ops (the outermost call
owns `BEGIN`/`COMMIT`). This lets composite operations (e.g. `submitContribution`)
compose transactional steps without nested-transaction errors.

The JSON store's `transaction(fn)` is a no-op wrapper — it keeps the interface
uniform but does **not** provide atomicity. This is a documented limitation, not
a silent claim.

## What this delivers vs. what it does not

**Delivers:**

- ACID transactions across records (the core value).
- Single-file durability (WAL, crash-safe).
- The same interface, so `Source`, `CapabilityService`, and `nextId` work
  unchanged.

**Does not deliver (future phase):**

- A normalized relational schema with foreign keys and queryable relationships.
  The path-keyed `records` table does not preclude this; the `storage` boundary
  is where a relational redesign would land.
- High-concurrency pooled request-path I/O. SQLite's synchronous
  `node:sqlite` API is appropriate for local or small multi-process installs;
  large agent fleets should use the Postgres backend.

## Postgres backend

`src/postgres-store.js` provides the production backend. It keeps the
path-keyed compatibility records while also synchronizing normalized tables
for lifecycle entities, capabilities, and relationship junctions. The async
API path uses a native `pg.Pool`, async transactions, and one pooled client per
transaction; the legacy synchronous methods remain available for CLI and
compatibility callers.

Select it with:

```bash
SOURCE_DATABASE_URL='postgres://source:password@db/source' \
  node bin/source.js --store postgres serve --host 0.0.0.0 --port 8787
```

The JSON and SQLite backends remain useful for local development and
single-node deployments. They are not evidence of Postgres production load
capacity.

The live Postgres gate is opt-in because it requires an operator-provided test
database:

```bash
SOURCE_TEST_DATABASE_URL='postgresql://source:password@db/source' npm run test:postgres
```

It creates an isolated temporary schema, exercises 1,000 concurrent async
lifecycle writes and 1,000 concurrent HTTP discovery requests, then removes
the schema. Run the external `npm run load` harness separately from another
host to include network and load-balancer behavior.

## Node version

`node:sqlite` requires Node ≥ 22.5 (unflagged in 23.4+, stable in 24). The
project's `engines` field still says `>=18` because the JSON store works there;
SQLite is opt-in. The runtime emits an `ExperimentalWarning` on Node 23 — it is
informational, not a failure.

## Tests

`tests/store.test.js` covers:

- transaction commit, rollback, and re-entrancy;
- the JSON store's no-op transaction (documented limitation);
- `listJson` direct-child semantics;
- artifact round-trip and dedup;
- the full vertical slice on `SqliteStore`;
- cross-backend equivalence (JSON vs SQLite produce identical stable fields).

## Cross-references

- `11-storage-model.md` — storage principles and the swap boundary.
- `decisions/0002-storage-json.md` — the original JSON hypothesis; this phase
  validates its reversibility.
- `16-mvp-results.md` — item 5 of the next-phase list.
