// Durable worker queue seam. Production stores implement leases in the
// database; workers can safely claim in parallel and recover abandoned work.

export class JobQueue {
  constructor(store) {
    this.store = store;
  }

  async enqueue({ kind, payload = {}, availableAt = new Date(), orgId = null, projectId = null, workId = null, maxAttempts = 5, maxQueueDepth = null, dedupeKey = null }) {
    if (typeof this.store.enqueueJobAsync !== 'function') {
      throw new Error('durable job queue requires a Postgres-backed store');
    }
    return this.store.enqueueJobAsync({ kind, payload, availableAt, orgId, projectId, workId, maxAttempts, maxQueueDepth, dedupeKey });
  }

  async claim({ workerId, limit = 10, leaseMs = 30_000, maxAttempts = null }) {
    if (typeof this.store.claimJobsAsync !== 'function') {
      throw new Error('durable job queue requires a Postgres-backed store');
    }
    return this.store.claimJobsAsync({ workerId, limit, leaseMs, maxAttempts });
  }

  async complete({ id, workerId, leaseToken, result = null }) {
    return this.store.completeJobAsync({ id, workerId, leaseToken, result });
  }

  async fail({ id, workerId, leaseToken, error, retryDelayMs = 1_000, maxAttempts = 5 }) {
    return this.store.failJobAsync({ id, workerId, leaseToken, error, retryDelayMs, maxAttempts });
  }

  async extend({ id, workerId, leaseToken, leaseMs = 30_000 }) {
    return this.store.extendJobAsync({ id, workerId, leaseToken, leaseMs });
  }

  async list({ orgId, projectId, workId = null, cursor = null, limit = 100 }) {
    if (typeof this.store.listJobsAsync !== 'function') {
      throw new Error('durable job queue requires a Postgres-backed store');
    }
    return this.store.listJobsAsync({ orgId, projectId, workId, cursor, limit });
  }

  async count({ orgId, projectId }) {
    if (typeof this.store.countJobsAsync !== 'function') throw new Error('durable job queue requires a Postgres-backed store');
    return this.store.countJobsAsync({ orgId, projectId });
  }
}
