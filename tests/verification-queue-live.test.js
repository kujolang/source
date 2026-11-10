import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/postgres-store.js';
import { JobQueue } from '../src/job-queue.js';

const dsn = process.env.SOURCE_TEST_DATABASE_URL;

test('evidence transactions fence cancelled, expired and reclaimed job leases', { skip: !dsn }, async (t) => {
  const schema = `source_evidence_lease_${process.pid}_${Date.now()}`;
  const store = new PostgresStore({ dsn, schema });
  const peer = new PostgresStore({ dsn, schema });
  t.after(async () => { await peer.closeAsync(); await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.closeAsync(); });
  const scope = { orgId: 'org', projectId: 'project' };
  const queue = new JobQueue(store);
  await queue.enqueue({ ...scope, kind: 'integration.verify', payload: { identity: 'exact' } });
  const [lease] = await queue.claim({ workerId: 'owner' });
  const owner = { ...scope, id: lease.id, workerId: lease.workerId, leaseToken: lease.leaseToken };
  await assert.rejects(() => store.lockJobLeaseAsync(owner), /requires a transaction/);
  await store.transactionAsync(async () => {
    assert.equal((await store.lockJobLeaseAsync(owner)).payload.identity, 'exact');
    await assert.rejects(() => store.lockJobLeaseAsync({ ...owner, projectId: 'other' }), /expired, cancelled, or superseded/);
    await assert.rejects(() => peer.transactionAsync(async () => {
      await peer._runAsync("SET LOCAL lock_timeout = '100ms'");
      await peer.cancelJobAsync({ ...scope, id: lease.id });
    }), (error) => error.code === '55P03', 'cancellation cannot interleave with a fenced evidence write');
  });
  await peer.cancelJobAsync({ ...scope, id: lease.id });
  await assert.rejects(() => store.transactionAsync(async () => {
    await store.writeJsonAsync('evidence/cancelled.json', { invalid: true });
    await store.lockJobLeaseAsync(owner);
  }), /expired, cancelled, or superseded/);
  assert.equal(await store.readJsonAsync('evidence/cancelled.json'), null);

  await queue.enqueue({ ...scope, kind: 'integration.verify' });
  const [expired] = await queue.claim({ workerId: 'old' });
  const stale = { ...scope, id: expired.id, workerId: expired.workerId, leaseToken: expired.leaseToken };
  await store.pool.query(`UPDATE "${schema}".jobs SET leased_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [expired.id]);
  await assert.rejects(() => store.transactionAsync(() => store.lockJobLeaseAsync(stale)), /expired/);
  const [renewed] = await peer.claimJobsAsync({ workerId: 'new' });
  await assert.rejects(() => store.transactionAsync(() => store.lockJobLeaseAsync(stale)), /superseded/);
  const current = { ...scope, id: renewed.id, workerId: renewed.workerId, leaseToken: renewed.leaseToken };
  await assert.rejects(() => store.transactionAsync(async () => {
    await store.lockJobLeaseAsync(current);
    await store.writeJsonAsync('evidence/expired-during-write.json', { invalid: true });
    await store._runAsync(`UPDATE "${schema}".jobs SET leased_until = clock_timestamp() - INTERVAL '1 second' WHERE id = '${renewed.id}'`);
    await store.lockJobLeaseAsync(current);
  }), /expired/);
  assert.equal(await peer.readJsonAsync('evidence/expired-during-write.json'), null);
  await store.transactionAsync(async () => {
    await store.lockJobLeaseAsync(current);
    await store.writeJsonAsync('evidence/current.json', { valid: true });
  });
  assert.deepEqual(await peer.readJsonAsync('evidence/current.json'), { valid: true });
});

test('Postgres priority, dependency, cancellation and expired leases remain fenced across stores', { skip: !dsn }, async (t) => {
  const schema = `source_verify_queue_${process.pid}_${Date.now()}`;
  const store = new PostgresStore({ dsn, schema });
  const peer = new PostgresStore({ dsn, schema });
  t.after(async () => { await peer.closeAsync(); await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.closeAsync(); });
  const queue = new JobQueue(store);
  const scope = { orgId: 'org', projectId: 'project' };
  await assert.rejects(() => queue.enqueue({ kind: 'check', priority: 101 }), /priority/);
  const [low, high, dependent] = await queue.enqueueBatch({ jobs: [
    { ...scope, kind: 'low', priority: -10, dedupeKey: 'low' },
    { ...scope, kind: 'high', priority: 50, dedupeKey: 'high' },
    { ...scope, kind: 'dependent', priority: 100, dedupeKey: 'dependent', dependsOn: ['low'] },
  ] });
  const [first] = await peer.claimJobsAsync({ workerId: 'peer', limit: 1 });
  assert.equal(first.id, high.id);
  assert.equal(first.priority, 50);
  assert.equal(await peer.completeJobAsync({ id: first.id, workerId: first.workerId, leaseToken: first.leaseToken }), true);
  const [second] = await queue.claim({ workerId: 'owner', limit: 1 });
  assert.equal(second.id, low.id, 'priority must not bypass prerequisite completion');
  assert.equal(await queue.cancel({ ...scope, projectId: 'other', id: low.id }), null);
  const cancelled = await queue.cancel({ ...scope, id: low.id, reason: 'superseded candidate' });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await queue.cancel({ ...scope, id: low.id, reason: 'duplicate' }), cancelled);
  assert.equal(await peer.completeJobAsync({ id: low.id, workerId: second.workerId, leaseToken: second.leaseToken }), false);
  assert.equal(await peer.extendJobAsync({ id: low.id, workerId: second.workerId, leaseToken: second.leaseToken }), null);
  assert.equal(await peer.failJobAsync({ id: low.id, workerId: second.workerId, leaseToken: second.leaseToken, error: 'stale error' }), null);
  assert.deepEqual(await queue.claim({ workerId: 'next' }), []);
  assert.equal((await queue.list(scope)).find((job) => job.id === dependent.id).status, 'failed');
  assert.equal(await queue.count(scope), 0);
  assert.equal(await queue.cancel({ ...scope, id: high.id }), null, 'completed work cannot be cancelled');

  const expiring = await queue.enqueue({ ...scope, kind: 'expired', dedupeKey: 'expired' });
  const [old] = await queue.claim({ workerId: 'old', leaseMs: 30000 });
  await store.pool.query(`UPDATE "${schema}".jobs SET leased_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [expiring.id]);
  assert.equal(await queue.complete({ id: old.id, workerId: old.workerId, leaseToken: old.leaseToken }), false);
  assert.equal(await queue.extend({ id: old.id, workerId: old.workerId, leaseToken: old.leaseToken }), null);
  const [reclaimed] = await peer.claimJobsAsync({ workerId: 'new' });
  assert.equal(reclaimed.id, old.id);
  assert.notEqual(reclaimed.leaseToken, old.leaseToken);
  assert.equal(await queue.complete({ id: old.id, workerId: old.workerId, leaseToken: old.leaseToken }), false);
  assert.equal(await peer.completeJobAsync({ id: reclaimed.id, workerId: reclaimed.workerId, leaseToken: reclaimed.leaseToken }), true);
  for (let round = 0; round < 10; round++) {
    const queued = await queue.enqueue({ ...scope, kind: 'race' });
    const [lease] = await queue.claim({ workerId: 'racing' });
    assert.equal(lease.id, queued.id);
    const [completion, cancellation] = await Promise.all([
      queue.complete({ id: lease.id, workerId: lease.workerId, leaseToken: lease.leaseToken }),
      peer.cancelJobAsync({ ...scope, id: lease.id }),
    ]);
    assert.equal(completion, cancellation === null, 'exactly one terminal transition wins');
    const saved = (await queue.list(scope)).find((job) => job.id === lease.id);
    assert.equal(saved.status, completion ? 'completed' : 'cancelled');
  }
});

test('existing queue schema migrates cancellation without losing queued jobs', { skip: !dsn }, async (t) => {
  const schema = `source_queue_upgrade_${process.pid}_${Date.now()}`;
  const original = new PostgresStore({ dsn, schema });
  let upgraded;
  t.after(async () => { await upgraded?.closeAsync(); await original.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await original.closeAsync(); });
  const queued = await original.enqueueJobAsync({ kind: 'before', orgId: 'org', projectId: 'project' });
  await original.pool.query(`ALTER TABLE "${schema}".jobs DROP CONSTRAINT jobs_status_check;
    ALTER TABLE "${schema}".jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('queued','leased','completed','failed'));
    ALTER TABLE "${schema}".jobs DROP COLUMN priority, DROP COLUMN cancel_reason, DROP COLUMN cancelled_at;`);
  upgraded = new PostgresStore({ dsn, schema });
  const [job] = await upgraded.claimJobsAsync({ workerId: 'after' });
  assert.equal(job.id, queued.id);
  assert.equal(job.priority, 0);
  assert.equal((await upgraded.cancelJobAsync({ id: job.id, orgId: 'org', projectId: 'project' })).status, 'cancelled');
});

test('HTTP cancellation requires explicit project authority and preserves scoped audit', { skip: !dsn }, async (t) => {
  const { Source } = await import('../src/source.js');
  const { startServer } = await import('../src/api.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'source-cancel-http-'));
  const schema = `source_cancel_http_${process.pid}_${Date.now()}`;
  const store = new PostgresStore({ dsn, schema });
  const src = new Source(root, { store });
  let server;
  t.after(async () => { server?.closeAllConnections?.(); await new Promise((resolve) => server ? server.close(resolve) : resolve()); await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.closeAsync(); await rm(root, { recursive: true, force: true }); });
  const org = await src.createOrgAsync({ name: 'cancel', slug: 'cancel' });
  const project = await src.createProjectAsync({ orgId: org.id, name: 'cancel', slug: 'cancel' });
  const principal = await src.createPrincipalAsync({ type: 'service', name: 'operator' });
  const scope = { orgId: org.id, projectId: project.id };
  const queued = await src.jobs.enqueue({ ...scope, kind: 'check' });
  server = await startServer(src, { port: 0 });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/orgs/${org.id}/projects/${project.id}/jobs/${queued.id}/cancel`;
  const token = async (allowed, extra = {}) => src.capabilities.issueAsync({ principalId: principal.id, allowed, scope: { org: org.id, project: project.id, ...extra } });
  const send = async (cap) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${cap.credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'superseded' }) });
  assert.equal((await send(await token(['enqueue_job']))).status, 403);
  assert.equal((await send(await token(['cancel_job'], { work: 'W1' }))).status, 403);
  const response = await send(await token(['cancel_job']));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).status, 'cancelled');
  const audit = src.readAudit();
  assert.ok(audit.some((event) => event.event === 'job.cancel' && event.jobId === queued.id && event.principalId === principal.id));
});
