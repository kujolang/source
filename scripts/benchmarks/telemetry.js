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

// Passive observers: no clientError/timeout server handler, body consumption,
// socket writes, request replay or admission changes. Never retain URLs/headers.
export class HttpTelemetry {
  constructor(server) {
    this.pending = new Set();
    this.routes = Object.fromEntries(['git', 'submit', 'other'].map(route => [route,
      { requests: 0, finished: 0, closedBeforeFinish: 0, abortedBodies: 0, statuses: {} }]));
    this.sockets = { opened: 0, closed: 0, closedWithError: 0, active: 0, peakActive: 0, timeouts: 0, errors: {} };
    this.failures = [];
    this.socketFailures = [];
    const socketState = new WeakMap();
    server.on('connection', socket => {
      const observed = { started: performance.now(), requests: 0 };
      socketState.set(socket, observed);
      this.sockets.opened++; this.sockets.active++;
      this.sockets.peakActive = Math.max(this.sockets.peakActive, this.sockets.active);
      socket.once('close', hadError => { this.sockets.closed++; this.sockets.active--; if (hadError) this.sockets.closedWithError++; });
      socket.on('timeout', () => { this.sockets.timeouts++; });
      socket.on('error', error => {
        const code = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ERR_HTTP_REQUEST_TIMEOUT', 'HPE_HEADER_OVERFLOW', 'HPE_INVALID_METHOD'].includes(error.code) ? error.code : 'other';
        this.sockets.errors[code] = (this.sockets.errors[code] || 0) + 1;
        if (this.socketFailures.length < 50) this.socketFailures.push({ code, elapsedMs: performance.now() - observed.started,
          requestsObserved: observed.requests, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten });
      });
    });
    server.prependListener('request', (req, res) => {
      const observed = socketState.get(req.socket);
      if (observed) observed.requests++;
      const route = req.url.startsWith('/git/') ? 'git' : /^\/api\/v1\/orgs\/[^/]+\/projects\/[^/]+\/submit(?:\?|$)/.test(req.url) ? 'submit' : 'other';
      const counts = this.routes[route]; counts.requests++;
      const entry = { route, req, res, started: performance.now() };
      this.pending.add(entry);
      req.once('aborted', () => { counts.abortedBodies++; });
      res.once('finish', () => {
        counts.finished++;
        const status = String(res.statusCode);
        counts.statuses[status] = (counts.statuses[status] || 0) + 1;
        this.pending.delete(entry);
      });
      res.once('close', () => {
        if (!res.writableFinished) {
          counts.closedBeforeFinish++;
          if (this.failures.length < 50) this.failures.push(this.describe(entry));
        }
        this.pending.delete(entry);
      });
    });
  }

  describe({ route, req, res, started }) {
    return { route, elapsedMs: performance.now() - started, requestComplete: req.complete,
      requestAborted: req.aborted, responseHeadersSent: res.headersSent, responseEnded: res.writableEnded };
  }

  snapshot() {
    return structuredClone({ scope: 'passive server HTTP/socket observations; no raw URLs, headers, bodies or error text; at most 50 failed and pending samples',
      sockets: this.sockets, routes: this.routes, pendingCount: this.pending.size,
      pending: [...this.pending].slice(0, 50).map(entry => this.describe(entry)), failures: this.failures, socketFailures: this.socketFailures });
  }
}
