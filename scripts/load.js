// Repeatable deployment load probe for the public agent surface.
// Example: node scripts/load.js --url https://source.example/.well-known/source --requests 10000 --concurrency 1000

import http from 'node:http';
import https from 'node:https';

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const url = flag('--url');
if (!url) {
  process.stderr.write('usage: node scripts/load.js --url <url> [--requests N] [--concurrency N] [--timeout-ms N]\n');
  process.exit(2);
}

const requests = Math.max(1, Number(flag('--requests', 1000)) || 1000);
const concurrency = Math.max(1, Math.min(requests, Number(flag('--concurrency', 100)) || 100));
const timeoutMs = Math.max(100, Number(flag('--timeout-ms', 30_000)) || 30_000);
const bearer = process.env.SOURCE_LOAD_BEARER;
const headers = bearer ? { Authorization: `Bearer ${bearer}` } : undefined;
const transport = url.startsWith('https:') ? https : http;
const agent = new transport.Agent({ keepAlive: true, maxSockets: Math.max(16, Math.min(concurrency, 256)), maxFreeSockets: 256 });
function request() {
  return new Promise((resolve, reject) => {
    const req = transport.get(url, { headers, agent, timeout: timeoutMs }, (response) => {
      response.resume();
      response.once('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode }));
    });
    req.once('timeout', () => req.destroy(new Error('request timed out')));
    req.once('error', reject);
  });
}
const latencies = [];
const errors = [];
let next = 0;
let active = 0;
let ticks = 0;
const timer = setInterval(() => { ticks += 1; }, 10);

async function worker() {
  while (true) {
    const index = next;
    next += 1;
    if (index >= requests) return;
    active += 1;
    const started = performance.now();
    try {
      const response = await request();
      latencies.push(performance.now() - started);
      if (!response.ok) errors.push({ index, status: response.status });
    } catch (error) {
      errors.push({ index, error: error instanceof Error ? error.message : String(error) });
    } finally {
      active -= 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
clearInterval(timer);
agent.destroy();
latencies.sort((a, b) => a - b);
const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? null;
const result = {
  url,
  requests,
  concurrency,
  completed: latencies.length + errors.length,
  ok: errors.length === 0,
  errors: errors.length,
  eventLoopTicks: ticks,
  latencyMs: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99), max: latencies.at(-1) ?? null },
  activeAtEnd: active,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (errors.length > 0) process.exitCode = 1;
