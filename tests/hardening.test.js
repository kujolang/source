import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { freshSource } from './helpers.js';
import { startServer } from '../src/api.js';

async function fixture(t) {
  const data = freshSource();
  const server = await startServer(data.src, { port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(data.dir, { recursive: true, force: true });
  });
  return { ...data, server, base: `http://127.0.0.1:${server.address().port}` };
}

function change(src, orgId, projectId, principalId) {
  const work = src.createWork({ orgId, projectId, requester: principalId, intent: 'review' });
  src.claimWork({ orgId, projectId, workId: work.id, principalId });
  const session = src.startSession({ orgId, projectId, workId: work.id, principalId });
  return src.submitChange({ orgId, projectId, workId: work.id, sessionId: session.id });
}

function bearer(credential) { return { Authorization: `Bearer ${credential}` }; }

test('default server binding is loopback; explicit host remains supported', async (t) => {
  const { server } = await fixture(t);
  assert.equal(server.address().address, '127.0.0.1');
});

test('evidence body cannot replace the authorized organization, project or change', async (t) => {
  const { src, org, project, agent, base } = await fixture(t);
  const own = change(src, org.id, project.id, agent.id);
  const otherOrg = src.createOrg({ name: 'other', slug: 'other' });
  const otherProject = src.createProject({ orgId: otherOrg.id, name: 'private', slug: 'private' });
  const foreign = change(src, otherOrg.id, otherProject.id, agent.id);
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: project.id, work: own.workId }, allowed: ['submit_evidence'] });
  const response = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/changes/${own.id}/evidence`, {
    method: 'POST', headers: bearer(cap.credential),
    body: JSON.stringify({ orgId: otherOrg.id, projectId: otherProject.id, changeId: foreign.id, subject: 'checks', claim: 'passed', type: 'test', producer: agent.id, result: { status: 'pass' } }),
  });
  assert.equal(response.status, 201);
  const evidence = await response.json();
  assert.deepEqual(src.getChange(otherOrg.id, otherProject.id, foreign.id).evidence, []);
  assert.deepEqual(src.getChange(org.id, project.id, own.id).evidence, [evidence.id]);
});

test('encoded Git receive-pack requires push authority before Git starts', async (t) => {
  const { src, org, project, agent, base } = await fixture(t);
  const repo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'private' });
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: project.id }, allowed: ['read_source'] });
  for (const suffix of ['git-receive-pack', 'git-%72eceive-pack', 'git-%2572eceive-pack']) {
    const response = await fetch(`${base}/git/${org.id}/${project.id}/${repo.id}.git/${suffix}`, {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`source:${cap.credential}`).toString('base64')}`, 'Content-Type': 'application/x-git-receive-pack-request' }, body: '0000',
    });
    await response.text();
    assert.equal(response.status, 403, suffix);
  }
});

test('web work stores principal identity without retaining its bearer credential', async (t) => {
  const { src, org, project, human, base } = await fixture(t);
  const cap = src.capabilities.issue({ principalId: human.id, scope: { org: org.id, project: project.id }, allowed: ['manage_work'] });
  const response = await fetch(`${base}/o/${org.id}/p/${project.id}/work`, {
    method: 'POST', headers: { ...bearer(cap.credential), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ intent: 'safe identity' }), redirect: 'manual',
  });
  assert.equal(response.status, 303);
  const workId = response.headers.get('location').split('/').at(-1);
  const work = src.getWork(org.id, project.id, workId);
  assert.equal(work.requester, human.id);
  assert.equal(JSON.stringify(work).includes(cap.credential), false);
  assert.equal(JSON.stringify(src.readAudit()).includes(cap.credential), false);
});

test('project management alone cannot grant organization membership', async (t) => {
  const { src, org, project, agent, base } = await fixture(t);
  const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: project.id }, allowed: ['manage_project'] });
  const response = await fetch(`${base}/o/${org.id}/p/${project.id}/settings/members`, {
    method: 'POST', headers: { ...bearer(cap.credential), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ principalId: agent.id, role: 'admin' }), redirect: 'manual',
  });
  assert.equal(response.status, 403);
  assert.equal(src.getOrgMembership(org.id, agent.id), null);
});

test('session IDs cannot read or revoke capability records through path traversal', async (t) => {
  const { src, org, project, human, base } = await fixture(t);
  const cap = src.capabilities.issue({ principalId: human.id, scope: { org: org.id, project: project.id }, allowed: ['read_source'] });
  const crafted = `../capabilities/${cap.id}`;
  const response = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}`, { headers: { Cookie: `source_session=${crafted}` } });
  await response.text();
  assert.equal(response.status, 401);
  assert.equal(src.getHumanSession(crafted), null);
  assert.equal(await src.getHumanSessionAsync(crafted), null);
  src.revokeHumanSession(crafted);
  await src.revokeHumanSessionAsync(crafted);
  assert.equal(src.capabilities.authorize(cap.credential, 'read_source').ok, true);
});

test('decision API records the authenticated actor, not a supplied decider', async (t) => {
  const { src, org, project, human, agent, base } = await fixture(t);
  const proposal = change(src, org.id, project.id, agent.id);
  const cap = src.capabilities.issue({ principalId: human.id, scope: { org: org.id, project: project.id }, allowed: ['accept_change'] });
  const response = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/changes/${proposal.id}/decision`, {
    method: 'POST', headers: bearer(cap.credential), body: JSON.stringify({ decision: 'rejected', decider: agent.id }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).decider, human.id);
});

test('caller dedupe keys are tenant-scoped and separated from workflow keys', async (t) => {
  const { src, org, project, agent, base } = await fixture(t);
  const other = src.createProject({ orgId: org.id, name: 'other', slug: 'other' });
  const rawKey = `${org.id}:${other.id}:WF1:push-1:checks`;
  const seen = [];
  src.jobs.enqueue = async (job) => { seen.push(job.dedupeKey); return { id: `J${seen.length}` }; };
  for (const target of [project, project, other]) {
    const cap = src.capabilities.issue({ principalId: agent.id, scope: { org: org.id, project: target.id }, allowed: ['enqueue_job'] });
    const response = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${target.id}/jobs`, { method: 'POST', headers: bearer(cap.credential), body: JSON.stringify({ kind: 'test', dedupeKey: rawKey }) });
    assert.equal(response.status, 202);
    await response.text();
  }
  assert.equal(seen[0], seen[1]);
  assert.notEqual(seen[0], seen[2]);
  assert.ok(seen.every((key) => key !== rawKey));
});

test('malformed Host returns 400 without terminating the serving process', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http';
    import { startServer } from './src/api.js';
    const server = await startServer({store: {}}, {port: 0});
    const status = await new Promise((resolve, reject) => {
      http.get({host:'127.0.0.1', port:server.address().port, path:'/healthz', headers:{host:'['}}, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    const healthy = await fetch('http://127.0.0.1:' + server.address().port + '/healthz');
    await healthy.text();
    server.closeAllConnections(); await new Promise(r => server.close(r));
    if (status !== 400 || healthy.status !== 200) process.exitCode = 2;
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});

test('queued client disconnect releases its late admission grant', { timeout: 5000 }, async (t) => {
  const { createConnection } = await import('node:net');
  const { once } = await import('node:events');
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  let entered;
  const entry = new Promise((resolve) => { entered = resolve; });
  const src = { store: {}, checkHealthAsync: async () => { entered(); await blocked; }, getInstanceAsync: async () => ({ id: 'instance' }) };
  const server = await startServer(src, { port: 0, requestConcurrency: 1, requestQueue: 1 });
  t.after(() => { unblock(); server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const first = fetch(`http://127.0.0.1:${port}/readyz`);
  await entry;
  let closed;
  const disconnected = new Promise((resolve) => { closed = resolve; });
  server.on('request', (req, res) => { if (req.url === '/healthz') res.on('close', closed); });
  let queued;
  const queueEntry = new Promise((resolve) => { queued = resolve; });
  const acquire = server.requestSlots.acquire.bind(server.requestSlots);
  server.requestSlots.acquire = () => { const value = acquire(); queued(); return value; };
  const socket = createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n');
  await queueEntry;
  socket.destroy();
  await disconnected;
  unblock();
  await (await first).text();
  await new Promise(setImmediate);
  assert.equal(server.requestSlots.active, 0);
  assert.equal(server.requestSlots.waiters.length, 0);
});

test('concurrent evidence additions preserve every relationship', async (t) => {
  const { src, org, project, agent } = await fixture(t);
  const proposal = change(src, org.id, project.id, agent.id);
  const evidence = await Promise.all(Array.from({ length: 20 }, (_, i) => src.addEvidenceAsync({ orgId: org.id, projectId: project.id, changeId: proposal.id, subject: 'checks', claim: `check-${i}`, type: 'test', producer: agent.id })));
  assert.deepEqual(new Set(src.getChange(org.id, project.id, proposal.id).evidence), new Set(evidence.map((item) => item.id)));
});

test('organization admins retain membership management through project sessions', async (t) => {
  const { src, org, project, human, agent, base } = await fixture(t);
  src.addOrgMember({ orgId: org.id, principalId: human.id, role: 'admin' });
  const cap = src.capabilities.issue({ principalId: human.id, scope: { org: org.id, project: project.id }, allowed: ['manage_org'] });
  const response = await fetch(`${base}/o/${org.id}/p/${project.id}/settings/members`, {
    method: 'POST', headers: { ...bearer(cap.credential), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ principalId: agent.id, role: 'maintainer' }), redirect: 'manual',
  });
  assert.equal(response.status, 303);
  assert.equal(src.getOrgMembership(org.id, agent.id).role, 'maintainer');
});
