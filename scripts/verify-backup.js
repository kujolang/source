#!/usr/bin/env node

// Verify a Source backup without mutating the source deployment.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function sha256(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--backup');
  const backup = index >= 0 ? args[index + 1] : undefined;
  if (!backup || args.includes('--help')) {
    process.stdout.write('Usage: node scripts/verify-backup.js --backup <source-backup-directory>\n');
    return;
  }
  const root = path.resolve(backup);
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'source-backup-v1' || !Array.isArray(manifest.files)) throw new Error('unsupported or invalid backup manifest');
  for (const item of manifest.files) {
    const file = path.join(root, item.name);
    const info = await stat(file);
    if (info.size !== item.bytes) throw new Error(`size mismatch: ${item.name}`);
    if (await sha256(file) !== item.sha256) throw new Error(`checksum mismatch: ${item.name}`);
    if (item.name.endsWith('.tar.gz')) await execFileAsync('tar', ['-tzf', file], { maxBuffer: 16 * 1024 * 1024 });
    if (item.name === 'database.dump') await execFileAsync('pg_restore', ['--list', file], { maxBuffer: 16 * 1024 * 1024 });
  }
  process.stdout.write(`${JSON.stringify({ backup: root, status: 'verified', files: manifest.files.length }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
