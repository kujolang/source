import http from 'node:http';
import https from 'node:https';

// A logical worker limit alone does not bound fetch's global connection pool.
// Use a private, explicitly bounded pool and consume every response to completion.
export async function runHttpLoad({ url, requests, concurrency, timeoutMs = 30_000, headers }) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('HTTP(S) URL required');
  for (const [name, value] of Object.entries({ requests, concurrency, timeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  const workers = Math.min(requests, concurrency);
  const transport = target.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: workers, maxTotalSockets: workers, maxFreeSockets: workers });
  const latencies = [];
  const statuses = {};
  const failures = [];
  let next = 0, completed = 0, active = 0, peakActive = 0, ticks = 0;
  const tick = setInterval(() => { ticks++; }, 10);
  const request = () => new Promise((resolve, reject) => {
    const req = transport.get(target, { headers, agent });
    // Bound the whole operation, including queueing and incomplete response bodies.
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    const finish = (error, status) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve(status);
    };
    req.once('error', finish);
    req.once('response', (response) => {
      response.once('error', finish);
      response.once('end', () => finish(null, response.statusCode));
      response.resume();
    });
  });
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= requests) return;
      active++;
      peakActive = Math.max(peakActive, active);
      const started = performance.now();
      try {
        const status = await request();
        latencies.push(performance.now() - started);
        statuses[status] = (statuses[status] || 0) + 1;
        if (status < 200 || status >= 300) failures.push({ index, status });
      } catch (error) {
        failures.push({ index, code: error.code || 'REQUEST_FAILED' });
      } finally {
        active--;
        completed++;
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    clearInterval(tick);
    agent.destroy();
  }
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? null;
  return {
    requests, concurrency: workers, maxSockets: workers, completed,
    ok: failures.length === 0, errors: failures.length, statuses, failures,
    eventLoopTicks: ticks, peakActive, activeAtEnd: active,
    latencyMs: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99), max: latencies.at(-1) ?? null },
  };
}
