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
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Source } from './source.js';
import { renderOrgIndexAsync, renderIndexAsync, renderProjectAsync, renderWorkAsync, renderChangeAsync, renderLogin, renderRepositoryAsync, renderBlobAsync, renderCommitAsync, renderActionsAsync, renderActionDetailAsync, renderSettingsAsync, managementPage, esc } from './web.js';
import { gitHttpBackend } from './git-http.js';
import { ACTIONS, authorizeRequest, authorizeRequestAsync, authorizeGit, authorizeGitAsync, bearerCredential } from './auth.js';
import { RateLimiter } from './ratelimit.js';
import { KeyedSemaphore, Semaphore } from './concurrency.js';

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function metrics(res, state, src, gitSlots, gitTenantSlots, artifactSlots, requestSlots, secretBroker, writerLease) {
  const lines = [
    '# HELP source_requests_total Total HTTP requests received.',
    '# TYPE source_requests_total counter',
    `source_requests_total ${state.requestsTotal}`,
    '# HELP source_responses_total Total HTTP responses completed.',
    '# TYPE source_responses_total counter',
    `source_responses_total ${state.responsesTotal}`,
    '# HELP source_active_requests Current requests being handled.',
    '# TYPE source_active_requests gauge',
    `source_active_requests ${state.activeRequests}`,
    '# HELP source_aborted_requests_total Requests whose clients disconnected before completion.',
    '# TYPE source_aborted_requests_total counter',
    `source_aborted_requests_total ${state.abortedRequests}`,
  ];
  const pool = typeof src?.store?.poolStats === 'function' ? src.store.poolStats() : null;
  if (pool) {
    lines.push(
      '# HELP source_postgres_pool_connections Current total Postgres pool connections.',
      '# TYPE source_postgres_pool_connections gauge',
      `source_postgres_pool_connections ${pool.total}`,
      '# HELP source_postgres_pool_idle Current idle Postgres pool connections.',
      '# TYPE source_postgres_pool_idle gauge',
      `source_postgres_pool_idle ${pool.idle}`,
      '# HELP source_postgres_pool_waiting Current requests waiting for a Postgres connection.',
      '# TYPE source_postgres_pool_waiting gauge',
      `source_postgres_pool_waiting ${pool.waiting}`,
      '# HELP source_postgres_fallback_active Current legacy psql fallback processes.',
      '# TYPE source_postgres_fallback_active gauge',
      `source_postgres_fallback_active ${pool.fallbackActive}`,
      '# HELP source_postgres_admission_active Current admitted database operations.',
      '# TYPE source_postgres_admission_active gauge',
      `source_postgres_admission_active ${pool.admissionActive || 0}`,
      '# HELP source_postgres_admission_waiting Current operations waiting for database admission.',
      '# TYPE source_postgres_admission_waiting gauge',
      `source_postgres_admission_waiting ${pool.admissionWaiting || 0}`,
      '# HELP source_postgres_admission_rejected_total Database operations rejected by the bounded admission queue.',
      '# TYPE source_postgres_admission_rejected_total counter',
      `source_postgres_admission_rejected_total ${pool.admissionRejected || 0}`,
    );
  }
  if (gitSlots) {
    lines.push(
      '# HELP source_git_admission_rejected_total Git requests rejected by the global admission queue.',
      '# TYPE source_git_admission_rejected_total counter',
      `source_git_admission_rejected_total ${gitSlots.rejected || 0}`,
      '# HELP source_git_tenant_buckets Current active per-project Git admission buckets.',
      '# TYPE source_git_tenant_buckets gauge',
      `source_git_tenant_buckets ${gitTenantSlots?.buckets?.size || 0}`,
      '# HELP source_git_tenant_admission_rejected_total Git requests rejected by per-project admission.',
      '# TYPE source_git_tenant_admission_rejected_total counter',
      `source_git_tenant_admission_rejected_total ${gitTenantSlots?.rejected || 0}`,
    );
  }
  if (artifactSlots) {
    lines.push(
      '# HELP source_artifact_admission_rejected_total Artifact downloads rejected by the bounded admission queue.',
      '# TYPE source_artifact_admission_rejected_total counter',
      `source_artifact_admission_rejected_total ${artifactSlots.rejected || 0}`,
      '# HELP source_artifact_admission_active Current artifact downloads admitted.',
      '# TYPE source_artifact_admission_active gauge',
      `source_artifact_admission_active ${artifactSlots.active || 0}`,
    );
  }
  if (requestSlots) {
    lines.push(
      '# HELP source_request_admission_active Current admitted HTTP requests.',
      '# TYPE source_request_admission_active gauge',
      `source_request_admission_active ${requestSlots.active || 0}`,
      '# HELP source_request_admission_waiting Current HTTP requests waiting for admission.',
      '# TYPE source_request_admission_waiting gauge',
      `source_request_admission_waiting ${requestSlots.waiters?.length || 0}`,
      '# HELP source_request_admission_rejected_total HTTP requests rejected by bounded admission.',
      '# TYPE source_request_admission_rejected_total counter',
      `source_request_admission_rejected_total ${requestSlots.rejected || 0}`,
    );
  }
  const secretMetrics = typeof secretBroker?.metrics === 'function' ? secretBroker.metrics() : null;
  if (secretMetrics) {
    lines.push(
      '# HELP source_secret_leases_issued_total Secret leases issued.',
      '# TYPE source_secret_leases_issued_total counter',
      `source_secret_leases_issued_total ${secretMetrics.issued || 0}`,
      '# HELP source_secret_leases_denied_total Secret lease requests denied.',
      '# TYPE source_secret_leases_denied_total counter',
      `source_secret_leases_denied_total ${secretMetrics.denied || 0}`,
      '# HELP source_secret_leases_revoked_total Secret leases revoked.',
      '# TYPE source_secret_leases_revoked_total counter',
      `source_secret_leases_revoked_total ${secretMetrics.revoked || 0}`,
      '# HELP source_secret_leases_active Current active secret lease metadata entries.',
      '# TYPE source_secret_leases_active gauge',
      `source_secret_leases_active ${secretMetrics.activeLeases || 0}`,
      '# HELP source_secret_provider_health_checks_total Secret provider health checks.',
      '# TYPE source_secret_provider_health_checks_total counter',
      `source_secret_provider_health_checks_total ${secretMetrics.healthChecks || 0}`,
      '# HELP source_secret_provider_health_failures_total Secret provider health check failures.',
      '# TYPE source_secret_provider_health_failures_total counter',
      `source_secret_provider_health_failures_total ${secretMetrics.healthFailures || 0}`,
    );
  }
  const writerMetrics = typeof writerLease?.metrics === 'function' ? writerLease.metrics() : null;
  if (writerMetrics) {
    lines.push(
      '# HELP source_writer_lease_active Whether this process currently holds the writer lease.',
      '# TYPE source_writer_lease_active gauge',
      `source_writer_lease_active ${writerMetrics.active || 0}`,
      '# HELP source_writer_lease_acquisitions_total Writer lease acquisitions.',
      '# TYPE source_writer_lease_acquisitions_total counter',
      `source_writer_lease_acquisitions_total ${writerMetrics.acquisitions || 0}`,
      '# HELP source_writer_lease_contention_total Writer lease acquisition contention events.',
      '# TYPE source_writer_lease_contention_total counter',
      `source_writer_lease_contention_total ${writerMetrics.contention || 0}`,
      '# HELP source_writer_lease_renewals_total Writer lease renewals.',
      '# TYPE source_writer_lease_renewals_total counter',
      `source_writer_lease_renewals_total ${writerMetrics.renewals || 0}`,
      '# HELP source_writer_lease_renewal_failures_total Writer lease renewal failures.',
      '# TYPE source_writer_lease_renewal_failures_total counter',
      `source_writer_lease_renewal_failures_total ${writerMetrics.renewalFailures || 0}`,
      '# HELP source_writer_lease_lost_total Writer lease loss events.',
      '# TYPE source_writer_lease_lost_total counter',
      `source_writer_lease_lost_total ${writerMetrics.lost || 0}`,
    );
  }
  const canonicalSlots = src?.canonicalGlobalSlots;
  if (canonicalSlots) {
    lines.push(
      '# HELP source_canonical_admission_active Current canonical promotions admitted globally.',
      '# TYPE source_canonical_admission_active gauge',
      `source_canonical_admission_active ${canonicalSlots.active || 0}`,
      '# HELP source_canonical_admission_waiting Current canonical promotions waiting globally.',
      '# TYPE source_canonical_admission_waiting gauge',
      `source_canonical_admission_waiting ${canonicalSlots.waiters?.length || 0}`,
      '# HELP source_canonical_admission_rejected_total Canonical promotions rejected by the global admission gate.',
      '# TYPE source_canonical_admission_rejected_total counter',
      `source_canonical_admission_rejected_total ${canonicalSlots.rejected || 0}`,
    );
  }
  for (const [status, count] of state.statuses) lines.push(`source_responses_by_status_total{status="${status}"} ${count}`);
  const body = `${lines.join('\n')}\n`;
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function isRetryableStoreError(error) {
  const code = String(error?.code || '');
  return code === 'DB_ADMISSION_EXHAUSTED'
    || code === 'CANONICAL_ADMISSION_EXHAUSTED'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT'
    || code === '53300'
    || code === '57P01'
    || code === '40001'
    || code === '40P01';
}

function requestIdempotencyKey(req, orgId, projectId, index = '') {
  const raw = req.headers['idempotency-key'];
  if (raw == null) return null;
  const key = Array.isArray(raw) ? raw[0] : String(raw);
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new Error('Idempotency-Key must contain 1-200 safe characters');
  return `http:${createHash('sha256').update(`${orgId}\0${projectId}\0${key}\0${index}`).digest('hex')}`;
}

function readText(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    req.on('aborted', () => {
      if (!settled) {
        settled = true;
        reject(new Error('request body aborted'));
      }
    });
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

function validWebhookSignature(raw, header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const supplied = header.replace(/^sha256=/i, '').trim();
  if (!/^[0-9a-f]{64}$/i.test(supplied)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  return timingSafeEqual(Buffer.from(supplied.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
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
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    req.on('aborted', () => {
      if (!settled) {
        settled = true;
        reject(new Error('request body aborted'));
      }
    });
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

async function sessionCredential(src, req) {
  const bearer = bearerCredential(req);
  if (bearer) return bearer;
  const sessionId = parseSessionCookie(req.headers.cookie);
  if (!sessionId) return null;
  const session = typeof src.getHumanSessionAsync === 'function'
    ? await src.getHumanSessionAsync(sessionId)
    : src.getHumanSession(sessionId);
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
async function guard(src, req, action, scope) {
  const credential = await sessionCredential(src, req);
  const r = typeof src.capabilities.authorizeAsync === 'function'
    ? await authorizeRequestAsync(src.capabilities, req, action, { ...scope, credential })
    : authorizeRequest(src.capabilities, req, action, { ...scope, credential });
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

function clientAddress(req, trustProxy = false) {
  const remote = req.socket.remoteAddress || 'unknown';
  if (!trustProxy) return remote;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers['x-real-ip'];
  return typeof real === 'string' && real.trim() ? real.trim() : remote;
}

// Resolve the Work id a Change belongs to (for work-scoped capability checks).
async function changeWork(src, orgId, projectId, changeId) {
  const c = typeof src.getChangeAsync === 'function'
    ? await src.getChangeAsync(orgId, projectId, changeId)
    : src.getChange(orgId, projectId, changeId);
  return c ? c.workId : undefined;
}

export function createServer(src, { port = 8787, tls, host, trustProxy = false, webhookSecret = process.env.SOURCE_WEBHOOK_SECRET || null, secretBroker = null, writerLease = null, rateLimit = {}, maxJsonBodyBytes = 1_000_000, maxJobPayloadBytes = 64 * 1024, maxJobQueueDepth = 100_000, maxWorkflowJobs = 1_000, maxGitBodyBytes = 100_000_000, maxChunkedGitBodyBytes = 16 * 1024 * 1024, maxGitResponseBytes = 512 * 1024 * 1024, gitConcurrency = 32, gitQueue = 256, gitTenantConcurrency = 8, gitTenantQueue = 256, gitTimeoutMs = 120_000, artifactConcurrency = 8, artifactQueue = 64, requestConcurrency = 2_048, requestQueue = 4_096, maxConnections = 10_000, requireReplication = false, replicationRole = 'primary', replicationMinStandbys = 1, replicationMaxLagBytes = 64 * 1024 * 1024, readOnly = false } = {}) {
  const limiter = new RateLimiter({ maxKeys: rateLimit.maxKeys || 100_000, store: rateLimit.store || src.store });
  const gitSlots = new Semaphore({ capacity: gitConcurrency, queue: gitQueue });
  const gitTenantSlots = new KeyedSemaphore({ capacity: gitTenantConcurrency, queue: gitTenantQueue, maxKeys: rateLimit.maxKeys || 100_000 });
  const chunkedGitSlots = new Semaphore({ capacity: Math.max(1, Math.min(4, gitConcurrency)), queue: Math.max(0, Math.min(32, gitQueue)) });
  const artifactSlots = new Semaphore({
    capacity: Math.min(256, Math.max(1, Math.trunc(artifactConcurrency))),
    queue: Math.min(10_000, Math.max(0, Math.trunc(artifactQueue))),
  });
  const requestSlots = new Semaphore({
    capacity: Math.min(10_000, Math.max(1, Math.trunc(requestConcurrency))),
    queue: Math.min(100_000, Math.max(0, Math.trunc(requestQueue))),
  });
  const limits = {
    submit: { limit: 10, windowMs: 60_000, ...(rateLimit.submit || {}) },
    gitPush: { limit: 30, windowMs: 60_000, ...(rateLimit.gitPush || {}) },
    gitRead: { limit: 120, windowMs: 60_000, ...(rateLimit.gitRead || {}) },
    jobEnqueue: { limit: 120, windowMs: 60_000, ...(rateLimit.jobEnqueue || {}) },
    workflowDispatch: { limit: 120, windowMs: 60_000, ...(rateLimit.workflowDispatch || {}) },
    login: { limit: 20, windowMs: 60_000, ...(rateLimit.login || {}) },
    session: { limit: 30, windowMs: 60_000, ...(rateLimit.session || {}) },
  };

  const handler = async (req, res) => {
    const state = server.metrics;
    state.requestsTotal += 1;
    state.activeRequests += 1;
    let accounted = false;
    let releaseRequest = null;
    const accountResponse = (aborted) => {
      if (accounted) return;
      accounted = true;
      state.activeRequests = Math.max(0, state.activeRequests - 1);
      if (aborted) state.abortedRequests += 1;
      else {
        state.responsesTotal += 1;
        const status = String(res.statusCode || 200);
        state.statuses.set(status, (state.statuses.get(status) || 0) + 1);
      }
      if (releaseRequest) {
        releaseRequest();
        releaseRequest = null;
      }
    };
    res.once('finish', () => accountResponse(false));
    res.once('close', () => { if (!res.writableFinished) accountResponse(true); });
    releaseRequest = await requestSlots.acquire();
    if (!releaseRequest) {
      res.setHeader('Retry-After', '1');
      return json(res, 503, { error: 'request capacity exhausted', retryable: true });
    }
    if (req.aborted) return res.destroy();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const fields = url.searchParams.get('fields') || undefined;

    try {
      if (req.method === 'GET' && pathname === '/metrics') return metrics(res, state, src, gitSlots, gitTenantSlots, artifactSlots, requestSlots, server.secretBroker, server.writerLease);
      if (server.draining && pathname !== '/healthz' && pathname !== '/readyz') {
        return json(res, 503, { error: 'server is draining' });
      }
      if (server.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        res.setHeader('Retry-After', '5');
        return json(res, 503, { error: 'read-only replica', retryable: true });
      }
      if (server.writerLease && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        await server.writerLease.assertAsync();
      }
      // --- login ---------------------------------------------------------
      if (req.method === 'GET' && pathname === '/login') {
        return loginPage(res, 200);
      }

      if (req.method === 'POST' && pathname === '/login') {
        const ip = clientAddress(req, trustProxy);
        if (!(await limiter.allowAsync(`login:${ip}`, limits.login))) {
          if (wantsJson(req)) return json(res, 429, { error: 'rate limit exceeded' });
          return loginPage(res, 429, 'rate limit exceeded');
        }
        const body = await readLoginBody(req);
        const principalId = body.principalId || null;
        const password = body.password || null;
        const orgId = body.orgId || undefined;
        const projectId = body.projectId || undefined;

        const principal = principalId
          ? (typeof src.getPrincipalAsync === 'function' ? await src.getPrincipalAsync(principalId) : src.getPrincipal(principalId))
          : null;
        const passwordOk = principal
          ? (typeof src.verifyPrincipalPasswordAsync === 'function'
            ? await src.verifyPrincipalPasswordAsync(principal.id, password)
            : src.verifyPrincipalPassword(principal.id, password))
          : false;
        if (!principal || !passwordOk) {
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
        const membership = typeof src.getOrgMembershipAsync === 'function'
          ? await src.getOrgMembershipAsync(orgId, principal.id)
          : src.getOrgMembership(orgId, principal.id);
        const project = typeof src.getProjectAsync === 'function'
          ? await src.getProjectAsync(orgId, projectId)
          : src.getProject(orgId, projectId);
        if (!membership || !project) {
          if (wantsJson(req)) return json(res, 403, { error: 'principal is not a member of this project' });
          return loginPage(res, 403, 'principal is not a member of this project');
        }
        const allowed = ['read_source', 'read_context'];
        if (membership.role === 'maintainer' || membership.role === 'admin') allowed.push('accept_change');
        if (body.management === '1' || body.management === 'true') {
          allowed.push('read_workflows', 'read_jobs', 'claim_work', 'start_session', 'submit_change', 'submit_evidence', 'dispatch_workflow', 'enqueue_job', 'git_push');
          if (membership.role === 'maintainer' || membership.role === 'admin') allowed.push('manage_work', 'manage_repository', 'manage_workflows');
          if (membership.role === 'admin') allowed.push('manage_org', 'manage_project');
        }
        const session = typeof src.createHumanSessionAsync === 'function'
          ? await src.createHumanSessionAsync({ principalId: principal.id, orgId, projectId, allowed })
          : src.createHumanSession({ principalId: principal.id, orgId, projectId, allowed });
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
        if (sessionId) {
          if (typeof src.revokeHumanSessionAsync === 'function') await src.revokeHumanSessionAsync(sessionId);
          else src.revokeHumanSession(sessionId);
        }
        const cookie = clearSessionHeader();
        if (wantsHtml(req)) {
          res.writeHead(303, { Location: '/login', 'Set-Cookie': cookie });
          return res.end();
        }
        const bodyOut = JSON.stringify({ ok: true, revoked: Boolean(sessionId) });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie, 'Content-Length': Buffer.byteLength(bodyOut) });
        res.end(bodyOut);
      }

      if (req.method === 'POST' && pathname === '/admin/orgs') {
        const g = await guard(src, req, ACTIONS.manage_org, {});
        if (g) return loginPage(res, g.status, g.body.error);
        const body = await readLoginBody(req);
        const org = await src.createOrgAsync({ name: body.name, slug: body.slug });
        return redirect(res, `/o/${encodeURIComponent(org.id)}`);
      }

      const projectCreateMatch = pathname.match(/^\/o\/([^/]+)\/projects$/);
      if (req.method === 'POST' && projectCreateMatch) {
        const orgId = projectCreateMatch[1];
        const g = await guard(src, req, ACTIONS.manage_project, { org: orgId });
        if (g) return loginPage(res, g.status, g.body.error);
        const body = await readLoginBody(req);
        const project = await src.createProjectAsync({ orgId, name: body.name, slug: body.slug, description: body.description || '', visibility: body.visibility || 'private' });
        return redirect(res, `/o/${encodeURIComponent(orgId)}/p/${encodeURIComponent(project.id)}`);
      }

      // Unauthenticated probes for load balancers and schedulers.
      if (req.method === 'GET' && pathname === '/healthz') {
        return json(res, 200, { status: 'ok' });
      }

      if (req.method === 'GET' && pathname === '/readyz') {
        if (server.draining) return json(res, 503, { status: 'not_ready', reason: 'server is draining' });
        try {
          if (typeof src.checkHealthAsync === 'function') await src.checkHealthAsync();
          else if (typeof src.store.checkHealthAsync === 'function') await src.store.checkHealthAsync();
          if (server.secretBroker) await server.secretBroker.checkHealth();
          if (server.writerLease) await server.writerLease.assertAsync();
          if (server.requireReplication) {
            if (typeof src.store.checkReplicationAsync !== 'function') throw new Error('replication readiness is not supported by the configured store');
            await src.store.checkReplicationAsync({ role: server.replicationRole, minStandbys: server.replicationMinStandbys, maxLagBytes: server.replicationMaxLagBytes });
          }
          const instance = await src.getInstanceAsync();
          if (!instance) return json(res, 503, { status: 'not_ready', reason: 'instance not initialized' });
          return json(res, 200, { status: 'ready', storage: 'ok' });
        } catch {
          return json(res, 503, { status: 'not_ready', reason: 'storage unavailable' });
        }
      }

      // --- human-facing HTML views ---------------------------------------
      if (req.method === 'GET' && pathname === '/') {
        const g = await guard(src, req, ACTIONS.read_source, {});
        if (g) return loginPage(res, g.status, g.body.error);
        return html(res, 200, await renderOrgIndexAsync(src));
      }

      // --- human-facing repository and workflow management ---------------
      const managementMatch = pathname.match(/^\/o\/([^/]+)\/p\/([^/]+)\/(.*)$/);
      if (managementMatch) {
        const [, orgId, projectId, managementPath] = managementMatch;
        if (req.method === 'GET' && managementPath === 'actions') {
          const g = await guard(src, req, ACTIONS.read_workflows, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          return html(res, 200, await renderActionsAsync(src, orgId, projectId));
        }
        const actionDetail = managementPath.match(/^actions\/([^/]+)$/);
        if (req.method === 'GET' && actionDetail) {
          const g = await guard(src, req, ACTIONS.read_workflows, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          return html(res, 200, await renderActionDetailAsync(src, orgId, projectId, actionDetail[1]));
        }
        if (req.method === 'GET' && managementPath === 'settings') {
          const g = await guard(src, req, ACTIONS.read_source, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          return html(res, 200, await renderSettingsAsync(src, orgId, projectId));
        }
        const repoTree = managementPath.match(/^r\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/);
        if (req.method === 'GET' && repoTree) {
          const g = await guard(src, req, ACTIONS.read_source, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          const ref = decodeURIComponent(repoTree[2]);
          const directory = (repoTree[3] || '').split('/').filter(Boolean).map(decodeURIComponent).join('/');
          return html(res, 200, await renderRepositoryAsync(src, orgId, projectId, repoTree[1], ref, directory));
        }
        const repoBlob = managementPath.match(/^r\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
        if (req.method === 'GET' && repoBlob) {
          const g = await guard(src, req, ACTIONS.read_source, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          const filePath = repoBlob[3].split('/').map(decodeURIComponent).join('/');
          return html(res, 200, await renderBlobAsync(src, orgId, projectId, repoBlob[1], decodeURIComponent(repoBlob[2]), filePath));
        }
        const repoCommit = managementPath.match(/^r\/([^/]+)\/commit\/([0-9a-f]{7,64})$/i);
        if (req.method === 'GET' && repoCommit) {
          const g = await guard(src, req, ACTIONS.read_source, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          return html(res, 200, await renderCommitAsync(src, orgId, projectId, repoCommit[1], repoCommit[2]));
        }
        if (req.method === 'POST' && managementPath === 'repos') {
          const g = await guard(src, req, ACTIONS.manage_repository, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          const body = await readLoginBody(req);
          const repo = await src.createRepositoryAsync({ orgId, projectId, name: body.name, defaultBranch: body.defaultBranch || 'main' });
          return redirect(res, `/o/${encodeURIComponent(orgId)}/p/${encodeURIComponent(projectId)}/r/${encodeURIComponent(repo.id)}/tree/${encodeURIComponent(repo.defaultBranch)}`);
        }
        if (req.method === 'POST' && managementPath === 'work') {
          const g = await guard(src, req, ACTIONS.manage_work, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          const body = await readLoginBody(req);
          const split = (value) => String(value || '').split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
          const work = await src.createWorkAsync({ orgId, projectId, intent: body.intent, requester: (await sessionCredential(src, req)) || 'web', requirements: split(body.requirements), acceptanceConditions: split(body.acceptanceConditions) });
          return redirect(res, `/o/${encodeURIComponent(orgId)}/p/${encodeURIComponent(projectId)}/w/${encodeURIComponent(work.id)}`);
        }
        if (req.method === 'POST' && managementPath === 'settings/members') {
          const g = await guard(src, req, ACTIONS.manage_project, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          const body = await readLoginBody(req);
          await src.addOrgMemberAsync({ orgId, principalId: body.principalId, role: body.role || 'member' });
          return redirect(res, `/o/${encodeURIComponent(orgId)}/p/${encodeURIComponent(projectId)}/settings`);
        }
        const workAction = managementPath.match(/^w\/([^/]+)\/(claim|sessions)$/);
        if (req.method === 'POST' && workAction) {
          const workId = workAction[1];
          const action = workAction[2];
          const body = await readLoginBody(req);
          const credential = await sessionCredential(src, req);
          const required = action === 'claim' ? ACTIONS.claim_work : ACTIONS.start_session;
          const auth = await authorizeRequestAsync(src.capabilities, req, required, { org: orgId, project: projectId, work: workId, credential });
          if (!auth.ok) return loginPage(res, auth.status, auth.error);
          if (action === 'claim') {
            await src.claimWorkAsync({ orgId, projectId, workId, principalId: auth.cap.principalId });
          } else {
            const environment = typeof body.environment === 'string' ? JSON.parse(body.environment || '{}') : body.environment || {};
            await src.startSessionAsync({ orgId, projectId, workId, principalId: auth.cap.principalId, environment, baseCommit: body.baseCommit || '' });
          }
          return redirect(res, `/o/${encodeURIComponent(orgId)}/p/${encodeURIComponent(projectId)}/w/${encodeURIComponent(workId)}`);
        }
        if (req.method === 'POST' && managementPath === 'actions') {
          const g = await guard(src, req, ACTIONS.manage_workflows, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          const body = await readLoginBody(req);
          const jobs = typeof body.jobs === 'string' ? JSON.parse(body.jobs) : body.jobs;
          const workflow = await src.createWorkflowAsync({ orgId, projectId, name: body.name, triggers: String(body.triggers || 'push').split(',').map((item) => item.trim()).filter(Boolean), jobs });
          return redirect(res, `/o/${encodeURIComponent(orgId)}/p/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(workflow.id)}`);
        }
        if (req.method === 'POST' && managementPath === 'actions/import') {
          const g = await guard(src, req, ACTIONS.manage_workflows, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          const body = await readLoginBody(req);
          const workflow = await src.importGitHubWorkflowAsync({ orgId, projectId, repoId: body.repository, ref: body.ref || 'HEAD', path: body.path });
          return redirect(res, `/o/${encodeURIComponent(orgId)}/p/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(workflow.id)}`);
        }
        const dispatch = managementPath.match(/^actions\/([^/]+)\/dispatch$/);
        if (req.method === 'POST' && dispatch) {
          const g = await guard(src, req, ACTIONS.dispatch_workflow, { org: orgId, project: projectId });
          if (g) return loginPage(res, g.status, g.body.error);
          const body = await readLoginBody(req);
          const payload = typeof body.payload === 'string' ? JSON.parse(body.payload || '{}') : body.payload || {};
          await src.dispatchWorkflowAsync({ orgId, projectId, workflowId: dispatch[1], event: body.event, eventId: body.eventId || null, payload });
          return redirect(res, `/o/${encodeURIComponent(orgId)}/p/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(dispatch[1])}`);
        }
        const changeAction = managementPath.match(/^c\/([^/]+)\/(decision|evidence|evaluate|scan|canonical)$/);
        if (changeAction) {
          const changeId = changeAction[1];
          const action = changeAction[2];
          const workId = await changeWork(src, orgId, projectId, changeId);
          if (action === 'scan' && req.method === 'GET') {
            const g = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return loginPage(res, g.status, g.body.error);
            const findings = await src.scanChangeSecretsAsync({ orgId, projectId, changeId });
            return html(res, 200, managementPage(`Secret scan ${changeId}`, `<h1>Secret scan</h1><pre>${esc(JSON.stringify(findings, null, 2))}</pre><p><a href="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(changeId)}">Back to change</a></p>`, orgId, projectId));
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          const body = await readLoginBody(req);
          if (action === 'decision') {
            const g = await guard(src, req, ACTIONS.accept_change, { org: orgId, project: projectId });
            if (g) return loginPage(res, g.status, g.body.error);
            const credential = await sessionCredential(src, req);
            const auth = await authorizeRequestAsync(src.capabilities, req, ACTIONS.accept_change, { org: orgId, project: projectId, credential });
            if (!auth.ok) return loginPage(res, auth.status, auth.error);
            await src.makeDecisionAsync({ orgId, projectId, changeId, decision: body.decision, decider: auth.cap.principalId, reasoning: body.reasoning || '' });
          } else if (action === 'evidence') {
            const g = await guard(src, req, ACTIONS.submit_evidence, { org: orgId, project: projectId, work: workId });
            if (g) return loginPage(res, g.status, g.body.error);
            await src.addEvidenceAsync({ orgId, projectId, changeId, type: body.type, claim: body.claim, producer: body.producer || 'web', subject: body.subject || 'web', result: typeof body.result === 'string' ? JSON.parse(body.result || '{}') : body.result || {} });
          } else if (action === 'evaluate') {
            const g = await guard(src, req, ACTIONS.submit_evidence, { org: orgId, project: projectId, work: workId });
            if (g) return loginPage(res, g.status, g.body.error);
            await src.evaluateChangeAsync({ orgId, projectId, changeId });
          } else if (action === 'canonical') {
            const g = await guard(src, req, ACTIONS.accept_change, { org: orgId, project: projectId });
            if (g) return loginPage(res, g.status, g.body.error);
            await src.updateCanonicalStateAsync({ orgId, projectId, changeId });
          }
          return redirect(res, `/o/${encodeURIComponent(orgId)}/p/${encodeURIComponent(projectId)}/c/${encodeURIComponent(changeId)}`);
        }
      }

      const orgPageMatch = pathname.match(/^\/o\/([^/]+)$/);
      if (req.method === 'GET' && orgPageMatch) {
        const [, orgId] = orgPageMatch;
        const g = await guard(src, req, ACTIONS.read_source, { org: orgId });
        if (g) return loginPage(res, g.status, g.body.error);
        return html(res, 200, await renderIndexAsync(src, orgId));
      }

      const pMatch = pathname.match(/^\/o\/([^/]+)\/p\/([^/]+)(?:\/w\/([^/]+))?(?:\/c\/([^/]+))?$/);
      if (req.method === 'GET' && pMatch) {
        const [, orgId, projectId, workId, changeId] = pMatch;
        const g = await guard(src, req, ACTIONS.read_source, { org: orgId, project: projectId });
        if (g) return loginPage(res, g.status, g.body.error);

        if (changeId) {
          const c = await src.getChangeAsync(orgId, projectId, changeId);
          if (!c) return html(res, 404, '<!doctype html><html><body><h1>Not found</h1></body></html>');
          return html(res, 200, await renderChangeAsync(src, orgId, projectId, changeId));
        }

        if (workId) {
          const wc = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
          if (wc) return loginPage(res, wc.status, wc.body.error);
          return html(res, 200, await renderWorkAsync(src, orgId, projectId, workId));
        }
        return html(res, 200, await renderProjectAsync(src, orgId, projectId));
      }

      // --- discovery (public) ---------------------------------------------
      if (pathname === '/.well-known/source') {
        if (!server.discoveryInstancePromise) {
          server.discoveryInstancePromise = Promise.resolve(
            typeof src.getInstanceAsync === 'function' ? src.getInstanceAsync() : src.getInstance(),
          );
        }
        return json(res, 200, {
          instance: (await server.discoveryInstancePromise)?.name ?? 'source',
          api_version: '1',
          protocols: ['http+json', 'git-smart-http'],
          endpoints: {
            orgs: '/api/v1/orgs',
            projects: '/api/v1/orgs/{org}/projects',
            work: '/api/v1/orgs/{org}/projects/{project}/work',
            changes: '/api/v1/orgs/{org}/projects/{project}/changes',
            jobs: '/api/v1/orgs/{org}/projects/{project}/jobs',
            jobs_batch: '/api/v1/orgs/{org}/projects/{project}/jobs/batch',
            workflows: '/api/v1/orgs/{org}/projects/{project}/workflows',
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
        const repo = await src.resolveRepositoryAsync(orgId, projectId, repoRef);
        if (!repo) return json(res, 404, { error: 'repository not found' });

        // Auth: read (upload-pack) vs write (receive-pack). Public repos allow
        // anonymous read; private repos require read_source; push always
        // requires git_push. Enforced here, before delegating to git.
        const service = url.searchParams.get('service') || '';
        const isWrite = service === 'git-receive-pack' || rest.includes('git-receive-pack');

        // Git only has three documented smart-HTTP path forms.  Passing an
        // arbitrary suffix to PATH_INFO would let Git normalize dot segments
        // after Source authorized a different repository.
        let decodedRest = rest;
        try {
          for (let i = 0; i < 2 && decodedRest.includes('%'); i += 1) decodedRest = decodeURIComponent(decodedRest);
        } catch {
          return gitAuthError(res, 400, 'invalid Git path');
        }
        if (!/^\/(?:info\/refs|git-upload-pack|git-receive-pack)\/?$/.test(decodedRest)
          || decodedRest.includes('..') || decodedRest.includes('\\')) {
          return gitAuthError(res, 400, 'invalid Git path');
        }

        // Rate-limit the write path (push) by client address.
        const ip = clientAddress(req, trustProxy);
        if (isWrite) {
          if (!(await limiter.allowAsync(`gitpush:${ip}`, limits.gitPush))) {
            return gitAuthError(res, 429, 'rate limit exceeded');
          }
        } else if (repo.visibility === 'public' && !(await limiter.allowAsync(`gitread:${ip}`, limits.gitRead))) {
          return gitAuthError(res, 429, 'rate limit exceeded');
        }

        const auth = typeof src.capabilities.authorizeAsync === 'function'
          ? await authorizeGitAsync(src.capabilities, req, {
            org: orgId,
            project: projectId,
            visibility: repo.visibility,
            isWrite,
          })
          : authorizeGit(src.capabilities, req, {
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

        const tenantRelease = await gitTenantSlots.acquire(`${orgId}:${projectId}`);
        if (!tenantRelease) return gitAuthError(res, 503, 'Git tenant service busy; retry later');
        const release = await gitSlots.acquire();
        if (!release) {
          tenantRelease();
          return gitAuthError(res, 503, 'Git service busy; retry later');
        }
        let body = null;
        let releaseChunked = null;
        try {
          const abortController = new AbortController();
          req.once('aborted', () => abortController.abort());
          res.once('close', () => {
            if (!res.writableFinished) abortController.abort();
          });
          let input = null;
          let contentLength = null;
          if (req.method === 'POST') {
            const length = Number(req.headers['content-length']);
            if (Number.isFinite(length)) {
              input = req;
              contentLength = length;
            } else {
              releaseChunked = await chunkedGitSlots.acquire();
              if (!releaseChunked) return gitAuthError(res, 503, 'chunked Git uploads busy; retry later');
              body = await readRawBody(req, Math.min(maxGitBodyBytes, maxChunkedGitBodyBytes));
            }
          }

          let streamed = false;
          const result = await gitHttpBackend({
          projectRoot: src.reposRoot(orgId, projectId),
          pathInfo: `/${repo.id}.git${decodedRest}`,
          queryString: url.search ? url.search.slice(1) : '',
          method: req.method,
          contentType: req.headers['content-type'] || '',
          body,
          input,
          contentLength,
          maxInputBytes: maxGitBodyBytes,
          abortSignal: abortController.signal,
          timeoutMs: gitTimeoutMs,
          remoteUser: auth.remoteUser,
          remoteAddr: req.socket.remoteAddress || '',
          headers: req.headers,
          maxOutputBytes: maxGitResponseBytes,
          stream: {
            onHeaders: (cgi) => {
              streamed = true;
              const responseHeaders = { ...cgi.headers };
              res.writeHead(cgi.status, responseHeaders);
            },
            onBody: (chunk) => res.write(chunk),
            onDrain: (resume) => res.once('drain', resume),
            onError: (error) => {
              if (!res.writableEnded) res.destroy(error);
            },
            onEnd: () => {
              if (streamed && !res.writableEnded) res.end();
            },
          },
          });

          if (streamed) return;

          const headers = { ...result.headers };
          if (result.body && result.body.length && !headers['content-length']) {
            headers['Content-Length'] = String(result.body.length);
          }
          res.writeHead(result.status, headers);
          return res.end(result.body);
        } finally {
          releaseChunked?.();
          release();
          tenantRelease();
        }
      }

      // --- organizations (tenant boundary) --------------------------------
      if (pathname === '/api/v1/orgs' && req.method === 'GET') {
        const g = await guard(src, req, ACTIONS.read_source, {});
        const pagination = parseListParams(url);
        if (g) return json(res, g.status, g.body);
        const requestLimit = pagination.limit ? pagination.limit + 1 : null;
        const items = await src.listOrgsAsync({ cursor: pagination.cursor, limit: requestLimit });
        return json(res, 200, paginatedResponse(items, pagination, fields));
      }

      if (pathname === '/api/v1/orgs' && req.method === 'POST') {
        const g = await guard(src, req, ACTIONS.manage_org, {});
        if (g) return json(res, g.status, g.body);
        const body = await readBody(req, maxJsonBodyBytes);
        const org = await src.createOrgAsync({ name: body.name, slug: body.slug });
        return json(res, 201, org);
      }

      const orgMatch = pathname.match(/^\/api\/v1\/orgs\/([^/]+)$/);
      if (orgMatch && req.method === 'GET') {
        const orgId = orgMatch[1];
        const g = await guard(src, req, ACTIONS.read_source, { org: orgId });
        if (g) return json(res, g.status, g.body);
        const org = await src.getOrgAsync(orgId);
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
          const g = await guard(src, req, ACTIONS.read_source, { org: orgId, project: projectId });
          if (g) return json(res, g.status, g.body);
          const p = await src.getProjectAsync(orgId, projectId);
          if (!p) return json(res, 404, { error: 'not found' });
          return json(res, 200, selectFields(p, fields));
        }

        if (rest === '/policy' && req.method === 'GET') {
          const g = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId });
          if (g) return json(res, g.status, g.body);
          return json(res, 200, await src.getPolicyAsync(orgId, projectId));
        }

        if (rest === '/work' && req.method === 'GET') {
          const g = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId });
          const pagination = parseListParams(url);
          if (g) return json(res, g.status, g.body);
          const requestLimit = pagination.limit ? pagination.limit + 1 : null;
          return json(
            res,
            200,
            paginatedResponse(
              await src.listWorkAsync(orgId, projectId, {
                cursor: pagination.cursor,
                limit: requestLimit,
              }),
              pagination,
              fields,
            ),
          );
        }

        const workflowMatch = rest.match(/^\/workflows(?:\/([^/]+)(\/dispatch)?)?$/);
        if (rest === '/workflows/import-github' && req.method === 'POST') {
          const g = await guard(src, req, ACTIONS.manage_workflows, { org: orgId, project: projectId });
          if (g) return json(res, g.status, g.body);
          const body = await readBody(req, maxJsonBodyBytes);
          const workflow = await src.importGitHubWorkflowAsync({ orgId, projectId, repoId: body.repository, ref: body.ref || 'HEAD', path: body.path });
          return json(res, 201, workflow);
        }
        const webhookMatch = rest.match(/^\/workflows\/([^/]+)\/webhook$/);
        if (webhookMatch && req.method === 'POST') {
          if (!webhookSecret) return json(res, 503, { error: 'webhook ingress is not configured' });
          const ip = clientAddress(req, trustProxy);
          if (!(await limiter.allowAsync(`webhook:${ip}:${orgId}:${projectId}`, limits.workflowDispatch))) return json(res, 429, { error: 'rate limit exceeded' });
          const raw = await readText(req, maxJsonBodyBytes);
          if (!validWebhookSignature(raw, req.headers['x-hub-signature-256'] || req.headers['x-source-signature-256'], webhookSecret)) return json(res, 401, { error: 'invalid webhook signature' });
          let body;
          try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: 'invalid JSON body' }); }
          const workflow = await src.getWorkflowAsync(orgId, projectId, webhookMatch[1]);
          if (!workflow) return json(res, 404, { error: 'workflow not found' });
          const eventId = body.eventId || req.headers['x-github-delivery'] || req.headers['x-source-delivery'];
          if (!eventId) return json(res, 400, { error: 'webhook delivery id is required' });
          const event = body.event || req.headers['x-github-event'] || 'webhook';
          const dispatch = await src.dispatchWorkflowAsync({ orgId, projectId, workflowId: workflow.id, event, eventId, payload: body.payload ?? body, maxQueueDepth: maxJobQueueDepth, maxWorkflowJobs });
          return json(res, 202, dispatch);
        }
        if (workflowMatch && !workflowMatch[1] && req.method === 'GET') {
          const g = await guard(src, req, ACTIONS.read_workflows, { org: orgId, project: projectId });
          if (g) return json(res, g.status, g.body);
          const pagination = parseListParams(url);
          const workflows = await src.listWorkflowsAsync(orgId, projectId, { cursor: pagination.cursor, limit: pagination.limit ? pagination.limit + 1 : 100 });
          return json(res, 200, paginatedResponse(workflows, pagination, fields));
        }

        if (workflowMatch && !workflowMatch[1] && req.method === 'POST') {
          const g = await guard(src, req, ACTIONS.manage_workflows, { org: orgId, project: projectId });
          if (g) return json(res, g.status, g.body);
          const body = await readBody(req, maxJsonBodyBytes);
          const workflow = await src.createWorkflowAsync({ orgId, projectId, name: body.name, triggers: body.triggers, jobs: body.jobs, enabled: body.enabled });
          return json(res, 201, workflow);
        }

        if (workflowMatch && workflowMatch[1] && workflowMatch[2] === '/dispatch' && req.method === 'POST') {
          const ip = clientAddress(req, trustProxy);
          if (!(await limiter.allowAsync(`workflow:${ip}:${orgId}:${projectId}`, limits.workflowDispatch))) return json(res, 429, { error: 'rate limit exceeded' });
          const g = await guard(src, req, ACTIONS.dispatch_workflow, { org: orgId, project: projectId });
          if (g) return json(res, g.status, g.body);
          const workflow = await src.getWorkflowAsync(orgId, projectId, workflowMatch[1]);
          if (!workflow) return json(res, 404, { error: 'workflow not found' });
          const body = await readBody(req, maxJsonBodyBytes);
          const dispatch = await src.dispatchWorkflowAsync({ orgId, projectId, workflowId: workflow.id, event: body.event, eventId: body.eventId, payload: body.payload ?? {}, maxQueueDepth: maxJobQueueDepth, maxWorkflowJobs });
          return json(res, 202, dispatch);
        }

        if (workflowMatch && workflowMatch[1] && !workflowMatch[2] && req.method === 'GET') {
          const g = await guard(src, req, ACTIONS.read_workflows, { org: orgId, project: projectId });
          if (g) return json(res, g.status, g.body);
          const workflow = await src.getWorkflowAsync(orgId, projectId, workflowMatch[1]);
          return workflow ? json(res, 200, selectFields(workflow, fields)) : json(res, 404, { error: 'workflow not found' });
        }

        if (rest === '/jobs' && req.method === 'GET') {
          const jobWorkId = url.searchParams.get('work') || null;
          const g = await guard(src, req, ACTIONS.read_jobs, { org: orgId, project: projectId, work: jobWorkId });
          if (g) return json(res, g.status, g.body);
          const pagination = parseListParams(url);
          const jobs = await src.jobs.list({
            orgId,
            projectId,
            workId: jobWorkId,
            cursor: pagination.cursor,
            limit: pagination.limit ? pagination.limit + 1 : 100,
          });
          return json(res, 200, paginatedResponse(jobs, pagination, fields));
        }

        if (rest === '/jobs/batch' && req.method === 'POST') {
          const body = await readBody(req, maxJsonBodyBytes);
          const requestKey = requestIdempotencyKey(req, orgId, projectId);
          const ip = clientAddress(req, trustProxy);
          if (!(await limiter.allowAsync(`jobbatch:${ip}:${orgId}:${projectId}`, { ...limits.jobEnqueue, cost: Array.isArray(body.jobs) ? body.jobs.length : 1 }))) {
            return json(res, 429, { error: 'rate limit exceeded' });
          }
          if (!Array.isArray(body.jobs) || body.jobs.length < 1 || body.jobs.length > 100) {
            return json(res, 400, { error: 'jobs must contain 1-100 items' });
          }
          const jobs = [];
          for (const job of body.jobs) {
            if (!job || typeof job.kind !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(job.kind)) throw new Error('invalid job kind');
            if (Buffer.byteLength(JSON.stringify(job.payload ?? {})) > maxJobPayloadBytes) throw new Error('job payload too large');
            const g = await guard(src, req, ACTIONS.enqueue_job, { org: orgId, project: projectId, work: job.workId || undefined });
            if (g) return json(res, g.status, g.body);
            jobs.push({
              kind: job.kind,
              payload: job.payload ?? {},
              availableAt: job.availableAt,
              workId: job.workId || null,
              maxAttempts: job.maxAttempts,
              dedupeKey: job.dedupeKey || (requestKey ? `${requestKey}:${jobs.length}` : null),
              orgId,
              projectId,
            });
          }
          const queued = await src.jobs.enqueueBatch({ jobs, maxQueueDepth: maxJobQueueDepth });
          return json(res, 202, { jobs: queued });
        }

        if (rest === '/jobs' && req.method === 'POST') {
          const body = await readBody(req, maxJsonBodyBytes);
          const requestKey = requestIdempotencyKey(req, orgId, projectId);
          const ip = clientAddress(req, trustProxy);
          if (!(await limiter.allowAsync(`job:${ip}:${orgId}:${projectId}`, limits.jobEnqueue))) {
            return json(res, 429, { error: 'rate limit exceeded' });
          }
          const g = await guard(src, req, ACTIONS.enqueue_job, {
            org: orgId,
            project: projectId,
            work: body.workId,
          });
          if (g) return json(res, g.status, g.body);
          if (typeof body.kind !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(body.kind)) {
            return json(res, 400, { error: 'kind must be 1-120 safe characters' });
          }
          const payloadBytes = Buffer.byteLength(JSON.stringify(body.payload ?? {}));
          if (payloadBytes > maxJobPayloadBytes) return json(res, 413, { error: 'job payload too large' });
          let job;
          try {
            job = await src.jobs.enqueue({
              kind: body.kind,
              payload: body.payload ?? {},
              orgId,
              projectId,
              workId: body.workId || null,
              maxQueueDepth: maxJobQueueDepth,
              dedupeKey: body.dedupeKey || requestKey,
            });
          } catch (error) {
            if (error?.message === 'job queue depth exceeded') return json(res, 429, { error: error.message });
            throw error;
          }
          return json(res, 202, job);
        }

        // Contribution flow: a Git-only developer submits a change from a
        // working clone. Source creates the Work → Session → Change → Evidence
        // lifecycle server-side. Public projects support low-friction
        // onboarding; private projects require a project-scoped capability.
        if (rest === '/submit' && req.method === 'POST') {
          const ip = clientAddress(req, trustProxy);
          if (!(await limiter.allowAsync(`submit:${ip}`, limits.submit))) {
            return json(res, 429, { error: 'rate limit exceeded' });
          }
          const body = await readBody(req, maxJsonBodyBytes);
          const project = typeof src.getProjectAsync === 'function'
            ? await src.getProjectAsync(orgId, projectId)
            : src.getProject(orgId, projectId);
          if (!project) return json(res, 404, { error: 'project not found' });
          let submitPrincipalId = null;
          if (project.visibility !== 'public') {
            const credential = await sessionCredential(src, req);
            const auth = typeof src.capabilities.authorizeAsync === 'function'
              ? await authorizeRequestAsync(src.capabilities, req, ACTIONS.submit_change, { org: orgId, project: projectId, credential })
              : authorizeRequest(src.capabilities, req, ACTIONS.submit_change, { org: orgId, project: projectId, credential });
            if (!auth.ok) return json(res, auth.status, { error: auth.error });
            submitPrincipalId = auth.cap.principalId;
          }
          const release = await gitSlots.acquire();
          if (!release) {
            req.resume();
            return json(res, 503, { error: 'Git service busy; retry later' });
          }
          try {
            const r = await src.submitContributionAsync({ ...body, orgId, projectId, principalId: submitPrincipalId });
            return json(res, 201, r);
          } finally {
            release();
          }
        }

        const workMatch = rest.match(/^\/work\/([^/]+)(\/.*)?$/);
        if (workMatch) {
          const workId = workMatch[1];
          const wrest = workMatch[2] || '';

          if (wrest === '' && req.method === 'GET') {
            const g = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const w = await src.getWorkAsync(orgId, projectId, workId);
            if (!w) return json(res, 404, { error: 'not found' });
            return json(res, 200, selectFields(w, fields));
          }

          if (wrest === '/claim' && req.method === 'POST') {
            const credential = await sessionCredential(src, req);
            const auth = typeof src.capabilities.authorizeAsync === 'function'
              ? await authorizeRequestAsync(src.capabilities, req, ACTIONS.claim_work, { org: orgId, project: projectId, work: workId, credential })
              : authorizeRequest(src.capabilities, req, ACTIONS.claim_work, { org: orgId, project: projectId, work: workId, credential });
            if (!auth.ok) return json(res, auth.status, { error: auth.error });
            const body = await readBody(req, maxJsonBodyBytes);
            const w = await src.claimWorkAsync({ orgId, projectId, workId, principalId: auth.cap.principalId });
            return json(res, 200, w);
          }

          if (wrest === '/sessions' && req.method === 'POST') {
            const ip = clientAddress(req, trustProxy);
            if (!(await limiter.allowAsync(`session:${ip}`, limits.session))) {
              return json(res, 429, { error: 'rate limit exceeded' });
            }
            const credential = await sessionCredential(src, req);
            const auth = typeof src.capabilities.authorizeAsync === 'function'
              ? await authorizeRequestAsync(src.capabilities, req, ACTIONS.start_session, { org: orgId, project: projectId, work: workId, credential })
              : authorizeRequest(src.capabilities, req, ACTIONS.start_session, { org: orgId, project: projectId, work: workId, credential });
            if (!auth.ok) return json(res, auth.status, { error: auth.error });
            const body = await readBody(req, maxJsonBodyBytes);
            const principalId = auth.cap.principalId;
            const s = await src.startSessionAsync({ orgId, projectId, workId, principalId, environment: body.environment, baseCommit: body.baseCommit });
            // Issue a session-scoped capability (temporary session identity):
            // bounded to this org/project/work, expiring, denied accept/policy.
            const cap = await src.issueSessionCapabilityAsync({ orgId, projectId, workId, principalId });
            return json(res, 201, { ...s, capability: cap });
          }

          if (wrest === '/context' && req.method === 'GET') {
            const g = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const w = await src.getWorkAsync(orgId, projectId, workId);
            if (!w) return json(res, 404, { error: 'not found' });
            // Scoped, token-bounded context: intent, requirements, acceptance,
            // policy, and current status — not the whole repository.
            return json(res, 200, {
              workId: w.id,
              intent: w.intent,
              requirements: w.requirements,
              acceptanceConditions: w.acceptanceConditions,
              status: w.status,
              policy: await src.getPolicyAsync(orgId, projectId),
            });
          }

          if (wrest === '/changes' && req.method === 'POST') {
            const g = await guard(src, req, ACTIONS.submit_change, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const body = await readBody(req, maxJsonBodyBytes);
            const c = await src.submitChangeAsync({ orgId, projectId, workId, sessionId: body.sessionId, baseCommit: body.baseCommit, headCommit: body.headCommit, repositories: body.repositories, repositoryChanges: body.repositoryChanges });
            return json(res, 201, c);
          }
        }

        const changeMatch = rest.match(/^\/changes\/([^/]+)(\/.*)?$/);
        if (changeMatch) {
          const changeId = changeMatch[1];
          const crest = changeMatch[2] || '';
          const workId = await changeWork(src, orgId, projectId, changeId);

          if (crest === '' && req.method === 'GET') {
            const g = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const c = await src.getChangeAsync(orgId, projectId, changeId);
            if (!c) return json(res, 404, { error: 'not found' });
            return json(res, 200, selectFields(c, fields));
          }

          if (crest === '/evidence' && req.method === 'POST') {
            const g = await guard(src, req, ACTIONS.submit_evidence, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const body = await readBody(req, maxJsonBodyBytes);
            const e = await src.addEvidenceAsync({ orgId, projectId, changeId, ...body });
            return json(res, 201, e);
          }

          if (crest === '/evaluate' && req.method === 'POST') {
            const g = await guard(src, req, ACTIONS.submit_evidence, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const r = await src.evaluateChangeAsync({ orgId, projectId, changeId });
            return json(res, 200, { evaluation: r.evaluation, interpretation: r.interpretation });
          }

          if (crest === '/scan' && req.method === 'GET') {
            const g = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const release = await gitSlots.acquire();
            if (!release) return json(res, 503, { error: 'Git service busy; retry later' });
            try {
              const findings = await src.scanChangeSecretsAsync({ orgId, projectId, changeId });
              return json(res, 200, { findings });
            } finally {
              release();
            }
          }

          if (crest === '/decision' && req.method === 'GET') {
            const g = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const c = await src.getChangeAsync(orgId, projectId, changeId);
            if (!c) return json(res, 404, { error: 'not found' });
            const decisions = await src.getDecisionManyAsync(orgId, projectId, c.decisions || []);
            return json(res, 200, decisions);
          }

          if (crest === '/decision' && req.method === 'POST') {
            const g = await guard(src, req, ACTIONS.accept_change, { org: orgId, project: projectId });
            if (g) return json(res, g.status, g.body);
            const body = await readBody(req, maxJsonBodyBytes);
            const d = await src.makeDecisionAsync({ orgId, projectId, changeId, decision: body.decision, decider: body.decider, reasoning: body.reasoning });
            return json(res, 201, d);
          }
        }

        const evidenceMatch = rest.match(/^\/evidence\/([^/]+)(\/.*)?$/);
        if (evidenceMatch) {
          const evidenceId = evidenceMatch[1];
          const erest = evidenceMatch[2] || '';
          if (erest === '' && req.method === 'GET') {
            const g = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId });
            if (g) return json(res, g.status, g.body);
            const e = await src.getEvidenceAsync(orgId, projectId, evidenceId);
            if (!e) return json(res, 404, { error: 'not found' });
            return json(res, 200, e);
          }
          if (erest === '/artifact' && req.method === 'GET') {
            const g = await guard(src, req, ACTIONS.read_context, { org: orgId, project: projectId });
            if (g) return json(res, g.status, g.body);
            const releaseArtifact = await artifactSlots.acquire();
            if (!releaseArtifact) {
              res.setHeader('Retry-After', '1');
              return json(res, 503, { error: 'artifact service busy; retry later', retryable: true });
            }
            try {
              const e = await src.getEvidenceAsync(orgId, projectId, evidenceId);
              if (!e || !e.artifactRef) return json(res, 404, { error: 'not found' });
              const bytes = typeof src.getArtifactAsync === 'function'
                ? await src.getArtifactAsync(e.artifactRef.hash)
                : src.getArtifact(e.artifactRef.hash);
              if (!bytes) return json(res, 404, { error: 'artifact not found' });
              res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
              return res.end(bytes);
            } finally {
              releaseArtifact();
            }
          }
        }
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy(e);
        return;
      }
      if (e?.code === 'DB_ADMISSION_EXHAUSTED') {
        res.setHeader('Retry-After', '1');
        return json(res, 503, { error: 'database admission capacity exhausted', retryable: true });
      }
      if (e?.code === 'CANONICAL_ADMISSION_EXHAUSTED') {
        res.setHeader('Retry-After', '1');
        return json(res, 503, { error: 'canonical update capacity exhausted', retryable: true });
      }
      if (e?.code === 'WRITER_LEASE_LOST' || e?.code === 'WRITER_LEASE_HELD') {
        res.setHeader('Retry-After', '1');
        return json(res, 503, { error: 'writer lease unavailable', retryable: true });
      }
      if (isRetryableStoreError(e)) {
        res.setHeader('Retry-After', '1');
        return json(res, 503, { error: 'storage temporarily unavailable', retryable: true });
      }
      return json(res, 400, { error: e.message });
    }
  };

  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.metrics = {
    requestsTotal: 0,
    responsesTotal: 0,
    activeRequests: 0,
    abortedRequests: 0,
    statuses: new Map(),
  };
  server.discoveryInstancePromise = null;
  server.secretBroker = secretBroker;
  server.writerLease = writerLease;
  server.artifactSlots = artifactSlots;
  server.requestSlots = requestSlots;
  server.draining = false;
  server.beginDrain = () => { server.draining = true; };
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = maxConnections;
  server.requireReplication = requireReplication === true || replicationRole === 'standby';
  server.replicationRole = replicationRole;
  server.replicationMinStandbys = Math.max(0, Math.trunc(replicationMinStandbys));
  server.replicationMaxLagBytes = Math.max(0, Math.trunc(replicationMaxLagBytes));
  server.readOnly = readOnly === true || replicationRole === 'standby';
  return server;
}

export function startServer(src, opts = {}) {
  const server = createServer(src, opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({
      port: opts.port ?? 8787,
      host: opts.host,
      backlog: opts.backlog ?? Math.max(511, opts.maxConnections ?? 10_000),
    }, () => resolve(server));
  });
}
