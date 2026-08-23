import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
