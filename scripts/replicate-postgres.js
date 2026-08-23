#!/usr/bin/env node

// Resumable one-way metadata replication over the transactional CDC feed.
// Multi-writer conflict resolution remains a deployment-level consensus concern.

import { PostgresStore } from '../src/postgres-store.js';

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  process.stdout.write('Usage: node scripts/replicate-postgres.js --source-url <dsn> --target-url <dsn> [--source-schema source] [--target-schema source] [--source-id primary] [--batch-size N]\n');
}

async function main() {
  const args = process.argv.slice(2);
  const sourceDsn = flag(args, '--source-url');
  const targetDsn = flag(args, '--target-url');
  if (args.includes('--help') || !sourceDsn || !targetDsn) return usage();
  const sourceSchema = flag(args, '--source-schema') || 'source';
  const targetSchema = flag(args, '--target-schema') || 'source';
  const sourceId = flag(args, '--source-id') || sourceSchema;
  const batchSize = Math.min(1_000, Math.max(1, Math.trunc(Number(flag(args, '--batch-size')) || 500)));
  if (sourceDsn === targetDsn && sourceSchema === targetSchema) throw new Error('source and target Postgres stores must be distinct');

  const source = new PostgresStore({ dsn: sourceDsn, schema: sourceSchema });
  const target = new PostgresStore({ dsn: targetDsn, schema: targetSchema });
  let cursor = 0;
  let applied = 0;
  try {
    while (true) {
      const page = await source.listReplicationEventsAsync({ afterSeq: cursor, limit: batchSize });
      if (!page.events.length) break;
      const result = await target.applyReplicationEventsAsync({ sourceId, events: page.events });
      cursor = result.cursor;
      applied += result.applied;
      if (!page.hasMore) break;
    }
    process.stdout.write(`${JSON.stringify({ status: 'replicated', sourceId, cursor, applied }, null, 2)}\n`);
  } finally {
    await Promise.all([source.closeAsync(), target.closeAsync()]);
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
