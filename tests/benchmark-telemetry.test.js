import test from 'node:test';
import assert from 'node:assert/strict';
import { StageTelemetry, processResources } from '../scripts/benchmarks/telemetry.js';
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
