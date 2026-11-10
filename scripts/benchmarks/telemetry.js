// Scoped diagnostics, not whole-host resource accounting. Sampling and the event
// loop histogram run only in the API/harness process; child resource totals are
// collected separately at exit and exclude Git descendants and PostgreSQL.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { freemem } from 'node:os';

export class StageTelemetry {
  constructor() {
    this.stages = [];
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.timer = setInterval(() => this.sample(), 1000);
    this.timer.unref();
    this.current = null;
  }

  sample() {
    if (!this.current) return;
    const rss = process.memoryUsage.rss(), free = freemem();
    this.current.samples++;
    this.current.parentSampledPeakRssBytes = Math.max(this.current.parentSampledPeakRssBytes, rss);
    this.current.hostMinimumFreeBytes = Math.min(this.current.hostMinimumFreeBytes, free);
  }

  begin(phase) {
    this.finish();
    this.histogram.reset();
    this.current = { phase, started: performance.now(), cpu: process.cpuUsage(), loop: performance.eventLoopUtilization(), samples: 0, parentSampledPeakRssBytes: 0, hostMinimumFreeBytes: Infinity };
    this.sample();
  }

  finish() {
    if (!this.current) return;
    this.sample();
    const { phase, started, cpu, loop, ...memory } = this.current;
    const samples = this.histogram.count;
    this.stages.push({ phase, wallMs: performance.now() - started, parentCpuMicros: process.cpuUsage(cpu), parentEventLoop: performance.eventLoopUtilization(loop), parentEventLoopDelayMs: {
      samples, p50: samples ? this.histogram.percentile(50) / 1e6 : null,
      p95: samples ? this.histogram.percentile(95) / 1e6 : null,
      p99: samples ? this.histogram.percentile(99) / 1e6 : null,
      max: samples ? this.histogram.max / 1e6 : null,
    }, ...memory });
    this.current = null;
  }

  stop() {
    this.finish(); clearInterval(this.timer); this.histogram.disable();
    return { scope: 'API/harness process per stage; host free bytes include all activity, not memory available or attributable usage; sampled RSS can miss peaks', sampleIntervalMs: 1000, eventLoopResolutionMs: 20, stages: this.stages };
  }
}

export function processResources() {
  return { cpuMicros: process.cpuUsage(), peakRssBytes: process.resourceUsage().maxRSS * 1024, scope: 'this Node process lifetime only; excludes descendants' };
}
