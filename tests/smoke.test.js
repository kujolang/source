import { test } from 'node:test';
import assert from 'node:assert';

test('node runtime is available', () => {
  assert.ok(process.version);
  console.log('node', process.version);
});
