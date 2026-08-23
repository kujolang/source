// Source — capability-gated API authorization.
//
// Maps HTTP requests to capability actions and enforces scope. The credential
// is an opaque bearer token; authorization is enforced server-side against the
// grant record (see capability.js). This module is the single place where the
// machine interface decides what a request is allowed to do.
//
// The Git smart-HTTP transport uses HTTP Basic auth (git clients do not send
// bearer tokens); `authorizeGit` maps that to the same capability model.

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
  enqueue_job: 'enqueue_job',
  read_jobs: 'read_jobs',
  manage_workflows: 'manage_workflows',
  read_workflows: 'read_workflows',
  dispatch_workflow: 'dispatch_workflow',
  git_push: 'git_push',
};

// Extract a bearer credential from an Authorization header.
export function bearerCredential(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Extract a Basic-auth credential (the password field) from an Authorization
// header. Git clients use HTTP Basic auth, not bearer tokens; the password is
// the capability credential and the username is ignored.
export function basicCredential(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return decoded.slice(i + 1);
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
export function authorizeRequest(capabilities, req, action, { org, project, work, credential } = {}) {
  const effectiveCredential = credential ?? bearerCredential(req);
  const auth = capabilities.authorize(effectiveCredential, action);
  if (!auth.ok) {
    return { ok: false, status: statusFor(auth.reason), error: auth.reason };
  }
  if (!scopeCovers(auth.cap, { org, project, work })) {
    return { ok: false, status: 403, error: 'scope violation' };
  }
  return { ok: true, cap: auth.cap };
}

export async function authorizeRequestAsync(capabilities, req, action, { org, project, work, credential } = {}) {
  const effectiveCredential = credential ?? bearerCredential(req);
  const auth = typeof capabilities.authorizeAsync === 'function'
    ? await capabilities.authorizeAsync(effectiveCredential, action)
    : capabilities.authorize(effectiveCredential, action);
  if (!auth.ok) return { ok: false, status: statusFor(auth.reason), error: auth.reason };
  if (!scopeCovers(auth.cap, { org, project, work })) return { ok: false, status: 403, error: 'scope violation' };
  return { ok: true, cap: auth.cap };
}

// Authorize a Git smart-HTTP request. Git clients use Basic auth; the password
// field is the capability credential.
//
//   read  (upload-pack / clone / fetch): public repos are anonymous; private
//         repos require a `read_source` capability scoped to the org/project.
//   write (receive-pack / push): always requires a `git_push` capability scoped
//         to the org/project.
//
// Returns {ok:true, remoteUser} or {ok:false, status, error}. `remoteUser` is
// the authenticated principal id, or '' for anonymous public read (so
// `git http-backend` does not treat the request as authenticated).
export function authorizeGit(capabilities, req, { org, project, visibility, isWrite }) {
  if (isWrite) {
    const credential = basicCredential(req);
    const auth = capabilities.authorize(credential, ACTIONS.git_push);
    if (!auth.ok) return { ok: false, status: statusFor(auth.reason), error: auth.reason };
    if (!scopeCovers(auth.cap, { org, project })) return { ok: false, status: 403, error: 'scope violation' };
    return { ok: true, remoteUser: auth.cap.principalId };
  }
  if (visibility === 'public') return { ok: true, remoteUser: '' };
  const credential = basicCredential(req);
  const auth = capabilities.authorize(credential, ACTIONS.read_source);
  if (!auth.ok) return { ok: false, status: statusFor(auth.reason), error: auth.reason };
  if (!scopeCovers(auth.cap, { org, project })) return { ok: false, status: 403, error: 'scope violation' };
  return { ok: true, remoteUser: auth.cap.principalId };
}

export async function authorizeGitAsync(capabilities, req, { org, project, visibility, isWrite }) {
  if (isWrite) {
    const credential = basicCredential(req);
    const auth = typeof capabilities.authorizeAsync === 'function'
      ? await capabilities.authorizeAsync(credential, ACTIONS.git_push)
      : capabilities.authorize(credential, ACTIONS.git_push);
    if (!auth.ok) return { ok: false, status: statusFor(auth.reason), error: auth.reason };
    if (!scopeCovers(auth.cap, { org, project })) return { ok: false, status: 403, error: 'scope violation' };
    return { ok: true, remoteUser: auth.cap.principalId };
  }
  if (visibility === 'public') return { ok: true, remoteUser: '' };
  const credential = basicCredential(req);
  const auth = typeof capabilities.authorizeAsync === 'function'
    ? await capabilities.authorizeAsync(credential, ACTIONS.read_source)
    : capabilities.authorize(credential, ACTIONS.read_source);
  if (!auth.ok) return { ok: false, status: statusFor(auth.reason), error: auth.reason };
  if (!scopeCovers(auth.cap, { org, project })) return { ok: false, status: 403, error: 'scope violation' };
  return { ok: true, remoteUser: auth.cap.principalId };
}
