# 11 — Storage Model

Status: **Implementation hypothesis (swappable) + evidence-backed immutability.**

## Layout

```text
data/
  instances/<instance-id>/
    instance.json
    orgs/<org-id>/
      org.json
      projects/<project-id>/
        project.json
        work/<work-id>.json
        sessions/<session-id>.json
        changes/<change-id>.json
        evidence/<evidence-id>.json
        decisions/<decision-id>.json
        policy.json
        repos/<repo-id>.git/          # bare Git repo
    artifacts/
      <sha256-prefix>/<sha256>        # content-addressed artifacts
    audit/
      audit.jsonl                     # append-only audit log
```

## Principles

1. **JSON files on disk** for domain records (MVP). Atomic write (write temp +
   rename). Matches the Kujo ecosystem's "plain JSON, inspectable" philosophy
   and needs zero dependencies. This is an **implementation hypothesis**:
   swappable for SQLite/Postgres behind the `storage` boundary without
   changing the domain model. **A SQLite backend now exists** (`sqlite-store.js`,
   `node:sqlite`) providing ACID transactions across records; see
   `20-sqlite-store.md`.

2. **Content-addressed artifacts.** Evidence artifacts are stored by SHA-256
   and are immutable. Re-ingesting identical bytes yields the same path.

3. **Append-only audit log.** `audit.jsonl` records every authorization event,
   Decision, and canonical-state update. Never rewritten.

4. **Git owns source.** Source never stores source content in its own store;
   Git's bare repos are the source of truth for code.

## Immutable vs mutable (recap)

- Immutable: Work identity/intent, Change base/head, Evidence artifacts,
  Decisions, audit entries.
- Mutable (versioned): Work status/assignee, Change review/decision state,
  Evidence validity/expiry.

## What is catastrophic to lose

| Data | Consequence of loss | Recovery requirement |
|---|---|---|
| Git objects (bare repos) | source history gone | backup bare repos; `git fsck` |
| Work history | collaboration record gone | backup `work/*.json` |
| Change records | proposed changes gone | backup `changes/*.json` |
| Decisions | *why* state changed gone | backup `decisions/*.json` |
| Identity records | principals gone | backup principal records |
| Audit log | authorization history gone | backup `audit.jsonl` |
| Evidence metadata | proof links gone | backup `evidence/*.json` |
| Critical evidence artifacts | proof content gone | backup `artifacts/` |

Backup = copy the `data/` tree (bare repos + JSON + artifacts). Full automated
backup is outside MVP but the requirement is documented here. (With the SQLite
backend, the domain records/artifacts/audit live in `source.sqlite`; the bare
repos remain on the filesystem.)

## PostgreSQL operation

The asynchronous PostgreSQL API uses a pooled connection for each transaction.
Project mutations acquire a project-row lock before reading and updating shared
relationships. This preserves concurrent evidence, session and decision links
across serving instances. Local JSON mutations serialize within one Source
instance; JSON remains unsuitable for multiple writers.

The synchronous PostgreSQL compatibility API launches a separate `psql` process
per call. Its `transaction(fn)` does **not** make several writes atomic. Use the
asynchronous API for serving. Run synchronous migration and maintenance offline,
with a verified backup; a failed migration can leave partial records. Correcting
that synchronous contract requires a separate compatibility design.

For PostgreSQL, domain records, audit entries and artifact bytes reside in the
database; bare Git repositories remain on disk. Back up both. The JSON layout and
`audit.jsonl` instructions above apply only to the JSON backend. See
[deployment and restore drills](23-tls-deployment.md) for operational commands.

## Cross-references

- `03-system-architecture.md` — storage boundary.
- `07-evidence-model.md` — artifact integrity.
- `12-threat-model.md` — tampered artifacts.
- `20-sqlite-store.md` — the SQLite backend and transactions.
