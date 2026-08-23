#!/usr/bin/env node

// Staging-only metadata failover drill. It writes a unique sentinel, replays
// the transactional feed to a peer, and measures time until the peer reads it.

import { PostgresStore } from '../src/postgres-store.js';

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  process.stdout.write('Usage: node scripts/failover-drill.js --source-url <dsn> --target-url <dsn> [--source-schema source] [--target-schema source] [--source-id primary] [--timeout-ms N] [--max-rto-ms N]\n');
}

async function main() {
  const args = process.argv.slice(2);
  const sourceDsn = flag(args, '--source-url');
  const targetDsn = flag(args, '--target-url');
  if (args.includes('--help') || !sourceDsn || !targetDsn) return usage();
  const sourceSchema = flag(args, '--source-schema') || 'source';
  const targetSchema = flag(args, '--target-schema') || 'source';
  const sourceId = flag(args, '--source-id') || sourceSchema;
  const timeoutMs = Math.min(10 * 60_000, Math.max(1_000, Math.trunc(Number(flag(args, '--timeout-ms')) || 60_000)));
  const maxRtoMs = flag(args, '--max-rto-ms') == null ? null : Math.min(timeoutMs, Math.max(1, Math.trunc(Number(flag(args, '--max-rto-ms')) || 1)));
  if (sourceDsn === targetDsn && sourceSchema === targetSchema) throw new Error('source and target Postgres stores must be distinct');

  const source = new PostgresStore({ dsn: sourceDsn, schema: sourceSchema });
  const target = new PostgresStore({ dsn: targetDsn, schema: targetSchema });
  const startedAt = Date.now();
  const sentinelPath = `replication-drills/${Date.now()}-${process.pid}.json`;
  const sentinel = { id: sentinelPath, kind: 'failover-drill', createdAt: new Date(startedAt).toISOString() };
  let cursor = 0;
  let applied = 0;
  let sourceSequence = null;
  try {
    await source.writeJsonAsync(sentinelPath, sentinel);
    while (Date.now() - startedAt < timeoutMs) {
      const page = await source.listReplicationEventsAsync({ afterSeq: cursor, limit: 500 });
      if (!page.events.length) break;
      const event = page.events.find((candidate) => candidate.path === sentinelPath);
      if (event) sourceSequence = Number(event.seq);
      const result = await target.applyReplicationEventsAsync({ sourceId, events: page.events });
      cursor = result.cursor;
      applied += result.applied;
      if (await target.readJsonAsync(sentinelPath)) {
        const rtoMs = Date.now() - startedAt;
        const output = { status: maxRtoMs != null && rtoMs > maxRtoMs ? 'failed' : 'passed', sourceId, sentinelPath, sourceSequence, cursor, applied, rtoMs, maxRtoMs };
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        if (output.status === 'failed') throw new Error(`RTO budget exceeded: ${rtoMs}ms > ${maxRtoMs}ms`);
        return;
      }
      if (!page.hasMore) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`failover drill timed out after ${timeoutMs}ms`);
  } finally {
    await Promise.all([source.closeAsync(), target.closeAsync()]);
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
