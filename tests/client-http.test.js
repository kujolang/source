import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { submitHttpRequest } from '../src/client-http.js';

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); return new Promise((resolve) => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}

test('submission HTTP exchange preserves JSON, status and retry headers without replay', async (t) => {
  let calls = 0;
  const url = await server(t, async (req, res) => {
    calls++; assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer fixture');
    assert.equal(req.headers['accept-encoding'], 'identity');
    let input = ''; for await (const part of req) input += part;
    assert.deepEqual(JSON.parse(input), { exact: true });
    res.writeHead(429, { 'retry-after': '3', 'content-type': 'application/json' }); res.end('{"retryable":true}');
  });
  const response = await submitHttpRequest(url, { headers: { authorization: 'Bearer fixture' }, body: '{"exact":true}', signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 429); assert.equal(response.ok, false); assert.equal(response.headers.get('Retry-After'), '3');
  assert.deepEqual(await response.json(), { retryable: true }); assert.equal(calls, 1);
});

test('submission redirects never receive a second request or forwarded credential', async (t) => {
  let calls = 0;
  const url = await server(t, (_req, res) => { calls++; res.writeHead(307, { location: '/destination' }); res.end(); });
  await assert.rejects(() => submitHttpRequest(url, { headers: { authorization: 'Bearer fixture' }, signal: AbortSignal.timeout(3000) }), /redirects/);
  assert.equal(calls, 1);
});

for (const stage of ['headers', 'body']) test(`deadline aborts a stalled ${stage} exchange and closes the connection`, async (t) => {
  const closed = Promise.withResolvers();
  const url = await server(t, (req, res) => {
    req.socket.once('close', closed.resolve);
    if (stage === 'body') { res.writeHead(200); res.write('{'); }
  });
  await assert.rejects(() => submitHttpRequest(url, { signal: AbortSignal.timeout(100) }), /abort|truncated/i);
  await closed.promise;
});

test('oversized and truncated submission responses fail within bounds', async (t) => {
  const url = await server(t, (req, res) => {
    if (req.url === '/large') { res.writeHead(200); res.end(Buffer.alloc(1024 * 1024 + 1)); }
    else { res.writeHead(200, { 'content-length': 1000, connection: 'close' }); res.end('{}'); }
  });
  await assert.rejects(() => submitHttpRequest(`${url}/large`, { signal: AbortSignal.timeout(3000) }), /exceeds|truncated/);
  await assert.rejects(() => submitHttpRequest(`${url}/short`, { signal: AbortSignal.timeout(3000) }), /truncated|aborted/);
});
