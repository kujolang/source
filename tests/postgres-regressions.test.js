import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/postgres-store.js';

const dsn = process.env.SOURCE_TEST_DATABASE_URL;

test('Postgres artifacts preserve empty and binary bytes through sync and async reads', { skip: !dsn }, async (t) => {
  const schema = `source_artifacts_${process.pid}_${Date.now()}`;
  const store = new PostgresStore({ dsn, schema });
  t.after(async () => { await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.closeAsync(); });
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 10, 13, 128]), Buffer.alloc(2048, 42)]) {
    const { hash } = await store.putArtifactAsync(bytes);
    assert.deepEqual(await store.getArtifactAsync(hash), bytes);
    assert.deepEqual(store.getArtifact(hash), bytes);
  }
  assert.equal(await store.getArtifactAsync('0'.repeat(64)), null);
});

test('Postgres JSON preserves backslashes, quotes, newlines and Unicode', { skip: !dsn }, async (t) => {
  const schema = `source_strings_${process.pid}_${Date.now()}`;
  const store = new PostgresStore({ dsn, schema });
  t.after(async () => { await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.closeAsync(); });
  const value = { id: 'roundtrip', text: "one\ntwo\\three'four ☃", nested: ['\\', '\t', '"'] };
  await store.writeJsonAsync('checks/async.json', value);
  assert.deepEqual(await store.readJsonAsync('checks/async.json'), value);
  store.writeJson('checks/sync.json', value);
  assert.deepEqual(store.readJson('checks/sync.json'), value);
});

test('Postgres retention preserves dependencies needed by queued jobs', { skip: !dsn }, async (t) => {
  const schema = `source_retention_${process.pid}_${Date.now()}`;
  const store = new PostgresStore({ dsn, schema, connectionOptions: { jobRetentionMs: 60000 } });
  t.after(async () => { await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.closeAsync(); });
  const parent = await store.enqueueJobAsync({ kind: 'parent', dedupeKey: 'parent-key' });
  const [lease] = await store.claimJobsAsync({ workerId: 'retention' });
  await store.completeJobAsync({ id: parent.id, workerId: 'retention', leaseToken: lease.leaseToken });
  const child = await store.enqueueJobAsync({ kind: 'child', dependsOn: ['parent-key'] });
  await store.pool.query(`UPDATE "${schema}".jobs SET updated_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`, [parent.id]);
  await store.pruneJobsAsync();
  const children = await store.claimJobsAsync({ workerId: 'child-worker' });
  assert.equal(children.length, 1);
  assert.equal(children[0].id, child.id);
  await store.completeJobAsync({ id: child.id, workerId: 'child-worker', leaseToken: children[0].leaseToken });
  await store.pruneJobsAsync();
  const remaining = await store.pool.query(`SELECT id FROM "${schema}".jobs WHERE id = $1`, [parent.id]);
  assert.equal(remaining.rowCount, 0);
});


test('independent Postgres Source instances retain concurrent evidence relationships', { skip: !dsn }, async (t) => {
  const { Source } = await import('../src/source.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const schema = `source_evidence_${process.pid}_${Date.now()}`;
  const root = mkdtempSync(`${tmpdir()}/source-evidence-`);
  const stores = [new PostgresStore({ dsn, schema }), new PostgresStore({ dsn, schema })];
  t.after(async () => { await stores[0].pool.query(`DROP SCHEMA "${schema}" CASCADE`); await Promise.all(stores.map(s => s.closeAsync())); rmSync(root, { recursive: true, force: true }); });
  const sources = stores.map(store => new Source(root, { store }));
  const src = sources[0];
  const org = await src.createOrgAsync({ name: 'concurrency', slug: 'concurrency' });
  const project = await src.createProjectAsync({ orgId: org.id, name: 'project', slug: 'project' });
  const agent = await src.createPrincipalAsync({ type: 'agent', name: 'agent' });
  const work = await src.createWorkAsync({ orgId: org.id, projectId: project.id, requester: agent.id, intent: 'review' });
  await src.claimWorkAsync({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const session = await src.startSessionAsync({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const change = await src.submitChangeAsync({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id });
  const evidence = await Promise.all(Array.from({ length: 20 }, (_, i) => sources[i % 2].addEvidenceAsync({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'checks', claim: `check-${i}`, type: 'test', producer: agent.id })));
  const updated = await src.getChangeAsync(org.id, project.id, change.id);
  assert.deepEqual(new Set(updated.evidence), new Set(evidence.map(e => e.id)));
});
