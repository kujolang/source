// Multi-tenant org management tests.
//
// The Organization is the tenant boundary. These tests prove that orgs are
// first-class in the API (list/get/create), that org-scoped capabilities are
// enforced server-side, and that a capability for one org cannot reach another
// org's projects or repositories.

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

test('org and project IDs use independent counters', () => {
  const { src, org, project } = freshSource();
  // The org counter no longer consumes the project counter: the first org is
  // O1 and the first project is P1 (previously the first project was P2).
  assert.equal(org.id, 'O1');
  assert.equal(project.id, 'P1');
});

test('list orgs returns all organizations', async () => {
  const { src, org, agent } = freshSource();
  const org2 = src.createOrg({ name: 'other', slug: 'other' });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: {}, allowed: ['read_source'] });
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/orgs`, { headers: auth(cap.credential) });
    assert.equal(res.status, 200);
    const orgs = await res.json();
    assert.ok(orgs.some((o) => o.id === org.id));
    assert.ok(orgs.some((o) => o.id === org2.id));
  });
});

test('get org returns the org', async () => {
  const { src, org, agent } = freshSource();
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id }, allowed: ['read_source'] });
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/api/v1/orgs/${org.id}`, { headers: auth(cap.credential) });
    assert.equal(res.status, 200);
    const o = await res.json();
    assert.equal(o.id, org.id);
    assert.equal(o.name, 'test-org');
  });
});

test('creating an org requires the manage_org capability', async () => {
  const { src, agent } = freshSource();
  const noPerm = src.capabilities.issue({ principalId: agent.id, scope: {}, allowed: ['read_source'] });
  const manage = src.capabilities.issue({ principalId: agent.id, scope: {}, allowed: ['manage_org'] });
  await withServer(src, async (base) => {
    const denied = await fetch(`${base}/api/v1/orgs`, { method: 'POST', headers: auth(noPerm.credential), body: JSON.stringify({ name: 'x', slug: 'x' }) });
    assert.equal(denied.status, 403);

    const ok = await fetch(`${base}/api/v1/orgs`, { method: 'POST', headers: auth(manage.credential), body: JSON.stringify({ name: 'acme', slug: 'acme' }) });
    assert.equal(ok.status, 201);
    const org = await ok.json();
    assert.equal(org.name, 'acme');
  });
});

test('an org-scoped capability cannot read another org project (403)', async () => {
  const { src, org, project, agent } = freshSource();
  const org2 = src.createOrg({ name: 'other', slug: 'other' });
  const p2 = src.createProject({ orgId: org2.id, slug: 'p2', name: 'P2' });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id }, allowed: ['read_source'] });
  await withServer(src, async (base) => {
    const ok = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}`, { headers: auth(cap.credential) });
    assert.equal(ok.status, 200);
    const denied = await fetch(`${base}/api/v1/orgs/${org2.id}/projects/${p2.id}`, { headers: auth(cap.credential) });
    assert.equal(denied.status, 403);
  });
});

test('an org-scoped capability cannot list another org work (403)', async () => {
  const { src, org, project, agent } = freshSource();
  const org2 = src.createOrg({ name: 'other', slug: 'other' });
  const p2 = src.createProject({ orgId: org2.id, slug: 'p2', name: 'P2' });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: project.id }, allowed: ['read_context'] });
  await withServer(src, async (base) => {
    const denied = await fetch(`${base}/api/v1/orgs/${org2.id}/projects/${p2.id}/work`, { headers: auth(cap.credential) });
    assert.equal(denied.status, 403);
  });
});

test('a project in another org is not reachable by id (server-side isolation)', async () => {
  const { src, org, project, agent } = freshSource();
  const org2 = src.createOrg({ name: 'other', slug: 'other' });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org2.id }, allowed: ['read_source'] });
  await withServer(src, async (base) => {
    // A valid org2-scoped credential cannot read org1's project by id: the
    // project is keyed under org1's path, so the lookup returns 404 (not the
    // project). The org-scoped path is the isolation boundary, not UI filtering.
    const res = await fetch(`${base}/api/v1/orgs/${org2.id}/projects/${project.id}`, { headers: auth(cap.credential) });
    assert.equal(res.status, 404);
  });
});
