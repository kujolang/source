#!/usr/bin/env node

// Verify the native Postgres replication contract required by a Source
// deployment. Source does not implement database consensus; the deployment
// must provide streaming replication or an equivalent managed service.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberFlag(args, name, fallback, min, max) {
  const value = Number(flag(args, name));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

function usage() {
  return 'Usage: node scripts/check-postgres-replication.js --database-url <postgresql-url> --role primary|standby [--min-standbys N] [--max-lag-bytes N]';
}

async function query(dsn, sql) {
  const { stdout } = await execFileAsync('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--dbname', dsn, '--command', sql], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  return String(stdout).trim();
}

async function primaryStatus(dsn) {
  const sql = `SELECT json_build_object(
    'inRecovery', pg_is_in_recovery(),
    'standbys', COALESCE((SELECT json_agg(json_build_object(
      'applicationName', application_name,
      'clientAddress', client_addr::text,
      'state', state,
      'syncState', sync_state,
      'replayLagBytes', COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)
    )) FROM pg_stat_replication), '[]'::json)
  )::text`;
  return JSON.parse(await query(dsn, sql));
}

async function standbyStatus(dsn) {
  const sql = `SELECT json_build_object(
    'inRecovery', pg_is_in_recovery(),
    'receiverStatus', COALESCE((SELECT status FROM pg_stat_wal_receiver LIMIT 1), 'disconnected'),
    'receiveLagBytes', COALESCE(pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()), 0)
  )::text`;
  return JSON.parse(await query(dsn, sql));
}

async function main() {
  const args = process.argv.slice(2);
  const dsn = flag(args, '--database-url') || process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
  const role = flag(args, '--role') || 'primary';
  if (args.includes('--help') || !dsn) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (role !== 'primary' && role !== 'standby') throw new Error('--role must be primary or standby');
  const maxLagBytes = numberFlag(args, '--max-lag-bytes', 64 * 1024 * 1024, 0, 1_000_000_000_000);
  const minStandbys = numberFlag(args, '--min-standbys', 1, 0, 1_000);
  const observed = role === 'primary' ? await primaryStatus(dsn) : await standbyStatus(dsn);
  const failures = [];
  if (role === 'primary') {
    if (observed.inRecovery) failures.push('database is in recovery, expected primary');
    const standbys = Array.isArray(observed.standbys) ? observed.standbys : [];
    const streaming = standbys.filter((replica) => replica.state === 'streaming');
    if (streaming.length < minStandbys) failures.push(`only ${streaming.length} streaming standby(s), expected at least ${minStandbys}`);
    const lagging = streaming.filter((replica) => Number(replica.replayLagBytes) > maxLagBytes);
    if (lagging.length) failures.push(`${lagging.length} standby(s) exceed ${maxLagBytes} replay-lag bytes`);
  } else {
    if (!observed.inRecovery) failures.push('database is not in recovery, expected standby');
    if (observed.receiverStatus !== 'streaming') failures.push(`WAL receiver status is ${observed.receiverStatus}, expected streaming`);
    if (Number(observed.receiveLagBytes) > maxLagBytes) failures.push(`standby exceeds ${maxLagBytes} receive-lag bytes`);
  }
  const result = { status: failures.length ? 'not_ready' : 'ready', role, observed, maxLagBytes, minStandbys, failures };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
