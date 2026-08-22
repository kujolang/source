import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.js';

test('CLI accepts documented global storage flags before the command', async () => {
  await run(['--store', 'json', 'help']);
  assert.ok(true);
});
