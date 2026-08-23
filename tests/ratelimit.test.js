// Rate-limiting tests.
//
// Proves the fixed-window rate limiter enforces limits per key, and that the
// anonymous `source submit` endpoint is rate-limited by client address (429 on
// exceeding the limit).

import { test } from 'node:test';
import assert from 'node:assert';
import { RateLimiter } from '../src/ratelimit.js';
import { freshSource, seedRepo } from './helpers.js';
import { startServer } from '../src/api.js';

test('RateLimiter allows up to the limit then rejects', () => {
  const rl = new RateLimiter();
  const opts = { limit: 2, windowMs: 60_000 };
  assert.equal(rl.allow('k', opts), true);
  assert.equal(rl.allow('k', opts), true);
  assert.equal(rl.allow('k', opts), false);
  // A different key is unaffected.
  assert.equal(rl.allow('other', opts), true);
});

test('RateLimiter resets after the window elapses', async () => {
  const rl = new RateLimiter();
  const opts = { limit: 1, windowMs: 15 };
  assert.equal(rl.allow('k', opts), true);
  assert.equal(rl.allow('k', opts), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rl.allow('k', opts), true);
});

test('the submit endpoint is rate-limited by client address', async () => {
  const { src, org } = freshSource();
  const project = src.createProject({ orgId: org.id, slug: 'public', name: 'Public', visibility: 'public' });
  const { repo, base, head } = seedRepo(src, org.id, project.id);

  const server = await startServer(src, { port: 0, rateLimit: { submit: { limit: 1, windowMs: 60_000 } } });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const body = JSON.stringify({ repoRef: repo.id, baseCommit: base, headCommit: head, intent: 'test', contributorName: 'dev' });
    const r1 = await fetch(`${baseUrl}/api/v1/orgs/${org.id}/projects/${project.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(r1.status, 201);

    const r2 = await fetch(`${baseUrl}/api/v1/orgs/${org.id}/projects/${project.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(r2.status, 429);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('human login is rate-limited by client address', async () => {
  const { src, org, project, human } = freshSource();
  const server = await startServer(src, { port: 0, rateLimit: { login: { limit: 1, windowMs: 60_000 } } });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    const r1 = await fetch(`${base}/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ principalId: human.id, password: 'test-password-123', orgId: org.id, projectId: project.id }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${base}/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ principalId: human.id, password: 'test-password-123', orgId: org.id, projectId: project.id }),
    });
    assert.equal(r2.status, 429);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('trusted proxy mode uses the forwarded client address for rate limits', async () => {
  const { src, org, project, human } = freshSource();
  const server = await startServer(src, { port: 0, trustProxy: true, rateLimit: { login: { limit: 1, windowMs: 60_000 } } });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ principalId: human.id, password: 'test-password-123', orgId: org.id, projectId: project.id });
    const first = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-forwarded-for': '198.51.100.10' },
      body,
    });
    const second = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-forwarded-for': '198.51.100.11' },
      body,
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('session issuance is rate-limited by client address', async () => {
  const { src, org, project, human, agent } = freshSource();
  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'session throttle', requester: human.id });
  const sessionBootstrap = src.capabilities.issue({
    principalId: agent.id,
    scope: { org: org.id, project: project.id },
    allowed: ['claim_work', 'start_session'],
  });

  const server = await startServer(src, { port: 0, rateLimit: { session: { limit: 1, windowMs: 60_000 } } });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${work.id}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionBootstrap.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: agent.id }),
    });

    const body = JSON.stringify({ principalId: agent.id, baseCommit: 'base' });
    const headers = { Authorization: `Bearer ${sessionBootstrap.credential}`, 'content-type': 'application/json' };

    const r1 = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${work.id}/sessions`, {
      method: 'POST',
      headers,
      body,
    });
    assert.equal(r1.status, 201);

    const r2 = await fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/work/${work.id}/sessions`, {
      method: 'POST',
      headers,
      body,
    });
    assert.equal(r2.status, 429);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
