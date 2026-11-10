// Smart-HTTP Git transport tests.
//
// Proves that a developer who knows Git but not Source can clone, fetch, and
// push over HTTP against a Source bare repository — the human onboarding ramp.
// The org is explicit in the URL (`/git/{org}/{project}/{repo}.git`), so the
// tenant boundary is enforced server-side.
//
// Git transport is capability-gated via HTTP Basic auth: public repos allow
// anonymous read; private repos require `read_source`; push always requires
// `git_push`. These tests exercise both the happy path (authenticated) and the
// auth rejections (401/403).
//
// Note: the git client runs in the same process as the server, so git commands
// must be invoked asynchronously (execFile, not execFileSync) to avoid blocking
// the event loop that serves the HTTP requests.

import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { freshSource, seedRepo } from './helpers.js';
import { startServer } from '../src/api.js';
import { gitHttpBackend } from '../src/git-http.js';

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve(stdout.trim());
    });
  });
}

async function withServer(src, fn) {
  const server = await startServer(src, { port: 0 });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

// Build a URL with Basic-auth credentials embedded (git sends these on every
// request to the host).
function authedUrl(base, path, credential) {
  const u = new URL(base + path);
  u.username = 'source';
  u.password = credential;
  return u.toString();
}

// Build an Authorization: Basic header value for fetch-based assertions.
function basicAuthHeader(credential) {
  return `Basic ${Buffer.from(`source:${credential}`).toString('base64')}`;
}

// Issue a project-scoped git capability (read + push).
function gitCap(src, orgId, projectId, principalId) {
  return src.issueGitCapability({ orgId, projectId, principalId });
}

test('aborting a Git backend request rejects promptly', async () => {
  const controller = new AbortController();
  const request = gitHttpBackend({
    projectRoot: '/tmp',
    pathInfo: '/missing.git/info/refs',
    abortSignal: controller.signal,
  });
  controller.abort();
  await assert.rejects(request, /Git request was aborted/);
});

test('git clone works over smart HTTP (authenticated)', async () => {
  const { src, org, project, human } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  const cap = gitCap(src, org.id, project.id, human.id);
  await withServer(src, async (base) => {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-http-clone-'));
    const url = authedUrl(base, `/git/${org.id}/${project.id}/${repo.id}.git`, cap.credential);
    await run(['clone', url, cloneDir]);
    const readme = readFileSync(path.join(cloneDir, 'README.md'), 'utf8');
    assert.ok(readme.includes('change'));
  });
});

test('git clone works by repository name over smart HTTP (authenticated)', async () => {
  const { src, org, project, human } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  const cap = gitCap(src, org.id, project.id, human.id);
  await withServer(src, async (base) => {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-http-name-'));
    const url = authedUrl(base, `/git/${org.id}/${project.id}/${repo.name}.git`, cap.credential);
    await run(['clone', url, cloneDir]);
    const readme = readFileSync(path.join(cloneDir, 'README.md'), 'utf8');
    assert.ok(readme.includes('change'));
  });
});

test('git fetch works over smart HTTP (authenticated)', async () => {
  const { src, org, project, human } = freshSource();
  const { repo, work } = seedRepo(src, org.id, project.id);
  const cap = gitCap(src, org.id, project.id, human.id);
  // Advance the bare repo with a new commit (via local push), then fetch it
  // over HTTP from a fresh clone.
  writeFileSync(path.join(work, 'NEW.md'), 'new\n');
  await run(['add', '.'], work);
  await run(['commit', '-m', 'new'], work);
  await run(['push', 'origin', 'main'], work);

  await withServer(src, async (base) => {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-http-fetch-'));
    const url = authedUrl(base, `/git/${org.id}/${project.id}/${repo.id}.git`, cap.credential);
    await run(['clone', url, cloneDir]);
    await run(['fetch', 'origin'], cloneDir);
    const log = await run(['log', '--oneline', 'origin/main'], cloneDir);
    assert.ok(log.includes('new'));
  });
});

test('git push works over smart HTTP (authenticated contribution transport)', async () => {
  const { src, org, project, human } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  const cap = gitCap(src, org.id, project.id, human.id);
  await withServer(src, async (base) => {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-http-push-'));
    const url = authedUrl(base, `/git/${org.id}/${project.id}/${repo.id}.git`, cap.credential);
    await run(['clone', url, cloneDir]);
    writeFileSync(path.join(cloneDir, 'CONTRIB.md'), 'contribution\n');
    await run(['config', 'user.email', 'contrib@example.com'], cloneDir);
    await run(['config', 'user.name', 'Contrib'], cloneDir);
    await run(['add', '.'], cloneDir);
    await run(['commit', '-m', 'contribution'], cloneDir);
    await run(['push', 'origin', 'main'], cloneDir);

    const git = src.gitRepo(org.id, project.id, repo.id);
    const tip = git.revParse('main');
    assert.ok(tip.length === 40);
    assert.ok(git.hasCommit(tip));
  });
});

test('public repository allows anonymous clone', async () => {
  const { src, org } = freshSource();
  const project = src.createProject({ orgId: org.id, slug: 'public', name: 'Public', visibility: 'public' });
  const { repo } = seedRepo(src, org.id, project.id);
  await withServer(src, async (base) => {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-http-public-'));
    await run(['clone', `${base}/git/${org.id}/${project.id}/${repo.id}.git`, cloneDir]);
    const readme = readFileSync(path.join(cloneDir, 'README.md'), 'utf8');
    assert.ok(readme.includes('change'));
  });
});

test('private repository read requires auth (401)', async () => {
  const { src, org, project } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/git/${org.id}/${project.id}/${repo.id}.git/info/refs?service=git-upload-pack`);
    assert.equal(res.status, 401);
    assert.ok((res.headers.get('www-authenticate') || '').includes('Basic'));
  });
});

test('push requires auth even for public repositories (401)', async () => {
  const { src, org } = freshSource();
  const project = src.createProject({ orgId: org.id, slug: 'public', name: 'Public', visibility: 'public' });
  const { repo } = seedRepo(src, org.id, project.id);
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/git/${org.id}/${project.id}/${repo.id}.git/info/refs?service=git-receive-pack`);
    assert.equal(res.status, 401);
  });
});

test('a capability scoped to another org cannot read its repo (403)', async () => {
  const { src, org, project, human } = freshSource();
  const org2 = src.createOrg({ name: 'other', slug: 'other' });
  const project2 = src.createProject({ orgId: org2.id, slug: 'p2', name: 'P2' });
  const { repo: repo2 } = seedRepo(src, org2.id, project2.id);
  // Capability scoped to org1/project1.
  const cap = gitCap(src, org.id, project.id, human.id);
  await withServer(src, async (base) => {
    const url = `${base}/git/${org2.id}/${project2.id}/${repo2.id}.git/info/refs?service=git-upload-pack`;
    const res = await fetch(url, { headers: { authorization: basicAuthHeader(cap.credential) } });
    assert.equal(res.status, 403);
  });
});

test('unknown repository returns 404 (tenant isolation)', async () => {
  const { src, org, project } = freshSource();
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/git/${org.id}/${project.id}/NOPE.git/info/refs?service=git-upload-pack`);
    assert.equal(res.status, 404);
  });
});

test('a repository in another org is not reachable (tenant isolation)', async () => {
  const { src, org, project } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  const org2 = src.createOrg({ name: 'other', slug: 'other' });
  await withServer(src, async (base) => {
    // The repo exists under org1; requesting it under org2 must 404.
    const res = await fetch(`${base}/git/${org2.id}/${project.id}/${repo.id}.git/info/refs?service=git-upload-pack`);
    assert.equal(res.status, 404);
  });
});

test('path traversal is rejected (no repo escape)', async () => {
  const { src, org, project } = freshSource();
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/git/${org.id}/${project.id}/..%2F..%2Fetc.git/info/refs?service=git-upload-pack`);
    assert.equal(res.status, 404);
  });
});

test('path traversal in the Git service suffix is rejected', async () => {
  const { src, org, project, human } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  const cap = gitCap(src, org.id, project.id, human.id);
  await withServer(src, async (base) => {
    const res = await fetch(
      `${base}/git/${org.id}/${project.id}/${repo.id}.git/%2e%2e/%2e%2e/other.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: basicAuthHeader(cap.credential) } },
    );
    assert.ok([400, 404].includes(res.status), `unexpected status: ${res.status}`);
  });
});

test('Git pipe errors and stderr overflow reject without retaining abort listeners', async () => {
  const { EventEmitter, getEventListeners } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  for (const mode of ['pipe', 'stderr']) {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let killed = false;
    child.kill = () => { killed = true; };
    const controller = new AbortController();
    const result = gitHttpBackend({ projectRoot: '/fixture', pathInfo: '/repo.git/git-upload-pack', spawnProcess: () => child, abortSignal: controller.signal, maxStderrBytes: 8 });
    const rejected = assert.rejects(result, mode === 'pipe' ? /broken pipe/ : /stderr exceeded/);
    if (mode === 'pipe') child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    else child.stderr.write(Buffer.alloc(9));
    await rejected;
    assert.equal(killed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  }
});

test('internal candidate refs cannot be modified by a Git push capability', async () => {
  const { src, org, project, human } = freshSource();
  const { repo, head } = seedRepo(src, org.id, project.id);
  const cap = gitCap(src, org.id, project.id, human.id);
  await withServer(src, async (base) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'source-internal-ref-'));
    await run(['clone', authedUrl(base, `/git/${org.id}/${project.id}/${repo.id}.git`, cap.credential), cwd]);
    await assert.rejects(() => run(['push', 'origin', `${head}:refs/source/candidates/forged`], cwd), /hidden ref/);
    assert.equal(src.gitRepo(org.id, project.id, repo.id).revParse('refs/source/candidates/forged'), '');
  });
});


test('compressed Git negotiation is decoded with bounded output', async () => {
  const { src, org, project, human } = freshSource();
  const { repo, head } = seedRepo(src, org.id, project.id);
  const cap = gitCap(src, org.id, project.id, human.id);
  const server = await startServer(src, { port: 0, maxGitBodyBytes: 1024 });
  const url = `http://127.0.0.1:${server.address().port}/git/${org.id}/${project.id}/${repo.id}.git/git-upload-pack`;
  const pkt = (value) => (Buffer.byteLength(value) + 4).toString(16).padStart(4, '0') + value;
  const request = Buffer.from(pkt('command=ls-refs\n') + '0001' + pkt('peel\n') + pkt('symrefs\n') + '0000');
  const post = (body, encoding) => fetch(url, { method: 'POST', headers: {
    authorization: basicAuthHeader(cap.credential),
    'content-type': 'application/x-git-upload-pack-request',
    'git-protocol': 'version=2',
    ...(encoding ? { 'content-encoding': encoding } : {}),
  }, body });
  try {
    for (const encoding of ['gzip', 'x-gzip']) {
      const response = await post(gzipSync(request), encoding);
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes(`${head} refs/heads/main`));
    }
    assert.equal((await post(gzipSync(Buffer.alloc(2048, 'a')), 'gzip')).status, 413);
    assert.equal((await post(Buffer.from('invalid gzip'), 'gzip')).status, 400);
    assert.equal((await post(request, 'br')).status, 415);
    const response = await post(request);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(`${head} refs/heads/main`));
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('standard Git fetch negotiates many new heads using gzip', async () => {
  const { src, org, project, human } = freshSource();
  const { repo, head, work } = seedRepo(src, org.id, project.id);
  const cap = gitCap(src, org.id, project.id, human.id);
  const server = await startServer(src, { port: 0 });
  const encodings = [];
  server.prependListener('request', (req) => {
    if (req.method === 'POST') encodings.push(req.headers['content-encoding'] || 'identity');
  });
  try {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-http-many-heads-'));
    const url = authedUrl(`http://127.0.0.1:${server.address().port}`, `/git/${org.id}/${project.id}/${repo.id}.git`, cap.credential);
    await run(['clone', url, cloneDir]);
    const tree = await run(['rev-parse', 'HEAD^{tree}'], work);
    const refs = [];
    for (let i = 0; i < 30; i++) {
      const commit = await run(['commit-tree', tree, '-p', head, '-m', `proposal ${i}`], work);
      await run(['update-ref', `refs/heads/proposal-${i}`, commit], work);
      refs.push(`refs/heads/proposal-${i}`);
    }
    await run(['push', 'origin', ...refs], work);
    await run(['fetch', 'origin'], cloneDir);
    assert.ok(encodings.includes('gzip'), 'real Git must exercise compressed negotiation');
    const received = await run(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/proposal-*'], cloneDir);
    assert.equal(received.split('\n').filter(Boolean).length, 30);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('disconnected Git requests waiting for admission do not start a backend after the slot releases', { timeout: 15000 }, async (t) => {
  const { request } = await import('node:http');
  const { src, org, project, human } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  const cap = src.capabilities.issue({ principalId: human.id, scope: { org: org.id, project: project.id }, allowed: ['read_source', 'read_context'] });
  src.getChangeAsync = async () => ({ workId: 'W1' });
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const spawn = childProcess.spawn; let backendStarts = 0;
  t.mock.method(childProcess, 'spawn', (...args) => { if (args[1]?.includes('http-backend')) backendStarts++; return spawn(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const scanReady = Promise.withResolvers(), releaseScan = Promise.withResolvers();
  src.scanChangeSecretsAsync = async () => { scanReady.resolve(); await releaseScan.promise; return []; };
  const server = await startServer(src, { port: 0, gitConcurrency: 1, gitTimeoutMs: 3000 });
  t.after(() => { releaseScan.resolve(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const scan = fetch(`${base}/api/v1/orgs/${org.id}/projects/${project.id}/changes/C1/scan`, { headers: { Authorization: `Bearer ${cap.credential}` } });
  await scanReady.promise;
  const pending = request(`${base}/git/${org.id}/${project.id}/${repo.id}.git/info/refs?service=git-upload-pack`, { headers: { Authorization: basicAuthHeader(cap.credential) } });
  pending.on('error', () => {}); pending.end();
  const until = async (predicate, ms = 1000) => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), 'request state reached before backend timeout');
  };
  await until(() => server.metrics.activeRequests === 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  pending.destroy();
  await until(() => server.metrics.abortedRequests === 1);
  releaseScan.resolve();
  assert.equal((await scan).status, 200);
  const live = await fetch(`${base}/git/${org.id}/${project.id}/${repo.id}.git/info/refs?service=git-upload-pack`, { headers: { Authorization: basicAuthHeader(cap.credential) } });
  assert.equal(live.status, 200); await live.arrayBuffer();
  assert.equal(backendStarts, 1, 'only the live request may start a Git backend');
  assert.equal(server.metrics.gitBackendOutcomes.get('exit_0'), 1);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(metrics, /source_git_backend_outcomes_total\{outcome="exit_0"\} 1/);
});

test('Git push capability cannot create replacement refs that reinterpret canonical objects', async () => {
  const { src, org, project, human } = freshSource();
  const { repo, base: originalBase, head } = seedRepo(src, org.id, project.id);
  const cap = gitCap(src, org.id, project.id, human.id);
  await withServer(src, async (base) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'source-replacement-ref-'));
    await run(['clone', authedUrl(base, `/git/${org.id}/${project.id}/${repo.id}.git`, cap.credential), cwd]);
    await assert.rejects(() => run(['push', 'origin', `${originalBase}:refs/replace/${head}`], cwd), /hidden ref/);
    assert.equal(src.gitRepo(org.id, project.id, repo.id).revParse(`refs/replace/${head}`), '');
  });
});
