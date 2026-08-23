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

function parseCookieHeader(headers) {
  const cookie = headers.get('set-cookie');
  if (!cookie) return null;
  return cookie.split(';')[0];
}

function auth(credential) {
  return { Authorization: `Bearer ${credential}` };
}

test('a request without a credential is refused (401)', async () => {
  const { src, org, project } = freshSource();
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}`);
    assert.equal(res.status, 401);
  });
});

test('an unknown credential is refused (401)', async () => {
  const { src, org, project } = freshSource();
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}`, { headers: auth('does-not-exist') });
    assert.equal(res.status, 401);
  });
});

test('an action outside the allowed set is refused (403)', async () => {
  const { src, org, project, agent } = freshSource();
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: project.id }, allowed: ['read_source'] });
  await withServer(src, async (base) => {
    // read_context is not in the allowed set.
    const res = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work`, { headers: auth(cap.credential) });
    assert.equal(res.status, 403);
  });
});

test('a denied action is refused even if allowed (403)', async () => {
  const { src, org, project, agent } = freshSource();
  const cap = src.capabilities.issue({
    principalId: agent.id,
    scope: { org: org.id, project: project.id },
    allowed: ['accept_change'],
    denied: ['accept_change'],
  });
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/changes/C1/decision`, { method: 'POST', headers: auth(cap.credential), body: JSON.stringify({}) });
    assert.equal(res.status, 403);
  });
});

test('an expired capability is refused (401)', async () => {
  const { src, org, project, agent } = freshSource();
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: project.id }, allowed: ['read_source'], ttlMs: -1000 });
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}`, { headers: auth(cap.credential) });
    assert.equal(res.status, 401);
  });
});

test('a revoked capability is refused (401)', async () => {
  const { src, org, project, agent } = freshSource();
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: project.id }, allowed: ['read_source'] });
  src.capabilities.revoke(cap.id);
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}`, { headers: auth(cap.credential) });
    assert.equal(res.status, 401);
  });
});

test('a project-scoped capability cannot read another project (403)', async () => {
  const { src, org, project, agent } = freshSource();
  const other = src.createProject({ orgId: org.id, slug: 'other', name: 'Other' });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: project.id }, allowed: ['read_source'] });
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${other.id}`, { headers: auth(cap.credential) });
    assert.equal(res.status, 403);
  });
});

test('a work-scoped capability cannot read another work item (403)', async () => {
  const { src, org, project, agent } = freshSource();
  const w1 = src.createWork({ orgId: org.id, projectId: project.id, intent: 'one', requester: 'U1' });
  const w2 = src.createWork({ orgId: org.id, projectId: project.id, intent: 'two', requester: 'U1' });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: project.id, work: w1.id }, allowed: ['read_context'] });
  await withServer(src, async (base) => {
    const ok = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${w1.id}`, { headers: auth(cap.credential) });
    assert.equal(ok.status, 200);
    const denied = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${w2.id}`, { headers: auth(cap.credential) });
    assert.equal(denied.status, 403);
  });
});

test('a session-scoped capability can submit but cannot accept (denied)', async () => {
  const { src, org, project, agent, human } = freshSource();
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'bounded agent work', requester: 'U1' });

  // Operator issues a bootstrap capability to claim + start a session.
  const bootstrap = src.capabilities.issue({
    principalId: agent.id,
    scope: { org: org.id, project: project.id },
    allowed: ['claim_work', 'start_session'],
  });

  await withServer(src, async (base) => {
    await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${w.id}/claim`, { method: 'POST', headers: auth(bootstrap.credential), body: JSON.stringify({ principalId: agent.id }) });
    const session = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${w.id}/sessions`, { method: 'POST', headers: auth(bootstrap.credential), body: JSON.stringify({ principalId: agent.id, baseCommit: 'base' }) })).json();
    const sessionCap = session.capability.credential;

    // The session capability can submit a change.
    const change = await (await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${w.id}/changes`, { method: 'POST', headers: auth(sessionCap), body: JSON.stringify({ sessionId: session.id, baseCommit: 'base', headCommit: 'head' }) })).json();
    assert.ok(change.id);

    // But it cannot accept the change (denied).
    const denied = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/changes/${change.id}/decision`, { method: 'POST', headers: auth(sessionCap), body: JSON.stringify({ decision: 'accepted', decider: agent.id }) });
    assert.equal(denied.status, 403);

    // A human maintainer with accept_change can.
    const humanCap = src.capabilities.issue({ principalId: human.id, scope: { org: org.id, project: project.id }, allowed: ['accept_change'] });
    const ok = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/changes/${change.id}/decision`, { method: 'POST', headers: auth(humanCap.credential), body: JSON.stringify({ decision: 'rejected', decider: human.id, reasoning: 'not ready' }) });
    assert.equal(ok.status, 201);
  });
});

test('session bootstrap binds the issued capability to the authenticated principal', async () => {
  const { src, org, project, agent, human } = freshSource();
  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'bind session identity', requester: human.id });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const bootstrap = src.capabilities.issue({
    principalId: agent.id,
    scope: { org: org.id, project: project.id },
    allowed: ['start_session'],
  });
  await withServer(src, async (base) => {
    const response = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${work.id}/sessions`, {
      method: 'POST',
      headers: { ...auth(bootstrap.credential), 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: human.id }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.principal, agent.id);
    assert.equal(body.capability.principalId, agent.id);
  });
});

test('human login issues a session and gates HTML/API with session cookies', async () => {
  const { src, org, project, human } = freshSource();
  await withServer(src, async (base) => {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ principalId: human.id, password: 'test-password-123', orgId: org.id, projectId: project.id }),
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    assert.equal(session.principal.id, human.id);
    assert.equal(session.capability.principalId, human.id);
    assert.ok(session.credential);
    const sessionCookie = parseCookieHeader(login.headers);
    assert.ok(sessionCookie);
    const cookieHeader = { Cookie: sessionCookie };
    const protectedProject = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}`, { headers: cookieHeader });
    assert.equal(protectedProject.status, 200);
    const anonymous = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}`, {});
    assert.equal(anonymous.status, 401);
  });
});

test('human HTML login lands on the scoped project and root redirects back to it', async () => {
  const { src, org, project, human } = freshSource();
  await withServer(src, async (base) => {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams({ principalId: human.id, password: 'test-password-123', orgId: org.id, projectId: project.id, management: '1' }),
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), `/o/${org.id}/p/${project.id}`);
    const sessionCookie = parseCookieHeader(login.headers);
    const root = await fetch(`${base}/`, { headers: { Cookie: sessionCookie }, redirect: 'manual' });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get('location'), `/o/${org.id}/p/${project.id}`);
  });
});

test('login page uses the vendored Kujo SiteKit shell', async () => {
  const { src } = freshSource();
  await withServer(src, async (base) => {
    const login = await fetch(`${base}/login`);
    assert.equal(login.status, 200);
    const html = await login.text();
    assert.match(html, /data-theme="kujo-light"/);
    assert.match(html, /\/assets\/sitekit\/sitekit\.css/);
    assert.match(html, /class="sk-form"/);
    assert.match(html, /class="sk-button"/);
  });
});

test('human login cannot self-select privileged actions or an unscoped session', async () => {
  const { src, org, project, human } = freshSource();
  await withServer(src, async (base) => {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        principalId: human.id,
        password: 'test-password-123',
        orgId: org.id,
        projectId: project.id,
        allowed: ['manage_org', 'modify_policy'],
        ttlMs: 1,
      }),
    });
    assert.equal(login.status, 200);
    const body = await login.json();
    assert.deepEqual(body.capability.scope, { org: org.id, project: project.id });
    assert.deepEqual(body.capability.allowed, ['read_source', 'read_context', 'accept_change']);
    assert.equal(body.capability.allowed.includes('modify_policy'), false);
  });
});

test('human login requires organization membership and role-scopes approval', async () => {
  const { src, org, project, human } = freshSource();
  const other = src.createPrincipal({ type: 'human', name: 'reader', password: 'reader-password-123' });
  await withServer(src, async (base) => {
    const denied = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ principalId: other.id, password: 'reader-password-123', orgId: org.id, projectId: project.id }),
    });
    assert.equal(denied.status, 403);

    src.addOrgMember({ orgId: org.id, principalId: other.id, role: 'member' });
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ principalId: other.id, password: 'reader-password-123', orgId: org.id, projectId: project.id }),
    });
    assert.equal(login.status, 200);
    const body = await login.json();
    assert.deepEqual(body.capability.allowed, ['read_source', 'read_context']);
    assert.equal(body.capability.allowed.includes('accept_change'), false);
    assert.equal(human.type, 'human');
  });
});

test('human sessions control authorization for human-facing actions', async () => {
  const { src, org, project, human, agent, service } = freshSource();
  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'login action test', requester: human.id });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id, baseCommit: 'base' });
  const change = src.submitChange({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id, baseCommit: 'base', headCommit: 'head' });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 't', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'e', claim: 'deterministic checks pass', type: 'eval', producer: service.id, result: { status: 'pass' } });

  await withServer(src, async (base) => {
    const invalid = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ principalId: human.id, password: 'wrong-password', orgId: org.id, projectId: project.id }),
    });
    assert.equal(invalid.status, 401);

    const maintainer = src.capabilities.issue({ principalId: human.id, scope: { org: org.id, project: project.id }, allowed: ['accept_change'] });
    const accepted = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/changes/${change.id}/decision`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${maintainer.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'accepted', decider: human.id, reasoning: 'ready' }),
    });
    assert.equal(accepted.status, 201);
  });
});

test('private contribution submit requires authorization', async () => {
  const { src, org, project } = freshSource();
  const repo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'main' });
  await withServer(src, async (base) => {
    // No credential: the submit endpoint is the anonymous contribution path.
    const res = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/submit`, { method: 'POST', body: JSON.stringify({ repoRef: repo.name, baseCommit: 'a', headCommit: 'b' }) });
    // The default project is private, so anonymous lifecycle mutation is denied.
    assert.equal(res.status, 401);
  });
});
