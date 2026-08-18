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

test('a request without a credential is refused (401)', async () => {
  const { src, project } = freshSource();
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/projects/${project.id}`);
    assert.equal(res.status, 401);
  });
});

test('an unknown credential is refused (401)', async () => {
  const { src, project } = freshSource();
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/projects/${project.id}`, { headers: auth('does-not-exist') });
    assert.equal(res.status, 401);
  });
});

test('an action outside the allowed set is refused (403)', async () => {
  const { src, project, agent } = freshSource();
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { project: project.id }, allowed: ['read_source'] });
  await withServer(src, async (base) => {
    // read_context is not in the allowed set.
    const res = await fetch(`${base}/api/v1/projects/${project.id}/work`, { headers: auth(cap.credential) });
    assert.equal(res.status, 403);
  });
});

test('a denied action is refused even if allowed (403)', async () => {
  const { src, project, agent } = freshSource();
  const cap = src.capabilities.issue({
    principalId: agent.id,
    scope: { project: project.id },
    allowed: ['accept_change'],
    denied: ['accept_change'],
  });
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/projects/${project.id}/changes/C1/decision`, { method: 'POST', headers: auth(cap.credential), body: JSON.stringify({}) });
    assert.equal(res.status, 403);
  });
});

test('an expired capability is refused (401)', async () => {
  const { src, project, agent } = freshSource();
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { project: project.id }, allowed: ['read_source'], ttlMs: -1000 });
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/projects/${project.id}`, { headers: auth(cap.credential) });
    assert.equal(res.status, 401);
  });
});

test('a revoked capability is refused (401)', async () => {
  const { src, project, agent } = freshSource();
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { project: project.id }, allowed: ['read_source'] });
  src.capabilities.revoke(cap.id);
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/projects/${project.id}`, { headers: auth(cap.credential) });
    assert.equal(res.status, 401);
  });
});

test('a project-scoped capability cannot read another project (403)', async () => {
  const { src, org, project, agent } = freshSource();
  const other = src.createProject({ orgId: org.id, slug: 'other', name: 'Other' });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { project: project.id }, allowed: ['read_source'] });
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/projects/${other.id}`, { headers: auth(cap.credential) });
    assert.equal(res.status, 403);
  });
});

test('a work-scoped capability cannot read another work item (403)', async () => {
  const { src, org, project, agent } = freshSource();
  const w1 = src.createWork({ orgId: org.id, projectId: project.id, intent: 'one', requester: 'U1' });
  const w2 = src.createWork({ orgId: org.id, projectId: project.id, intent: 'two', requester: 'U1' });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { project: project.id, work: w1.id }, allowed: ['read_context'] });
  await withServer(src, async (base) => {
    const ok = await fetch(`${base}/api/v1/projects/${project.id}/work/${w1.id}`, { headers: auth(cap.credential) });
    assert.equal(ok.status, 200);
    const denied = await fetch(`${base}/api/v1/projects/${project.id}/work/${w2.id}`, { headers: auth(cap.credential) });
    assert.equal(denied.status, 403);
  });
});

test('a session-scoped capability can submit but cannot accept (denied)', async () => {
  const { src, org, project, agent, human } = freshSource();
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'bounded agent work', requester: 'U1' });

  // Operator issues a bootstrap capability to claim + start a session.
  const bootstrap = src.capabilities.issue({
    principalId: agent.id,
    scope: { project: project.id },
    allowed: ['claim_work', 'start_session'],
  });

  await withServer(src, async (base) => {
    await fetch(`${base}/api/v1/projects/${project.id}/work/${w.id}/claim`, { method: 'POST', headers: auth(bootstrap.credential), body: JSON.stringify({ principalId: agent.id }) });
    const session = await (await fetch(`${base}/api/v1/projects/${project.id}/work/${w.id}/sessions`, { method: 'POST', headers: auth(bootstrap.credential), body: JSON.stringify({ principalId: agent.id, baseCommit: 'base' }) })).json();
    const sessionCap = session.capability.credential;

    // The session capability can submit a change.
    const change = await (await fetch(`${base}/api/v1/projects/${project.id}/work/${w.id}/changes`, { method: 'POST', headers: auth(sessionCap), body: JSON.stringify({ sessionId: session.id, baseCommit: 'base', headCommit: 'head' }) })).json();
    assert.ok(change.id);

    // But it cannot accept the change (denied).
    const denied = await fetch(`${base}/api/v1/projects/${project.id}/changes/${change.id}/decision`, { method: 'POST', headers: auth(sessionCap), body: JSON.stringify({ decision: 'accepted', decider: agent.id }) });
    assert.equal(denied.status, 403);

    // A human maintainer with accept_change can.
    const humanCap = src.capabilities.issue({ principalId: human.id, scope: { project: project.id }, allowed: ['accept_change'] });
    const ok = await fetch(`${base}/api/v1/projects/${project.id}/changes/${change.id}/decision`, { method: 'POST', headers: auth(humanCap.credential), body: JSON.stringify({ decision: 'rejected', decider: human.id, reasoning: 'not ready' }) });
    assert.equal(ok.status, 201);
  });
});

test('the contribution submit endpoint remains public (low-friction onboarding)', async () => {
  const { src, org, project } = freshSource();
  const repo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'main' });
  await withServer(src, async (base) => {
    // No credential: the submit endpoint is the anonymous contribution path.
    const res = await fetch(`${base}/api/v1/projects/${project.id}/submit`, { method: 'POST', body: JSON.stringify({ repoRef: repo.name, baseCommit: 'a', headCommit: 'b' }) });
    // base/head commits are not present, so it fails with 400 — but not 401/403.
    assert.equal(res.status, 400);
  });
});
