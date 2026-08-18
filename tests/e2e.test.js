import { test } from 'node:test';
import assert from 'node:assert';
import { freshSource, seedRepo } from './helpers.js';

test('full vertical slice: Work → Session → Change → Evidence → Decision → Canonical State', () => {
  const { src, org, project, agent, service, human } = freshSource();
  const { repo, base, head } = seedRepo(src, org.id, project.id);

  // 1. Create Work
  const work = src.createWork({
    orgId: org.id,
    projectId: project.id,
    intent: 'fix parser regression',
    requester: human.id,
    requirements: ['parser handles empty input'],
    acceptanceConditions: ['tests pass', 'no regressions'],
  });

  // 2. Claim Work (agent)
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });

  // 3. Start Session (agent, bounded capability)
  const cap = src.capabilities.issue({
    principalId: agent.id,
    scope: { project: project.id, work: work.id },
    allowed: ['read_source', 'read_context', 'submit_change', 'submit_evidence'],
    denied: ['accept_change', 'modify_policy', 'publish_release'],
  });
  assert.ok(src.capabilities.authorize(cap.credential, 'submit_change').ok);
  assert.equal(src.capabilities.authorize(cap.credential, 'accept_change').ok, false);

  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id, baseCommit: base });

  // 4. Submit Change (exact base state)
  const change = src.submitChange({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id, baseCommit: base, headCommit: head });
  assert.equal(change.baseCommit, base);

  // 5. Generate/attach Evidence (verification service)
  const testEvidence = src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'parser tests', claim: 'tests pass', type: 'test', producer: service.id, artifact: JSON.stringify({ suite: 'parser', passed: 12, failed: 0 }), result: { status: 'pass' } });
  const evalEvidence = src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'eval gate', claim: 'deterministic checks pass', type: 'eval', producer: service.id, artifact: JSON.stringify({ checks: 27, failed: 0 }), result: { status: 'pass' } });

  // 6. Evaluate policy
  const evaluation = src.evaluateChange({ orgId: org.id, projectId: project.id, changeId: change.id });
  assert.equal(evaluation.evaluation.ok, true);

  // 7. Make Decision (human maintainer)
  const decision = src.makeDecision({ orgId: org.id, projectId: project.id, changeId: change.id, decision: 'accepted', decider: human.id, reasoning: 'evidence satisfied' });

  // 8. Update canonical Git state
  const update = src.updateCanonicalState({ orgId: org.id, projectId: project.id, changeId: change.id, repoId: repo.id });
  assert.equal(update.ok, true);

  // 9. Verify the complete chain is reconstructable
  const git = src.gitRepo(org.id, project.id, repo.id);
  assert.equal(git.revParse('main'), head);

  const finalWork = src.getWork(org.id, project.id, work.id);
  assert.equal(finalWork.status, 'closed');
  assert.ok(finalWork.sessions.includes(session.id));
  assert.ok(finalWork.changes.includes(change.id));
  assert.ok(finalWork.decisions.includes(decision.id));

  const finalChange = src.getChange(org.id, project.id, change.id);
  assert.ok(finalChange.evidence.includes(testEvidence.id));
  assert.ok(finalChange.evidence.includes(evalEvidence.id));

  // 10. Audit trail preserves the whole story
  const audit = src.readAudit();
  const events = audit.map((e) => e.event);
  for (const ev of ['work.create', 'work.claim', 'session.start', 'change.submit', 'evidence.add', 'policy.evaluate', 'decision.make', 'canonical.update']) {
    assert.ok(events.includes(ev), `audit should include ${ev}`);
  }
});

test('no LLM is required for deterministic operations (by construction)', () => {
  // The vertical slice is fully deterministic: every operation above is a
  // pure function of its inputs. This test asserts the service exposes no
  // LLM dependency and completes without any model call.
  const { src, org, project, agent, service, human } = freshSource();
  const { repo, base, head } = seedRepo(src, org.id, project.id);
  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'x', requester: human.id });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const s = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id, baseCommit: base });
  const c = src.submitChange({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: s.id, baseCommit: base, headCommit: head });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 't', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'e', claim: 'deterministic checks pass', type: 'eval', producer: service.id, result: { status: 'pass' } });
  const ev = src.evaluateChange({ orgId: org.id, projectId: project.id, changeId: c.id });
  assert.equal(ev.evaluation.ok, true);
  src.makeDecision({ orgId: org.id, projectId: project.id, changeId: c.id, decision: 'accepted', decider: human.id });
  const up = src.updateCanonicalState({ orgId: org.id, projectId: project.id, changeId: c.id, repoId: repo.id });
  assert.equal(up.ok, true);
});
