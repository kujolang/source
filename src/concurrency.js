// Small bounded async primitives used at process boundaries.

export class Semaphore {
  constructor({ capacity, queue = 0 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('semaphore capacity must be a positive integer');
    this.capacity = capacity;
    this.queueLimit = Math.max(0, Number.isInteger(queue) ? queue : 0);
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(this._release);
    }
    if (this.waiters.length >= this.queueLimit) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  _release = () => {
    const next = this.waiters.shift();
    if (next) next(this._release);
    else this.active -= 1;
  };
}
