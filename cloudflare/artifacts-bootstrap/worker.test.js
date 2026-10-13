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

test('mints a short-lived operator credential and disposes the repository capability', async () => {
  const calls = [];
  const repo = {
    async info() { return { name: 'source-hybrid-one', remote: 'https://account.artifacts.cloudflare.net/git/source-bootstrap/source-hybrid-one.git' }; },
    async createToken(...args) { calls.push(args); return { plaintext: 'art_v1_fixture', expiresAt: 12345 }; },
    [Symbol.dispose]() { calls.push('disposed'); },
  };
  const request = new Request('https://worker.test/repos/source-hybrid-one/token', { method: 'POST', headers: { Authorization: `Bearer ${secret}` } });
  const response = await worker.fetch(request, { SOURCE_BOOTSTRAP_SECRET: secret, ARTIFACTS: { async get(name) { calls.push(name); return repo; } } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).token, 'art_v1_fixture');
  assert.deepEqual(calls, ['source-hybrid-one', ['write', 300], 'disposed']);
});

test('token endpoint denies unauthenticated callers and redacts upstream failure', async () => {
  let calls = 0, disposed = false;
  const env = { SOURCE_BOOTSTRAP_SECRET: secret, ARTIFACTS: { async get() { calls++; return {
    async info() { throw new Error('sensitive-upstream-value'); }, [Symbol.dispose]() { disposed = true; }
  }; } } };
  const request = (auth) => new Request('https://worker.test/repos/source-hybrid-one/token', { method: 'POST', headers: { Authorization: auth } });
  assert.equal((await worker.fetch(request('wrong'), env)).status, 401);
  assert.equal(calls, 0);
  const response = await worker.fetch(request(`Bearer ${secret}`), env);
  assert.equal(response.status, 502); assert.equal(disposed, true);
  assert.ok(!(await response.text()).includes('sensitive-upstream-value'));
});
