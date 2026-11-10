import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresStore } from '../src/postgres-store.js';

function fixture(execute = async () => {}) {
  const events = []; let active = 0; let maximum = 0; let admissionReleased = 0;
  const releases = [];
  const client = {
    async query(sql) {
      active++; maximum = Math.max(maximum, active); events.push(`start:${sql}`);
      try { await execute(sql); return { rows: [{ value: sql }] }; }
      finally { events.push(`end:${sql}`); active--; }
    },
    release(error) { assert.equal(active, 0, 'client cannot return to pool with a pending query'); releases.push(error); },
  };
  const store = Object.create(PostgresStore.prototype);
  store._asyncTransaction = new AsyncLocalStorage();
  store.pool = { connect: async () => client };
  store._acquireDbSlot = async () => () => { admissionReleased++; };
  return { store, events, releases, maximum: () => maximum, admissionReleased: () => admissionReleased };
}

test('transaction serializes parallel and nested queries on one client', async () => {
  const f = fixture(async () => new Promise((resolve) => setImmediate(resolve)));
  const results = await f.store.transactionAsync(() => Promise.all(Array.from({ length: 20 }, (_, i) =>
    i % 2 ? f.store.transactionAsync(() => f.store._runAsync(`SELECT ${i}`)) : f.store._runAsync(`SELECT ${i}`))));
  assert.deepEqual(results, Array.from({ length: 20 }, (_, i) => `SELECT ${i}`));
  assert.equal(f.maximum(), 1);
  assert.equal(f.events[0], 'start:BEGIN'); assert.equal(f.events.at(-1), 'end:COMMIT');
  assert.equal(f.events.filter((event) => event === 'start:BEGIN').length, 1);
  assert.equal(f.releases.length, 1); assert.equal(f.admissionReleased(), 1);
});

test('callback failure drains admitted queries before rollback and rejects escaped contexts', async () => {
  let notify; let release; let context; let slow;
  const started = new Promise((resolve) => { notify = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(async (sql) => { if (sql === 'slow') { notify(); await gate; } });
  const failure = new Error('callback failed');
  const transaction = f.store.transactionAsync(async () => {
    context = f.store._asyncTransaction.getStore();
    slow = f.store._runAsync('slow'); await started; throw failure;
  });
  const outcome = transaction.then(() => null, (error) => error);
  await started; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.releases.length, 0);
  assert.ok(!f.events.includes('start:ROLLBACK'));
  await assert.rejects(() => f.store._asyncTransaction.run(context, () => f.store._runAsync('late')), /no longer active/);
  release(); assert.equal(await slow, 'slow'); assert.equal(await outcome, failure);
  assert.ok(f.events.indexOf('end:slow') < f.events.indexOf('start:ROLLBACK'));
  assert.equal(f.maximum(), 1); assert.equal(f.releases.length, 1);
  await assert.rejects(() => f.store._asyncTransaction.run(context, () => f.store.transactionAsync(() => 'late')), /no longer active/);
});

test('SQL failure poisons the transaction even when the callback catches it', async () => {
  const failure = new Error('query failed');
  const f = fixture(async (sql) => { if (sql === 'bad') throw failure; });
  await assert.rejects(() => f.store.transactionAsync(async () => {
    const results = await Promise.allSettled([f.store._runAsync('bad'), f.store._runAsync('must-not-run')]);
    assert.ok(results.every((result) => result.status === 'rejected' && result.reason === failure));
    return 'not committed';
  }), (error) => error === failure);
  assert.ok(!f.events.includes('start:must-not-run')); assert.ok(!f.events.includes('start:COMMIT'));
  assert.ok(f.events.includes('end:ROLLBACK')); assert.equal(f.releases.length, 1);
});

test('failed rollback discards the client and retains the original error', async () => {
  const rollback = new Error('connection lost during rollback'); const failure = new Error('application failure');
  const f = fixture(async (sql) => { if (sql === 'ROLLBACK') throw rollback; });
  await assert.rejects(() => f.store.transactionAsync(() => { throw failure; }), (error) => error === failure);
  assert.deepEqual(f.releases, [rollback]); assert.equal(f.admissionReleased(), 1);
});
