import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freshSource, seedRepo } from './helpers.js';

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fullChange(src, org, project, agent, service) {
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'fix parser regression', requester: 'U1' });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id });
  const s = src.startSession({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id, baseCommit: 'base' });
  const c = src.submitChange({ orgId: org.id, projectId: project.id, workId: w.id, sessionId: s.id, baseCommit: 'base', headCommit: 'head' });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'tests', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'eval', claim: 'deterministic checks pass', type: 'eval', producer: service.id, result: { status: 'pass' } });
  return { w, s, c };
}

test('a decision can be recorded and is tied to evidence/source state', () => {
  const { src, org, project, agent, service, human } = freshSource();
  const { c } = fullChange(src, org, project, agent, service);
  const d = src.makeDecision({ orgId: org.id, projectId: project.id, changeId: c.id, decision: 'accepted', decider: human.id, reasoning: 'looks good' });
  assert.equal(d.decision, 'accepted');
  assert.equal(d.sourceState, c.headCommit);
  assert.ok(d.evidenceSnapshot.length >= 2);
  const change = src.getChange(org.id, project.id, c.id);
  assert.equal(change.decisionState, 'accepted');
});

test('an agent (non-human) cannot accept a change', () => {
  const { src, org, project, agent, service } = freshSource();
  const { c } = fullChange(src, org, project, agent, service);
  assert.throws(
    () => src.makeDecision({ orgId: org.id, projectId: project.id, changeId: c.id, decision: 'accepted', decider: agent.id }),
    /may not accept/,
  );
});

test('acceptance is refused when evidence is missing', () => {
  const { src, org, project, agent, human } = freshSource();
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'x', requester: 'U1' });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id });
  const s = src.startSession({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id });
  const c = src.submitChange({ orgId: org.id, projectId: project.id, workId: w.id, sessionId: s.id, baseCommit: 'b', headCommit: 'h' });
  assert.throws(
    () => src.makeDecision({ orgId: org.id, projectId: project.id, changeId: c.id, decision: 'accepted', decider: human.id }),
    /missing evidence/,
  );
});

test('accepted work updates canonical git state safely (fast-forward)', () => {
  const { src, org, project, agent, service, human } = freshSource();
  const { repo, base, head } = seedRepo(src, org.id, project.id);
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'change README', requester: 'U1' });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id });
  const s = src.startSession({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id, baseCommit: base });
  const c = src.submitChange({ orgId: org.id, projectId: project.id, workId: w.id, sessionId: s.id, baseCommit: base, headCommit: head });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'tests', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'eval', claim: 'deterministic checks pass', type: 'eval', producer: service.id, result: { status: 'pass' } });
  src.makeDecision({ orgId: org.id, projectId: project.id, changeId: c.id, decision: 'accepted', decider: human.id });
  const result = src.updateCanonicalState({ orgId: org.id, projectId: project.id, changeId: c.id, repoId: repo.id });
  assert.equal(result.ok, true);
  const git = src.gitRepo(org.id, project.id, repo.id);
  assert.equal(git.revParse('main'), head);
  const work = src.getWork(org.id, project.id, w.id);
  assert.equal(work.status, 'closed');
});

test('TOCTOU: non-fast-forward update is refused', () => {
  const { src, org, project, agent, service, human } = freshSource();
  const { repo, base, head, work } = seedRepo(src, org.id, project.id);
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'change', requester: 'U1' });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id });
  const s = src.startSession({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id, baseCommit: base });
  const c = src.submitChange({ orgId: org.id, projectId: project.id, workId: w.id, sessionId: s.id, baseCommit: base, headCommit: head });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'tests', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'eval', claim: 'deterministic checks pass', type: 'eval', producer: service.id, result: { status: 'pass' } });
  src.makeDecision({ orgId: org.id, projectId: project.id, changeId: c.id, decision: 'accepted', decider: human.id });

  // Simulate a concurrent push: advance main past the Change's head commit.
  writeFileSync(path.join(work, 'CONCURRENT.md'), 'concurrent\n');
  run(['add', '.'], work);
  run(['commit', '-m', 'concurrent'], work);
  run(['push', 'origin', 'main'], work);

  // The Change's head no longer descends from the current tip, so the update
  // must be refused rather than silently merged.
  const result = src.updateCanonicalState({ orgId: org.id, projectId: project.id, changeId: c.id, repoId: repo.id });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('descend') || result.reason.includes('non-fast-forward'));
});

test('concurrent canonical updates are serialized per project', async () => {
  const { src, org, project, agent, service, human } = freshSource();
  const { c } = fullChange(src, org, project, agent, service);
  src.makeDecision({ orgId: org.id, projectId: project.id, changeId: c.id, decision: 'accepted', decider: human.id });
  const acceptedChange = src.getChange(org.id, project.id, c.id);
  acceptedChange.repositoryChanges = Array.from({ length: 20 }, (_, index) => ({ repoId: `R${index + 1}`, baseCommit: 'base', headCommit: 'head' }));
  src.store.writeJson(`${src._projectRel(org.id, project.id)}/changes/${c.id}.json`, acceptedChange);
  let active = 0;
  let maximum = 0;
  src.gitRepo = () => ({
    async hasCommitAsync() { return true; },
    async defaultBranchAsync() { return 'main'; },
    async fastForwardAsync() {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { ok: true, reason: 'fast-forwarded' };
    },
  });
  const results = await Promise.all([
    src.updateCanonicalStateAsync({ orgId: org.id, projectId: project.id, changeId: c.id }),
    src.updateCanonicalStateAsync({ orgId: org.id, projectId: project.id, changeId: c.id }),
  ]);
  assert.ok(maximum > 1);
  assert.ok(maximum <= src.canonicalRepoConcurrency);
  assert.ok(results.every((result) => result.ok));
});
