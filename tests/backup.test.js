import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
