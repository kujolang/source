import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
  let peerServer;
  try {
    store = new PostgresStore({ dsn, schema, connectionOptions: { maxConnections: 32, maxDbQueue: 4_096 } });
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'source-pg-live-'));
    const gitRoot = mkdtempSync(path.join(tmpdir(), 'source-pg-git-'));
    src = new Source(dataRoot, { store, gitRoot });
    await store.writeJsonAsync('instance.json', { id: 'instance', name: 'postgres-live', apiVersion: '1' });
    const org = await src.createOrgAsync({ name: 'load-org', slug: 'load-org' });
    const project = await src.createProjectAsync({ orgId: org.id, name: 'load-project', slug: 'load-project' });
    const quotaProject = await src.createProjectAsync({ orgId: org.id, name: 'quota-project', slug: 'quota-project' });
    const principal = await src.createPrincipalAsync({ type: 'agent', name: 'load-agent' });
    peerStore = new PostgresStore({ dsn, schema, connectionOptions: { maxConnections: 32, maxDbQueue: 4_096 } });
    const peerSrc = new Source(dataRoot, { store: peerStore, gitRoot });
    assert.equal((await peerSrc.getProjectAsync(org.id, project.id)).id, project.id);
    const peerRepo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'shared-main' });
    assert.equal((await peerSrc.getRepositoryAsync(org.id, project.id, peerRepo.id)).barePath, peerRepo.barePath);
    const workflowClone = mkdtempSync(path.join(tmpdir(), 'source-workflow-'));
    execFileSync('git', ['clone', peerRepo.barePath, workflowClone], { stdio: 'ignore' });
    mkdirSync(path.join(workflowClone, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(workflowClone, '.github', 'workflows', 'checks.yml'), 'name: checks\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: kujo check\n');
    execFileSync('git', ['-C', workflowClone, 'config', 'user.email', 'source@test.invalid']);
    execFileSync('git', ['-C', workflowClone, 'config', 'user.name', 'Source Test']);
    execFileSync('git', ['-C', workflowClone, 'add', '.github/workflows/checks.yml']);
    execFileSync('git', ['-C', workflowClone, 'commit', '-m', 'add workflow'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workflowClone, 'push', 'origin', 'HEAD:main'], { stdio: 'ignore' });
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
    const batch = await src.jobs.enqueueBatch({
      jobs: [
        { kind: 'agent.batch.bulk', payload: { index: 1 }, orgId: org.id, projectId: project.id, dedupeKey: 'batch-event-1' },
        { kind: 'agent.batch.bulk', payload: { index: 2 }, orgId: org.id, projectId: project.id, dedupeKey: 'batch-event-2' },
        { kind: 'agent.batch.bulk', payload: { index: 3 }, orgId: org.id, projectId: project.id, dedupeKey: 'batch-event-1' },
      ],
      maxQueueDepth: 100,
    });
    assert.equal(batch.length, 3);
    assert.equal(batch.filter((job) => job.status === 'queued').length, 2);
    assert.equal(batch[2].id, batch[0].id);
    const batchClaims = await src.jobs.claim({ workerId: 'batch-worker', limit: 10 });
    await Promise.all(batchClaims.map((job) => src.jobs.complete({ id: job.id, workerId: 'batch-worker', leaseToken: job.leaseToken, result: { ok: true } })));
    const quotaResults = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => src.jobs.enqueue({
      kind: 'agent.quota', payload: { index: i }, orgId: org.id, projectId: quotaProject.id, maxQueueDepth: 1,
    })));
    assert.equal(quotaResults.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(quotaResults.filter((result) => result.reason?.message === 'job queue depth exceeded').length, 19);
    const quotaJob = (await src.jobs.claim({ workerId: 'quota-worker', limit: 1 }))[0];
    assert.equal(quotaJob.id, quotaResults.find((result) => result.status === 'fulfilled').value.id);
    await src.jobs.complete({ id: quotaJob.id, workerId: 'quota-worker', leaseToken: quotaJob.leaseToken, result: { ok: true } });
    const recycledQuotaJob = await src.jobs.enqueue({
      kind: 'agent.quota.recycled', payload: { recycled: true }, orgId: org.id, projectId: quotaProject.id, maxQueueDepth: 1,
    });
    assert.equal(recycledQuotaJob.status, 'queued');
    const recycledClaim = (await src.jobs.claim({ workerId: 'quota-worker-2', limit: 1 }))[0];
    await src.jobs.complete({ id: recycledClaim.id, workerId: 'quota-worker-2', leaseToken: recycledClaim.leaseToken, result: { ok: true } });
    const workflow = await src.createWorkflowAsync({
      orgId: org.id,
      projectId: project.id,
      name: 'push checks',
      triggers: ['push'],
      jobs: [{ kind: 'agent.workflow.check', payload: { command: 'kujo check' } }],
    });
    const dispatches = await Promise.all(Array.from({ length: 20 }, () => src.dispatchWorkflowAsync({
      orgId: org.id, projectId: project.id, workflowId: workflow.id, event: 'push', eventId: 'push-1', payload: { ref: 'main' },
    })));
    const dispatchedJobs = dispatches.map((dispatch) => dispatch.workflows[0].jobs[0]);
    assert.equal(new Set(dispatchedJobs.map((job) => job.id)).size, 1);
    assert.equal(dispatchedJobs.filter((job) => job.status === 'queued').length, 1);
    assert.equal(dispatchedJobs.filter((job) => job.status === 'deduplicated').length, 19);
    const workflowJob = (await src.jobs.claim({ workerId: 'workflow-worker', limit: 1 }))[0];
    assert.equal(workflowJob.id, dispatchedJobs[0].id);
    await src.jobs.complete({ id: workflowJob.id, workerId: 'workflow-worker', leaseToken: workflowJob.leaseToken, result: { ok: true } });
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
    store = new PostgresStore({ dsn, schema, connectionOptions: { maxConnections: 32, maxDbQueue: 4_096 } });
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

    server = await startServer(src, { port: 0, maxConnections: 2_000, webhookSecret: 'live-webhook-secret' });
    const jobCapability = await src.capabilities.issueAsync({
      principalId: principal.id,
      scope: { org: org.id, project: project.id },
      allowed: ['enqueue_job', 'read_jobs', 'manage_workflows', 'read_workflows', 'dispatch_workflow'],
    });
    const jobUrl = `http://127.0.0.1:${server.address().port}/api/v1/orgs/${org.id}/projects/${project.id}/jobs`;
    const enqueuedResponse = await fetch(jobUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jobCapability.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'agent.api', payload: { source: 'live-test' } }),
    });
    assert.equal(enqueuedResponse.status, 202, await enqueuedResponse.clone().text());
    const listedResponse = await fetch(`${jobUrl}?limit=2`, { headers: { Authorization: `Bearer ${jobCapability.credential}` } });
    assert.equal(listedResponse.status, 200);
    assert.ok(Array.isArray((await listedResponse.json()).items));
    const workflowUrl = `http://127.0.0.1:${server.address().port}/api/v1/orgs/${org.id}/projects/${project.id}/workflows`;
    const importedWorkflowResponse = await fetch(`${workflowUrl}/import-github`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jobCapability.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository: peerRepo.id, path: '.github/workflows/checks.yml', ref: 'main' }),
    });
    assert.equal(importedWorkflowResponse.status, 201);
    assert.equal((await importedWorkflowResponse.json()).source.provider, 'github-actions');
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
    const workflowResponse = await fetch(workflowUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jobCapability.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'api checks', triggers: ['api.push'], jobs: [{ kind: 'agent.api-check', payload: { check: 'smoke' } }] }),
    });
    assert.equal(workflowResponse.status, 201);
    const apiWorkflow = await workflowResponse.json();
    const dispatchResponse = await fetch(`${workflowUrl}/${apiWorkflow.id}/dispatch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jobCapability.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'api.push', eventId: 'api-push-1', payload: { ref: 'main' } }),
    });
    assert.equal(dispatchResponse.status, 202, await dispatchResponse.clone().text());
    const apiDispatch = await dispatchResponse.json();
    const apiJob = apiDispatch.workflows[0].jobs[0];
    const webhookUrl = `${workflowUrl}/${apiWorkflow.id}/webhook`;
    const webhookBody = JSON.stringify({ event: 'api.push', payload: { ref: 'main' } });
    const signature = `sha256=${createHmac('sha256', 'live-webhook-secret').update(webhookBody).digest('hex')}`;
    const invalidWebhook = await fetch(webhookUrl, { method: 'POST', headers: { 'X-GitHub-Event': 'api.push', 'X-GitHub-Delivery': 'github-1', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64), 'Content-Type': 'application/json' }, body: webhookBody });
    assert.equal(invalidWebhook.status, 401);
    const webhookResponse = await fetch(webhookUrl, { method: 'POST', headers: { 'X-GitHub-Event': 'api.push', 'X-GitHub-Delivery': 'github-1', 'X-Hub-Signature-256': signature, 'Content-Type': 'application/json' }, body: webhookBody });
    assert.equal(webhookResponse.status, 202);
    const webhookDispatch = await webhookResponse.json();
    const replayResponse = await fetch(webhookUrl, { method: 'POST', headers: { 'X-GitHub-Event': 'api.push', 'X-GitHub-Delivery': 'github-1', 'X-Hub-Signature-256': signature, 'Content-Type': 'application/json' }, body: webhookBody });
    assert.equal(replayResponse.status, 202);
    const replayDispatch = await replayResponse.json();
    assert.equal(replayDispatch.workflows[0].jobs[0].id, webhookDispatch.workflows[0].jobs[0].id);
    assert.equal(replayDispatch.workflows[0].jobs[0].status, 'deduplicated');
    const claimedApiJobs = await src.jobs.claim({ workerId: 'api-workflow-worker', limit: 3 });
    const claimedApiJob = claimedApiJobs.find((job) => job.id === apiJob.id);
    assert.ok(claimedApiJob);
    const claimedWebhookJobs = await src.jobs.claim({ workerId: 'webhook-worker', limit: 10 });
    assert.ok(claimedWebhookJobs.some((job) => job.id === webhookDispatch.workflows[0].jobs[0].id));
    await Promise.all([...claimedApiJobs, ...claimedWebhookJobs].map((job) => src.jobs.complete({ id: job.id, workerId: job.workerId, leaseToken: job.leaseToken, result: { ok: true } })));
    const url = `http://127.0.0.1:${server.address().port}/.well-known/source`;
    const responses = await Promise.all(Array.from({ length: 1_000 }, () => fetch(url)));
    assert.ok(responses.every((response) => response.status === 200));

    peerServer = await startServer(peerSrc, { port: 0, maxConnections: 2_000 });
    const peerUrl = `http://127.0.0.1:${peerServer.address().port}/.well-known/source`;
    assert.equal((await fetch(peerUrl)).status, 200);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
    assert.equal((await fetch(peerUrl)).status, 200);
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (peerServer) {
      peerServer.closeAllConnections?.();
      await new Promise((resolve) => peerServer.close(() => resolve()));
    }
    await store?.closeAsync().catch(() => {});
    await peerStore?.closeAsync().catch(() => {});
    execFileSync('psql', ['-d', dsn, '-v', 'ON_ERROR_STOP=1', '-c', `DROP SCHEMA IF EXISTS "${schema}" CASCADE`], { stdio: 'ignore' });
  }
});
