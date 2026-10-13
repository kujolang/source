import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
const secret = 'test-only-secret-with-at-least-32-characters';
function fixture() {
  const calls = [];
  return { calls, env: { SOURCE_BOOTSTRAP_SECRET: secret, ARTIFACTS: { async create(...args) {
    calls.push(args); return { name: args[0], remote: 'https://example.test/repo.git', token: 'test-token' };
  } } } };
}
const req = (body, authorization = `Bearer ${secret}`) => new Request('https://worker.test/repos', {
  method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body
});
test('unauthorized and unconfigured requests never create repositories', async () => {
  for (const authorization of ['', 'Bearer wrong']) {
    const { env, calls } = fixture();
    assert.equal((await worker.fetch(req('{}', authorization), env)).status, 401);
    assert.equal(calls.length, 0);
  }
  const { env, calls } = fixture(); delete env.SOURCE_BOOTSTRAP_SECRET;
  assert.equal((await worker.fetch(req('{}'), env)).status, 401);
  assert.equal(calls.length, 0);
});
test('rejects malformed, oversized and out-of-scope names before upstream calls', async () => {
  for (const body of ['{', 'null', '{}', JSON.stringify({name: '../main'}), JSON.stringify({name: 'production'}), JSON.stringify({name: 'source-smoke-ok', padding: 'x'.repeat(1024)})]) {
    const { env, calls } = fixture();
    assert.equal((await worker.fetch(req(body), env)).status, 400);
    assert.equal(calls.length, 0);
  }
});
test('creates an isolated main-branch repository and prevents caching of credentials', async () => {
  const { env, calls } = fixture();
  const response = await worker.fetch(req('{"name":"source-smoke-one"}'), env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).token, 'test-token');
  assert.deepEqual(calls, [['source-smoke-one', {setDefaultBranch: 'main'}]]);
});
test('upstream errors are redacted and not retried', async () => {
  let calls = 0;
  const response = await worker.fetch(req('{"name":"source-smoke-one"}'), {
    SOURCE_BOOTSTRAP_SECRET: secret, ARTIFACTS: {create() { calls++; throw new Error('secret-token'); }}
  });
  assert.equal(response.status, 502); assert.equal(calls, 1);
  assert.ok(!(await response.text()).includes('secret-token'));
});
