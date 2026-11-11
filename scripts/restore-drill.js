#!/usr/bin/env node
// Restore only into owned temporary roots/database. An optional operator-owned
// callback can validate application invariants before successful cleanup.
import { mkdir, mkdtemp, readdir, rm, copyFile, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readBackupManifest, verifyBackup } from '../src/backup-verification.js';
const exec = promisify(execFile);
const options = { timeout: 120000, maxBuffer: 16 * 1024 * 1024 };
async function databaseCommand(command, args) {
  try { return await exec(command, args, options); }
  catch { throw new Error(`${command} failed during isolated restore; inspect the retained restore with operator credentials`); }
}

function databaseUrl(dsn, database) {
  const url = new URL(dsn);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('database URL must use PostgreSQL');
  url.pathname = `/${database}`;
  return url.toString();
}

async function findGitRepos(root) {
  const repos = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name.endsWith('.git')) repos.push(full);
      else await visit(full);
    }
  }
  await visit(root);
  return repos;
}

export async function restoreDrill({ backup, dsn, validateRestored } = {}) {
  const root = path.resolve(backup);
  const manifest = await readBackupManifest(root);
  if (manifest.database && !dsn) throw new Error('database URL is required for a PostgreSQL backup');
  const databaseName = `source_restore_${process.pid}_${Date.now().toString(36)}`;
  const maintenanceDsn = manifest.database ? databaseUrl(dsn, 'postgres') : null;
  const restoredDsn = manifest.database ? databaseUrl(dsn, databaseName) : null;
  const drillRoot = await mkdtemp(path.join(os.tmpdir(), 'source-restore-drill-'));
  const snapshot = path.join(drillRoot, 'backup');
  const dataParent = path.join(drillRoot, 'data'), gitParent = path.join(drillRoot, 'git');
  const dataRoot = path.join(dataParent, path.basename(manifest.dataRoot));
  const gitRoot = manifest.gitRoot === manifest.dataRoot ? dataRoot : path.join(gitParent, path.basename(manifest.gitRoot));
  let databaseCreated = false, verified = false, applicationStarted = false;
  try {
    await Promise.all([mkdir(snapshot), mkdir(dataParent), mkdir(gitParent)]);
    // Snapshot admitted names first. Verification/extraction then use private
    // bytes, not operator files that could change between these operations.
    await writeFile(path.join(snapshot, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    for (const item of manifest.files) await copyFile(path.join(root, item.name), path.join(snapshot, item.name));
    await verifyBackup(snapshot);
    for (const [name, destination] of [['data.tar.gz', dataParent], ['git.tar.gz', gitParent]]) {
      if (manifest.files.some(item => item.name === name)) await exec('tar', ['-xzf', path.join(snapshot, name), '-C', destination, '--no-same-owner', '--no-same-permissions'], options);
    }
    const gitRepos = await findGitRepos(gitRoot);
    for (const repo of gitRepos) {
      try { await access(path.join(repo, 'objects', 'info', 'alternates')); throw new Error('restored Git repository depends on external alternate object storage'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await exec('git', ['--no-replace-objects', '-C', repo, 'fsck', '--full', '--no-reflogs'], options);
    }
    if (manifest.database) {
      await databaseCommand('createdb', ['--maintenance-db', maintenanceDsn, databaseName]);
      databaseCreated = true;
      await databaseCommand('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', restoredDsn, path.join(snapshot, 'database.dump')]);
      const schema = manifest.database.schema;
      const check = await databaseCommand('psql', ['--dbname', restoredDsn, '--tuples-only', '--no-align', '--command', `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '${schema}'`]);
      if (Number(check.stdout.trim()) !== 1) throw new Error('restored Postgres schema was not found');
    }
    applicationStarted = Boolean(validateRestored);
    const application = validateRestored ? await validateRestored({ dataRoot, gitRoot, dsn: restoredDsn, schema: manifest.database?.schema, manifest }) : null;
    const result = { status: 'restored', backup: root, filesVerified: manifest.files.length, gitRepositories: gitRepos.length, database: databaseCreated ? databaseName : null, schema: manifest.database?.schema || null, application };
    verified = true;
    return result;
  } catch (error) {
    error.restoreState = { root: drillRoot, database: databaseCreated ? databaseName : null };
    throw error;
  } finally {
    if (verified) {
      if (databaseCreated) {
        try { await databaseCommand('dropdb', ['--maintenance-db', maintenanceDsn, databaseName]); }
        catch (error) { error.restoreState = { root: drillRoot, database: databaseName }; throw error; }
      }
      await rm(drillRoot, { recursive: true, force: true });
    } else if (!databaseCreated && !applicationStarted) await rm(drillRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  if (!flag('--backup') || args.includes('--help')) {
    console.log('Usage: node scripts/restore-drill.js --backup <directory> [--database-url <PostgreSQL URL>]'); return;
  }
  console.log(JSON.stringify(await restoreDrill({ backup: flag('--backup'), dsn: flag('--database-url') || process.env.SOURCE_TEST_DATABASE_URL || process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL }), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`error: ${error.message}`); if (error.restoreState?.database) console.error(JSON.stringify({ retainedRestore: error.restoreState })); process.exitCode = 1; });
}
