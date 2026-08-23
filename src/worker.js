// Bounded worker runtime for durable Source jobs.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SourceWorker {
  constructor({ queue, handlers = {}, workerId, concurrency = 8, leaseMs = 30_000, pollMs = 1_000, maxPollMs = 10_000, retryDelayMs = 1_000, maxAttempts = 5, projectBurst = 8, errorBackoffMs = 1_000, jitterRatio = 0.2, random = Math.random, handlerTimeoutMs = 15 * 60_000, shutdownTimeoutMs = 30_000, onError = null } = {}) {
    if (!queue) throw new Error('queue is required');
    if (!workerId) throw new Error('workerId is required');
    this.queue = queue;
    this.handlers = handlers;
    this.workerId = workerId;
    this.concurrency = Math.min(1000, Math.max(1, Math.trunc(concurrency)));
    this.leaseMs = Math.max(1, Math.trunc(leaseMs));
    this.pollMs = Math.max(1, Math.trunc(pollMs));
    const safeMaxPollMs = Number.isFinite(Number(maxPollMs)) ? Number(maxPollMs) : 10_000;
    this.maxPollMs = Math.max(this.pollMs, Math.min(300_000, Math.trunc(safeMaxPollMs)));
    this.retryDelayMs = Math.max(0, Math.trunc(retryDelayMs));
    this.maxAttempts = Math.max(1, Math.trunc(maxAttempts));
    this.projectBurst = Math.min(1_000, Math.max(1, Math.trunc(projectBurst)));
    this.errorBackoffMs = Math.max(1, Math.trunc(errorBackoffMs));
    this.jitterRatio = Math.min(1, Math.max(0, Number(jitterRatio) || 0));
    this.random = typeof random === 'function' ? random : Math.random;
    this.handlerTimeoutMs = Math.min(24 * 60 * 60_000, Math.max(0, Math.trunc(handlerTimeoutMs)));
    this.shutdownTimeoutMs = Math.min(300_000, Math.max(0, Math.trunc(shutdownTimeoutMs)));
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.lastError = null;
    this.stopping = false;
    this.running = null;
    this._idleWaiters = new Set();
    this.activeJobs = 0;
    this.counters = { claimed: 0, completed: 0, failed: 0, errors: 0 };
  }

  start() {
    if (this.running) return this;
    this.stopping = false;
    this.running = this._loop().finally(() => { this.running = null; });
    return this;
  }

  async stop({ timeoutMs = this.shutdownTimeoutMs } = {}) {
    this.stopping = true;
    for (const wake of this._idleWaiters) wake();
    this._idleWaiters.clear();
    if (!this.running) return true;
    const safeTimeout = Math.min(300_000, Math.max(0, Math.trunc(timeoutMs)));
    if (!safeTimeout) {
      await this.running;
      return true;
    }
    let timer;
    const drained = await Promise.race([
      this.running.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          this._reportError(new Error(`worker shutdown drain exceeded ${safeTimeout}ms; leases will recover after expiry`));
          resolve(false);
        }, safeTimeout);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    return drained;
  }

  metrics() {
    return { ...this.counters, activeJobs: this.activeJobs, stopping: this.stopping };
  }

  async _loop() {
    let failures = 0;
    let idlePollMs = this.pollMs;
    while (!this.stopping) {
      let jobs;
      try {
        jobs = await this.queue.claim({ workerId: this.workerId, limit: this.concurrency, leaseMs: this.leaseMs, projectBurst: this.projectBurst });
        failures = 0;
      } catch (error) {
        failures += 1;
        this.counters.errors += 1;
        this._reportError(error);
        await sleep(this._jitteredDelay(Math.min(60_000, this.errorBackoffMs * (2 ** Math.min(failures - 1, 6)))));
        continue;
      }
      if (!jobs.length) {
        const delay = this._jitteredDelay(idlePollMs);
        if (typeof this.queue.waitForWork === 'function') {
          let wakeStopWait;
          const stopWait = new Promise((resolve) => {
            wakeStopWait = () => resolve();
            this._idleWaiters.add(wakeStopWait);
          });
          await Promise.race([this.queue.waitForWork({ timeoutMs: delay }), stopWait]).catch(() => {});
          this._idleWaiters.delete(wakeStopWait);
        } else {
          await sleep(delay);
        }
        idlePollMs = Math.min(this.maxPollMs, idlePollMs * 2);
        continue;
      }
      this.counters.claimed += jobs.length;
      idlePollMs = this.pollMs;
      await Promise.all(jobs.map((job) => this._runJob(job)));
    }
  }

  async _runJob(job) {
    const handler = this.handlers[job.kind];
    let heartbeat;
    let timeout;
    const controller = new AbortController();
    this.activeJobs += 1;
    try {
      if (typeof handler !== 'function') throw new Error(`no handler registered for job kind: ${job.kind}`);
      const heartbeatMs = Math.max(1, Math.floor(this.leaseMs / 3));
      heartbeat = setInterval(() => {
        this.queue.extend({ id: job.id, workerId: this.workerId, leaseToken: job.leaseToken, leaseMs: this.leaseMs }).catch(() => {});
      }, heartbeatMs);
      const resultPromise = Promise.resolve().then(() => handler(job.payload, job, { signal: controller.signal }));
      const result = this.handlerTimeoutMs
        ? await Promise.race([
          resultPromise,
          new Promise((resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort(new Error('worker handler timeout'));
              reject(new Error(`worker handler exceeded ${this.handlerTimeoutMs}ms`));
            }, this.handlerTimeoutMs);
            timeout.unref?.();
          }),
        ])
        : await resultPromise;
      await this.queue.complete({ id: job.id, workerId: this.workerId, leaseToken: job.leaseToken, result });
      this.counters.completed += 1;
    } catch (error) {
      this.counters.failed += 1;
      this._reportError(error);
      try {
        await this.queue.fail({
          id: job.id,
          workerId: this.workerId,
          leaseToken: job.leaseToken,
          error: error instanceof Error ? error.message : String(error),
          retryDelayMs: this.retryDelayMs,
          maxAttempts: job.maxAttempts ?? this.maxAttempts,
        });
      } catch (failureError) {
        // A transient database failure must not terminate the worker. The
        // lease will expire and another claim cycle can recover the job.
        this._reportError(failureError);
      }
    } finally {
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
    }
  }

  _reportError(error) {
    this.lastError = error instanceof Error ? error : new Error(String(error));
    try { this.onError(this.lastError); } catch { /* telemetry must not kill the worker */ }
  }

  _jitteredDelay(baseMs) {
    if (!this.jitterRatio) return baseMs;
    const randomValue = Math.min(1, Math.max(0, Number(this.random()) || 0));
    const factor = 1 - this.jitterRatio + (2 * this.jitterRatio * randomValue);
    return Math.max(1, Math.round(baseMs * factor));
  }
}
