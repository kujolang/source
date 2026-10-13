import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../src/api.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { hybridFixture, runGit } from '../scripts/contest/lib/hybrid-fixture.js';
import { artifactsBinding, ArtifactsBridge } from '../src/integrations/artifacts.js';

test('real Source review publishes through the Worker contract and independently clones canonical content', async (t) => {
  const f = await hybridFixture(); t.after(f.cleanup);
  const head = f.commit('# Accepted proposal\n');
  const p = f.propose('', head);
  await assert.rejects(p.promote(), /not accepted/);
  assert.throws(() => f.src.makeDecision({ ...f.scope, changeId: p.change.id, decision: 'accepted', decider: f.agent.id }));
  assert.throws(() => runGit(['push', f.repo.barePath, 'HEAD:refs/heads/main'], f.writer), /canonical branch requires/);
  assert.equal(runGit(['ls-remote', '--heads', f.remotePath], f.root), '');
  p.accept();
  assert.throws(() => f.src.updateCanonicalState({ ...f.scope, changeId: p.change.id }), /asynchronous/);
  assert.equal((await p.promote()).ok, true);
  assert.equal(f.src.getWork(f.scope.orgId, f.scope.projectId, p.work.id).status, 'closed');
  const clone = path.join(f.root, 'independent'); runGit(['clone', f.remotePath, clone], f.root);
  assert.equal(runGit(['rev-parse', 'HEAD'], clone), head);
  assert.equal(readFileSync(path.join(clone, 'README.md'), 'utf8'), '# Accepted proposal\n');
  assert.equal((await p.promote()).ok, true, 'retry is idempotent even for the initial commit');
  const binding = artifactsBinding(f.src.gitRepo(f.scope.orgId, f.scope.projectId, f.repo.id));
  assert.equal(binding.remote, f.remote);
  function scan(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) scan(file); else { const text = readFileSync(file).toString(); assert.ok(!text.includes(f.token)); assert.ok(!text.includes(f.secret)); } } }
  scan(f.src.dataRoot);
  await assert.rejects(f.src.updateRepositoryAsync({ ...f.scope, repoId: f.repo.id, defaultBranch: 'other' }), /immutable/);
});

test('remote compare-and-swap rejects a competing update and never closes its Work', async (t) => {
  const f = await hybridFixture(); t.after(f.cleanup);
  const base = f.commit('# Base\n'); const initial = f.propose('', base); initial.accept(); assert.equal((await initial.promote()).ok, true);
  const head = f.commit('# Proposed\n'); const p = f.propose(base, head); p.accept();
  runGit(['checkout', '-b', 'competitor', base], f.writer); const competing = f.commit('# Competing\n');
  let injected = false;
  f.transport.before = (args) => { if (args[0] === 'push' && !injected) { injected = true; runGit(['push', f.remotePath, `${competing}:refs/heads/main`], f.writer); } };
  assert.equal((await p.promote()).ok, false);
  assert.equal(runGit(['rev-parse', 'main'], f.remotePath), competing);
  assert.equal(f.src.gitRepo(f.scope.orgId, f.scope.projectId, f.repo.id).revParse('main'), base);
  assert.equal(f.src.getWork(f.scope.orgId, f.scope.projectId, p.work.id).status, 'accepted');
  assert.equal((await p.promote()).ok, false, 'divergent remote requires a revision');
});

test('lost push acknowledgement recovers on retry without repushing or leaking errors', async (t) => {
  const f = await hybridFixture(); t.after(f.cleanup);
  const head = f.commit('# Recoverable\n'); const p = f.propose('', head); p.accept();
  let pushes = 0;
  f.transport.after = (args) => { if (args[0] === 'push') { pushes++; throw new Error(f.token); } };
  const failed = await p.promote(); assert.equal(failed.ok, false); assert.ok(!JSON.stringify(failed).includes(f.token));
  assert.equal(runGit(['rev-parse', 'main'], f.remotePath), head);
  assert.equal(f.src.gitRepo(f.scope.orgId, f.scope.projectId, f.repo.id).revParse('main'), '');
  assert.equal(f.src.getWork(f.scope.orgId, f.scope.projectId, p.work.id).status, 'accepted');
  assert.equal((await p.promote()).ok, true); assert.equal(pushes, 1);
});

test('bound repositories fail closed when operator configuration is absent', async (t) => {
  const f = await hybridFixture(); t.after(f.cleanup);
  const p = f.propose('', f.commit('# No fallback\n')); p.accept(); f.src.artifacts = null;
  assert.equal((await p.promote()).ok, false);
  assert.equal(runGit(['ls-remote', '--heads', f.remotePath], f.root), '');
});

test('credential remote substitution and insecure Worker URLs are rejected', async () => {
  assert.throws(() => new ArtifactsBridge({ url: 'http://public.example', secret: 'x'.repeat(32) }), /invalid/);
  const bridge = new ArtifactsBridge({ url: 'https://worker.example', secret: 'x'.repeat(32), fetchImpl: async () => Response.json({ name: 'source-hybrid-test', remote: 'https://evil.example/repo.git', token: 'art_v1_fixture' }) });
  await assert.rejects(bridge.credentials('source-hybrid-test'), /invalid Artifacts remote/);
});


test('HTTP staging accepts proposals, rejects direct canonical pushes and reports failed promotion', async (t) => {
  const f = await hybridFixture(); t.after(f.cleanup);
  const cap = f.src.issueGitCapability({ ...f.scope, principalId: f.agent.id });
  const humanCap = f.src.capabilities.issue({ principalId: f.human.id, scope: { org: f.scope.orgId, project: f.scope.projectId }, allowed: ['accept_change'] });
  const server = await startServer(f.src, { host: '127.0.0.1', port: 0 });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const remote = new URL(`/git/${f.scope.orgId}/${f.scope.projectId}/${f.repo.id}.git`, origin);
  remote.username = 'source'; remote.password = cap.credential;
  const head = f.commit('# HTTP proposal\n');
  const git = (args) => promisify(execFile)('git', args, { cwd: f.writer, timeout: 15000 });
  await git(['push', remote.href, `${head}:refs/heads/staged`]);
  await assert.rejects(git(['push', remote.href, `${head}:refs/heads/main`]), /canonical branch requires/);
  const p = f.propose('', head); p.accept(); f.src.artifacts = null;
  const response = await fetch(`${origin}/o/${f.scope.orgId}/p/${f.scope.projectId}/c/${p.change.id}/canonical`, { method: 'POST', headers: { Authorization: `Bearer ${humanCap.credential}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '', redirect: 'manual' });
  assert.equal(response.status, 409); assert.match(await response.text(), /configuration required/);
  unlinkSync(path.join(f.repo.barePath, 'source-artifacts.json'));
  await assert.rejects(p.promote(), /binding missing/);
  const advertised = await fetch(`${origin}/git/${f.scope.orgId}/${f.scope.projectId}/${f.repo.id}.git/info/refs?service=git-receive-pack`, { headers: { Authorization: `Basic ${Buffer.from(`source:${cap.credential}`).toString('base64')}` } });
  assert.equal(advertised.status, 503);
});

test('local canonical compare-and-swap preserves a concurrent ref update', async (t) => {
  const f = await hybridFixture(); t.after(f.cleanup);
  const base = f.commit('# Base\n'); const p = f.propose('', base); p.accept(); await p.promote();
  const head = f.commit('# Planned\n'); f.propose(base, head);
  runGit(['checkout', '-b', 'other', base], f.writer); const other = f.commit('# Concurrent\n'); f.propose(base, other);
  const git = f.src.gitRepo(f.scope.orgId, f.scope.projectId, f.repo.id);
  const ancestor = git.isAncestorAsync.bind(git); let calls = 0;
  git.isAncestorAsync = async (...args) => { const result = await ancestor(...args); if (++calls === 2) runGit(['update-ref', 'refs/heads/main', other], git.barePath); return result; };
  assert.equal((await git.fastForwardAsync(base, head, 'main')).ok, false);
  assert.equal(git.revParse('main'), other);
});

test('same operator binding can be resumed, and cannot change the pinned remote', async (t) => {
  const f = await hybridFixture(); t.after(f.cleanup);
  unlinkSync(path.join(f.repo.barePath, 'hooks', 'pre-receive'));
  assert.throws(() => f.src.gitRepo(f.scope.orgId, f.scope.projectId, f.repo.id), /guard missing/);
  await f.src.bindArtifactsRepositoryAsync({ ...f.scope, repoId: f.repo.id, name: f.name });
  assert.ok(f.src.gitRepo(f.scope.orgId, f.scope.projectId, f.repo.id));
  await assert.rejects(f.src.bindArtifactsRepositoryAsync({ ...f.scope, repoId: f.repo.id, name: 'source-hybrid-other' }), /already bound/);
});
