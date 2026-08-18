import { test } from 'node:test';
import assert from 'node:assert';
import { freshSource } from './helpers.js';

test('a capability authorizes allowed actions and denies others', () => {
  const { src, agent } = freshSource();
  const cap = src.capabilities.issue({
    principalId: agent.id,
    scope: { project: 'P1' },
    allowed: ['read_source', 'submit_change'],
    denied: ['accept_change'],
  });
  assert.ok(src.capabilities.authorize(cap.credential, 'read_source').ok);
  assert.ok(src.capabilities.authorize(cap.credential, 'submit_change').ok);
  assert.equal(src.capabilities.authorize(cap.credential, 'accept_change').ok, false);
  assert.equal(src.capabilities.authorize(cap.credential, 'modify_policy').ok, false);
});

test('an expired capability is refused', () => {
  const { src, agent } = freshSource();
  const cap = src.capabilities.issue({
    principalId: agent.id,
    scope: { project: 'P1' },
    allowed: ['read_source'],
    ttlMs: -1000, // already expired
  });
  const r = src.capabilities.authorize(cap.credential, 'read_source');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('a revoked capability is refused', () => {
  const { src, agent } = freshSource();
  const cap = src.capabilities.issue({ principalId: agent.id, scope: {}, allowed: ['read_source'] });
  src.capabilities.revoke(cap.id);
  const r = src.capabilities.authorize(cap.credential, 'read_source');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'revoked');
});

test('an unknown credential is refused', () => {
  const { src } = freshSource();
  const r = src.capabilities.authorize('does-not-exist', 'read_source');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown credential');
});

test('tenant isolation: a second org cannot read the first org project', () => {
  const { src, org, project } = freshSource();
  const org2 = src.createOrg({ name: 'other', slug: 'other' });
  // The project belongs to org1; reading it under org2 must return null.
  const p = src.getProject(org2.id, project.id);
  assert.equal(p, null);
  // And org1's project is still readable under org1.
  assert.ok(src.getProject(org.id, project.id));
});
