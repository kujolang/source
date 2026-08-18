// Smart-HTTP Git transport tests.
//
// Proves that a developer who knows Git but not Source can clone, fetch, and
// push over HTTP against a Source bare repository — the human onboarding ramp.
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

test('git clone works over smart HTTP', async () => {
  const { src, org, project } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  await withServer(src, async (base) => {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-http-clone-'));
    await run(['clone', `${base}/git/${project.id}/${repo.id}.git`, cloneDir]);
    const readme = readFileSync(path.join(cloneDir, 'README.md'), 'utf8');
    assert.ok(readme.includes('change'));
  });
});

test('git clone works by repository name over smart HTTP', async () => {
  const { src, org, project } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  await withServer(src, async (base) => {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-http-name-'));
    await run(['clone', `${base}/git/${project.id}/${repo.name}.git`, cloneDir]);
    const readme = readFileSync(path.join(cloneDir, 'README.md'), 'utf8');
    assert.ok(readme.includes('change'));
  });
});

test('git fetch works over smart HTTP', async () => {
  const { src, org, project } = freshSource();
  const { repo, work } = seedRepo(src, org.id, project.id);
  // Advance the bare repo with a new commit (via local push), then fetch it
  // over HTTP from a fresh clone.
  writeFileSync(path.join(work, 'NEW.md'), 'new\n');
  await run(['add', '.'], work);
  await run(['commit', '-m', 'new'], work);
  await run(['push', 'origin', 'main'], work);

  await withServer(src, async (base) => {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-http-fetch-'));
    await run(['clone', `${base}/git/${project.id}/${repo.id}.git`, cloneDir]);
    await run(['fetch', 'origin'], cloneDir);
    const log = await run(['log', '--oneline', 'origin/main'], cloneDir);
    assert.ok(log.includes('new'));
  });
});

test('git push works over smart HTTP (contribution transport)', async () => {
  const { src, org, project } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  await withServer(src, async (base) => {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-http-push-'));
    await run(['clone', `${base}/git/${project.id}/${repo.id}.git`, cloneDir]);
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

test('unknown repository returns 404 (tenant isolation)', async () => {
  const { src, org, project } = freshSource();
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/git/${project.id}/NOPE.git/info/refs?service=git-upload-pack`);
    assert.equal(res.status, 404);
  });
});

test('path traversal is rejected (no repo escape)', async () => {
  const { src, org, project } = freshSource();
  await withServer(src, async (base) => {
    const res = await fetch(`${base}/git/${project.id}/..%2F..%2Fetc.git/info/refs?service=git-upload-pack`);
    assert.equal(res.status, 404);
  });
});
