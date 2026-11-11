# Coordinated restore of Source's actual project state

Validated on 2026-11-10 local time, at implementation `7236d2a`.
[Original report](real-project-restore.json) contains commands/policy, candidate,
test outputs, receipts, backup checksums and fresh-process restore assertions.
This proves a quiesced local restore, not online snapshot consistency, replicated
primary failover, power-loss durability or full migration readiness.

## Actual lifecycle and restore

The private real-project harness imported Source history at `dda1c8b` and submitted
the restore implementation at `7236d2a`. Three required checks verified candidate
`4fd75be01f69b6d8fc2b7e4b7ed12f31a19fd85d`, tree
`bea7c85a1a3ee3cc47b7123ed6faee422276804b`:

| Check | Result | Executor elapsed |
|---|---|---:|
| Preflight | Syntax checked 120 JavaScript files | 6,372 ms |
| Runtime | 43 passed, 1 excluded nested-container case | 3,706 ms |
| Git/API/broker/sync and backup | 35 passed, 1 PostgreSQL-only skip | 61,677 ms |

The container intentionally has neither a Docker socket nor database credentials.
The PostgreSQL backup case passed separately against a disposable host database.
Existing live OCI evidence covers the excluded nested-container boundary. These
are targeted suites, not a fresh full-suite or production acceptance claim.

After scoped acceptance/promotion and a fresh authenticated clone, the harness:

1. Stopped the actual CLI worker and API listener and closed the original pool.
2. Ran the backup CLI against the now-quiescent Git/data root and custom
   PostgreSQL schema. Creation verified the staged archives before publication.
3. Renamed the original data root out of service so its previous path no longer
   existed. Original Git could not accidentally satisfy restored operations.
4. Restored a private, checksum-verified snapshot into a new filesystem root and
   a separately created PostgreSQL database. Git fsck checked one bare repository.
5. Launched `check-restored-project.js` in a fresh Node process against only the
   restored paths/database. It verified exact candidate/landed refs, the entire
   status (policy evaluation, acceptance, intent, outcome), three identical
   receipts, original artifact hashes, and the completed job records.
6. Proved private authentication survived: anonymous Git was denied, an
   authenticated clone matched the candidate, proposal ancestry survived, and
   authorized repeat promotion returned the same landed commit.
7. Confirmed the original offline Git/control-plane state was unchanged, then
   removed successful drill resources.

The backup contained a 2,360,818-byte filesystem archive and a 70,737-byte custom
PostgreSQL dump. The measured backup/restore portion took 7,251 ms; the complete
development lifecycle and restore took 93.940 seconds. These are one local
fixture's observations, not RTO/SLO guarantees or load measurements. The archives
and temporary database were deleted after verification; the report retains their
manifest hashes, not a reusable backup or sensitive database dump.

## Correctness changes and regression evidence

Three regressions failed before implementation: combined data/Git restores
reported zero repositories checked; checksum mismatch did not reject restore;
and relocated Source metadata still selected its original absolute Git path.
Source now resolves repository paths from its configured Git root and scoped IDs
for synchronous, asynchronous, optimized PostgreSQL and batched lookup paths.
Reads do not rewrite historical metadata or verification receipts. Preserve the
canonical `orgs/<org>/projects/<project>/repos/<repo>.git` layout when restoring;
manually stored arbitrary per-repository paths are not a supported location map.

Backup admission validates the bounded manifest, names, archive correspondence,
sizes and SHA-256 digests. Archive listing must contain only regular files and
directories under the expected root; path traversal, symbolic/hard links and
special files are rejected. A Linux test exposed BusyBox tar's regular-file mode
for hardlinks; its arrow annotation is now rejected as well. Conservative
annotation rejection may also refuse filenames containing those link markers.
Source's backup creator checks the same contract before publishing its staging
directory. Restore verifies a private copy, so later changes to the original
backup cannot substitute different bytes during extraction.

Restore checks repositories in the combined data root or separate Git archive,
rejects external alternate-object dependencies, and restores the manifest's
actual PostgreSQL schema rather than assuming `source`. Optional trusted operator
validation runs before success cleanup. Failed database/application restores
retain owned state for inspection; successful cleanup failures are surfaced.
The ordinary drill only checks archives, Git and schema existence. Application
agreement is established by the explicit project checker, not by table presence.

Focused Git, HTTP, broker, API, artifact and backup regressions: **53 passed,
zero skipped**, 55.984 seconds. After the final backup failure-output hardening,
the backup suite passed **6/6**, including live PostgreSQL and a synthetic failed
dump that neither exposed its fixture credential nor published a partial backup.
That failure-output test was red before the catch was added; no real credential
was used. Syntax lint checked 120 JavaScript files; whitespace checks passed.

## Reproduction and boundaries

```sh
# Build the operator image; keep the working tree and GitHub origin unchanged.
node scripts/build-self-verification-image.js 7236d2a > /absolute/image.json
SOURCE_TEST_DATABASE_URL='<disposable PostgreSQL DSN>' \
  node scripts/real-project-lifecycle.js \
  dda1c8b 7236d2a /absolute/image.json /absolute/new-report.json --restore
```

On this macOS host, prefix the invocation with `PATH="/usr/bin:$PATH"` to select
the working Apple Git 2.50.1 installation, as documented in the earlier
[actual lifecycle report](real-project-lifecycle.md). The PostgreSQL role needs
permission to create/drop disposable databases. The restore subprocess commands
are bounded to 120 seconds; this demonstration does not establish large-backup
capacity. Use operator-trusted backups: checksums establish integrity, not
authenticity, and PostgreSQL dumps contain executable SQL and private records.

For a failed drill, inspect the reported retained root/database before manually
cleaning only those resources. Do not point restore at a production database.
For production backup, stop/drain **all** writers across API instances, workers,
replication and administrative processes; the script itself does not acquire a
distributed freeze or certify a concurrently changing source.

Still open: deployed primary loss, online snapshot coordination, partial storage
loss/failover, sustained recovery load, queue-integrated OCI worker restart,
project-specific human/provider workflows and the remaining production gates.
