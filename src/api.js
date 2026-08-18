// Source — HTTP API and agent discovery.
//
// The machine interface. No critical capability requires HTML. Responses are
// compact JSON with field selection and pagination. Mutating operations are
// capability-gated via `Authorization: Bearer <credential>`.
//
// The same server also serves Git over smart HTTP (`/git/…`) by delegating to
// `git http-backend`; see `git-http.js`.

import http from 'node:http';
import { Source } from './source.js';
import { renderIndex, renderProject, renderWork, renderChange } from './web.js';
import { gitHttpBackend } from './git-http.js';

const ORG = 'O1';

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

export function createServer(src, { port = 8787 } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const fields = url.searchParams.get('fields') || undefined;

    try {
      // --- human-facing HTML views --------------------------------------
      if (req.method === 'GET' && pathname === '/') {
        return html(res, 200, renderIndex(src, ORG));
      }
      const pMatch = pathname.match(/^\/p\/([^/]+)(?:\/w\/([^/]+))?(?:\/c\/([^/]+))?$/);
      if (req.method === 'GET' && pMatch) {
        const [, projectId, workId, changeId] = pMatch;
        if (changeId) return html(res, 200, renderChange(src, ORG, projectId, changeId));
        if (workId) return html(res, 200, renderWork(src, ORG, projectId, workId));
        return html(res, 200, renderProject(src, ORG, projectId));
      }

      // --- discovery -----------------------------------------------------
      if (pathname === '/.well-known/source') {
        return json(res, 200, {
          instance: src.getInstance()?.name ?? 'source',
          api_version: '1',
          protocols: ['http+json', 'git-smart-http'],
          endpoints: {
            projects: '/api/v1/projects',
            work: '/api/v1/projects/{project}/work',
            changes: '/api/v1/projects/{project}/changes',
            evidence: '/api/v1/projects/{project}/evidence',
            git: '/git/{project}/{repo}.git',
            policy: '/api/v1/projects/{project}/policy',
            submit: '/api/v1/projects/{project}/submit',
          },
          capabilities: ['read_source', 'read_context', 'submit_change', 'submit_evidence'],
          auth: ['capability'],
        });
      }

      // --- smart-HTTP Git transport --------------------------------------
      // Maps /git/{project}/{repo}.git/{service} to a bare repository and
      // delegates to `git http-backend`. Supports clone, fetch, pull, and push.
      // The URL may use the repository id (R1) or name (main); the bare
      // directory is always keyed by id, so pathInfo uses the resolved id.
      const gitMatch = pathname.match(/^\/git\/([^/]+)\/([^/]+\.git)(\/.*)?$/);
      if (gitMatch && (req.method === 'GET' || req.method === 'POST')) {
        const [, projectId, repoFile, rest = ''] = gitMatch;
        const repoRef = repoFile.slice(0, -'.git'.length);
        const repo = src.resolveRepository(ORG, projectId, repoRef);
        if (!repo) return json(res, 404, { error: 'repository not found' });

        let body = null;
        if (req.method === 'POST') body = await readRawBody(req);

        const result = await gitHttpBackend({
          projectRoot: src.reposRoot(ORG, projectId),
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

      // --- projects ------------------------------------------------------
      if (pathname === '/api/v1/projects' && req.method === 'GET') {
        return json(res, 200, selectFields(src.listProjects(ORG), fields));
      }

      const projectMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)(\/.*)?$/);
      if (projectMatch) {
        const projectId = projectMatch[1];
        const rest = projectMatch[2] || '';

        if (rest === '' && req.method === 'GET') {
          const p = src.getProject(ORG, projectId);
          if (!p) return json(res, 404, { error: 'not found' });
          return json(res, 200, selectFields(p, fields));
        }

        if (rest === '/policy' && req.method === 'GET') {
          return json(res, 200, src.getPolicy(ORG, projectId));
        }

        if (rest === '/work' && req.method === 'GET') {
          return json(res, 200, selectFields(src.listWork(ORG, projectId), fields));
        }

        // Contribution flow: a Git-only developer submits a change from a
        // working clone. Source creates the Work → Session → Change → Evidence
        // lifecycle server-side.
        if (rest === '/submit' && req.method === 'POST') {
          const body = await readBody(req);
          const r = src.submitContribution({ orgId: ORG, projectId, ...body });
          return json(res, 201, r);
        }

        const workMatch = rest.match(/^\/work\/([^/]+)(\/.*)?$/);
        if (workMatch) {
          const workId = workMatch[1];
          const wrest = workMatch[2] || '';

          if (wrest === '' && req.method === 'GET') {
            const w = src.getWork(ORG, projectId, workId);
            if (!w) return json(res, 404, { error: 'not found' });
            return json(res, 200, selectFields(w, fields));
          }

          if (wrest === '/claim' && req.method === 'POST') {
            const body = await readBody(req);
            const w = src.claimWork({ orgId: ORG, projectId, workId, principalId: body.principalId });
            return json(res, 200, w);
          }

          if (wrest === '/sessions' && req.method === 'POST') {
            const body = await readBody(req);
            const s = src.startSession({ orgId: ORG, projectId, workId, principalId: body.principalId, environment: body.environment, baseCommit: body.baseCommit });
            return json(res, 201, s);
          }

          if (wrest === '/context' && req.method === 'GET') {
            const w = src.getWork(ORG, projectId, workId);
            if (!w) return json(res, 404, { error: 'not found' });
            // Scoped, token-bounded context: intent, requirements, acceptance,
            // policy, and current status — not the whole repository.
            return json(res, 200, {
              workId: w.id,
              intent: w.intent,
              requirements: w.requirements,
              acceptanceConditions: w.acceptanceConditions,
              status: w.status,
              policy: src.getPolicy(ORG, projectId),
            });
          }

          if (wrest === '/changes' && req.method === 'POST') {
            const body = await readBody(req);
            const c = src.submitChange({ orgId: ORG, projectId, workId, sessionId: body.sessionId, baseCommit: body.baseCommit, headCommit: body.headCommit, repositories: body.repositories });
            return json(res, 201, c);
          }
        }

        const changeMatch = rest.match(/^\/changes\/([^/]+)(\/.*)?$/);
        if (changeMatch) {
          const changeId = changeMatch[1];
          const crest = changeMatch[2] || '';

          if (crest === '' && req.method === 'GET') {
            const c = src.getChange(ORG, projectId, changeId);
            if (!c) return json(res, 404, { error: 'not found' });
            return json(res, 200, selectFields(c, fields));
          }

          if (crest === '/evidence' && req.method === 'POST') {
            const body = await readBody(req);
            const e = src.addEvidence({ orgId: ORG, projectId, changeId, ...body });
            return json(res, 201, e);
          }

          if (crest === '/evaluate' && req.method === 'POST') {
            const r = src.evaluateChange({ orgId: ORG, projectId, changeId });
            return json(res, 200, { evaluation: r.evaluation, interpretation: r.interpretation });
          }

          if (crest === '/decision' && req.method === 'GET') {
            const c = src.getChange(ORG, projectId, changeId);
            if (!c) return json(res, 404, { error: 'not found' });
            const decisions = (c.decisions || []).map((id) => src.getDecision(ORG, projectId, id)).filter(Boolean);
            return json(res, 200, decisions);
          }

          if (crest === '/decision' && req.method === 'POST') {
            const body = await readBody(req);
            const d = src.makeDecision({ orgId: ORG, projectId, changeId, decision: body.decision, decider: body.decider, reasoning: body.reasoning });
            return json(res, 201, d);
          }
        }

        const evidenceMatch = rest.match(/^\/evidence\/([^/]+)(\/.*)?$/);
        if (evidenceMatch) {
          const evidenceId = evidenceMatch[1];
          const erest = evidenceMatch[2] || '';
          if (erest === '' && req.method === 'GET') {
            const e = src.getEvidence(ORG, projectId, evidenceId);
            if (!e) return json(res, 404, { error: 'not found' });
            return json(res, 200, e);
          }
          if (erest === '/artifact' && req.method === 'GET') {
            const e = src.getEvidence(ORG, projectId, evidenceId);
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
