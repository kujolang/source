#!/usr/bin/env node
import path from 'node:path';
import { verifyBackup } from '../src/backup-verification.js';

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--backup');
  const backup = index >= 0 ? args[index + 1] : undefined;
  if (!backup || args.includes('--help')) {
    process.stdout.write('Usage: node scripts/verify-backup.js --backup <source-backup-directory>\n');
    return;
  }
  const root = path.resolve(backup);
  const manifest = await verifyBackup(root);
  console.log(JSON.stringify({ backup: root, status: 'verified', files: manifest.files.length }, null, 2));
}
main().catch(error => { process.stderr.write(`error: ${error.message}\n`); process.exitCode = 1; });
