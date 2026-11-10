// Bounded client backoff for explicit admission rejection. Transport errors and
// ambiguous mutation outcomes must not be retried as if they were rejections.
import { setTimeout as delay } from 'node:timers/promises';

export class ClientRetry {
  constructor({ maxRetries = 8, maxElapsedMs = 600000, fallbackMs = 60000, now = Date.now, sleep = delay, random = Math.random, onRetry = ({ operation, delayMs, attempt }) => process.stderr.write(`Source ${operation} throttled; retry ${attempt}/${maxRetries} in ${Math.ceil(delayMs / 1000)}s\n`) } = {}) {
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 20 || !Number.isSafeInteger(maxElapsedMs) || maxElapsedMs < 1 || maxElapsedMs > 600000 || !Number.isSafeInteger(fallbackMs) || fallbackMs < 1 || fallbackMs > 120000) throw new Error('invalid client retry bounds');
    this.maxRetries = maxRetries; this.maxElapsedMs = maxElapsedMs; this.fallbackMs = fallbackMs;
    this.now = now; this.sleep = sleep; this.random = random; this.onRetry = onRetry;
    this.started = now(); this.retries = 0; this.operations = new Map();
  }

  timeoutMs() {
    const remaining = this.maxElapsedMs - (this.now() - this.started);
    if (remaining <= 0) throw new Error('Source client retry deadline exceeded');
    return Math.max(1, Math.min(120000, remaining));
  }

  async wait(operation, retryAfter = null) {
    if (this.retries >= this.maxRetries) throw new Error('Source client retry limit exceeded');
    const count = this.operations.get(operation) || 0;
    let minimum = null;
    if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter)) minimum = Number(retryAfter) * 1000;
    else if (typeof retryAfter === 'string' && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter) && Number.isFinite(Date.parse(retryAfter))) minimum = Math.max(0, Date.parse(retryAfter) - this.now());
    if (minimum === null) minimum = Math.min(120000, this.fallbackMs * (2 ** Math.min(count, 3)));
    const jitter = Math.floor(Math.max(0, Math.min(1, this.random())) * Math.min(15000, minimum * .25));
    const delayMs = Math.max(1, minimum + jitter);
    if (!Number.isSafeInteger(delayMs) || this.now() - this.started + delayMs >= this.maxElapsedMs) throw new Error('Source throttling exceeds client retry deadline');
    this.retries++; this.operations.set(operation, count + 1);
    this.onRetry({ operation, delayMs, attempt: this.retries });
    await this.sleep(delayMs);
    this.timeoutMs();
  }
}

export async function submitRequest(url, options, { retry = new ClientRetry(), fetchImpl = fetch } = {}) {
  while (true) {
    // An uncertain response or timeout could follow a committed mutation. Only
    // Source's explicit pre-admission 429 is safe to replay without idempotency.
    const signal = AbortSignal.timeout(retry.timeoutMs());
    let response, body;
    try {
      response = await fetchImpl(url, { ...options, signal });
      body = await response.json();
    } catch (error) {
      const codes = ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND'];
      const code = error?.cause?.code ?? error?.code;
      const failure = new Error('Source submit transport failed; outcome unknown; inspect before retrying');
      failure.diagnostic = { operation: 'submit', kind: 'transport', code: codes.includes(code) ? code : null, timedOut: error?.name === 'TimeoutError', responseReceived: Boolean(response), outcomeUnknown: true };
      throw failure;
    }
    if (response.status === 429 && body?.retryable === true) {
      await retry.wait('submit', response.headers.get('retry-after'));
      continue;
    }
    if (!response.ok) throw new Error(body.error || `submit failed (${response.status})`);
    return body;
  }
}
