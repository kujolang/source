// Run with a disposable PostgreSQL database and an installed baseline checkout.
// Usage: SOURCE_TEST_DATABASE_URL=... node worker-wakeup.mjs BASELINE OUTPUT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { platform, arch } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [baselinePath, output] = process.argv.slice(2);
const dsn = process.env.SOURCE_TEST_DATABASE_URL;
if (!baselinePath || !output || !dsn) throw new Error('baseline checkout, output path and disposable database are required');

const root = new URL('../../../../', import.meta.url);
const baseline = pathToFileURL(path.resolve(baselinePath) + path.sep);
const pollMs = 250;
const samples = { baseline: [], current: [] };
const backends = {};

async function setup(label, checkout) {
  const [{ PostgresStore }, { JobQueue }, { SourceWorker }] = await Promise.all(
    ['postgres-store', 'job-queue', 'worker'].map(name => import(new URL(`src/${name}.js`, checkout))),
  );
  const schema = `source_wakeup_${label}_${process.pid}_${Date.now()}`;
  const store = new PostgresStore({ dsn, schema });
  const queue = new JobQueue(store);
  backends[label] = { store, schema, queue, SourceWorker };
  await store._ensureJobListenerAsync();
}

async function measure(label, iteration) {
  const { queue, SourceWorker } = backends[label];
  const emptyClaim = Promise.withResolvers();
  const handled = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let claims = 0;
  const testQueue = {
    async claim(options) {
      const jobs = await queue.claim(options);
      claims++;
      if (!jobs.length) emptyClaim.resolve();
      return jobs;
    },
    async complete(options) {
      await queue.complete(options);
      finished.resolve();
    },
    fail: options => queue.fail(options),
    extend: options => queue.extend(options),
    ...(queue.waitForWork && { waitForWork: options => queue.waitForWork(options) }),
  };
  const worker = new SourceWorker({
    queue: testQueue, workerId: `benchmark-${iteration}`, concurrency: 1,
    pollMs, maxPollMs: pollMs, jitterRatio: 0,
    handlers: { benchmark: payload => { handled.resolve({ payload, at: performance.now() }); } },
  });
  const timeout = setTimeout(() => {
    const error = new Error('worker wakeup sample timed out');
    handled.reject(error);
    finished.resolve();
    emptyClaim.resolve();
  }, 5000);
  handled.promise.catch(() => {});
  worker.start();
  try {
    await emptyClaim.promise;
    // Give the worker its idle wait after the empty claim.
    await new Promise(setImmediate);
    const start = performance.now();
    await queue.enqueue({ kind: 'benchmark', payload: { iteration } });
    const receipt = await handled.promise;
    await finished.promise;
    assert.deepEqual(receipt.payload, { iteration });
    assert.equal(claims, 2, 'one empty claim and one claim of the queued job');
    return receipt.at - start;
  } finally {
    clearTimeout(timeout);
    await worker.stop({ timeoutMs: 0 });
  }
}

const revision = checkout => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
try {
  await setup('baseline', baseline);
  await setup('current', root);
  for (let i = -1; i < 7; i++) {
    const order = i % 2 === 0 ? ['baseline', 'current'] : ['current', 'baseline'];
    for (const label of order) {
      const elapsed = await measure(label, i);
      if (i >= 0) samples[label].push(elapsed);
    }
  }
  const result = Object.fromEntries(Object.entries(samples).map(([label, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return [label, { samplesMs: values, medianMs: sorted[3], minMs: sorted[0], maxMs: sorted.at(-1) }];
  }));
  writeFileSync(output, JSON.stringify({
    baselineRevision: revision(baseline), currentRevision: revision(root),
    node: process.version, platform: platform(), arch: arch(), pollMs,
    workload: 'warm idle worker, one committed job, elapsed from enqueue start to handler entry',
    warmupsPerRevision: 1, sampleOrder: 'alternating baseline-first and current-first',
    equivalentJobs: true, results: result,
  }, null, 2) + '\n', { flag: 'wx' });
} finally {
  for (const { store, schema } of Object.values(backends)) {
    try { await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await store.closeAsync(); }
  }
}
