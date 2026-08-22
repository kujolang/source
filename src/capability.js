// Source — capability issuance and verification.
//
// A capability is a bounded grant of authority. The credential is an opaque
// random reference; authorization is enforced server-side against the grant
// record (scope, allowed/denied, expiry, revocation).

import { createCapability } from './domain.js';
import { nextId, nextIdAsync, randomHex } from './ids.js';

export class CapabilityService {
  constructor(store) {
    this.store = store;
    this._cache = new Map();
    this._cacheAt = 0;
    this._cacheTtlMs = 5_000;
  }

  _rel(id) {
    return `capabilities/${id}.json`;
  }

  // Issue a capability. Returns the grant record (including the credential).
  issue({ principalId, scope, allowed = [], denied = [], ttlMs = 4 * 60 * 60 * 1000 }) {
    const id = nextId(this.store, 'capability');
    const credential = randomHex(24);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const cap = createCapability({ id, principalId, scope, allowed, denied, expiresAt, credential });
    this.store.writeJson(this._rel(id), cap);
    this._cache.set(credential, cap);
    return cap;
  }

  async issueAsync({ principalId, scope, allowed = [], denied = [], ttlMs = 4 * 60 * 60 * 1000 }) {
    const id = await nextIdAsync(this.store, 'capability');
    const credential = randomHex(24);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const cap = createCapability({ id, principalId, scope, allowed, denied, expiresAt, credential });
    if (typeof this.store.writeJsonAsync === 'function') await this.store.writeJsonAsync(this._rel(id), cap);
    else this.store.writeJson(this._rel(id), cap);
    this._cache.set(credential, cap);
    return cap;
  }

  // Look up a grant by credential. Returns null if unknown.
  lookup(credential) {
    if (!credential) return null;
    const storeLookup = typeof this.store.getCapabilityByCredential === 'function' ? this.store.getCapabilityByCredential(credential) : null;
    if (storeLookup) {
      this._cache.set(credential, storeLookup);
      return storeLookup;
    }

    this._refreshCache();
    const cached = this._cache.get(credential);
    if (cached) return cached;
    return null;
  }

  async lookupAsync(credential) {
    if (!credential) return null;
    if (typeof this.store.getCapabilityByCredentialAsync === 'function') {
      const storeLookup = await this.store.getCapabilityByCredentialAsync(credential);
      if (storeLookup) {
        this._cache.set(credential, storeLookup);
        return storeLookup;
      }
      return null;
    }
    return this.lookup(credential);
  }

  _refreshCache() {
    const now = Date.now();
    if (this._cache.size > 0 && now - this._cacheAt < this._cacheTtlMs) return;

    const next = new Map();
    const ids = this.store.listJson('capabilities');
    for (const id of ids) {
      const cap = this.store.readJson(this._rel(id));
      if (cap && cap.credential) next.set(cap.credential, cap);
    }
    this._cache = next;
    this._cacheAt = now;
  }

  // Verify a credential authorizes an action. Returns {ok, reason, cap}.
  authorize(credential, action) {
    if (!credential) return { ok: false, reason: 'missing credential' };
    const cap = this.lookup(credential);
    if (!cap) return { ok: false, reason: 'unknown credential' };
    if (cap.revoked) return { ok: false, reason: 'revoked' };
    if (new Date(cap.expiresAt).getTime() < Date.now()) {
      return { ok: false, reason: 'expired' };
    }
    if (cap.denied && cap.denied.includes(action)) {
      return { ok: false, reason: `denied: ${action}` };
    }
    if (cap.allowed && cap.allowed.length > 0 && !cap.allowed.includes(action)) {
      return { ok: false, reason: `not allowed: ${action}` };
    }
    return { ok: true, reason: 'authorized', cap };
  }

  async authorizeAsync(credential, action) {
    if (!credential) return { ok: false, reason: 'missing credential' };
    const cap = await this.lookupAsync(credential);
    if (!cap) return { ok: false, reason: 'unknown credential' };
    if (cap.revoked) return { ok: false, reason: 'revoked' };
    if (new Date(cap.expiresAt).getTime() < Date.now()) return { ok: false, reason: 'expired' };
    if (cap.denied && cap.denied.includes(action)) return { ok: false, reason: `denied: ${action}` };
    if (cap.allowed && cap.allowed.length > 0 && !cap.allowed.includes(action)) {
      return { ok: false, reason: `not allowed: ${action}` };
    }
    return { ok: true, reason: 'authorized', cap };
  }

  revoke(id) {
    const cap = this.store.readJson(this._rel(id));
    if (!cap) return false;
    cap.revoked = true;
    this.store.writeJson(this._rel(id), cap);
    this._cache.delete(cap.credential);
    this._cacheAt = 0;
    return true;
  }
}
