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
    assert.equal(res.status, 400);
  });
});
