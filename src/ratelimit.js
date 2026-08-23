// Source — in-memory fixed-window rate limiter.
//
// A simple, deterministic, per-key fixed-window counter. No external
// dependencies. Used to throttle anonymous/unauthenticated paths (the
// `source submit` contribution endpoint and Git push) so a single client
// cannot exhaust the server. Keys are typically the client address; limits
// and windows are configurable per route.

export class RateLimiter {
  constructor({ maxKeys = 100_000, store = null } = {}) {
    this.buckets = new Map(); // key -> { count, resetAt }
    this.maxKeys = maxKeys;
    this.store = store;
  }

  // Fixed-window counter. Returns true if the request is allowed, false if the
  // key has exceeded `limit` within the current `windowMs` window.
  allow(key, { limit, windowMs, cost = 1 }) {
    const now = Date.now();
    if (this.store && typeof this.store.allowRateLimit === 'function') {
      return this.store.allowRateLimit(key, limit, windowMs, now, cost);
    }
    return this._allowInMemory(key, limit, windowMs, now, cost);
  }

  async allowAsync(key, { limit, windowMs, cost = 1 }) {
    const now = Date.now();
    if (this.store && typeof this.store.allowRateLimitAsync === 'function') {
      return this.store.allowRateLimitAsync(key, limit, windowMs, now, cost);
    }
    if (this.store && typeof this.store.allowRateLimit === 'function') {
      return this.store.allowRateLimit(key, limit, windowMs, now, cost);
    }
    return this._allowInMemory(key, limit, windowMs, now, cost);
  }

  _allowInMemory(key, limit, windowMs, now, cost = 1) {
    const safeCost = Math.min(1000, Math.max(1, Math.trunc(cost)));
    if (this.buckets.size >= this.maxKeys && !this.buckets.has(key)) {
      for (const [candidate, bucket] of this.buckets) {
        if (now >= bucket.resetAt) this.buckets.delete(candidate);
        if (this.buckets.size < this.maxKeys) break;
      }
      if (this.buckets.size >= this.maxKeys) return false;
    }
    let b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    if (b.count + safeCost > limit) return false;
    b.count += safeCost;
    return true;
  }

  // Clear all state (used by tests).
  reset() {
    this.buckets.clear();
  }
}
