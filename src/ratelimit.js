// Source — in-memory fixed-window rate limiter.
//
// A simple, deterministic, per-key fixed-window counter. No external
// dependencies. Used to throttle anonymous/unauthenticated paths (the
// `source submit` contribution endpoint and Git push) so a single client
// cannot exhaust the server. Keys are typically the client address; limits
// and windows are configurable per route.

export class RateLimiter {
  constructor() {
    this.buckets = new Map(); // key -> { count, resetAt }
  }

  // Fixed-window counter. Returns true if the request is allowed, false if the
  // key has exceeded `limit` within the current `windowMs` window.
  allow(key, { limit, windowMs }) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    if (b.count >= limit) return false;
    b.count += 1;
    return true;
  }

  // Clear all state (used by tests).
  reset() {
    this.buckets.clear();
  }
}
