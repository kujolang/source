// Source — HTTP API and agent discovery.
//
// The machine interface. No critical capability requires HTML. Responses are
// compact JSON with field selection and pagination. Mutating operations are
// capability-gated via `Authorization: Bearer <credential>`.
//
// The Organization is the tenant boundary and is explicit in every route:
// `/api/v1/orgs/{org}/projects/{project}/…`. Tenant isolation is enforced
// server-side (org-scoped paths + org-scoped capability checks), never by UI
// filtering.
//
// The same server also serves Git over smart HTTP (`/git/{org}/{project}/…`)
// by delegating to `git http-backend`; see `git-http.js`. Git transport is
// capability-gated via HTTP Basic auth (see `authorizeGit` in auth.js).
//
// Anonymous/unauthenticated paths (the `source submit` contribution endpoint
// and Git push) are rate-limited by client address (see `ratelimit.js`).
//
// TLS: pass `tls: { key, cert }` (PEM) to `createServer`/`startServer` to
// terminate TLS in-process (Node `https`). Otherwise the server is plain HTTP
// and TLS is expected to be terminated by a reverse proxy (see
// `23-tls-deployment.md`).

import http from 'node:http';
import https from 'node:https';
import { Source } from './source.js';
import { renderOrgIndex, renderIndex, renderProject, renderWork, renderChange, renderLogin } from './web.js';
import { gitHttpBackend } from './git-http.js';
import { ACTIONS, authorizeRequest, authorizeGit, bearerCredential } from './auth.js';
import { RateLimiter } from './ratelimit.js';
import { Semaphore } from './concurrency.js';

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readText(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > maxBytes) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    readText(req, maxBytes)
      .then((data) => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error('invalid JSON body'));
        }
      })
      .catch(reject);
  });
}

async function readLoginBody(req) {
  const raw = await readText(req, 10_000);
  if (!raw) return {};
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid body');
  }
}

// Read a raw (possibly binary) request body, e.g. a Git packfile upload.
function readRawBody(req, maxBytes = 100_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > maxBytes) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const SESSION_COOKIE = 'source_session';

function parseSessionCookie(header) {
  if (!header) return null;
  const match = String(header)
    .split(';')
    .find((segment) => segment.trim().startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  return match.trim().slice(SESSION_COOKIE.length + 1);
}

function sessionCredential(src, req) {
  const bearer = bearerCredential(req);
  if (bearer) return bearer;
  const sessionId = parseSessionCookie(req.headers.cookie);
  if (!sessionId) return null;
  const session = src.getHumanSession(sessionId);
  return session?.credential || null;
}

function sessionHeaders(session) {
  const maxAge = session?.expiresAt ? Math.max(1, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)) : 0;
  return `${SESSION_COOKIE}=${session.id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearSessionHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

function wantsJson(req) {
  return String(req.headers.accept || '').includes('application/json');
}

function loginPage(res, status = 200, error) {
  return html(res, status, renderLogin({ error }));
}

// Apply field selection to an object (or array of objects).
function selectFields(obj, fields) {
  if (!fields) return obj;
  const keys = fields.split(',');
  if (Array.isArray(obj)) return obj.map((o) => selectFields(o, fields));
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

function parseListParams(url) {
  const limitRaw = url.searchParams.get('limit');
  const rawLimit = Number(limitRaw);
  return {
    cursor: url.searchParams.get('cursor') || null,
    limit: Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : null,
  };
}

function paginate(items, { cursor, limit }) {
  if (!limit) return { items, nextCursor: null };
  const start = cursor ? items.findIndex((item) => item?.id === cursor) + 1 : 0;
  const safeStart = start > 0 ? start : 0;
  const window = items.slice(safeStart, safeStart + limit + 1);
  const page = window.slice(0, limit);
  const nextCursor = window.length > limit ? page[page.length - 1]?.id : null;
  return { items: page, nextCursor };
}

function paginatedResponse(items, pagination, fields) {
  const { items: page, nextCursor } = paginate(items, pagination);
  const payload = selectFields(page, fields);
  if (!pagination.limit) return payload;
  return { items: payload, nextCursor };
}

// Authorize a request against a capability action and scope. Returns null when
// authorized, or {status, body} to send as the rejection response.
function guard(src, req, action, scope) {
  const credential = sessionCredential(src, req);
  const r = authorizeRequest(src.capabilities, req, action, { ...scope, credential });
  if (r.ok) return null;
  return { status: r.status, body: { error: r.error } };
}

// Reject a Git transport request. 401 responses carry a WWW-Authenticate
// challenge so git clients know to send Basic auth.
function gitAuthError(res, status, error) {
  const body = JSON.stringify({ error });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (status === 401) headers['WWW-Authenticate'] = 'Basic realm="source"';
  res.writeHead(status, headers);
  res.end(body);
}

// Resolve the Work id a Change belongs to (for work-scoped capability checks).
function changeWork(src, orgId, projectId, changeId) {
  const c = src.getChange(orgId, projectId, changeId);
  return c ? c.workId : undefined;
}

export function createServer(src, { port = 8787, tls, host, rateLimit = {}, maxJsonBodyBytes = 1_000_000, maxGitBodyBytes = 100_000_000, gitConcurrency = 32, gitQueue = 256, maxConnections = 10_000 } = {}) {
  const limiter = new RateLimiter({ maxKeys: rateLimit.maxKeys || 100_000, store: rateLimit.store || src.store });
  const gitSlots = new Semaphore({ capacity: gitConcurrency, queue: gitQueue });
  const limits = {
    submit: { limit: 10, windowMs: 60_000, ...(rateLimit.submit || {}) },
    gitPush: { limit: 30, windowMs: 60_000, ...(rateLimit.gitPush || {}) },
    login: { limit: 20, windowMs: 60_000, ...(rateLimit.login || {}) },
    session: { limit: 30, windowMs: 60_000, ...(rateLimit.session || {}) },
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const fields = url.searchParams.get('fields') || undefined;

    try {
      // --- login ---------------------------------------------------------
      if (req.method === 'GET' && pathname === '/login') {
        return loginPage(res, 200);
      }

      if (req.method === 'POST' && pathname === '/login') {
        const ip = req.socket.remoteAddress || 'unknown';
        if (!limiter.allow(`login:${ip}`, limits.login)) {
          if (wantsJson(req)) return json(res, 429, { error: 'rate limit exceeded' });
          return loginPage(res, 429, 'rate limit exceeded');
        }
        const body = await readLoginBody(req);
        const principalId = body.principalId || null;
        const password = body.password || null;
        const orgId = body.orgId || undefined;
        const projectId = body.projectId || undefined;
        const parsedTtl = body.ttlMs !== undefined && body.ttlMs !== null ? Number(body.ttlMs) : undefined;
        const ttlMs = Number.isFinite(parsedTtl) ? parsedTtl : undefined;

        const principal = principalId ? src.getPrincipal(principalId) : null;
        if (!principal || !src.verifyPrincipalPassword(principal.id, password)) {
          if (wantsJson(req)) return json(res, 401, { error: 'principal id required' });
          return loginPage(res, 401, 'invalid credentials');
        }
        if (principal.type !== 'human') {
          if (wantsJson(req)) return json(res, 403, { error: `principal is not human: ${principal.type}` });
          return loginPage(res, 403, `principal is not human: ${principal.type}`);
        }

        if (!orgId || !projectId) {
          if (wantsJson(req)) return json(res, 400, { error: 'orgId and projectId are required' });
          return loginPage(res, 400, 'org and project are required');
        }
        const session = src.createHumanSession({ principalId: principal.id, orgId, projectId, ttlMs });
        const headers = { 'Set-Cookie': sessionHeaders(session), 'Content-Type': 'application/json' };

        if (wantsHtml(req)) {
          headers.Location = '/';
          res.writeHead(303, headers);
          return res.end();
        }

        const bodyOut = JSON.stringify(session);
        headers['Content-Length'] = Buffer.byteLength(bodyOut);
        res.writeHead(200, headers);
        return res.end(bodyOut);
      }

      if (req.method === 'POST' && pathname === '/logout') {
        const sessionId = parseSessionCookie(req.headers.cookie);
        if (sessionId) src.revokeHumanSession(sessionId);
        const cookie = clearSessionHeader();
        if (wantsHtml(req)) {
          res.writeHead(303, { Location: '/login', 'Set-Cookie': cookie });
          return res.end();
        }
        const bodyOut = JSON.stringify({ ok: true, revoked: Boolean(sessionId) });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie, 'Content-Length': Buffer.byteLength(bodyOut) });
        res.end(bodyOut);
      }

      // --- human-facing HTML views ---------------------------------------
      if (req.method === 'GET' && pathname === '/') {
        const g = guard(src, req, ACTIONS.read_source, {});
        if (g) return loginPage(res, g.status, g.body.error);
        return html(res, 200, renderOrgIndex(src));
      }

      const orgPageMatch = pathname.match(/^\/o\/([^/]+)$/);
      if (req.method === 'GET' && orgPageMatch) {
        const [, orgId] = orgPageMatch;
        const g = guard(src, req, ACTIONS.read_source, { org: orgId });
        if (g) return loginPage(res, g.status, g.body.error);
        return html(res, 200, renderIndex(src, orgId));
      }

      const pMatch = pathname.match(/^\/o\/([^/]+)\/p\/([^/]+)(?:\/w\/([^/]+))?(?:\/c\/([^/]+))?$/);
      if (req.method === 'GET' && pMatch) {
        const [, orgId, projectId, workId, changeId] = pMatch;
        const g = guard(src, req, ACTIONS.read_source, { org: orgId, project: projectId });
        if (g) return loginPage(res, g.status, g.body.error);

        if (changeId) {
          const c = src.getChange(orgId, projectId, changeId);
          if (!c) return html(res, 404, '<!doctype html><html><body><h1>Not found</h1></body></html>');
          return html(res, 200, renderChange(src, orgId, projectId, changeId));
        }

        if (workId) {
          const wc = guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
          if (wc) return loginPage(res, wc.status, wc.body.error);
          return html(res, 200, renderWork(src, orgId, projectId, workId));
        }
        return html(res, 200, renderProject(src, orgId, projectId));
      }

      // --- discovery (public) ---------------------------------------------
      if (pathname === '/.well-known/source') {
        return json(res, 200, {
          instance: src.getInstance()?.name ?? 'source',
          api_version: '1',
          protocols: ['http+json', 'git-smart-http'],
          endpoints: {
            orgs: '/api/v1/orgs',
            projects: '/api/v1/orgs/{org}/projects',
            work: '/api/v1/orgs/{org}/projects/{project}/work',
            changes: '/api/v1/orgs/{org}/projects/{project}/changes',
            evidence: '/api/v1/orgs/{org}/projects/{project}/evidence',
            git: '/git/{org}/{project}/{repo}.git',
            policy: '/api/v1/orgs/{org}/projects/{project}/policy',
            submit: '/api/v1/orgs/{org}/projects/{project}/submit',
          },
          capabilities: Object.values(ACTIONS),
          auth: {
            type: 'capability',
            header: 'Authorization: Bearer <credential>',
            note: 'capabilities are issued out-of-band (CLI/operator) and scoped to org/project/work',
          },
          git_auth: {
            type: 'basic',
            note: 'git transport uses HTTP Basic auth; the password is a capability credential (read_source for private read, git_push for push)',
          },
        });
      }

      // --- smart-HTTP Git transport --------------------------------------
      // Maps /git/{org}/{project}/{repo}.git/{service} to a bare repository and
      // delegates to `git http-backend`. Supports clone, fetch, pull, and push.
      // The URL may use the repository id (R1) or name (main); the bare
      // directory is always keyed by id, so pathInfo uses the resolved id.
      const gitMatch = pathname.match(/^\/git\/([^/]+)\/([^/]+)\/([^/]+\.git)(\/.*)?$/);
      if (gitMatch && (req.method === 'GET' || req.method === 'POST')) {
        const [, orgId, projectId, repoFile, rest = ''] = gitMatch;
        const repoRef = repoFile.slice(0, -'.git'.length);
        const repo = src.resolveRepository(orgId, projectId, repoRef);
        if (!repo) return json(res, 404, { error: 'repository not found' });

        // Auth: read (upload-pack) vs write (receive-pack). Public repos allow
        // anonymous read; private repos require read_source; push always
        // requires git_push. Enforced here, before delegating to git.
        const service = url.searchParams.get('service') || '';
        const isWrite = service === 'git-receive-pack' || rest.includes('git-receive-pack');

        // Rate-limit the write path (push) by client address.
        if (isWrite) {
          const ip = req.socket.remoteAddress || 'unknown';
          if (!limiter.allow(`gitpush:${ip}`, limits.gitPush)) {
            return gitAuthError(res, 429, 'rate limit exceeded');
          }
        }

        const auth = authorizeGit(src.capabilities, req, {
          org: orgId,
          project: projectId,
          visibility: repo.visibility,
          isWrite,
        });
        if (!auth.ok) return gitAuthError(res, auth.status, auth.error);
        const declaredLength = Number(req.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxGitBodyBytes) {
          return gitAuthError(res, 413, 'request body too large');
        }

        const release = await gitSlots.acquire();
        if (!release) return gitAuthError(res, 503, 'Git service busy; retry later');
        let body = null;
        try {
          if (req.method === 'POST') body = await readRawBody(req, maxGitBodyBytes);

          const result = await gitHttpBackend({
          projectRoot: src.reposRoot(orgId, projectId),
          pathInfo: `/${repo.id}.git${rest}`,
          queryString: url.search ? url.search.slice(1) : '',
          method: req.method,
          contentType: req.headers['content-type'] || '',
          body,
          remoteUser: auth.remoteUser,
          remoteAddr: req.socket.remoteAddress || '',
          headers: req.headers,
          });

          const headers = { ...result.headers };
          if (result.body && result.body.length && !headers['content-length']) {
            headers['Content-Length'] = String(result.body.length);
          }
          res.writeHead(result.status, headers);
          return res.end(result.body);
        } finally {
          release();
        }
      }

      // --- organizations (tenant boundary) --------------------------------
      if (pathname === '/api/v1/orgs' && req.method === 'GET') {
        const g = guard(src, req, ACTIONS.read_source, {});
        const pagination = parseListParams(url);
        if (g) return json(res, g.status, g.body);
        const requestLimit = pagination.limit ? pagination.limit + 1 : null;
        const items = src.listOrgs({ cursor: pagination.cursor, limit: requestLimit });
        return json(res, 200, paginatedResponse(items, pagination, fields));
      }

      if (pathname === '/api/v1/orgs' && req.method === 'POST') {
        const g = guard(src, req, ACTIONS.manage_org, {});
        if (g) return json(res, g.status, g.body);
        const body = await readBody(req, maxJsonBodyBytes);
        const org = src.createOrg({ name: body.name, slug: body.slug });
        return json(res, 201, org);
      }

      const orgMatch = pathname.match(/^\/api\/v1\/orgs\/([^/]+)$/);
      if (orgMatch && req.method === 'GET') {
        const orgId = orgMatch[1];
        const g = guard(src, req, ACTIONS.read_source, { org: orgId });
        if (g) return json(res, g.status, g.body);
        const org = src.getOrg(orgId);
        if (!org) return json(res, 404, { error: 'not found' });
        return json(res, 200, selectFields(org, fields));
      }

      // --- projects (org-scoped) ------------------------------------------
      const projectMatch = pathname.match(/^\/api\/v1\/orgs\/([^/]+)\/projects\/([^/]+)(\/.*)?$/);
      if (projectMatch) {
        const orgId = projectMatch[1];
        const projectId = projectMatch[2];
        const rest = projectMatch[3] || '';

        if (rest === '' && req.method === 'GET') {
          const g = guard(src, req, ACTIONS.read_source, { org: orgId, project: projectId });
          if (g) return json(res, g.status, g.body);
          const p = src.getProject(orgId, projectId);
          if (!p) return json(res, 404, { error: 'not found' });
          return json(res, 200, selectFields(p, fields));
        }

        if (rest === '/policy' && req.method === 'GET') {
          const g = guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId });
          if (g) return json(res, g.status, g.body);
          return json(res, 200, src.getPolicy(orgId, projectId));
        }

        if (rest === '/work' && req.method === 'GET') {
          const g = guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId });
          const pagination = parseListParams(url);
          if (g) return json(res, g.status, g.body);
          const requestLimit = pagination.limit ? pagination.limit + 1 : null;
          return json(
            res,
            200,
            paginatedResponse(
              src.listWork(orgId, projectId, {
                cursor: pagination.cursor,
                limit: requestLimit,
              }),
              pagination,
              fields,
            ),
          );
        }

        // Contribution flow: a Git-only developer submits a change from a
        // working clone. Source creates the Work → Session → Change → Evidence
        // lifecycle server-side. Public by design (low-friction onboarding);
        // rate-limited by client address.
        if (rest === '/submit' && req.method === 'POST') {
          const ip = req.socket.remoteAddress || 'unknown';
          if (!limiter.allow(`submit:${ip}`, limits.submit)) {
            return json(res, 429, { error: 'rate limit exceeded' });
          }
          const body = await readBody(req, maxJsonBodyBytes);
          const r = await src.submitContributionAsync({ orgId, projectId, ...body });
          return json(res, 201, r);
        }

        const workMatch = rest.match(/^\/work\/([^/]+)(\/.*)?$/);
        if (workMatch) {
          const workId = workMatch[1];
          const wrest = workMatch[2] || '';

          if (wrest === '' && req.method === 'GET') {
            const g = guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const w = src.getWork(orgId, projectId, workId);
            if (!w) return json(res, 404, { error: 'not found' });
            return json(res, 200, selectFields(w, fields));
          }

          if (wrest === '/claim' && req.method === 'POST') {
            const g = guard(src, req, ACTIONS.claim_work, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const body = await readBody(req, maxJsonBodyBytes);
            const w = src.claimWork({ orgId, projectId, workId, principalId: body.principalId });
            return json(res, 200, w);
          }

          if (wrest === '/sessions' && req.method === 'POST') {
            const ip = req.socket.remoteAddress || 'unknown';
            if (!limiter.allow(`session:${ip}`, limits.session)) {
              return json(res, 429, { error: 'rate limit exceeded' });
            }
            const g = guard(src, req, ACTIONS.start_session, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const body = await readBody(req, maxJsonBodyBytes);
            const s = src.startSession({ orgId, projectId, workId, principalId: body.principalId, environment: body.environment, baseCommit: body.baseCommit });
            // Issue a session-scoped capability (temporary session identity):
            // bounded to this org/project/work, expiring, denied accept/policy.
            const cap = src.issueSessionCapability({ orgId, projectId, workId, principalId: body.principalId });
            return json(res, 201, { ...s, capability: cap });
          }

          if (wrest === '/context' && req.method === 'GET') {
            const g = guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const w = src.getWork(orgId, projectId, workId);
            if (!w) return json(res, 404, { error: 'not found' });
            // Scoped, token-bounded context: intent, requirements, acceptance,
            // policy, and current status — not the whole repository.
            return json(res, 200, {
              workId: w.id,
              intent: w.intent,
              requirements: w.requirements,
              acceptanceConditions: w.acceptanceConditions,
              status: w.status,
              policy: src.getPolicy(orgId, projectId),
            });
          }

          if (wrest === '/changes' && req.method === 'POST') {
            const g = guard(src, req, ACTIONS.submit_change, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const body = await readBody(req, maxJsonBodyBytes);
            const c = src.submitChange({ orgId, projectId, workId, sessionId: body.sessionId, baseCommit: body.baseCommit, headCommit: body.headCommit, repositories: body.repositories, repositoryChanges: body.repositoryChanges });
            return json(res, 201, c);
          }
        }

        const changeMatch = rest.match(/^\/changes\/([^/]+)(\/.*)?$/);
        if (changeMatch) {
          const changeId = changeMatch[1];
          const crest = changeMatch[2] || '';
          const workId = changeWork(src, orgId, projectId, changeId);

          if (crest === '' && req.method === 'GET') {
            const g = guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const c = src.getChange(orgId, projectId, changeId);
            if (!c) return json(res, 404, { error: 'not found' });
            return json(res, 200, selectFields(c, fields));
          }

          if (crest === '/evidence' && req.method === 'POST') {
            const g = guard(src, req, ACTIONS.submit_evidence, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const body = await readBody(req, maxJsonBodyBytes);
            const e = src.addEvidence({ orgId, projectId, changeId, ...body });
            return json(res, 201, e);
          }

          if (crest === '/evaluate' && req.method === 'POST') {
            const g = guard(src, req, ACTIONS.submit_evidence, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const r = src.evaluateChange({ orgId, projectId, changeId });
            return json(res, 200, { evaluation: r.evaluation, interpretation: r.interpretation });
          }

          if (crest === '/scan' && req.method === 'GET') {
            const g = guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const findings = await src.scanChangeSecretsAsync({ orgId, projectId, changeId });
            return json(res, 200, { findings });
          }

          if (crest === '/decision' && req.method === 'GET') {
            const g = guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const c = src.getChange(orgId, projectId, changeId);
            if (!c) return json(res, 404, { error: 'not found' });
            const decisions = (c.decisions || []).map((id) => src.getDecision(orgId, projectId, id)).filter(Boolean);
            return json(res, 200, decisions);
          }

          if (crest === '/decision' && req.method === 'POST') {
            const g = guard(src, req, ACTIONS.accept_change, { org: orgId, project: projectId });
            if (g) return json(res, g.status, g.body);
            const body = await readBody(req, maxJsonBodyBytes);
            const d = src.makeDecision({ orgId, projectId, changeId, decision: body.decision, decider: body.decider, reasoning: body.reasoning });
            return json(res, 201, d);
          }
        }

        const evidenceMatch = rest.match(/^\/evidence\/([^/]+)(\/.*)?$/);
        if (evidenceMatch) {
          const evidenceId = evidenceMatch[1];
          const erest = evidenceMatch[2] || '';
          if (erest === '' && req.method === 'GET') {
            const g = guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId });
            if (g) return json(res, g.status, g.body);
            const e = src.getEvidence(orgId, projectId, evidenceId);
            if (!e) return json(res, 404, { error: 'not found' });
            return json(res, 200, e);
          }
          if (erest === '/artifact' && req.method === 'GET') {
            const g = guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId });
            if (g) return json(res, g.status, g.body);
            const e = src.getEvidence(orgId, projectId, evidenceId);
            if (!e || !e.artifactRef) return json(res, 404, { error: 'not found' });
            const bytes = src.getArtifact(e.artifactRef.hash);
            if (!bytes) return json(res, 404, { error: 'artifact not found' });
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            return res.end(bytes);
          }
        }
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  };

  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = maxConnections;
  return server;
}

export function startServer(src, opts) {
  const server = createServer(src, opts);
  return new Promise((resolve) => {
    server.listen(opts.port ?? 8787, opts.host, () => resolve(server));
  });
}
