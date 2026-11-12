import assert from 'node:assert/strict';
import { SourceWorker } from '../../../../src/worker.js';
const turn = () => new Promise(resolve => setImmediate(resolve));
let releaseSlow;
const slow = new Promise(resolve => { releaseSlow = resolve; });
const pending = ['slow', 'fast', 'waiting'].map(id => ({ id, kind: 'probe' }));
const started = [], completed = [];
const queue = {
  async claim({ limit }) { return pending.splice(0, limit); },
  async complete({ id }) { completed.push(id); return true; },
  async extend() { return true; },
  async fail() { assert.fail('unexpected job failure'); },
};
const worker = new SourceWorker({ queue, workerId: 'audit', concurrency: 2, pollMs: 1, handlers: { probe: async (_, job) => { started.push(job.id); if (job.id === 'slow') await slow; } } });
worker.start();
for (let i = 0; i < 100 && !completed.includes('fast'); i++) await turn();
assert.ok(completed.includes('fast'));
for (let i = 0; i < 10; i++) await turn();
assert.deepEqual(started, ['slow', 'fast']);
assert.equal(worker.activeJobs, 1);
assert.equal(pending.length, 1);
const observation = { activeJobs: worker.activeJobs, configuredConcurrency: 2, queuedJobs: pending.length, fastJobCompleted: true, waitingJobStarted: false };
const stopping = worker.stop(); releaseSlow(); await stopping;
const invalid = new SourceWorker({ queue, workerId: 'invalid', concurrency: 'not-a-number', handlerTimeoutMs: 'not-a-number' });
assert.ok(Number.isNaN(invalid.concurrency));
assert.ok(Number.isNaN(invalid.handlerTimeoutMs));
console.log(JSON.stringify({ waveBarrier: observation, invalidConfiguration: { concurrencyIsNaN: true, handlerTimeoutIsNaN: true, handlerTimeoutEnabled: Boolean(invalid.handlerTimeoutMs) } }, null, 2));
