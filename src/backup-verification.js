// Shared backup admission. Checksums establish integrity, not author trust.
import { createReadStream } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const allowed = new Set(['data.tar.gz', 'git.tar.gz', 'database.dump']);

export async function readBackupManifest(root) {
  const file = path.join(root, 'manifest.json');
  const info = await lstat(file);
  if (!info.isFile() || info.size > 65536) throw new Error('invalid backup manifest file');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.format !== 'source-backup-v1' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 3) throw new Error('unsupported or invalid backup manifest');
  const names = new Set();
  for (const item of manifest.files) {
    if (!allowed.has(item.name) || names.has(item.name) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('invalid backup file entry');
    names.add(item.name);
  }
  for (const rootName of [manifest.dataRoot, manifest.gitRoot]) {
    if (typeof rootName !== 'string' || !path.isAbsolute(rootName) || !path.basename(rootName) || /[\r\n\0]/.test(rootName)) throw new Error('invalid backup source root');
  }
  if (!names.has('data.tar.gz') || (manifest.dataRoot !== manifest.gitRoot) !== names.has('git.tar.gz')) throw new Error('backup filesystem roots do not match archives');
  if (Boolean(manifest.database) !== names.has('database.dump')) throw new Error('backup database manifest does not match dump');
  if (manifest.database && (manifest.database.format !== 'postgres-custom' || !/^[a-z_][a-z0-9_]{0,62}$/.test(manifest.database.schema))) throw new Error('invalid backup database schema');
  return manifest;
}

export async function inspectBackupArchive(archive, expectedRoot) {
  const options = { timeout: 120000, maxBuffer: 16 * 1024 * 1024 };
  const { stdout } = await exec('tar', ['-tzf', archive], options);
  const entries = stdout.split('\n').filter(Boolean);
  if (!entries.length || entries.some(entry => entry.includes('\\') || entry.startsWith('/') || entry.split('/').includes('..') || entry.split('/')[0] !== expectedRoot)) throw new Error('unsafe or unexpected archive path');
  const verbose = (await exec('tar', ['-tvzf', archive], options)).stdout.split('\n').filter(Boolean);
  if (verbose.length !== entries.length || verbose.some(line => !['-', 'd'].includes(line[0]))) throw new Error('backup archives permit only regular files and directories');
  return entries;
}

export async function verifyBackup(root) {
  const manifest = await readBackupManifest(root);
  for (const item of manifest.files) {
    const file = path.join(root, item.name);
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`backup payload is not a regular file: ${item.name}`);
    if (info.size !== item.bytes) throw new Error(`size mismatch: ${item.name}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== item.sha256) throw new Error(`checksum mismatch: ${item.name}`);
    if (item.name.endsWith('.tar.gz')) await inspectBackupArchive(file, path.basename(item.name === 'git.tar.gz' ? manifest.gitRoot : manifest.dataRoot));
    if (item.name === 'database.dump') await exec('pg_restore', ['--list', file], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  }
  return manifest;
}
