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

function auth(credential) {
  return { Authorization: `Bearer ${credential}` };
}

test('discovery endpoint returns a compact machine manifest', async () => {
  const { src } = freshSource();
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/.well-known/source`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.api_version, '1');
    assert.ok(body.endpoints.orgs);
    assert.ok(body.endpoints.work);
    assert.ok(body.endpoints.git);
    assert.ok(Array.isArray(body.capabilities));
    assert.ok(body.capabilities.includes('manage_org'));
    assert.equal(body.auth.type, 'capability');
  });
});

test('database admission exhaustion returns retryable service backpressure', async () => {
  const { src, org, project, agent } = freshSource();
  const capability = src.capabilities.issue({
    principalId: agent.id,
    scope: { org: org.id, project: project.id },
    allowed: ['read_source'],
  });
  src.getProjectAsync = async () => {
    const error = new Error('Postgres query admission queue exhausted');
    error.code = 'DB_ADMISSION_EXHAUSTED';
    throw error;
  };
  await withServer(src, async (base) => {
    const response = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}`, { headers: auth(capability.credential) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json(), { error: 'database admission capacity exhausted', retryable: true });
  });
});

test('an agent can complete the workflow without HTML (capability-gated)', async () => {
  const { src, org, project, agent, service, human } = freshSource();
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'fix parser regression', requester: 'U1' });

  // Bootstrap capability for the agent (operator-issued, org+project-scoped).
  const agentCap = src.capabilities.issue({
    principalId: agent.id,
    scope: { org: org.id, project: project.id },
    allowed: ['read_source', 'read_context', 'claim_work', 'start_session', 'submit_change', 'submit_evidence'],
  });
  // Maintainer capability for the decision.
  const humanCap = src.capabilities.issue({
    principalId: human.id,
    scope: { org: org.id, project: project.id },
    allowed: ['accept_change'],
  });

  await withServer(src, async (base) => {
    // discover project
    const p = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}`, { headers: auth(agentCap.credential) })).json();
    assert.equal(p.id, project.id);

    // list work
    const workList = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work`, { headers: auth(agentCap.credential) })).json();
    assert.ok(workList.some((x) => x.id === w.id));

    // claim work
    const claim = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${w.id}/claim`, { method: 'POST', headers: auth(agentCap.credential), body: JSON.stringify({ principalId: human.id }) })).json();
    assert.equal(claim.status, 'claimed');
    assert.equal(claim.assignee, agent.id);

    // start session (returns a session-scoped capability)
    const session = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${w.id}/sessions`, { method: 'POST', headers: auth(agentCap.credential), body: JSON.stringify({ principalId: agent.id, baseCommit: 'base' }) })).json();
    assert.ok(session.id);
    assert.ok(session.capability.credential, 'session returns a scoped capability');

    // retrieve scoped context
    const ctx = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${w.id}/context`, { headers: auth(agentCap.credential) })).json();
    assert.equal(ctx.intent, 'fix parser regression');
    assert.ok(ctx.policy);

    // submit change
    const change = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${w.id}/changes`, { method: 'POST', headers: auth(agentCap.credential), body: JSON.stringify({ sessionId: session.id, baseCommit: 'base', headCommit: 'head' }) })).json();
    assert.equal(change.baseCommit, 'base');

    // submit evidence
    const ev = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/changes/${change.id}/evidence`, { method: 'POST', headers: auth(agentCap.credential), body: JSON.stringify({ subject: 'tests', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } }) })).json();
    assert.ok(ev.id);

    // evaluate
    const evalRes = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/changes/${change.id}/evaluate`, { method: 'POST', headers: auth(agentCap.credential) })).json();
    assert.ok(evalRes.interpretation);

    // decision (requires accept_change — the human maintainer's capability)
    const decision = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/changes/${change.id}/decision`, { method: 'POST', headers: auth(humanCap.credential), body: JSON.stringify({ decision: 'rejected', decider: human.id, reasoning: 'needs work' }) })).json();
    assert.equal(decision.decision, 'rejected');
  });
});

test('field selection reduces response size (token efficiency)', async () => {
  const { src, org, project, agent } = freshSource();
  src.createWork({ orgId: org.id, projectId: project.id, intent: 'a fairly long intent string to measure', requester: 'U1', requirements: ['r1', 'r2', 'r3'], acceptanceConditions: ['a1', 'a2'] });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: project.id }, allowed: ['read_context'] });

  await withServer(src, async (base) => {
    const full = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work`, { headers: auth(cap.credential) })).text();
    const slim = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work?fields=id,status,intent`, { headers: auth(cap.credential) })).text();
    assert.ok(slim.length < full.length, `slim (${slim.length}) should be smaller than full (${full.length})`);
  });
});

test('org listing supports cursor+limit pagination', async () => {
  const { src, org, project, agent } = freshSource();
  const otherOrg = src.createOrg({ name: 'other', slug: 'other' });
  const thirdOrg = src.createOrg({ name: 'third', slug: 'third' });
  src.createWork({ orgId: org.id, projectId: project.id, intent: 'first', requester: 'U1' });
  src.createWork({ orgId: org.id, projectId: project.id, intent: 'second', requester: 'U1' });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: {}, allowed: ['manage_org', 'read_source', 'read_context'] });

  await withServer(src, async (base) => {
    const first = await (await fetch(`${base}/api/v1/orgs?limit=2`, { headers: auth(cap.credential) })).json();
    assert.ok(first.nextCursor);
    assert.equal(first.items.length, 2);

    const second = await (await fetch(`${base}/api/v1/orgs?limit=2&cursor=${first.nextCursor}`, { headers: auth(cap.credential) })).json();
    assert.ok(Array.isArray(second.items));
    assert.equal(second.items.length, 1);
  });
});

test('work listing supports cursor+limit pagination', async () => {
  const { src, org, project, agent, human } = freshSource();
  src.createWork({ orgId: org.id, projectId: project.id, intent: 'a', requester: human.id });
  src.createWork({ orgId: org.id, projectId: project.id, intent: 'b', requester: human.id });
  src.createWork({ orgId: org.id, projectId: project.id, intent: 'c', requester: human.id });
  const cap = src.capabilities.issue({
    principalId: agent.id,
    scope: { org: org.id, project: project.id },
    allowed: ['read_context'],
  });

  await withServer(src, async (base) => {
    const first = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work?limit=2`, { headers: auth(cap.credential) })).json();
    assert.ok(first.nextCursor);
    assert.equal(first.items.length, 2);

    const second = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work?limit=2&cursor=${first.nextCursor}`, { headers: auth(cap.credential) })).json();
    assert.ok(Array.isArray(second.items));
    assert.equal(second.items.length, 1);
  });
});
