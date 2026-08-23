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

  acquire() {
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(this._release);
    }
    if (this.waiters.length >= this.queueLimit) {
      this.rejected += 1;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  _release = () => {
    const next = this.waiters.shift();
    if (next) next(this._release);
    else this.active -= 1;
  };
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

  async acquire(key) {
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
    const release = await bucket.acquire();
    if (!release) {
      if (bucket.active === 0 && bucket.waiters.length === 0) this.buckets.delete(normalized);
      this.rejected += 1;
      return null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (bucket.active === 0 && bucket.waiters.length === 0) this.buckets.delete(normalized);
    };
  }
}
