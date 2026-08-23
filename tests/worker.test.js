import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceWorker } from '../src/worker.js';

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('worker test timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

test('worker bounds handler concurrency and stops gracefully', async () => {
  const jobs = Array.from({ length: 20 }, (_, index) => ({ id: `J${index}`, kind: 'batch', payload: { index } }));
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const queue = {
    async claim({ limit }) { return jobs.splice(0, limit); },
    async complete() { completed += 1; },
    async fail() { assert.fail('unexpected failure'); },
    async extend() { return true; },
  };
  const worker = new SourceWorker({
    queue,
    workerId: 'worker-1',
    concurrency: 4,
    pollMs: 1,
    handlers: {
      batch: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
    },
  });
  worker.start();
  await waitFor(() => completed === 20);
  await worker.stop();
  assert.equal(maxActive, 4);
});

test('worker routes handler failures to retry/failure state', async () => {
  let claimed = true;
  let failure;
  const queue = {
    async claim() {
      if (!claimed) return [];
      claimed = false;
      return [{ id: 'J1', kind: 'missing', payload: {} }];
    },
    async complete() { assert.fail('unexpected completion'); },
    async fail(args) { failure = args; },
    async extend() { return true; },
  };
  const worker = new SourceWorker({ queue, workerId: 'worker-2', pollMs: 1, handlers: {} });
  worker.start();
  await waitFor(() => Boolean(failure));
  await worker.stop();
  assert.match(failure.error, /no handler registered/);
  assert.equal(failure.workerId, 'worker-2');
});

test('worker survives transient queue outages and reports errors', async () => {
  let claimAttempts = 0;
  let completed = false;
  const errors = [];
  const queue = {
    async claim() {
      claimAttempts += 1;
      if (claimAttempts < 3) throw new Error('database unavailable');
      if (completed) return [];
      return [{ id: 'J-recovered', kind: 'recover', payload: {} }];
    },
    async complete() { completed = true; },
    async fail() { assert.fail('unexpected failure'); },
    async extend() { return true; },
  };
  const worker = new SourceWorker({
    queue,
    workerId: 'worker-recovery',
    pollMs: 1,
    errorBackoffMs: 1,
    onError: (error) => errors.push(error.message),
    handlers: { recover: async () => {} },
  });
  worker.start();
  await waitFor(() => completed);
  await worker.stop();
  assert.equal(claimAttempts >= 3, true);
  assert.deepEqual(errors, ['database unavailable', 'database unavailable']);
  assert.equal(worker.lastError.message, 'database unavailable');
});

test('worker shutdown has a bounded drain and leaves hung leases recoverable', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let claimed = false;
  const queue = {
    async claim() {
      if (claimed) return [];
      claimed = true;
      return [{ id: 'J1', kind: 'blocked', payload: {}, leaseToken: 'lease-1', maxAttempts: 2 }];
    },
    async extend() {},
    async complete() {},
    async fail() {},
  };
  const worker = new SourceWorker({
    queue,
    workerId: 'shutdown-test',
    pollMs: 1,
    shutdownTimeoutMs: 10,
    handlers: { blocked: async () => blocked },
  });
  worker.start();
  await waitFor(() => claimed);
  assert.equal(await worker.stop(), false);
  release();
  await waitFor(() => worker.running === null);
});

test('worker times out a hung handler and aborts its signal before retry routing', async () => {
  let failure;
  let observedSignal;
  const queue = {
    async claim() {
      if (failure) return [];
      return [{ id: 'J-timeout', kind: 'timeout', payload: {}, leaseToken: 'lease-timeout', maxAttempts: 2 }];
    },
    async extend() {},
    async complete() { assert.fail('timed out handler must not complete'); },
    async fail(args) { failure = args; },
  };
  const worker = new SourceWorker({
    queue,
    workerId: 'timeout-test',
    pollMs: 1,
    handlerTimeoutMs: 10,
    handlers: { timeout: async (_payload, _job, { signal }) => {
      observedSignal = signal;
      await new Promise(() => {});
    } },
  });
  worker.start();
  await waitFor(() => Boolean(failure));
  await worker.stop();
  assert.match(failure.error, /handler exceeded 10ms/);
  assert.equal(observedSignal.aborted, true);
});

test('worker jitters idle polling and outage backoff to avoid fleet synchronization', async () => {
  const worker = new SourceWorker({ queue: { claim: async () => [] }, workerId: 'jitter-test', pollMs: 100, jitterRatio: 0.25, random: () => 0 });
  assert.equal(worker._jitteredDelay(100), 75);
  worker.random = () => 1;
  assert.equal(worker._jitteredDelay(100), 125);
  worker.jitterRatio = 0;
  assert.equal(worker._jitteredDelay(100), 100);
});
