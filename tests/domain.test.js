import { test } from 'node:test';
import assert from 'node:assert';
import { freshSource } from './helpers.js';

test('project can contain a repository', () => {
  const { src, org, project } = freshSource();
  const repo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'main' });
  const p = src.getProject(org.id, project.id);
  assert.ok(p.repositories.includes(repo.id));
});

test('work can be created, claimed, and assigned', () => {
  const { src, org, project, agent } = freshSource();
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'fix parser regression', requester: 'U1' });
  assert.equal(w.status, 'open');
  const claimed = src.claimWork({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.assignee, agent.id);
});

test('a session can be started and completed', () => {
  const { src, org, project, agent } = freshSource();
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'implement API', requester: 'U1' });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id });
  const s = src.startSession({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id, baseCommit: 'abc' });
  assert.equal(s.workId, w.id);
  assert.equal(s.principal, agent.id);
  const done = src.completeSession({ orgId: org.id, projectId: project.id, sessionId: s.id, result: 'pass' });
  assert.equal(done.result, 'pass');
  assert.ok(done.endedAt);
});

test('workflow fan-out uses the batch queue seam when the store supports it', async () => {
  const { src, org, project } = freshSource();
  const workflow = await src.createWorkflowAsync({
    orgId: org.id,
    projectId: project.id,
    name: 'batch checks',
    triggers: ['push'],
    jobs: [
      { kind: 'agent.check.one', payload: {} },
      { kind: 'agent.check.two', payload: {} },
    ],
  });
  let calls = 0;
  src.store.enqueueJobsAsync = async ({ jobs }) => {
    calls += 1;
    return jobs.map((job, index) => ({ ...job, id: `J${index + 1}`, status: 'queued' }));
  };
  const dispatch = await src.dispatchWorkflowAsync({ orgId: org.id, projectId: project.id, workflowId: workflow.id, event: 'push', eventId: 'push-batch' });
  assert.equal(calls, 1);
  assert.equal(dispatch.workflows[0].jobs.length, 2);
});

test('workflow dispatch enforces a bounded fanout', async () => {
  const { src, org, project } = freshSource();
  const workflow = await src.createWorkflowAsync({
    orgId: org.id,
    projectId: project.id,
    name: 'bounded checks',
    triggers: ['push'],
    jobs: [{ kind: 'agent.check.one', payload: {} }, { kind: 'agent.check.two', payload: {} }],
  });
  await assert.rejects(
    src.dispatchWorkflowAsync({ orgId: org.id, projectId: project.id, workflowId: workflow.id, event: 'push', maxWorkflowJobs: 1 }),
    /fanout exceeds configured limit/,
  );
});

test('workflow dependencies are validated as an acyclic graph', async () => {
  const { src, org, project } = freshSource();
  await assert.rejects(src.createWorkflowAsync({
    orgId: org.id,
    projectId: project.id,
    name: 'cyclic checks',
    triggers: ['push'],
    jobs: [
      { kind: 'agent.check.one', payload: { jobId: 'one', needs: ['two'] } },
      { kind: 'agent.check.two', payload: { jobId: 'two', needs: ['one'] } },
    ],
  }), /cycle/);
});

test('workflow dependency identifiers remain bounded and unique', async () => {
  const { src, org, project } = freshSource();
  await assert.rejects(src.createWorkflowAsync({
    orgId: org.id,
    projectId: project.id,
    name: 'invalid checks',
    triggers: ['push'],
    jobs: [
      { kind: 'agent.check.one', payload: { jobId: 'same' } },
      { kind: 'agent.check.two', payload: { jobId: 'same' } },
    ],
  }), /unique/);
  await assert.rejects(src.createWorkflowAsync({
    orgId: org.id,
    projectId: project.id,
    name: 'oversized checks',
    triggers: ['push'],
    jobs: [{ kind: 'agent.check.one', payload: { jobId: 'x'.repeat(121) } }],
  }), /safe event names/);
});

test('change fan-out and evidence relationships are bounded', () => {
  const { src, org, project, agent } = freshSource();
  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'bounded change', requester: agent.id });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  assert.throws(() => src.submitChange({
    orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id,
    repositories: Array.from({ length: 1_001 }, (_, index) => `R${index}`),
  }), /repository limit/);
  const change = src.submitChange({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id });
  change.evidence = Array.from({ length: 1_000 }, (_, index) => `E${index}`);
  src.store.writeJson(`${src._projectRel(org.id, project.id)}/changes/${change.id}.json`, change);
  assert.throws(() => src.addEvidence({
    orgId: org.id, projectId: project.id, changeId: change.id, subject: 'bounded', claim: 'bounded', type: 'test', producer: agent.id,
  }), /evidence limit/);
  change.decisions = Array.from({ length: 1_000 }, (_, index) => `D${index}`);
  src.store.writeJson(`${src._projectRel(org.id, project.id)}/changes/${change.id}.json`, change);
  assert.throws(() => src.makeDecision({
    orgId: org.id, projectId: project.id, changeId: change.id, decision: 'rejected', decider: agent.id,
  }), /decision limit/);
});

test('a change can be submitted and is tied to an exact base state', () => {
  const { src, org, project, agent } = freshSource();
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'change', requester: 'U1' });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id });
  const s = src.startSession({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id, baseCommit: 'base123' });
  const c = src.submitChange({ orgId: org.id, projectId: project.id, workId: w.id, sessionId: s.id, baseCommit: 'base123', headCommit: 'head456' });
  assert.equal(c.baseCommit, 'base123');
  assert.equal(c.headCommit, 'head456');
  assert.equal(c.workId, w.id);
  assert.equal(c.sessionId, s.id);
  const work = src.getWork(org.id, project.id, w.id);
  assert.equal(work.status, 'submitted');
  assert.ok(work.changes.includes(c.id));
});

test('invalid work transitions are rejected', () => {
  const { src, org, project } = freshSource();
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'x', requester: 'U1' });
  // open -> in_progress is invalid (must claim first)
  assert.throws(() => src.startSession({ orgId: org.id, projectId: project.id, workId: w.id, principalId: 'U1' }), /invalid work transition/);
});
