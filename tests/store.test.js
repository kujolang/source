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
import { seedRepo } from './helpers.js';

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'source-store-'));
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
