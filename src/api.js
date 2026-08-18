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
// by delegating to `git http-backend`; see `git-http.js`.

import http from 'node:http';
import { Source } from './source.js';
import { renderOrgIndex, renderIndex, renderProject, renderWork, renderChange } from './web.js';
import { gitHttpBackend } from './git-http.js';
import { ACTIONS, authorizeRequest } from './auth.js';

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
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

// Apply field selection to an object (or array of objects).
function selectFields(obj, fields) {
  if (!fields) return obj;
  const keys = fields.split(',');
  if (Array.isArray(obj)) return obj.map((o) => selectFields(o, fields));
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

// Authorize a request against a capability action and scope. Returns null when
// authorized, or {status, body} to send as the rejection response.
function guard(src, req, action, scope) {
  const r = authorizeRequest(src.capabilities, req, action, scope);
  if (r.ok) return null;
  return { status: r.status, body: { error: r.error } };
}

// Resolve the Work id a Change belongs to (for work-scoped capability checks).
function changeWork(src, orgId, projectId, changeId) {
  const c = src.getChange(orgId, projectId, changeId);
  return c ? c.workId : undefined;
}

export function createServer(src, { port = 8787 } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const fields = url.searchParams.get('fields') || undefined;

    try {
      // --- human-facing HTML views (public; human auth is a later phase) ---
      if (req.method === 'GET' && pathname === '/') {
        return html(res, 200, renderOrgIndex(src));
      }
      const orgPageMatch = pathname.match(/^\/o\/([^/]+)$/);
      if (req.method === 'GET' && orgPageMatch) {
        return html(res, 200, renderIndex(src, orgPageMatch[1]));
      }
      const pMatch = pathname.match(/^\/o\/([^/]+)\/p\/([^/]+)(?:\/w\/([^/]+))?(?:\/c\/([^/]+))?$/);
      if (req.method === 'GET' && pMatch) {
        const [, orgId, projectId, workId, changeId] = pMatch;
        if (changeId) return html(res, 200, renderChange(src, orgId, projectId, changeId));
        if (workId) return html(res, 200, renderWork(src, orgId, projectId, workId));
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

        let body = null;
        if (req.method === 'POST') body = await readRawBody(req);

        const result = await gitHttpBackend({
          projectRoot: src.reposRoot(orgId, projectId),
          pathInfo: `/${repo.id}.git${rest}`,
          queryString: url.search ? url.search.slice(1) : '',
          method: req.method,
          contentType: req.headers['content-type'] || '',
          body,
          remoteUser: 'anonymous', // MVP has no auth; replaced by capability-gated auth
          remoteAddr: req.socket.remoteAddress || '',
          headers: req.headers,
        });

        const headers = { ...result.headers };
        if (result.body && result.body.length && !headers['content-length']) {
          headers['Content-Length'] = String(result.body.length);
        }
        res.writeHead(result.status, headers);
        return res.end(result.body);
      }

      // --- organizations (tenant boundary) --------------------------------
      if (pathname === '/api/v1/orgs' && req.method === 'GET') {
        const g = guard(src, req, ACTIONS.read_source, {});
        if (g) return json(res, g.status, g.body);
        return json(res, 200, selectFields(src.listOrgs(), fields));
      }

      if (pathname === '/api/v1/orgs' && req.method === 'POST') {
        const g = guard(src, req, ACTIONS.manage_org, {});
        if (g) return json(res, g.status, g.body);
        const body = await readBody(req);
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
          if (g) return json(res, g.status, g.body);
          return json(res, 200, selectFields(src.listWork(orgId, projectId), fields));
        }

        // Contribution flow: a Git-only developer submits a change from a
        // working clone. Source creates the Work → Session → Change → Evidence
        // lifecycle server-side. Public by design (low-friction onboarding);
        // rate limiting is a documented follow-up.
        if (rest === '/submit' && req.method === 'POST') {
          const body = await readBody(req);
          const r = src.submitContribution({ orgId, projectId, ...body });
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
            const body = await readBody(req);
            const w = src.claimWork({ orgId, projectId, workId, principalId: body.principalId });
            return json(res, 200, w);
          }

          if (wrest === '/sessions' && req.method === 'POST') {
            const g = guard(src, req, ACTIONS.start_session, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const body = await readBody(req);
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
            const body = await readBody(req);
            const c = src.submitChange({ orgId, projectId, workId, sessionId: body.sessionId, baseCommit: body.baseCommit, headCommit: body.headCommit, repositories: body.repositories });
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
            const body = await readBody(req);
            const e = src.addEvidence({ orgId, projectId, changeId, ...body });
            return json(res, 201, e);
          }

          if (crest === '/evaluate' && req.method === 'POST') {
            const g = guard(src, req, ACTIONS.submit_evidence, { org: orgId, project: projectId, work: workId });
            if (g) return json(res, g.status, g.body);
            const r = src.evaluateChange({ orgId, projectId, changeId });
            return json(res, 200, { evaluation: r.evaluation, interpretation: r.interpretation });
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
            const body = await readBody(req);
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
  });

  return server;
}

export function startServer(src, opts) {
  const server = createServer(src, opts);
  return new Promise((resolve) => {
    server.listen(opts.port ?? 8787, () => resolve(server));
  });
}
