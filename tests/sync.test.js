import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freshSource, seedRepo } from './helpers.js';
import { startServer } from '../src/api.js';
import { git } from '../src/remote.js';
import { syncFromWorkingDir } from '../src/sync.js';

async function fixture(fn) {
  const { src, org, project, human } = freshSource();
  const { work, head } = seedRepo(src, org.id, project.id);
  const target = src.createRepository({ orgId: org.id, projectId: project.id, name: 'secondary' });
  const cap = src.issueGitCapability({ orgId: org.id, projectId: project.id, principalId: human.id });
  const server = await startServer(src, { port: 0 });
  const url = `http://127.0.0.1:${server.address().port}/git/${org.id}/${project.id}/${target.id}.git`;
  try { await fn({ cwd: work, head, url, credential: cap.credential, target, src }); }
  finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
}

test('sync adds Source remote, copies branches/tags and leaves origin/upstream untouched', async () => {
  await fixture(async ({ cwd, head, url, credential, target }) => {
    const origin = await git(['remote', 'get-url', 'origin'], cwd);
    await git(['branch', '--set-upstream-to=origin/main', 'main'], cwd);
    await git(['branch', 'feature'], cwd);
    await git(['tag', '-a', 'v1', '-m', 'release'], cwd);
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../bin/source.js', import.meta.url)),
      '--store', 'json', 'sync', '--cwd', cwd, '--url', url,
    ], { cwd, env: { ...process.env, SOURCE_CREDENTIAL: credential } });
    const result = JSON.parse(stdout);
    assert.equal(result.remote, 'source');
    assert.equal(existsSync(path.join(cwd, '.source')), false);
    for (const ref of ['main', 'feature', 'v1^{}']) assert.equal(await git(['rev-parse', ref], target.barePath), head);
    assert.equal(await git(['remote', 'get-url', 'origin'], cwd), origin);
    assert.equal(await git(['rev-parse', '--abbrev-ref', 'main@{upstream}'], cwd), 'origin/main');
    // Repeat safely; ignore configured push destinations and mirror options.
    await git(['config', 'remote.source.pushurl', origin], cwd);
    await git(['config', 'remote.source.mirror', 'true'], cwd);
    await syncFromWorkingDir({ cwd, credential });
    await assert.rejects(() => syncFromWorkingDir({ cwd, url: url.replace('/R2.git', '/other.git'), credential }), /different URL/);
  });
});

test('sync dry run leaves refs unchanged; divergent push is atomic and never deletes remote branches', async () => {
  await fixture(async ({ cwd, head, url, credential, target }) => {
    await syncFromWorkingDir({ cwd, url, credential });
    await git(['branch', 'remote-only', head], target.barePath);
    await git(['checkout', '--orphan', 'unrelated'], cwd);
    writeFileSync(path.join(cwd, 'UNRELATED'), 'unrelated\n');
    await git(['add', '.'], cwd);
    await git(['commit', '-m', 'unrelated'], cwd);
    await git(['branch', '-f', 'main', 'HEAD'], cwd);
    await assert.rejects(() => syncFromWorkingDir({ cwd, credential }), /Source Git push failed/);
    assert.equal(await git(['rev-parse', 'main'], target.barePath), head);
    assert.equal(await git(['rev-parse', 'remote-only'], target.barePath), head);
    await assert.rejects(() => git(['rev-parse', '--verify', 'unrelated'], target.barePath));
    await git(['checkout', 'main'], cwd);
    await git(['reset', '--hard', head], cwd);
    await syncFromWorkingDir({ cwd, credential, dryRun: true });
    await assert.rejects(() => git(['rev-parse', '--verify', 'unrelated'], target.barePath));
  });
});

test('sync rejects missing credentials on private repos and invalid destinations', async () => {
  await fixture(async ({ cwd, url, target }) => {
    await assert.rejects(() => syncFromWorkingDir({ cwd, url, credential: 'invalid' }), /Source Git push failed/);
    await assert.rejects(() => git(['rev-parse', '--verify', 'main'], target.barePath));
    await assert.rejects(() => syncFromWorkingDir({ cwd, remote: 'origin' }), /expected a Source/);
    await assert.rejects(() => syncFromWorkingDir({ cwd, remote: '--all' }), /invalid Source remote/);
    const empty = mkdtempSync(path.join(tmpdir(), 'source-sync-empty-'));
    await git(['init', '-b', 'main'], empty);
    await assert.rejects(() => syncFromWorkingDir({ cwd: empty, url, dryRun: true }), /existing remote/);
    assert.equal(await git(['remote'], empty), '');
  });
});
