// Repeatable deployment load probe for the public agent surface.
// Example: node scripts/load.js --url https://source.example/.well-known/source --requests 10000 --concurrency 1000

import { runHttpLoad } from './lib/http-load.js';

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
const result = await runHttpLoad({ url, requests, concurrency, timeoutMs, headers });
// Report counts once per completed request, including non-2xx responses.
const { failures, ...summary } = result;
process.stdout.write(`${JSON.stringify({ url, ...summary }, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
