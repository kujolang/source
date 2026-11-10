// Explicit live, isolated application checks through the real promotion broker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freshSource } from './helpers.js';
import { CandidateContainerExecutor } from '../src/candidate-executor.js';
import { verificationIdentity } from '../src/verification.js';
const exec = promisify(execFile);
const image = process.env.SOURCE_TEST_CONTAINER_IMAGE;
const nodeVersion = process.env.SOURCE_TEST_CONTAINER_NODE_VERSION;
const enabled = Boolean(image && nodeVersion);

for (const scenario of ['interaction', 'single-bad-proposal']) test(`live semantic integration and split: ${scenario}`, { skip: !enabled, timeout: 120000 }, async (t) => {
  const f = freshSource();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const { src, org, project, human, service } = f;
  const repo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'semantic' });
  const scope = { orgId: org.id, projectId: project.id, repoId: repo.id, principalId: human.id };
  const cwd = path.join(f.dir, 'seed'); await mkdir(cwd);
  const git = async (dir, ...args) => (await exec('git', args, { cwd: dir })).stdout.trim();
  await git(cwd, 'init', '-b', 'main'); await git(cwd, 'config', 'user.name', 'Fixture'); await git(cwd, 'config', 'user.email', 'fixture@example.com');
  for (const [name, value] of Object.entries({ 'a.json': 2, 'b.json': 2, 'capacity.json': 5 })) await writeFile(path.join(cwd, name), JSON.stringify(value));
  // Different component files share a capacity constraint. Git merges are clean,
  // component unit checks pass, but their combined behavior can be invalid.
  await writeFile(path.join(cwd, 'check.cjs'), `
    const fs=require('node:fs'),assert=require('node:assert/strict');
    assert.equal(process.version,${JSON.stringify(nodeVersion)});
    const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
    const a=read('a.json'),b=read('b.json'),capacity=read('capacity.json');
    if(process.argv[2]==='unit') { for(const n of [a,b]) assert.ok(Number.isInteger(n)&&n>=0&&n<=4); }
    else { assert.ok(a+b<=capacity,'shared capacity exceeded: '+a+'+'+b+'>'+capacity); }
    console.log(process.argv[2]+' passed: '+a+'+'+b);
  `);
  await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'shared capacity application');
  await git(cwd, 'remote', 'add', 'origin', repo.barePath); await git(cwd, 'push', 'origin', 'main');
  const base = await git(cwd, 'rev-parse', 'HEAD');
  const executor = new CandidateContainerExecutor({ workspaceRoot: path.join(f.dir, 'workspaces'), image, toolVersions: { node: nodeVersion }, runtime: process.env.SOURCE_TEST_CONTAINER_RUNTIME || 'docker', timeoutMs: 15000 });
  const policy = { version: 'semantic-v1', securityPolicyVersion: '1', checks: ['unit', 'integration'].map((id) => ({
    id, version: '1', tier: id === 'unit' ? 1 : 2, command: ['node', 'check.cjs', id], toolVersions: executor.profile.toolVersions,
    environment: executor.environment, inputs: {}, externalState: {}, deterministic: true, maxAgeMs: 120000, producers: [service.id],
  })) };
  await src.integration.configure({ ...scope, policy });
  const changes = await Promise.all(['a', 'b'].map(async (component) => {
    const dir = path.join(f.dir, component); await git(f.dir, 'clone', repo.barePath, dir);
    await git(dir, 'config', 'user.name', component); await git(dir, 'config', 'user.email', `${component}@example.com`);
    await writeFile(path.join(dir, `${component}.json`), JSON.stringify(component === 'b' && scenario === 'single-bad-proposal' ? 4 : 3));
    await git(dir, 'add', '.'); await git(dir, 'commit', '-m', component); await git(dir, 'push', 'origin', `HEAD:refs/heads/proposal-${component}`);
    const headCommit = await git(dir, 'rev-parse', 'HEAD');
    return { component, headCommit };
  }));
  // Persist lifecycle records serially: JSON storage is deliberately single-writer.
  for (const proposal of changes) {
    const agent = src.createPrincipal({ type: 'agent', name: proposal.component });
    const work = src.createWork({ ...scope, intent: proposal.component, requester: agent.id });
    src.claimWork({ ...scope, workId: work.id, principalId: agent.id });
    const session = src.startSession({ ...scope, workId: work.id, principalId: agent.id, baseCommit: base });
    proposal.change = src.submitChange({ ...scope, workId: work.id, sessionId: session.id, repositories: [repo.id], baseCommit: base, headCommit: proposal.headCommit });
  }
  const input = (report) => ({ ...scope, candidateId: report.candidate.id });
  const verify = async (report) => {
    const results = [];
    for (const check of policy.checks) {
      const identity = verificationIdentity(report.candidate, policy, check.id);
      const result = await executor.execute({ repository: repo.barePath, candidate: report.candidate, check, identity, job: { id: check.id, leaseToken: report.candidate.id } });
      const receipt = await src.integration.record({ ...input(report), principalId: service.id, checkId: check.id, ...result });
      results.push({ check: check.id, result, receipt });
    }
    return results;
  };
  const singles = [];
  for (const proposal of changes) {
    const report = await src.planIntegrationAsync({ ...scope, changeIds: [proposal.change.id] });
    singles.push({ report, results: await verify(report) });
  }
  assert.equal(singles[0].results[1].result.execution.status, 'pass');
  assert.equal(singles[1].results[1].result.execution.status, scenario === 'interaction' ? 'pass' : 'fail');
  const combined = await src.planIntegrationAsync({ ...scope, changeIds: changes.map(p => p.change.id) });
  assert.equal(combined.candidate.proposals.length, 2); assert.deepEqual(combined.conflicts, []);
  // Reusing a genuine passing component execution for the combined tree is denied.
  await assert.rejects(() => src.integration.record({ ...input(combined), principalId: service.id, checkId: 'integration', ...singles[0].results[1].result }), /exact candidate/);
  const results = await verify(combined);
  assert.equal(results[0].result.execution.status, 'pass');
  assert.equal(results[1].result.execution.status, 'fail');
  assert.match(results[1].result.execution.stderr, /shared capacity exceeded/);
  await assert.rejects(() => src.integration.accept(input(combined)), /not satisfied/);
  assert.equal(await git(repo.barePath, 'rev-parse', 'main'), base);
  const split = await src.integration.split(input(combined));
  assert.equal(split.children.length, 2);
  const passing = []; const failing = [];
  for (const child of split.children) {
    assert.equal((await src.integration.evaluate(input(child))).ok, false, 'split identity requires fresh checks even if tree equals an earlier singleton');
    await assert.rejects(() => src.integration.accept(input(child)), /not satisfied/);
    const checked = await verify(child);
    (checked[1].result.execution.status === 'pass' ? passing : failing).push(child);
  }
  assert.equal(passing.length, scenario === 'interaction' ? 2 : 1);
  assert.equal(failing.length, scenario === 'interaction' ? 0 : 1);
  if (failing.length) assert.equal(failing[0].candidate.proposals[0].id, changes[1].change.id);
  for (const child of passing) await src.integration.accept(input(child));
  const landed = await src.integration.promote(input(passing[0])); assert.equal(landed.state, 'landed');
  if (passing.length === 2) assert.equal((await src.integration.promote(input(passing[1]))).state, 'rejected', 'individually safe children cannot race past combined failure');
  assert.equal(await git(repo.barePath, 'show', 'main:a.json'), '3');
  assert.equal(await git(repo.barePath, 'show', 'main:b.json'), '2');
  await assert.rejects(() => src.integration.accept(input(combined)), /not satisfied/);
  t.diagnostic(JSON.stringify({ scenario, combined: combined.candidate.id, unit: 'pass', integration: 'fail', passingSplits: passing.length, failingSplits: failing.length, landed: landed.headCommit }));
});
