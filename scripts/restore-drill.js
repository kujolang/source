#!/usr/bin/env node

// Restore a Source backup into isolated temporary filesystem roots and a
// temporary Postgres database, then verify Git integrity and database content.
// The drill never targets the source deployment database or filesystem roots.

import { createReadStream } from 'node:fs';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function safeIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error(`unsafe database identifier: ${value}`);
  return value;
}

function databaseUrl(dsn, database) {
  const url = new URL(dsn);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('--database-url must be a PostgreSQL URL');
  url.pathname = `/${database}`;
  return url.toString();
}

async function manifestFor(root) {
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'source-backup-v1' || !Array.isArray(manifest.files)) throw new Error('unsupported or invalid backup manifest');
  return manifest;
}

function archiveEntryIsSafe(entry) {
  const normalized = entry.replaceAll('\\', '/');
  return !normalized.startsWith('/') && !normalized.split('/').includes('..');
}

async function extractArchive(archive, destination) {
  const { stdout } = await execFileAsync('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 });
  const entries = stdout.split('\n').filter(Boolean);
  if (entries.some((entry) => !archiveEntryIsSafe(entry))) throw new Error(`unsafe archive path in ${path.basename(archive)}`);
  await execFileAsync('tar', ['-xzf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions'], { maxBuffer: 2 * 1024 * 1024 });
  return entries;
}

async function findGitRepos(root) {
  const repos = [];
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name.endsWith('.git')) repos.push(full);
      else await visit(full);
    }
  }
  await visit(root);
  return repos;
}

async function main() {
  const args = process.argv.slice(2);
  const backup = flag(args, '--backup');
  const dsn = flag(args, '--database-url') || process.env.SOURCE_TEST_DATABASE_URL || process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
  if (!backup || !dsn || args.includes('--help')) {
    process.stdout.write('Usage: node scripts/restore-drill.js --backup <source-backup-directory> --database-url <postgresql-url>\n');
    if (!backup || !dsn) return;
  }
  const root = path.resolve(backup);
  await access(root, fsConstants.R_OK);
  const manifest = await manifestFor(root);
  const files = new Map(manifest.files.map((item) => [item.name, path.join(root, item.name)]));
  const dataArchive = files.get('data.tar.gz');
  const gitArchive = files.get('git.tar.gz');
  const databaseDump = files.get('database.dump');
  if (!dataArchive) throw new Error('backup is missing data.tar.gz');
  const drillRoot = await mkdtemp(path.join(os.tmpdir(), 'source-restore-drill-'));
  const dataRoot = path.join(drillRoot, 'data');
  const gitRoot = path.join(drillRoot, 'git');
  const databaseName = safeIdentifier(`source_restore_${process.pid}_${Date.now().toString(36)}`.slice(0, 63));
  const maintenanceDsn = databaseUrl(dsn, 'postgres');
  const restoredDsn = databaseUrl(dsn, databaseName);
  let databaseCreated = false;
  try {
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(dataRoot), mkdir(gitRoot)]));
    const dataEntries = await extractArchive(dataArchive, dataRoot);
    const gitEntries = gitArchive ? await extractArchive(gitArchive, gitRoot) : [];
    const gitRepos = await findGitRepos(gitRoot);
    for (const repo of gitRepos) await execFileAsync('git', ['-C', repo, 'fsck', '--full', '--no-reflogs'], { maxBuffer: 4 * 1024 * 1024 });
    if (databaseDump) {
      await execFileAsync('createdb', ['--maintenance-db', maintenanceDsn, databaseName], { maxBuffer: 2 * 1024 * 1024 });
      databaseCreated = true;
      await execFileAsync('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', restoredDsn, databaseDump], { maxBuffer: 4 * 1024 * 1024 });
      const check = await execFileAsync('psql', ['--dbname', restoredDsn, '--tuples-only', '--no-align', '--command', "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = 'source'"], { maxBuffer: 2 * 1024 * 1024 });
      if (Number(String(check.stdout).trim()) !== 1) throw new Error('restored Postgres schema was not found');
    }
    process.stdout.write(`${JSON.stringify({ status: 'restored', backup: root, dataEntries: dataEntries.length, gitEntries: gitEntries.length, gitRepositories: gitRepos.length, database: databaseCreated ? databaseName : null }, null, 2)}\n`);
  } finally {
    if (databaseCreated) await execFileAsync('dropdb', ['--if-exists', '--maintenance-db', maintenanceDsn, databaseName], { maxBuffer: 2 * 1024 * 1024 }).catch(() => {});
    await rm(drillRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
