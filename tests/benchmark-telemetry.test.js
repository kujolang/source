import test from 'node:test';
import assert from 'node:assert/strict';
import { StageTelemetry, HttpTelemetry, processResources } from '../scripts/benchmarks/telemetry.js';
import http from 'node:http';
import net from 'node:net';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('stage telemetry observes an actual event-loop stall and closes each phase separately', async () => {
  const telemetry = new StageTelemetry();
  try {
    telemetry.begin('submission');
    await sleep(40);
    const until = performance.now() + 80;
    while (performance.now() < until) { /* intentional synchronous stall */ }
    await sleep(40);
    telemetry.begin('cleanup'); await sleep(40);
    const report = telemetry.stop();
    assert.deepEqual(report.stages.map((s) => s.phase), ['submission', 'cleanup']);
    const first = report.stages[0];
    assert.ok(first.parentEventLoopDelayMs.max >= 60, JSON.stringify(first));
    assert.ok(first.parentEventLoop.active >= 60);
    assert.ok(first.parentCpuMicros.user > 0);
    assert.ok(first.samples >= 2 && first.parentSampledPeakRssBytes > 0);
    assert.ok(Number.isFinite(first.hostMinimumFreeBytes));
    assert.ok(report.stages.every((s) => s.wallMs > 0));
    assert.equal(telemetry.stop().stages.length, 2, 'stopping twice does not duplicate phases');
    assert.ok(processResources().peakRssBytes > 0);
  } finally { telemetry.stop(); }
});

test('HTTP diagnostics distinguish pending, finished and aborted requests without retaining private input', async t => {
  const seen = Promise.withResolvers();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/git/')) { req.resume(); res.end('ok'); }
    else seen.resolve();
  });
  const telemetry = new HttpTelemetry(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/git/private/repo.git?secret=private-value`);
  assert.equal(await response.text(), 'ok');
  const request = http.request(`${url}/api/v1/orgs/private/projects/private/submit?secret=private-value`, {
    method: 'POST', headers: { authorization: 'Bearer private-value', 'content-length': 100 }, agent: false,
  });
  request.on('error', () => {}); request.write('private-value');
  await seen.promise;
  const pending = telemetry.snapshot();
  assert.equal(pending.routes.git.finished, 1); assert.equal(pending.routes.submit.requests, 1);
  assert.equal(pending.pendingCount, 1); assert.equal(pending.pending[0].requestComplete, false);
  request.destroy();
  const deadline = Date.now() + 3000;
  while (telemetry.snapshot().pendingCount && Date.now() < deadline) await sleep(10);
  const after = telemetry.snapshot();
  assert.equal(after.pendingCount, 0); assert.equal(after.routes.submit.closedBeforeFinish, 1);
  assert.equal(after.routes.submit.abortedBodies, 1); assert.equal(after.failures[0].route, 'submit');
  assert.ok(!JSON.stringify(after).includes('private-value'));
  assert.equal(pending.pendingCount, 1, 'snapshots do not mutate with later events');
});

test('HTTP diagnostics preserve native parser rejection and bounded failure samples', async t => {
  const server = http.createServer((_req, res) => res.destroy());
  const telemetry = new HttpTelemetry(server);
  assert.equal(server.listenerCount('clientError'), 0);
  assert.equal(server.listenerCount('timeout'), 0);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const exchange = input => new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1'); let output = '';
    socket.on('error', reject); socket.on('data', data => { output += data; });
    socket.once('connect', () => socket.end(input)); socket.once('close', () => resolve(output));
  });
  assert.match(await exchange('BAD METHOD / HTTP/1.1\r\n\r\n'), /^HTTP\/1.1 400/);
  for (let i = 0; i < 55; i++) await exchange('GET /unknown-private-path HTTP/1.1\r\nHost: localhost\r\n\r\n');
  const report = telemetry.snapshot();
  assert.equal(report.routes.other.closedBeforeFinish, 55);
  assert.equal(report.failures.length, 50); assert.equal(report.pendingCount, 0);
  assert.ok(!JSON.stringify(report).includes('unknown-private-path'));
});
