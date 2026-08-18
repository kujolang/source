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
