// Source — capability issuance and verification.
//
// A capability is a bounded grant of authority. The credential is an opaque
// random reference; authorization is enforced server-side against the grant
// record (scope, allowed/denied, expiry, revocation).

import { createCapability } from './domain.js';
import { nextId, randomHex } from './ids.js';

export class CapabilityService {
  constructor(store) {
    this.store = store;
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
    return cap;
  }

  // Look up a grant by credential. Returns null if unknown.
  lookup(credential) {
    const ids = this.store.listJson('capabilities');
    for (const id of ids) {
      const cap = this.store.readJson(this._rel(id));
      if (cap && cap.credential === credential) return cap;
    }
    return null;
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

  revoke(id) {
    const cap = this.store.readJson(this._rel(id));
    if (!cap) return false;
    cap.revoked = true;
    this.store.writeJson(this._rel(id), cap);
    return true;
  }
}
