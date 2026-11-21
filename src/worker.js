// Bounded worker runtime for durable Source jobs.

export class SourceWorker {
  constructor({ queue, handlers = {}, workerId, concurrency = 8, leaseMs = 30_000, pollMs = 1_000, maxPollMs = 10_000, retryDelayMs = 1_000, maxAttempts = 5, projectBurst = 8, errorBackoffMs = 1_000, jitterRatio = 0.2, random = Math.random, handlerTimeoutMs = 15 * 60_000, shutdownTimeoutMs = 30_000, onError = null } = {}) {
    if (!queue) throw new Error('queue is required');
    if (!workerId) throw new Error('workerId is required');
    // Preserve finite numeric coercion/clamping, but never let NaN disable bounds.
    for (const [name, value] of Object.entries({ concurrency, leaseMs, pollMs, maxPollMs, retryDelayMs, maxAttempts, projectBurst, errorBackoffMs, jitterRatio, handlerTimeoutMs, shutdownTimeoutMs })) {
      if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value))) throw new TypeError(`${name} must be a finite number`);
    }
    this.queue = queue;
    this.handlers = handlers;
    this.workerId = workerId;
    this.concurrency = Math.min(1000, Math.max(1, Math.trunc(concurrency)));
    this.leaseMs = Math.min(86_400_000, Math.max(1, Math.trunc(leaseMs)));
    this.pollMs = Math.min(300_000, Math.max(1, Math.trunc(pollMs)));
    this.maxPollMs = Math.max(this.pollMs, Math.min(300_000, Math.trunc(maxPollMs)));
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
    if ((typeof timeoutMs !== 'number' && typeof timeoutMs !== 'string') || (typeof timeoutMs === 'string' && !timeoutMs.trim()) || !Number.isFinite(Number(timeoutMs))) throw new TypeError('timeoutMs must be a finite number');
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
    const active = new Set();
    let slotAvailable;
    try {
      while (!this.stopping) {
        if (active.size >= this.concurrency) {
          // Wake on one free slot or shutdown, without waiting for the slowest job.
          let wake;
          const stopped = new Promise(resolve => { wake = resolve; this._idleWaiters.add(wake); });
          slotAvailable = wake;
          try { await stopped; }
          finally { slotAvailable = null; this._idleWaiters.delete(wake); }
          continue;
        }
        let jobs;
        try {
          jobs = await this.queue.claim({ workerId: this.workerId, limit: this.concurrency - active.size, leaseMs: this.leaseMs, projectBurst: this.projectBurst });
          failures = 0;
        } catch (error) {
          failures += 1;
          this.counters.errors += 1;
          this._reportError(error);
          await this._wait(this._jitteredDelay(Math.min(60_000, this.errorBackoffMs * (2 ** Math.min(failures - 1, 6)))));
          continue;
        }
        if (!jobs.length) {
          const delay = this._jitteredDelay(idlePollMs);
          await this._waitForWork(delay);
          idlePollMs = Math.min(this.maxPollMs, idlePollMs * 2);
          continue;
        }
        this.counters.claimed += jobs.length;
        idlePollMs = this.pollMs;
        for (const job of jobs) {
          const task = this._runJob(job).finally(() => { active.delete(task); slotAvailable?.(); });
          active.add(task);
        }
        // A partial claim may leave spare slots; poll/notifications still admit
        // newly queued work while existing handlers run.
      }
    } finally {
      await Promise.all(active);
    }
  }

  _waitForWork(ms) {
    if (typeof this.queue.waitForWork !== 'function') return this._wait(ms);
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const controller = new AbortController();
      const finish = () => {
        clearTimeout(timer);
        this._idleWaiters.delete(finish);
        controller.abort();
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this._idleWaiters.add(finish);
      Promise.resolve().then(() => {
        if (controller.signal.aborted) return false;
        return this.queue.waitForWork({ timeoutMs: ms, signal: controller.signal });
      }).then((woken) => {
        // An unavailable listener must leave the polling delay in effect.
        if (woken !== false && !controller.signal.aborted) finish();
      }, (error) => {
        if (!controller.signal.aborted) this._reportError(error);
      });
    });
  }

  _wait(ms) {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this._idleWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this._idleWaiters.add(finish);
    });
  }

  async _runJob(job) {
    const handler = Object.hasOwn(this.handlers, job.kind) ? this.handlers[job.kind] : undefined;
    let heartbeat;
    let timeout;
    let leaseDeadline;
    const controller = new AbortController();
    let rejectLease;
    const leaseLost = new Promise((_resolve, reject) => { rejectLease = reject; });
    let heartbeatPending = false;
    let executionEnded = false;
    this.activeJobs += 1;
    try {
      if (typeof handler !== 'function') throw new Error(`no handler registered for job kind: ${job.kind}`);
      const renewDeadline = (expiresAt) => {
        clearTimeout(leaseDeadline);
        const remaining = Date.parse(expiresAt) - Date.now();
        const delay = Number.isFinite(remaining) ? Math.max(0, Math.min(remaining, this.leaseMs)) : this.leaseMs;
        leaseDeadline = setTimeout(() => {
          const error = new Error('worker lease heartbeat deadline exceeded');
          controller.abort(error);
          rejectLease(error);
        }, delay);
        leaseDeadline.unref?.();
      };
      renewDeadline(job.leasedUntil);
      const heartbeatMs = Math.max(1, Math.floor(this.leaseMs / 3));
      heartbeat = setInterval(() => {
        if (heartbeatPending || controller.signal.aborted) return;
        heartbeatPending = true;
        Promise.resolve().then(() => this.queue.extend({ id: job.id, workerId: this.workerId, leaseToken: job.leaseToken, leaseMs: this.leaseMs }))
          .then((lease) => {
            if (lease === null || lease === false) throw new Error('worker job lease lost or cancelled');
            if (!executionEnded && !controller.signal.aborted) renewDeadline(lease?.leased_until);
          }).catch((error) => {
            if (executionEnded) return;
            controller.abort(error);
            rejectLease(error);
          }).finally(() => { heartbeatPending = false; });
      }, heartbeatMs);
      const resultPromise = Promise.resolve().then(() => handler(job.payload, job, { signal: controller.signal }));
      const result = this.handlerTimeoutMs
        ? await Promise.race([
          resultPromise,
          leaseLost,
          new Promise((resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort(new Error('worker handler timeout'));
              reject(new Error(`worker handler exceeded ${this.handlerTimeoutMs}ms`));
            }, this.handlerTimeoutMs);
            timeout.unref?.();
          }),
        ])
        : await Promise.race([resultPromise, leaseLost]);
      if (controller.signal.aborted) throw controller.signal.reason;
      const completed = await this.queue.complete({ id: job.id, workerId: this.workerId, leaseToken: job.leaseToken, result });
      if (completed === false) throw new Error('worker completion rejected: lease lost or cancelled');
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
      executionEnded = true;
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      if (leaseDeadline) clearTimeout(leaseDeadline);
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
