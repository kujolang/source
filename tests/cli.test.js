import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

test('CLI accepts documented global storage flags before the command', async () => {
  await run(['--store', 'json', 'help']);
  assert.ok(true);
});

test('CLI refuses exposed Postgres serving without writer fencing', () => {
  const result = spawnSync(process.execPath, ['bin/source.js', '--store', 'postgres', 'serve', '--host', '0.0.0.0'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --writer-lease/);
});

test('production container command enables writer fencing', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  assert.match(dockerfile, /CMD .*--writer-lease/);
});

test('demo command bootstraps a login-ready local tenant', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'source-demo-data-'));
  const gitRoot = mkdtempSync(path.join(tmpdir(), 'source-demo-git-'));
  const env = { ...process.env, SOURCE_DATA: dataRoot, SOURCE_GIT_ROOT: gitRoot };
  const result = spawnSync(process.execPath, ['bin/source.js', 'demo', '--password', 'local-password-123'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.login, {
    principalId: 'U1',
    orgId: 'O1',
    projectId: 'P1',
    management: true,
    url: 'http://localhost:8787/login',
  });
  assert.equal(output.repository.id, 'R1');
  assert.match(output.message, /does not ship with a default password/);

  const repeat = spawnSync(process.execPath, ['bin/source.js', 'demo', '--password', 'different-password-123'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).existing, true);
});
