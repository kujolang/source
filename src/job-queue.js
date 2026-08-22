// Durable worker queue seam. Production stores implement leases in the
// database; workers can safely claim in parallel and recover abandoned work.

export class JobQueue {
  constructor(store) {
    this.store = store;
  }

  async enqueue({ kind, payload = {}, availableAt = new Date() }) {
    if (typeof this.store.enqueueJobAsync !== 'function') {
      throw new Error('durable job queue requires a Postgres-backed store');
    }
    return this.store.enqueueJobAsync({ kind, payload, availableAt });
  }

  async claim({ workerId, limit = 10, leaseMs = 30_000 }) {
    if (typeof this.store.claimJobsAsync !== 'function') {
      throw new Error('durable job queue requires a Postgres-backed store');
    }
    return this.store.claimJobsAsync({ workerId, limit, leaseMs });
  }

  async complete({ id, workerId, result = null }) {
    return this.store.completeJobAsync({ id, workerId, result });
  }

  async fail({ id, workerId, error, retryDelayMs = 1_000, maxAttempts = 5 }) {
    return this.store.failJobAsync({ id, workerId, error, retryDelayMs, maxAttempts });
  }

  async extend({ id, workerId, leaseMs = 30_000 }) {
    return this.store.extendJobAsync({ id, workerId, leaseMs });
  }
}
