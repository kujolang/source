import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresStore } from '../src/postgres-store.js';
import { Source } from '../src/source.js';
import { startServer } from '../src/api.js';
import { SourceWorker } from '../src/worker.js';

const dsn = process.env.SOURCE_TEST_DATABASE_URL;

test('Postgres async lifecycle and HTTP burst remain correct under 1000 agents', { skip: !dsn }, async () => {
  const schema = `source_test_${Date.now()}_${process.pid}`;
  let store;
  let src;
  let server;
  try {
    store = new PostgresStore({ dsn, schema, connectionOptions: { maxConnections: 16 } });
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'source-pg-live-'));
    src = new Source(dataRoot, { store });
    await store.writeJsonAsync('instance.json', { id: 'instance', name: 'postgres-live', apiVersion: '1' });
    const org = await src.createOrgAsync({ name: 'load-org', slug: 'load-org' });
    const project = await src.createProjectAsync({ orgId: org.id, name: 'load-project', slug: 'load-project' });
    const principal = await src.createPrincipalAsync({ type: 'agent', name: 'load-agent' });
    const works = await Promise.all(Array.from({ length: 1_000 }, (_, i) => src.createWorkAsync({
      orgId: org.id,
      projectId: project.id,
      intent: `agent-${i}`,
      requester: principal.id,
    })));
    assert.equal(works.length, 1_000);
    assert.equal((await src.listWorkAsync(org.id, project.id, { limit: 1_001 })).length, 1_000);

    const queued = await Promise.all(Array.from({ length: 100 }, (_, i) => src.jobs.enqueue({ kind: 'agent.batch', payload: { index: i } })));
    const claims = (await Promise.all(Array.from({ length: 8 }, (_, i) => src.jobs.claim({ workerId: `worker-${i}`, limit: 20 })))).flat();
    assert.equal(new Set(claims.map((job) => job.id)).size, queued.length);
    await Promise.all(claims.map((job) => src.jobs.complete({ id: job.id, workerId: job.workerId, result: { ok: true } })));
    const leaseJob = await src.jobs.enqueue({ kind: 'agent.recover', payload: {} });
    const leased = (await src.jobs.claim({ workerId: 'crashed-worker', limit: 1, leaseMs: 1 }))[0];
    assert.equal(leased.id, leaseJob.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recovered = (await src.jobs.claim({ workerId: 'recovery-worker', limit: 1, leaseMs: 5_000 }))[0];
    assert.equal(recovered.id, leaseJob.id);
    await src.jobs.complete({ id: recovered.id, workerId: 'recovery-worker', result: { recovered: true } });

    const restartJob = await src.jobs.enqueue({ kind: 'agent.restart', payload: {} });
    const restartLease = (await src.jobs.claim({ workerId: 'terminated-worker', limit: 1, leaseMs: 1 }))[0];
    assert.equal(restartLease.id, restartJob.id);
    await store.closeAsync();
    store = new PostgresStore({ dsn, schema, connectionOptions: { maxConnections: 16 } });
    src = new Source(dataRoot, { store });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterRestart = (await src.jobs.claim({ workerId: 'restarted-worker', limit: 1, leaseMs: 5_000 }))[0];
    assert.equal(afterRestart.id, restartJob.id);
    await src.jobs.complete({ id: afterRestart.id, workerId: 'restarted-worker', result: { restarted: true } });

    let handled = 0;
    let retryAttempts = 0;
    await Promise.all(Array.from({ length: 100 }, (_, i) => src.jobs.enqueue({ kind: 'agent.worker', payload: { index: i } })));
    await src.jobs.enqueue({ kind: 'agent.retry', payload: {} });
    const worker = new SourceWorker({
      queue: src.jobs,
      workerId: 'live-worker',
      concurrency: 8,
      pollMs: 2,
      leaseMs: 5_000,
      retryDelayMs: 5,
      handlers: {
        'agent.worker': async () => { handled += 1; },
        'agent.retry': async () => {
          retryAttempts += 1;
          if (retryAttempts === 1) throw new Error('transient');
          return { retried: true };
        },
      },
    });
    worker.start();
    const deadline = Date.now() + 5_000;
    while ((handled < 100 || retryAttempts < 2) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await worker.stop();
    assert.equal(handled, 100);
    assert.equal(retryAttempts, 2);

    server = await startServer(src, { port: 0, maxConnections: 2_000 });
    const url = `http://127.0.0.1:${server.address().port}/.well-known/source`;
    const responses = await Promise.all(Array.from({ length: 1_000 }, () => fetch(url)));
    assert.ok(responses.every((response) => response.status === 200));
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    await store?.closeAsync().catch(() => {});
    execFileSync('psql', ['-d', dsn, '-v', 'ON_ERROR_STOP=1', '-c', `DROP SCHEMA IF EXISTS "${schema}" CASCADE`], { stdio: 'ignore' });
  }
});
