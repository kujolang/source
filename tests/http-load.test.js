import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runHttpLoad } from '../scripts/lib/http-load.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, server); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('load probe bounds sockets and actually overlaps requests', async () => {
  let active = 0, peak = 0, sockets = 0;
  const pending = [];
  await withServer((_req, res) => {
    active++; peak = Math.max(peak, active);
    pending.push(res);
    if (pending.length === 16) {
      for (const response of pending.splice(0)) { active--; response.end('ok'); }
    }
  }, async (url, server) => {
    server.on('connection', () => sockets++);
    const result = await runHttpLoad({ url, requests: 64, concurrency: 16 });
    assert.equal(result.completed, 64);
    assert.equal(result.errors, 0);
    assert.equal(result.statuses[200], 64);
    assert.equal(peak, 16);
    assert.equal(sockets, 16, 'completed response connections must be reused');
    assert.equal(result.activeAtEnd, 0);
  });
});

test('non-2xx responses are counted once, not as two completions', async () => {
  await withServer((_req, res) => { res.writeHead(503); res.end('busy'); }, async (url) => {
    const result = await runHttpLoad({ url, requests: 20, concurrency: 4 });
    assert.equal(result.completed, 20);
    assert.equal(result.errors, 20);
    assert.equal(result.statuses[503], 20);
    assert.equal(result.ok, false);
  });
});

test('load probe terminates incomplete and disconnected responses', async () => {
  for (const disconnect of [false, true]) {
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('incomplete');
      if (disconnect) setTimeout(() => res.destroy(), 5);
    }, async (url) => {
      const result = await runHttpLoad({ url, requests: 2, concurrency: 2, timeoutMs: 100 });
      assert.equal(result.completed, 2);
      assert.equal(result.errors, 2);
      assert.equal(result.activeAtEnd, 0);
    });
  }
});

test('load CLI runs in a separate process and reports failures with a nonzero exit', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  await withServer((_req, res) => { res.writeHead(503); res.end('busy'); }, async (url) => {
    await assert.rejects(promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../scripts/load.js', import.meta.url)),
      '--url', url, '--requests', '8', '--concurrency', '4',
    ]), (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.completed, 8);
      assert.equal(result.errors, 8);
      assert.equal(result.maxSockets, 4);
      return true;
    });
  });
});
