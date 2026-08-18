# Decision 0002 — Storage: JSON files (MVP)

**Classification:** Implementation hypothesis.

## Alternatives

1. **SQLite** — relational, transactional, but adds a dependency and is less
   "inspectable" than plain files.
2. **Postgres** — production-grade but overkill for the MVP and not runnable
   here.
3. **JSON files on disk** — zero dependency, matches the Kujo ecosystem's
   "plain JSON, inspectable" philosophy, atomic writes via temp+rename.

## Selected

JSON files on disk with atomic writes, behind a `storage` boundary.

## Tradeoffs

- No transactions across records; mitigated by append-only audit log and
  content-addressed artifacts (the critical data is immutable).
- Concurrency is single-writer per record; fine for MVP scale.

## Reversibility

The `storage` boundary exposes `get/put/list/append`; swapping to SQLite or
Postgres does not change the domain model or on-disk JSON shape.
