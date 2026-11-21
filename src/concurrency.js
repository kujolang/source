// Small bounded async primitives used at process boundaries.

export class Semaphore {
  constructor({ capacity, queue = 0 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('semaphore capacity must be a positive integer');
    this.capacity = capacity;
    this.queueLimit = Math.max(0, Number.isInteger(queue) ? queue : 0);
    this.active = 0;
    this.waiters = [];
    this.rejected = 0;
  }

  acquire({ signal } = {}) {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(this._permit());
    }
    if (this.waiters.length >= this.queueLimit) {
      this.rejected += 1;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal?.removeEventListener('abort', cancel);
        resolve(this._permit());
      };
      const cancel = () => {
        this.waiters.splice(this.waiters.indexOf(grant), 1);
        resolve(null);
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  _permit() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

// Per-key admission prevents one tenant from monopolizing a shared global
// budget. Idle key buckets are removed so attacker-controlled key cardinality
// cannot grow memory without bound.
export class KeyedSemaphore {
  constructor({ capacity, queue = 0, maxKeys = 10_000 } = {}) {
    this.capacity = capacity;
    this.queue = queue;
    this.maxKeys = Math.max(1, Math.trunc(maxKeys));
    this.buckets = new Map();
    this.rejected = 0;
  }

  async acquire(key, { signal } = {}) {
    if (signal?.aborted) return null;
    const normalized = String(key).slice(0, 256);
    let bucket = this.buckets.get(normalized);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        this.rejected += 1;
        return null;
      }
      bucket = new Semaphore({ capacity: this.capacity, queue: this.queue });
      this.buckets.set(normalized, bucket);
    }
    const release = await bucket.acquire({ signal });
    if (!release) {
      if (bucket.active === 0 && this.buckets.get(normalized) === bucket) this.buckets.delete(normalized);
      if (!signal?.aborted) this.rejected += 1;
      return null;
    }
    return () => {
      release();
      if (bucket.active === 0 && this.buckets.get(normalized) === bucket) this.buckets.delete(normalized);
    };
  }
}

// Stop taking new items on failure, and finish admitted work before returning
// so callers can safely release admission slots and transaction locks.
export async function mapConcurrent(items, concurrency, transform) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  const run = async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await transform(items[index]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  if (failure) throw failure.error;
  return results;
}
