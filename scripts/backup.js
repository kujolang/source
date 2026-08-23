#!/usr/bin/env node

// Create a self-describing Source backup. Filesystem roots are archived with
// tar; Postgres is captured with pg_dump when a DSN is supplied. The staging
// directory is promoted only after every archive and checksum is complete.

import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args, name) {
  const value = flag(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isoPart() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

async function sha256(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

async function archiveRoot(root, destination, label) {
  const resolved = path.resolve(root);
  await access(resolved, fsConstants.R_OK);
  const parent = path.dirname(resolved);
  const name = path.basename(resolved);
  const archive = path.join(destination, `${label}.tar.gz`);
  await execFileAsync('tar', ['-czf', archive, '-C', parent, name], { maxBuffer: 2 * 1024 * 1024 });
  return archive;
}

async function findGitRepos(root) {
  const result = [];
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name.endsWith('.git')) result.push(full);
      else await visit(full);
    }
  }
  await visit(path.resolve(root));
  return result;
}

async function verifyGit(root) {
  for (const repo of await findGitRepos(root)) {
    await execFileAsync('git', ['-C', repo, 'fsck', '--full', '--no-reflogs'], { maxBuffer: 4 * 1024 * 1024 });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    process.stdout.write('Usage: node scripts/backup.js --output <dir> [--data-root <dir>] [--git-root <dir>] [--database-url <dsn>] [--schema <name>]\n');
    return;
  }
  const output = path.resolve(required(args, '--output'));
  const dataRoot = path.resolve(flag(args, '--data-root') || process.env.SOURCE_DATA || '.source');
  const gitRoot = path.resolve(flag(args, '--git-root') || process.env.SOURCE_GIT_ROOT || dataRoot);
  const dsn = flag(args, '--database-url') || process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
  const schema = flag(args, '--schema') || 'source';
  await mkdir(output, { recursive: true });
  const roots = [dataRoot, ...(gitRoot === dataRoot ? [] : [gitRoot])];
  for (const root of roots) {
    if (output === root || output.startsWith(`${root}${path.sep}`)) {
      throw new Error(`backup output must not be inside source root: ${output}`);
    }
    await access(root, fsConstants.R_OK);
  }
  const finalDir = path.join(output, `source-backup-${isoPart()}`);
  const staging = await mkdtemp(path.join(output, '.source-backup-'));
  const files = [];
  try {
    await verifyGit(gitRoot);
    files.push(await archiveRoot(dataRoot, staging, 'data'));
    if (gitRoot !== dataRoot) files.push(await archiveRoot(gitRoot, staging, 'git'));
    if (dsn) {
      const database = path.join(staging, 'database.dump');
      await execFileAsync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--schema', schema, '--file', database, '--dbname', dsn], { maxBuffer: 4 * 1024 * 1024 });
      files.push(database);
    }
    const manifest = {
      format: 'source-backup-v1',
      createdAt: new Date().toISOString(),
      dataRoot,
      gitRoot,
      database: dsn ? { format: 'postgres-custom', schema } : null,
      files: [],
    };
    for (const file of files) {
      const info = await stat(file);
      manifest.files.push({ name: path.basename(file), bytes: info.size, sha256: await sha256(file) });
    }
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(staging, finalDir);
    process.stdout.write(`${JSON.stringify({ backup: finalDir, manifest: path.join(finalDir, 'manifest.json'), files: manifest.files }, null, 2)}\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
