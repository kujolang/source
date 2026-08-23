// Source — storage backend tests.
//
// Proves the SQLite store satisfies the same interface as the JSON store,
// provides ACID transactions (the JSON store's documented gap), and that the
// full vertical slice runs identically on both backends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Source } from '../src/source.js';
import { Store } from '../src/store.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { PostgresStore } from '../src/postgres-store.js';
import { seedRepo } from './helpers.js';

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'source-store-'));
}

const PG_DSN = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;

function newUniqueSchema() {
  return `source_test_${Date.now()}_${Math.random().toString(16).slice(2)}`.replace(/\W/g, '');
}

function buildRelationshipFixture(src) {
  src.initInstance({ name: 'test' });
  const org = src.createOrg({ name: 'o', slug: 'o' });
  const project = src.createProject({ orgId: org.id, slug: 'p', name: 'P' });
  const human = src.createPrincipal({ type: 'human', name: 'h' });
  const agent = src.createPrincipal({ type: 'agent', name: 'a' });
  const service = src.createPrincipal({ type: 'service', name: 's' });
  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'x', requester: human.id });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const change = src.submitChange({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id, baseCommit: 'base', headCommit: 'head' });
  const evidence1 = src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 't', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } });
  const evidence2 = src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'e', claim: 'deterministic checks pass', type: 'eval', producer: service.id, result: { status: 'pass' } });
  const decision = src.makeDecision({ orgId: org.id, projectId: project.id, changeId: change.id, decision: 'accepted', decider: human.id, reasoning: 'ok' });
  const graph = src.queryWorkGraph(org.id, project.id, work.id);
  const serviceActivity = src.queryPrincipalActivity(org.id, project.id, service.id);
  const humanActivity = src.queryPrincipalActivity(org.id, project.id, human.id);
  return {
    org,
    project,
    human,
    agent,
    service,
    work,
    session,
    change,
    evidence1,
    evidence2,
    decision,
    graph,
    activity: serviceActivity,
    serviceActivity,
    humanActivity,
  };
}

function lifecycleSummary(store) {
  const src = new Source(tmp(), { store });
  src.initInstance({ name: 'test' });
  const org = src.createOrg({ name: 'o', slug: 'o' });
  const project = src.createProject({ orgId: org.id, slug: 'p', name: 'P' });
  const human = src.createPrincipal({ type: 'human', name: 'h' });
  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'x', requester: human.id });
  return {
    projectId: project.id,
    ownerOrg: project.ownerOrg,
    workId: work.id,
    orgId: org.id,
    intent: work.intent,
    status: work.status,
    policy: src.getPolicy(org.id, project.id),
  };
}

// --- transaction semantics ------------------------------------------------

test('SqliteStore transaction commits atomically', () => {
  const store = new SqliteStore(tmp());
  store.transaction(() => {
    store.writeJson('a.json', { v: 1 });
    store.writeJson('b.json', { v: 2 });
  });
  assert.equal(store.readJson('a.json').v, 1);
  assert.equal(store.readJson('b.json').v, 2);
});

test('SqliteStore transaction rolls back all writes on failure', () => {
  const store = new SqliteStore(tmp());
  store.writeJson('pre.json', { v: 0 });
  assert.throws(() => {
    store.transaction(() => {
      store.writeJson('a.json', { v: 1 });
      store.writeJson('b.json', { v: 2 });
      throw new Error('boom');
    });
  });
  assert.equal(store.readJson('pre.json').v, 0); // pre-existing survives
  assert.equal(store.readJson('a.json'), null); // rolled back
  assert.equal(store.readJson('b.json'), null); // rolled back
});

test('SqliteStore nested transactions are re-entrant', () => {
  const store = new SqliteStore(tmp());
  store.transaction(() => {
    store.writeJson('a.json', { v: 1 });
    store.transaction(() => {
      store.writeJson('b.json', { v: 2 });
    });
  });
  assert.equal(store.readJson('a.json').v, 1);
  assert.equal(store.readJson('b.json').v, 2);
});

test('JSON store transaction is a no-op wrapper (documented limitation)', () => {
  const store = new Store(tmp());
  store.writeJson('a.json', { v: 1 });
  assert.throws(() => {
    store.transaction(() => {
      store.writeJson('b.json', { v: 2 });
      throw new Error('boom');
    });
  });
  // The JSON store does not roll back: b.json was already written.
  assert.equal(store.readJson('b.json').v, 2);
});

test('JSON store async contract avoids synchronous file I/O and serializes counters', async () => {
  const store = new Store(tmp());
  const originalRead = store.readJson;
  const originalWrite = store.writeJson;
  store.readJson = () => { throw new Error('sync read used'); };
  store.writeJson = () => { throw new Error('sync write used'); };
  await Promise.all(Array.from({ length: 100 }, () => store.nextIdAsync('work', 'W')));
  await store.writeJsonAsync('records/W1.json', { id: 'W1' });
  assert.deepEqual(await store.readJsonAsync('records/W1.json'), { id: 'W1' });
  assert.equal((await store.listJsonAsync('records')).length, 1);
  store.readJson = originalRead;
  store.writeJson = originalWrite;
  assert.equal((await store.getMetaAsync('counter:work')), 100);
});

// --- interface contract ----------------------------------------------------

test('SqliteStore listJson returns direct children only', () => {
  const store = new SqliteStore(tmp());
  store.writeJson('orgs/O1/projects/P1/work/W1.json', { id: 'W1' });
  store.writeJson('orgs/O1/projects/P1/work/W2.json', { id: 'W2' });
  store.writeJson('orgs/O1/projects/P1/work/W3.json', { id: 'W3' });
  store.writeJson('orgs/O1/projects/P1/changes/C1.json', { id: 'C1' });
  assert.deepEqual(store.listJson('orgs/O1/projects/P1/work'), ['W1', 'W2', 'W3']);
  assert.deepEqual(store.listJson('orgs/O1/projects/P1/changes'), ['C1']);
  assert.deepEqual(store.listJson('orgs/O1/projects/P1/nonexistent'), []);
});

test('SqliteStore artifacts round-trip content-addressed bytes', () => {
  const store = new SqliteStore(tmp());
  const bytes = Buffer.from('artifact-bytes', 'utf8');
  const { hash } = store.putArtifact(bytes);
  const got = store.getArtifact(hash);
  assert.ok(Buffer.isBuffer(got));
  assert.equal(got.toString('utf8'), 'artifact-bytes');
  // Re-putting identical bytes yields the same hash (dedup).
  const again = store.putArtifact(Buffer.from('artifact-bytes', 'utf8'));
  assert.equal(again.hash, hash);
  assert.equal(store.getArtifact('deadbeef'), null);
});

// --- full vertical slice on SQLite -----------------------------------------

test('full vertical slice runs on SqliteStore', () => {
  const dir = tmp();
  const src = new Source(dir, { store: new SqliteStore(dir) });
  src.initInstance({ name: 'test' });
  const org = src.createOrg({ name: 'o', slug: 'o' });
  const project = src.createProject({ orgId: org.id, slug: 'p', name: 'P' });
  const human = src.createPrincipal({ type: 'human', name: 'h' });
  const agent = src.createPrincipal({ type: 'agent', name: 'a' });
  const service = src.createPrincipal({ type: 'service', name: 's' });
  const { repo, base, head } = seedRepo(src, org.id, project.id);

  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'x', requester: human.id });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id, baseCommit: base });
  const change = src.submitChange({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id, baseCommit: base, headCommit: head });

  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 't', claim: 'tests pass', type: 'test', producer: service.id, artifact: 'artifact-bytes', result: { status: 'pass' } });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'e', claim: 'deterministic checks pass', type: 'eval', producer: service.id, result: { status: 'pass' } });

  const ev = src.evaluateChange({ orgId: org.id, projectId: project.id, changeId: change.id });
  assert.equal(ev.evaluation.ok, true);

  const decision = src.makeDecision({ orgId: org.id, projectId: project.id, changeId: change.id, decision: 'accepted', decider: human.id });
  const up = src.updateCanonicalState({ orgId: org.id, projectId: project.id, changeId: change.id, repoId: repo.id });
  assert.equal(up.ok, true);

  // Chain + artifact round-trip.
  const finalWork = src.getWork(org.id, project.id, work.id);
  assert.equal(finalWork.status, 'closed');
  assert.ok(finalWork.sessions.includes(session.id));
  assert.ok(finalWork.changes.includes(change.id));
  assert.ok(finalWork.decisions.includes(decision.id));

  const evidence = src.listEvidence(org.id, project.id);
  assert.equal(evidence.length, 2);
  const withArtifact = evidence.find((e) => e.artifactRef);
  const bytes = src.getArtifact(withArtifact.artifactRef.hash);
  assert.equal(bytes.toString('utf8'), 'artifact-bytes');

  const audit = src.readAudit();
  assert.ok(audit.some((e) => e.event === 'decision.make'));
  assert.ok(audit.some((e) => e.event === 'canonical.update'));
});

// --- cross-backend equivalence ---------------------------------------------

test('JSON and SQLite stores produce equivalent lifecycle results', () => {
  const run = (store) => {
    const dir = tmp();
    const src = new Source(dir, { store });
    src.initInstance({ name: 'test' });
    const org = src.createOrg({ name: 'o', slug: 'o' });
    const project = src.createProject({ orgId: org.id, slug: 'p', name: 'P' });
    const human = src.createPrincipal({ type: 'human', name: 'h' });
    const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'x', requester: human.id });
    return {
      project: src.getProject(org.id, project.id),
      work: src.getWork(org.id, project.id, work.id),
      policy: src.getPolicy(org.id, project.id),
    };
  };

  const jsonResult = run(new Store(tmp()));
  const sqliteResult = run(new SqliteStore(tmp()));

  // Stable fields (ignore timestamps) must match across backends.
  assert.equal(jsonResult.project.id, sqliteResult.project.id);
  assert.equal(jsonResult.project.slug, sqliteResult.project.slug);
  assert.equal(jsonResult.project.ownerOrg, sqliteResult.project.ownerOrg);
  assert.equal(jsonResult.work.id, sqliteResult.work.id);
  assert.equal(jsonResult.work.intent, sqliteResult.work.intent);
  assert.equal(jsonResult.work.status, sqliteResult.work.status);
  assert.deepEqual(jsonResult.policy, sqliteResult.policy);
});

if (PG_DSN) {
  test('JSON, SQLite, and Postgres stores produce equivalent lifecycle results', () => {
    const json = lifecycleSummary(new Store(tmp()));
    const sqlite = lifecycleSummary(new SqliteStore(tmp()));
    const pg = lifecycleSummary(new PostgresStore({ dsn: PG_DSN, schema: newUniqueSchema() }));

    assert.equal(json.ownerOrg, sqlite.ownerOrg);
    assert.equal(json.ownerOrg, pg.ownerOrg);
    assert.equal(json.intent, sqlite.intent);
    assert.equal(json.intent, pg.intent);
    assert.equal(json.status, sqlite.status);
    assert.equal(json.status, pg.status);
    assert.deepEqual(json.policy, sqlite.policy);
    assert.deepEqual(json.policy, pg.policy);
  });
}

test('JSON and SQLite query relationship APIs behave consistently', () => {
  const jsonSource = new Source(tmp());
  const jsonResult = buildRelationshipFixture(jsonSource);
  const jsonGraph = jsonResult.graph;

  const sqliteSource = new Source(tmp(), { store: new SqliteStore(tmp()) });
  const sqliteResult = buildRelationshipFixture(sqliteSource);
  const sqliteGraph = sqliteResult.graph;

  assert.equal(jsonGraph.workId, sqliteGraph.workId);
  assert.equal(jsonGraph.changes.length, 1);
  assert.equal(sqliteGraph.changes.length, 1);
  assert.equal(jsonGraph.changes[0].decisions.length, 1);
  assert.equal(sqliteGraph.changes[0].decisions.length, 1);
  assert.equal(jsonResult.serviceActivity.evidence.length, 2);
  assert.equal(sqliteResult.serviceActivity.evidence.length, 2);
  assert.equal(jsonResult.humanActivity.decisions.length, 1);
  assert.equal(sqliteResult.humanActivity.decisions.length, 1);
});

if (PG_DSN) {
  test('Postgres store supports relationship queries', () => {
    const store = new PostgresStore({ dsn: PG_DSN, schema: newUniqueSchema() });
    const src = new Source(tmp(), { store });
    const fixture = buildRelationshipFixture(src);
    const graph = fixture.graph;
    const { serviceActivity, humanActivity } = fixture;

    assert.ok(graph);
    assert.equal(graph.workId, fixture.work.id);
    assert.equal(graph.changes.length, 1);
    assert.equal(graph.changes[0].evidence.length, 2);
    assert.equal(graph.changes[0].decisions[0].decision.decision, 'accepted');
    assert.equal(serviceActivity.evidence.length, 2);
    assert.equal(humanActivity.decisions.length, 1);
    assert.equal(humanActivity.decisions[0].id, fixture.decision.id);
  });

  test('Postgres migration from JSON preserves relational data', () => {
    const schema = newUniqueSchema();
    const legacy = new Source(tmp());
    const legacyResult = buildRelationshipFixture(legacy);
    const pg = new PostgresStore({ dsn: PG_DSN, schema });
    const counts = pg.migrateFromStore(legacy.store);
    const migrated = new Source(legacy.dir, { store: pg });
    const graph = migrated.queryWorkGraph(legacyResult.org.id, legacyResult.project.id, legacyResult.work.id);
    const serviceActivity = migrated.queryPrincipalActivity(legacyResult.org.id, legacyResult.project.id, legacyResult.service.id);
    const humanActivity = migrated.queryPrincipalActivity(legacyResult.org.id, legacyResult.project.id, legacyResult.human.id);

    assert.equal(counts.orgs, 1);
    assert.equal(counts.works, 1);
    assert.equal(counts.projects, 1);
    assert.equal(graph.work.id, legacyResult.work.id);
    assert.equal(graph.changes[0].id, legacyResult.change.id);
    assert.equal(serviceActivity.evidence.length, 2);
    assert.equal(humanActivity.decisions.length, 1);
  });
}
