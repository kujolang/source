// Source — HTTP API and agent discovery.
//
// The machine interface. No critical capability requires HTML. Responses are
// compact JSON with field selection and pagination. Mutating operations are
// capability-gated via `Authorization: Bearer <credential>`.

import http from 'node:http';
import { Source } from './source.js';
import { renderIndex, renderProject, renderWork, renderChange } from './web.js';

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
          protocols: ['http+json'],
          endpoints: {
            projects: '/api/v1/projects',
            work: '/api/v1/projects/{project}/work',
            changes: '/api/v1/projects/{project}/changes',
            evidence: '/api/v1/projects/{project}/evidence',
            git: '/git/{project}/{repo}.git',
            policy: '/api/v1/projects/{project}/policy',
          },
          capabilities: ['read_source', 'read_context', 'submit_change', 'submit_evidence'],
          auth: ['capability'],
        });
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
