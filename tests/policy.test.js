import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { freshSource } from './helpers.js';

function setupChange(src, org, project, agent) {
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'fix', requester: 'U1' });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id });
  const s = src.startSession({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id, baseCommit: 'base' });
  const c = src.submitChange({ orgId: org.id, projectId: project.id, workId: w.id, sessionId: s.id, baseCommit: 'base', headCommit: 'head' });
  return { w, s, c };
}

test('policy determines required evidence; missing evidence is visible', () => {
  const { src, org, project, agent } = freshSource();
  const { c } = setupChange(src, org, project, agent);
  const r = src.evaluateChange({ orgId: org.id, projectId: project.id, changeId: c.id });
  assert.equal(r.evaluation.ok, false);
  assert.ok(r.evaluation.missing.length >= 2); // test + eval required by default
  assert.ok(r.interpretation.some((l) => l.includes('Missing evidence')));
});

test('satisfied evidence is visible after adding it', () => {
  const { src, org, project, agent, service } = freshSource();
  const { c } = setupChange(src, org, project, agent);
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'tests', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'eval', claim: 'deterministic checks pass', type: 'eval', producer: service.id, result: { status: 'pass' } });
  const r = src.evaluateChange({ orgId: org.id, projectId: project.id, changeId: c.id });
  assert.equal(r.evaluation.ok, true);
  assert.equal(r.evaluation.missing.length, 0);
  assert.ok(r.interpretation.some((l) => l.includes('Ready for review')));
});

test('evidence retains its underlying artifact and integrity', () => {
  const { src, org, project, agent, service } = freshSource();
  const { c } = setupChange(src, org, project, agent);
  const artifact = JSON.stringify({ checks: 27, failed: 0, detail: 'full tool output' });
  const e = src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'eval', claim: 'deterministic checks pass', type: 'eval', producer: service.id, artifact, result: { status: 'pass' } });
  assert.ok(e.artifactRef);
  assert.ok(e.integrity);
  const stored = src.getArtifact(e.artifactRef.hash).toString('utf8');
  assert.equal(stored, artifact);
  assert.ok(stored.includes('full tool output'));
});

test('evidence artifacts are bounded before durable storage', () => {
  const { src, org, project, service } = freshSource();
  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'artifact bound', requester: 'U1' });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: service.id });
  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: service.id, baseCommit: 'base' });
  const change = src.submitChange({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id, baseCommit: 'base', headCommit: 'head' });
  const bounded = new src.constructor(src.dataRoot, { store: src.store, gitRoot: src.gitRoot, maxArtifactBytes: 4 });
  assert.throws(() => bounded.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'test', claim: 'bounded', type: 'eval', producer: service.id, artifact: '12345' }), /artifact exceeds 4 byte limit/);
});

test('tampered artifact is detected (integrity hash mismatch)', () => {
  const { src, org, project, agent, service } = freshSource();
  const { c } = setupChange(src, org, project, agent);
  const e = src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'eval', claim: 'deterministic checks pass', type: 'eval', producer: service.id, artifact: 'original', result: { status: 'pass' } });
  const wrong = src.getArtifact('0'.repeat(64));
  assert.equal(wrong, null);
  const expected = createHash('sha256').update('original').digest('hex');
  assert.equal(e.integrity, expected);
});
