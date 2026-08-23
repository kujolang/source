import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('Git replication mirrors multiple repositories and is safely repeatable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-replication-'));
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  const repo = path.join(sourceRoot, 'orgs', 'O1', 'projects', 'P1', 'repos', 'R1.git');
  const work = path.join(root, 'work');
  await mkdir(path.dirname(repo), { recursive: true });
  execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', work], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'config', 'user.email', 'replication@test.invalid']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 'Replication Test']);
  await writeFile(path.join(work, 'README.md'), 'one\n');
  execFileSync('git', ['-C', work, 'add', 'README.md']);
  execFileSync('git', ['-C', work, 'commit', '-m', 'one'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', repo]);
  execFileSync('git', ['-C', work, 'push', 'origin', 'main'], { stdio: 'ignore' });

  const run = () => execFileAsync(process.execPath, ['scripts/replicate-git.js', '--source-root', sourceRoot, '--target-root', targetRoot, '--concurrency', '2'], { cwd: process.cwd() });
  const first = JSON.parse((await run()).stdout);
  assert.equal(first.repositories.length, 1);
  assert.equal(execFileSync('git', ['--git-dir', path.join(targetRoot, 'orgs/O1/projects/P1/repos/R1.git'), 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim().length, 40);
  const second = JSON.parse((await run()).stdout);
  assert.equal(second.repositories[0].status, 'replicated');
});
