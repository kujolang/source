import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, readFile, writeFile, symlink, link, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { restoreDrill } from '../scripts/restore-drill.js';

const execFileAsync = promisify(execFile);

test('failed database dumps do not publish backups or print the database credential', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-backup-error-'));
  try {
    const data = path.join(root, 'data'), bin = path.join(root, 'bin'), output = path.join(root, 'backups');
    await mkdir(data); await mkdir(bin);
    await writeFile(path.join(bin, 'pg_dump'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const secret = 'fixture-only-database-password';
    await assert.rejects(() => execFileAsync(process.execPath, ['scripts/backup.js', '--data-root', data, '--output', output], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SOURCE_DATABASE_URL: `postgresql://fixture:${secret}@invalid/database` },
    }), error => {
      assert.equal(error.stderr.includes(secret), false, 'database credential must not appear in failure output');
      assert.match(error.stderr, /pg_dump failed/); return true;
    });
    assert.deepEqual(await readdir(output), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup workflow archives and verifies a Git root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-backup-test-'));
  const dataRoot = path.join(root, 'data');
  const output = path.join(root, 'backups');
  const repo = path.join(dataRoot, 'orgs', 'O1', 'projects', 'P1', 'repos', 'R1.git');
  try {
    await mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '--bare', repo]);
    const { stdout } = await execFileAsync(process.execPath, ['scripts/backup.js', '--data-root', dataRoot, '--output', output], { cwd: process.cwd() });
    const result = JSON.parse(stdout);
    assert.match(result.backup, /source-backup-/);
    const verified = await execFileAsync(process.execPath, ['scripts/verify-backup.js', '--backup', result.backup], { cwd: process.cwd() });
    assert.match(verified.stdout, /"status": "verified"/);
    const restored = await execFileAsync(process.execPath, ['scripts/restore-drill.js', '--backup', result.backup, '--database-url', 'postgresql:///postgres?host=/tmp']);
    assert.equal(JSON.parse(restored.stdout).gitRepositories, 1, 'combined data/Git archives must actually fsck their Git repositories');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const kind of ['symlink', 'hardlink']) test(`restore refuses ${kind} archive entries`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-backup-link-'));
  try {
    const data = path.join(root, 'data'); await mkdir(data);
    const original = path.join(data, 'original'); await writeFile(original, 'fixture');
    if (kind === 'symlink') await symlink(original, path.join(data, 'linked'));
    else await link(original, path.join(data, 'linked'));
    await assert.rejects(() => execFileAsync(process.execPath, ['scripts/backup.js', '--data-root', data, '--output', path.join(root, 'backups')]), /regular files and directories/);
    const backup = path.join(root, 'crafted'); await mkdir(backup);
    await execFileAsync('tar', ['-czf', path.join(backup, 'data.tar.gz'), '-C', root, 'data']);
    const bytes = await readFile(path.join(backup, 'data.tar.gz'));
    await writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ format: 'source-backup-v1', dataRoot: data, gitRoot: data, database: null, files: [{ name: 'data.tar.gz', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }));
    await assert.rejects(() => restoreDrill({ backup }), /regular files and directories/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup and restore use the declared PostgreSQL schema and separate Git root', { skip: !process.env.SOURCE_TEST_DATABASE_URL }, async () => {
  const dsn = process.env.SOURCE_TEST_DATABASE_URL;
  const schema = `backup_test_${process.pid}_${Date.now()}`;
  const root = await mkdtemp(path.join(tmpdir(), 'source-backup-pg-'));
  const query = async (url, sql) => (await execFileAsync('psql', ['--dbname', url, '-At', '--set', 'ON_ERROR_STOP=1', '--command', sql])).stdout.trim();
  try {
    await query(dsn, `CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.fixture(value text); INSERT INTO ${schema}.fixture VALUES ('original immutable record')`);
    const data = path.join(root, 'data'), git = path.join(root, 'git');
    await mkdir(data); await mkdir(git);
    await execFileAsync('git', ['init', '--bare', path.join(git, 'R1.git')]);
    const backup = JSON.parse((await execFileAsync(process.execPath, ['scripts/backup.js', '--data-root', data, '--git-root', git, '--schema', schema, '--output', path.join(root, 'backups')], { env: { ...process.env, SOURCE_DATABASE_URL: dsn } })).stdout).backup;
    const result = await restoreDrill({ backup, dsn, validateRestored: async restored => {
      assert.equal(restored.schema, schema);
      assert.notEqual(restored.dataRoot, data); assert.notEqual(restored.gitRoot, git);
      assert.equal(await query(restored.dsn, `SELECT value FROM ${schema}.fixture`), 'original immutable record');
      await query(restored.dsn, `UPDATE ${schema}.fixture SET value='restored-only change'`);
      assert.equal(await query(dsn, `SELECT value FROM ${schema}.fixture`), 'original immutable record');
      return { schemaRestored: true, sourceUnchanged: true };
    } });
    assert.equal(result.gitRepositories, 1); assert.equal(result.schema, schema);
    assert.equal(await query(dsn, `SELECT count(*) FROM pg_database WHERE datname='${result.database}'`), '0', 'successful temporary database removed');
    let retained;
    await assert.rejects(() => restoreDrill({ backup, dsn, validateRestored: async () => { throw new Error('application mismatch'); } }), error => {
      retained = error.restoreState; return error.message === 'application mismatch' && Boolean(retained.database);
    });
    assert.equal(await query(dsn, `SELECT count(*) FROM pg_database WHERE datname='${retained.database}'`), '1', 'failed restored state remains inspectable');
    const maintenance = new URL(dsn); maintenance.pathname = '/postgres';
    await execFileAsync('dropdb', ['--maintenance-db', maintenance.toString(), retained.database]);
    await rm(retained.root, { recursive: true, force: true });
  } finally {
    await query(dsn, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await rm(root, { recursive: true, force: true });
  }
});

test('restore refuses a checksum mismatch before extraction or database work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-backup-corrupt-'));
  try {
    const data = path.join(root, 'data'); await mkdir(data);
    await writeFile(path.join(data, 'important'), 'original');
    const backup = JSON.parse((await execFileAsync(process.execPath, ['scripts/backup.js', '--data-root', data, '--output', path.join(root, 'backups')])).stdout).backup;
    const manifestPath = path.join(backup, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files[0].sha256 = '0'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => execFileAsync(process.execPath, ['scripts/restore-drill.js', '--backup', backup, '--database-url', 'postgresql:///nonexistent?host=/tmp']), /checksum mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
