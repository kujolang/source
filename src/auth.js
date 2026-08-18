// Source — capability-gated API authorization.
//
// Maps HTTP requests to capability actions and enforces scope. The credential
// is an opaque bearer token; authorization is enforced server-side against the
// grant record (see capability.js). This module is the single place where the
// machine interface decides what a request is allowed to do.

// Canonical capability actions. Kept in one place so the API, policy, and
// discovery manifest agree on the vocabulary.
export const ACTIONS = {
  read_source: 'read_source',
  read_context: 'read_context',
  claim_work: 'claim_work',
  start_session: 'start_session',
  submit_change: 'submit_change',
  submit_evidence: 'submit_evidence',
  accept_change: 'accept_change',
  modify_policy: 'modify_policy',
  publish_release: 'publish_release',
  manage_org: 'manage_org',
};

// Extract a bearer credential from an Authorization header.
export function bearerCredential(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Does a capability's scope cover a request targeting {org, project, work}?
// A missing scope field means "no restriction" (instance-wide).
export function scopeCovers(cap, { org, project, work } = {}) {
  const s = cap.scope || {};
  if (s.org && s.org !== org) return false;
  if (s.project && s.project !== project) return false;
  if (s.work && s.work !== work) return false;
  return true;
}

// Map an authorization failure reason to an HTTP status.
// 401 = authentication failure (missing/unknown/expired/revoked credential).
// 403 = authorization failure (denied/not-allowed/scope violation).
function statusFor(reason) {
  if (reason === 'missing credential') return 401;
  if (reason === 'unknown credential') return 401;
  if (reason === 'expired') return 401;
  if (reason === 'revoked') return 401;
  return 403;
}

// Authorize a request against a capability service.
// Returns {ok:true, cap} or {ok:false, status, error}.
export function authorizeRequest(capabilities, req, action, { org, project, work } = {}) {
  const credential = bearerCredential(req);
  const auth = capabilities.authorize(credential, action);
  if (!auth.ok) {
    return { ok: false, status: statusFor(auth.reason), error: auth.reason };
  }
  if (!scopeCovers(auth.cap, { org, project, work })) {
    return { ok: false, status: 403, error: 'scope violation' };
  }
  return { ok: true, cap: auth.cap };
}
