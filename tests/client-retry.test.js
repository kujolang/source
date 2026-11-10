import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRetry, submitRequest } from '../src/client-retry.js';
import { authenticatedGit, git } from '../src/remote.js';
import { createServer } from 'node:http';

function fixture(options = {}) {
  let now = 0; const sleeps = [], events = [];
  const retry = new ClientRetry({ now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, random: () => 0, onRetry: (event) => events.push(event), ...options });
  return { retry, sleeps, events };
}

test('backoff honors seconds/date Retry-After, falls back conservatively and shares a bounded budget', async () => {
  const f = fixture({ maxRetries: 4 });
  await f.retry.wait('submit', '2');
  await f.retry.wait('submit', 'Thu, 01 Jan 1970 00:00:05 GMT');
  await f.retry.wait('Git fetch'); await f.retry.wait('submit', '-1');
  assert.deepEqual(f.sleeps, [2000, 3000, 60000, 120000]);
  await assert.rejects(() => f.retry.wait('Git push'), /retry limit/);
  assert.equal(f.events.length, 4);
  await assert.rejects(() => fixture().retry.wait('submit', '999999999999999999999'), /deadline/);
  await assert.rejects(() => fixture({ maxElapsedMs: 100 }).retry.wait('submit', '1'), /deadline/);
});

test('Git retries only explicit HTTP 429 and never exposes failed argv credentials', async () => {
  const f = fixture(); let calls = 0;
  const run = authenticatedGit('secret-fixture-token', 'https://source.invalid/git/O/P/R.git', '.', { retry: f.retry, runGit: async () => {
    if (++calls < 3) throw Object.assign(new Error('secret-fixture-token'), { httpStatus: 429 }); return 'done';
  } });
  assert.equal(await run(['fetch']), 'done'); assert.deepEqual(f.sleeps, [60000, 120000]);
  for (const status of [null, 401, 403, 500, 503]) {
    let attempts = 0;
    const failed = authenticatedGit('secret-fixture-token', 'https://source.invalid/git/O/P/R.git', '.', { retry: fixture().retry, runGit: async () => { attempts++; throw Object.assign(new Error('secret-fixture-token'), { httpStatus: status }); } });
    await assert.rejects(() => failed(['push']), (error) => /Source Git push failed/.test(error.message) && !error.message.includes('secret-fixture-token'));
    assert.equal(attempts, 1);
  }
});

test('real Git HTTP throttle is classified without retaining remote stderr', async (t) => {
  const server = createServer((_req, res) => { res.writeHead(429); res.end('fixture throttled'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(() => git(['ls-remote', `http://127.0.0.1:${server.address().port}/repo.git`], '.'), (error) => error.httpStatus === 429 && !Object.hasOwn(error, 'stderr'));
});

test('submit replays only explicit pre-admission rejection, never uncertain mutation results', async () => {
  const f = fixture(); let calls = 0;
  const input = { method: 'POST', body: '{"head":"fixture"}', redirect: 'error' };
  const fetchImpl = async (_url, options) => {
    assert.equal(options.body, input.body); assert.ok(options.signal);
    return ++calls === 1 ? new Response(JSON.stringify({ error: 'rate limit exceeded', retryable: true }), { status: 429, headers: { 'retry-after': '1' } }) : Response.json({ change: { id: 'C1' } });
  };
  assert.deepEqual(await submitRequest('https://source.invalid/submit', input, { retry: f.retry, fetchImpl }), { change: { id: 'C1' } });
  assert.deepEqual(f.sleeps, [1000]); assert.equal(calls, 2);
  for (const response of [new Response('{"error":"ambiguous"}', { status: 500 }), new Response('{"error":"unmarked"}', { status: 429 }), new Error('connection lost after commit')]) {
    let attempts = 0;
    await assert.rejects(() => submitRequest('https://source.invalid/submit', input, { retry: fixture().retry, fetchImpl: async () => { attempts++; if (response instanceof Error) throw response; return response; } }));
    assert.equal(attempts, 1);
  }
});

test('server marks throttled submit before mutation and client waits for admission', async (t) => {
  const { freshSource } = await import('./helpers.js');
  const { startServer } = await import('../src/api.js');
  const { src, org } = freshSource();
  const project = src.createProject({ orgId: org.id, name: 'public', slug: 'public', visibility: 'public' });
  let mutations = 0;
  src.submitContributionAsync = async () => ({ change: { id: `C${++mutations}` } });
  const server = await startServer(src, { port: 0, rateLimit: { submit: { limit: 1, windowMs: 500 } } });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/orgs/${org.id}/projects/${project.id}/submit`;
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(url, options)).status, 201);
  const denied = await fetch(url, options);
  assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '1');
  assert.equal((await denied.json()).retryable, true); assert.equal(mutations, 1);
  const events = [];
  const result = await submitRequest(url, options, { retry: new ClientRetry({ maxElapsedMs: 5000, random: () => 0, onRetry: (event) => events.push(event) }) });
  assert.equal(result.change.id, 'C2'); assert.equal(mutations, 2); assert.equal(events.length, 1);
  assert.equal(events[0].delayMs, 1000);
});

test('Git failure diagnostics retain safe process facts without stderr, argv or arbitrary fields', async () => {
  const secret = 'secret-fixture-token';
  for (const input of [
    { code: 'EAGAIN', failureKind: 'resource_exhausted', signal: null, httpStatus: null },
    { code: 128, failureKind: 'transport', signal: 'SIGTERM', killed: true, httpStatus: 503, curlCode: 18 },
    { code: secret, failureKind: secret, signal: secret, httpStatus: secret, curlCode: secret },
  ]) {
    const run = authenticatedGit(secret, 'https://source.invalid/git/O/P/R.git', '.', { runGit: async () => { throw Object.assign(new Error(secret), input, { stderr: secret, cmd: secret }); } });
    await assert.rejects(() => run(['fetch']), (error) => {
      assert.ok(!JSON.stringify(error).includes(secret));
      assert.equal(error.diagnostic.operation, 'fetch');
      assert.equal(error.diagnostic.code, input.code === 'EAGAIN' ? 'EAGAIN' : null);
      assert.equal(error.diagnostic.exitCode, input.code === 128 ? 128 : null);
      assert.equal(error.diagnostic.httpStatus, input.httpStatus === 503 ? 503 : null);
      assert.equal(error.diagnostic.curlCode, input.curlCode === 18 ? 18 : null);
      return true;
    });
  }
});

test('real truncated HTTP response retains only numeric curl diagnosis', async (t) => {
  const packet = (value) => (Buffer.byteLength(value) + 4).toString(16).padStart(4, '0') + value;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
      res.end(packet('# service=git-upload-pack\n') + '0000' + packet('version 2\n') + packet('ls-refs=unborn\n') + '0000');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': '1000', connection: 'close' });
    res.end('0010');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/repo.git`;
  await assert.rejects(() => authenticatedGit(null, url, '.4-missing-directory')(['ls-remote', url]), (error) => error.diagnostic.code === 'ENOENT');
  await assert.rejects(() => authenticatedGit(null, url, '.')(['ls-remote', url]), (error) => {
    assert.equal(error.diagnostic.curlCode, 18);
    assert.equal(error.diagnostic.exitCode, 128);
    assert.ok(!Object.hasOwn(error, 'stderr'));
    return true;
  });
});


test('submit preserves safe nested transport codes but never retries an uncertain mutation', async () => {
  for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'private-fixture-token']) {
    let calls = 0;
    await assert.rejects(() => submitRequest('https://source.invalid/submit', { method: 'POST' }, { fetchImpl: async () => {
      calls++; throw Object.assign(new Error('private-fixture-token'), { cause: { code, address: 'private-fixture-token' } });
    } }), (error) => {
      assert.equal(error.diagnostic.code, code.startsWith('UND_') ? code : null);
      assert.equal(error.diagnostic.outcomeUnknown, true);
      assert.equal(error.diagnostic.responseReceived, false);
      assert.ok(!JSON.stringify(error).includes('private-fixture-token'));
      return true;
    });
    assert.equal(calls, 1);
  }
});
