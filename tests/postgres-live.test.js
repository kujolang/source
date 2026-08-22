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
  let peerStore;
  let server;
  try {
    store = new PostgresStore({ dsn, schema, connectionOptions: { maxConnections: 16 } });
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'source-pg-live-'));
    const gitRoot = mkdtempSync(path.join(tmpdir(), 'source-pg-git-'));
    src = new Source(dataRoot, { store, gitRoot });
    await store.writeJsonAsync('instance.json', { id: 'instance', name: 'postgres-live', apiVersion: '1' });
    const org = await src.createOrgAsync({ name: 'load-org', slug: 'load-org' });
    const project = await src.createProjectAsync({ orgId: org.id, name: 'load-project', slug: 'load-project' });
    const principal = await src.createPrincipalAsync({ type: 'agent', name: 'load-agent' });
    peerStore = new PostgresStore({ dsn, schema, connectionOptions: { maxConnections: 16 } });
    const peerSrc = new Source(dataRoot, { store: peerStore, gitRoot });
    assert.equal((await peerSrc.getProjectAsync(org.id, project.id)).id, project.id);
    const peerRepo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'shared-main' });
    assert.equal((await peerSrc.getRepositoryAsync(org.id, project.id, peerRepo.id)).barePath, peerRepo.barePath);
    const works = await Promise.all(Array.from({ length: 1_000 }, (_, i) => src.createWorkAsync({
      orgId: org.id,
      projectId: project.id,
      intent: `agent-${i}`,
      requester: principal.id,
    })));
    assert.equal(works.length, 1_000);
    assert.equal((await src.listWorkAsync(org.id, project.id, { limit: 1_001 })).length, 1_000);
    const firstWorkPage = await src.listWorkAsync(org.id, project.id, { limit: 100 });
    const secondWorkPage = await src.listWorkAsync(org.id, project.id, { cursor: firstWorkPage.at(-1).id, limit: 100 });
    assert.equal(firstWorkPage.length, 100);
    assert.equal(secondWorkPage.length, 100);
    assert.equal(new Set([...firstWorkPage, ...secondWorkPage].map((work) => work.id)).size, 200);

    const queued = await Promise.all(Array.from({ length: 100 }, (_, i) => src.jobs.enqueue({ kind: 'agent.batch', payload: { index: i } })));
    const claims = (await Promise.all(Array.from({ length: 8 }, (_, i) => src.jobs.claim({ workerId: `worker-${i}`, limit: 20 })))).flat();
    assert.equal(new Set(claims.map((job) => job.id)).size, queued.length);
  await Promise.all(claims.map((job) => src.jobs.complete({ id: job.id, workerId: job.workerId, leaseToken: job.leaseToken, result: { ok: true } })));
    const peerJob = await src.jobs.enqueue({ kind: 'agent.peer', payload: { node: 'primary' } });
    const peerClaim = (await peerSrc.jobs.claim({ workerId: 'peer-worker', limit: 1 }))[0];
    assert.equal(peerClaim.id, peerJob.id);
  await peerSrc.jobs.complete({ id: peerClaim.id, workerId: 'peer-worker', leaseToken: peerClaim.leaseToken, result: { node: 'peer' } });
    const leaseJob = await src.jobs.enqueue({ kind: 'agent.recover', payload: {} });
    const leased = (await src.jobs.claim({ workerId: 'crashed-worker', limit: 1, leaseMs: 1 }))[0];
    assert.equal(leased.id, leaseJob.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recovered = (await src.jobs.claim({ workerId: 'recovery-worker', limit: 1, leaseMs: 5_000 }))[0];
    assert.equal(recovered.id, leaseJob.id);
    await src.jobs.complete({ id: recovered.id, workerId: 'recovery-worker', leaseToken: recovered.leaseToken, result: { recovered: true } });

    const fencedJob = await src.jobs.enqueue({ kind: 'agent.fenced', payload: {}, orgId: org.id, projectId: project.id });
    const firstLease = (await src.jobs.claim({ workerId: 'fence-a', limit: 1, leaseMs: 1 }))[0];
    assert.equal(firstLease.id, fencedJob.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondLease = (await src.jobs.claim({ workerId: 'fence-b', limit: 1, leaseMs: 5_000 }))[0];
    assert.equal(secondLease.id, fencedJob.id);
    assert.equal(await src.jobs.complete({ id: fencedJob.id, workerId: 'fence-a', leaseToken: firstLease.leaseToken, result: { stale: true } }), false);
    assert.equal(await src.jobs.complete({ id: fencedJob.id, workerId: 'fence-b', leaseToken: secondLease.leaseToken, result: { stale: false } }), true);

    const cappedJob = await src.jobs.enqueue({ kind: 'agent.capped', payload: {}, orgId: org.id, projectId: project.id, maxAttempts: 1 });
    const cappedLease = (await src.jobs.claim({ workerId: 'cap-a', limit: 1, leaseMs: 1 }))[0];
    assert.equal(cappedLease.id, cappedJob.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const capReclaim = (await src.jobs.claim({ workerId: 'cap-b', limit: 1 }))[0];
    assert.notEqual(capReclaim?.id, cappedJob.id);
    if (capReclaim) await src.jobs.complete({ id: capReclaim.id, workerId: 'cap-b', leaseToken: capReclaim.leaseToken, result: { unrelated: true } });
    const cappedRows = await src.jobs.list({ orgId: org.id, projectId: project.id, limit: 100 });
    assert.equal(cappedRows.find((job) => job.id === cappedJob.id)?.status, 'failed');

    const restartJob = await src.jobs.enqueue({ kind: 'agent.restart', payload: {} });
    const restartLease = (await src.jobs.claim({ workerId: 'terminated-worker', limit: 1, leaseMs: 1 }))[0];
    assert.equal(restartLease.id, restartJob.id);
    await store.closeAsync();
    store = new PostgresStore({ dsn, schema, connectionOptions: { maxConnections: 16 } });
    src = new Source(dataRoot, { store, gitRoot });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterRestart = (await src.jobs.claim({ workerId: 'restarted-worker', limit: 1, leaseMs: 5_000 }))[0];
    assert.equal(afterRestart.id, restartJob.id);
  await src.jobs.complete({ id: afterRestart.id, workerId: 'restarted-worker', leaseToken: afterRestart.leaseToken, result: { restarted: true } });

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
    const jobCapability = await src.capabilities.issueAsync({
      principalId: principal.id,
      scope: { org: org.id, project: project.id },
      allowed: ['enqueue_job', 'read_jobs'],
    });
    const jobUrl = `http://127.0.0.1:${server.address().port}/api/v1/orgs/${org.id}/projects/${project.id}/jobs`;
    const enqueuedResponse = await fetch(jobUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jobCapability.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'agent.api', payload: { source: 'live-test' } }),
    });
    assert.equal(enqueuedResponse.status, 202);
    const listedResponse = await fetch(`${jobUrl}?limit=2`, { headers: { Authorization: `Bearer ${jobCapability.credential}` } });
    assert.equal(listedResponse.status, 200);
    assert.ok(Array.isArray((await listedResponse.json()).items));
    const workCapability = await src.capabilities.issueAsync({
      principalId: principal.id,
      scope: { org: org.id, project: project.id, work: 'W1' },
      allowed: ['enqueue_job', 'read_jobs'],
    });
    const scopedJob = await fetch(jobUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workCapability.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'agent.scoped', workId: 'W1', payload: {} }),
    });
    assert.equal(scopedJob.status, 202);
    const scopedJobs = await fetch(`${jobUrl}?work=W1`, { headers: { Authorization: `Bearer ${workCapability.credential}` } });
    assert.equal(scopedJobs.status, 200);
    const outOfScopeJobs = await fetch(`${jobUrl}?work=W2`, { headers: { Authorization: `Bearer ${workCapability.credential}` } });
    assert.equal(outOfScopeJobs.status, 403);
    const outOfScopeJob = await fetch(jobUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workCapability.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'agent.scoped', workId: 'W2', payload: {} }),
    });
    assert.equal(outOfScopeJob.status, 403);
    const url = `http://127.0.0.1:${server.address().port}/.well-known/source`;
    const responses = await Promise.all(Array.from({ length: 1_000 }, () => fetch(url)));
    assert.ok(responses.every((response) => response.status === 200));
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    await store?.closeAsync().catch(() => {});
    await peerStore?.closeAsync().catch(() => {});
    execFileSync('psql', ['-d', dsn, '-v', 'ON_ERROR_STOP=1', '-c', `DROP SCHEMA IF EXISTS "${schema}" CASCADE`], { stdio: 'ignore' });
  }
});
