// Bounded worker runtime for durable Source jobs.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SourceWorker {
  constructor({ queue, handlers = {}, workerId, concurrency = 8, leaseMs = 30_000, pollMs = 1_000, retryDelayMs = 1_000, maxAttempts = 5 } = {}) {
    if (!queue) throw new Error('queue is required');
    if (!workerId) throw new Error('workerId is required');
    this.queue = queue;
    this.handlers = handlers;
    this.workerId = workerId;
    this.concurrency = Math.min(1000, Math.max(1, Math.trunc(concurrency)));
    this.leaseMs = Math.max(1, Math.trunc(leaseMs));
    this.pollMs = Math.max(1, Math.trunc(pollMs));
    this.retryDelayMs = Math.max(0, Math.trunc(retryDelayMs));
    this.maxAttempts = Math.max(1, Math.trunc(maxAttempts));
    this.stopping = false;
    this.running = null;
  }

  start() {
    if (this.running) return this;
    this.stopping = false;
    this.running = this._loop().finally(() => { this.running = null; });
    return this;
  }

  async stop() {
    this.stopping = true;
    await this.running;
  }

  async _loop() {
    while (!this.stopping) {
      const jobs = await this.queue.claim({ workerId: this.workerId, limit: this.concurrency, leaseMs: this.leaseMs });
      if (!jobs.length) {
        await sleep(this.pollMs);
        continue;
      }
      await Promise.all(jobs.map((job) => this._runJob(job)));
    }
  }

  async _runJob(job) {
    const handler = this.handlers[job.kind];
    let heartbeat;
    try {
      if (typeof handler !== 'function') throw new Error(`no handler registered for job kind: ${job.kind}`);
      const heartbeatMs = Math.max(1, Math.floor(this.leaseMs / 3));
      heartbeat = setInterval(() => {
        this.queue.extend({ id: job.id, workerId: this.workerId, leaseMs: this.leaseMs }).catch(() => {});
      }, heartbeatMs);
      const result = await handler(job.payload, job);
      await this.queue.complete({ id: job.id, workerId: this.workerId, result });
    } catch (error) {
      await this.queue.fail({
        id: job.id,
        workerId: this.workerId,
        error: error instanceof Error ? error.message : String(error),
        retryDelayMs: this.retryDelayMs,
        maxAttempts: this.maxAttempts,
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}
