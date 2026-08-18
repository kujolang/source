import { test } from 'node:test';
import assert from 'node:assert';
import { freshSource } from './helpers.js';
import { startServer } from '../src/api.js';

async function withServer(src, fn) {
  const server = await startServer(src, { port: 0 });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('discovery endpoint returns a compact machine manifest', async () => {
  const { src } = freshSource();
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/.well-known/source`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.api_version, '1');
    assert.ok(body.endpoints.work);
    assert.ok(body.endpoints.git);
    assert.ok(Array.isArray(body.capabilities));
  });
});

test('an agent can complete the workflow without HTML', async () => {
  const { src, org, project, agent, service, human } = freshSource();
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'fix parser regression', requester: 'U1' });

  await withServer(src, async (base) => {
    // discover project
    const p = await (await fetch(`${base}/api/v1/projects/${project.id}`)).json();
    assert.equal(p.id, project.id);

    // list work
    const workList = await (await fetch(`${base}/api/v1/projects/${project.id}/work`)).json();
    assert.ok(workList.some((x) => x.id === w.id));

    // claim work
    const claim = await (await fetch(`${base}/api/v1/projects/${project.id}/work/${w.id}/claim`, { method: 'POST', body: JSON.stringify({ principalId: agent.id }) })).json();
    assert.equal(claim.status, 'claimed');

    // start session
    const session = await (await fetch(`${base}/api/v1/projects/${project.id}/work/${w.id}/sessions`, { method: 'POST', body: JSON.stringify({ principalId: agent.id, baseCommit: 'base' }) })).json();
    assert.ok(session.id);

    // retrieve scoped context
    const ctx = await (await fetch(`${base}/api/v1/projects/${project.id}/work/${w.id}/context`)).json();
    assert.equal(ctx.intent, 'fix parser regression');
    assert.ok(ctx.policy);

    // submit change
    const change = await (await fetch(`${base}/api/v1/projects/${project.id}/work/${w.id}/changes`, { method: 'POST', body: JSON.stringify({ sessionId: session.id, baseCommit: 'base', headCommit: 'head' }) })).json();
    assert.equal(change.baseCommit, 'base');

    // submit evidence
    const ev = await (await fetch(`${base}/api/v1/projects/${project.id}/changes/${change.id}/evidence`, { method: 'POST', body: JSON.stringify({ subject: 'tests', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } }) })).json();
    assert.ok(ev.id);

    // evaluate
    const evalRes = await (await fetch(`${base}/api/v1/projects/${project.id}/changes/${change.id}/evaluate`, { method: 'POST' })).json();
    assert.ok(evalRes.interpretation);

    // decision
    const decision = await (await fetch(`${base}/api/v1/projects/${project.id}/changes/${change.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'rejected', decider: human.id, reasoning: 'needs work' }) })).json();
    assert.equal(decision.decision, 'rejected');
  });
});

test('field selection reduces response size (token efficiency)', async () => {
  const { src, org, project } = freshSource();
  src.createWork({ orgId: org.id, projectId: project.id, intent: 'a fairly long intent string to measure', requester: 'U1', requirements: ['r1', 'r2', 'r3'], acceptanceConditions: ['a1', 'a2'] });

  await withServer(src, async (base) => {
    const full = await (await fetch(`${base}/api/v1/projects/${project.id}/work`)).text();
    const slim = await (await fetch(`${base}/api/v1/projects/${project.id}/work?fields=id,status,intent`)).text();
    assert.ok(slim.length < full.length, `slim (${slim.length}) should be smaller than full (${full.length})`);
  });
});
