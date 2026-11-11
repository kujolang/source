// Real Source trees and actual Chromium, through isolated execution and broker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freshSource } from './helpers.js';
import { CandidateContainerExecutor } from '../src/candidate-executor.js';
import { verificationIdentity } from '../src/verification.js';
const exec = promisify(execFile);
const imageReport = process.env.SOURCE_TEST_BROWSER_IMAGE_REPORT;

test('actual browser staging rejects regressed Source UI and cannot transfer passing evidence', { skip: !imageReport, timeout: 180000 }, async t => {
  const image = JSON.parse(await readFile(imageReport));
  assert.match(image.revision, /^[a-f0-9]{40}$/);
  assert.ok(image.browserBuild?.checkerSha256);
  const f = freshSource();
  const workspaceRoot = path.join(f.dir, 'workspaces');
  t.after(async () => {
    const files = await readdir(workspaceRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (files.length) t.diagnostic(`retained execution state for operator recovery: ${f.dir}`);
    else await rm(f.dir, { recursive: true, force: true });
  });
  const scope = { orgId: f.org.id, projectId: f.project.id, principalId: f.human.id };
  const repo = f.src.createRepository({ ...scope, name: 'actual-source-ui' });
  scope.repoId = repo.id;
  const git = async (args, input) => {
    const pending = exec('git', ['--no-replace-objects', '-c', 'user.name=Browser fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      cwd: repo.barePath, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_INDEX_FILE: path.join(f.dir, 'fixture-index'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    if (input != null) pending.child.stdin.end(input);
    return (await pending).stdout.trim();
  };
  await git(['fetch', fileURLToPath(new URL('..', import.meta.url)), image.revision]);
  const base = await git(['rev-parse', `${image.revision}^`]);
  await git(['update-ref', 'refs/heads/main', base]);
  await git(['read-tree', image.revision]);
  const original = await git(['show', `${image.revision}:src/web.js`]);
  assert.ok(original.includes('Sign in with a human principal'));
  const badBlob = await git(['hash-object', '-w', '--stdin'], original.replace('Sign in with a human principal', 'Regressed sign-in heading'));
  await git(['update-index', '--cacheinfo', `100644,${badBlob},src/web.js`]);
  const badTree = await git(['write-tree']);
  const badHead = await git(['commit-tree', badTree, '-p', image.revision, '-m', 'Deliberate login regression']);
  const executor = new CandidateContainerExecutor({ workspaceRoot, image: image.image, toolVersions: image.toolVersions,
    runtime: 'docker', memory: '2g', timeoutMs: 90000, maxActive: 1 });
  const check = { id: 'browser', version: '1', tier: 3, command: ['node', '/opt/source-browser-staging.mjs'],
    environment: executor.environment, toolVersions: image.toolVersions, inputs: {}, externalState: {},
    deterministic: false, maxAgeMs: 600000, producers: [f.service.id] };
  const policy = { version: 'browser-negative-v1', securityPolicyVersion: '1', checks: [check] };
  await f.src.integration.configure({ ...scope, policy });
  const plan = async headCommit => {
    const work = f.src.createWork({ ...scope, intent: 'Actual Source UI', requester: f.agent.id });
    f.src.claimWork({ ...scope, workId: work.id, principalId: f.agent.id });
    const session = f.src.startSession({ ...scope, workId: work.id, principalId: f.agent.id, baseCommit: base });
    const change = f.src.submitChange({ ...scope, workId: work.id, sessionId: session.id, repositories: [repo.id], baseCommit: base, headCommit });
    return f.src.planIntegrationAsync({ ...scope, changeIds: [change.id] });
  };
  const good = await plan(image.revision), bad = await plan(badHead);
  const input = report => ({ ...scope, candidateId: report.candidate.id });
  const execute = report => executor.execute({ repository: repo.barePath, candidate: report.candidate, check,
    identity: verificationIdentity(report.candidate, policy, check.id), job: { id: report.candidate.id } });
  const pass = await execute(good);
  assert.equal(pass.execution.status, 'pass', pass.output);
  const passReceipt = await f.src.integration.record({ ...input(good), principalId: f.service.id, checkId: check.id, ...pass });
  assert.equal((await f.src.integration.evaluate(input(good))).ok, true);
  assert.equal((await f.src.integration.evaluate(input(good), { forReuse: true })).ok, false, 'browser checks always rerun');
  await assert.rejects(() => f.src.integration.record({ ...input(bad), principalId: f.service.id, checkId: check.id, ...pass }), /exact candidate/);
  const fail = await execute(bad);
  assert.equal(fail.execution.status, 'fail');
  assert.match(fail.output, /Regressed sign-in heading/);
  const failReceipt = await f.src.integration.record({ ...input(bad), principalId: f.service.id, checkId: check.id, ...fail });
  assert.equal((await f.src.integration.evaluate(input(bad))).ok, false);
  await assert.rejects(() => f.src.integration.accept(input(bad)), /not satisfied/);
  await assert.rejects(() => f.src.integration.promote(input(bad)), /exact-candidate evidence and acceptance required/);
  assert.equal(await git(['rev-parse', 'main']), base);
  await f.src.integration.accept(input(good));
  assert.equal((await f.src.integration.promote(input(good))).state, 'landed');
  assert.equal(await git(['rev-parse', 'main']), good.candidate.headCommit);
  assert.deepEqual(await readdir(workspaceRoot), []);
  t.diagnostic(JSON.stringify({ good: good.candidate, bad: bad.candidate, passReceipt, failReceipt, failureOutput: fail.output,
    rejectedWrongCandidateEvidence: true, regressedUiDenied: true, browserEvidenceNotReusable: true,
    canonicalUnchangedUntilGoodAcceptance: true, workspacesEmpty: true }));
});
