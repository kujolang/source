import { test } from 'node:test';
import assert from 'node:assert';
import { freshSource } from './helpers.js';
import { CapabilityService } from '../src/capability.js';

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

test('hashed capability stores never persist the bearer credential', async () => {
  let persisted;
  const service = new CapabilityService({
    hashCapabilities: true,
    nextId: () => 'C1',
    writeJson: (_path, value) => { persisted = value; },
    getCapabilityByCredential: (credential) => credential === persisted?.credential ? persisted : null,
    listJson: () => [],
  });
  const issued = service.issue({ principalId: 'P1', scope: {}, allowed: ['read_source'] });
  assert.notEqual(persisted.credential, issued.credential);
  assert.equal(service.authorize(issued.credential, 'read_source').ok, true);
  assert.equal(service.authorize(persisted.credential, 'read_source').ok, false);
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

test('lookup uses a store capability index when available', () => {
  const store = {
    writeJson() {},
    readJson() {},
    listJson() {
      return [];
    },
    getCapabilityByCredential: (credential) => {
      if (credential === 'indexed') {
        return {
          id: 'C1',
          principalId: 'P1',
          scope: { org: 'O1' },
          allowed: ['read_source'],
          denied: [],
          expiresAt: new Date(Date.now() + 10_000).toISOString(),
          credential: 'indexed',
        };
      }
      return null;
    },
  };
  const service = new CapabilityService(store);
  const found = service.lookup('indexed');
  assert.equal(found?.credential, 'indexed');
  assert.equal(found?.principalId, 'P1');
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

test('indexed capability lookup retains no credential cache and reflects deletion', async () => {
  let present = true;
  const service = new CapabilityService({
    getCapabilityByCredential: () => present ? { id: 'K1' } : null,
    getCapabilityByCredentialAsync: async () => present ? { id: 'K1' } : null,
  });
  for (let i = 0; i < 1000; i++) {
    assert.equal(service.lookup(`sync-${i}`).id, 'K1');
    assert.equal((await service.lookupAsync(`async-${i}`)).id, 'K1');
  }
  assert.equal(service._cache.size, 0);
  present = false;
  assert.equal(service.lookup('sync-1'), null);
  assert.equal(await service.lookupAsync('async-1'), null);
});

test('revoking a hashed grant preserves its stored credential hash', () => {
  let persisted;
  const service = new CapabilityService({
    hashCapabilities: true, nextId: () => 'K1',
    writeJson: (_path, value) => { persisted = value; }, readJson: () => persisted,
    getCapabilityByCredential: (credential) => credential === persisted.credential ? persisted : null,
  });
  const issued = service.issue({ principalId: 'U1', allowed: ['read_source'] });
  const originalHash = persisted.credential;
  service.revoke(issued.id);
  assert.equal(persisted.credential, originalHash);
  assert.equal(service.authorize(issued.credential, 'read_source').reason, 'revoked');
});
