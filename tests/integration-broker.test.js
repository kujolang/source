import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { freshSource, seedRepo } from './helpers.js';
import { verificationIdentity, createVerificationReceipt } from '../src/verification.js';
import { digest } from '../src/integration-planner.js';
import { startServer } from '../src/api.js';
const exec = promisify(execFile);

test('legacy assembly candidates remain inspectable but cannot reuse evidence or authorize promotion', async (t) => {
  const f = await setup(t); const item = await f.propose('legacy');
  const report = structuredClone(item.report);
  delete report.candidate.assemblyContract;
  delete report.candidate.id;
  report.candidate.id = digest(report.candidate);
  const input = { ...item.input, candidateId: report.candidate.id };
  const root = f.src.integration.scope(input);
  execFileSync('git', ['update-ref', `refs/source/candidates/${input.candidateId}`, report.candidate.headCommit], { cwd: f.repo.barePath });
  await f.src._asyncWrite(`${root}/${input.candidateId}.json`, report);
  // Model a persisted pre-upgrade passing receipt and human acceptance, not just
  // an unverified historical snapshot. These must not restore authorization.
  const artifactRef = f.src.store.putArtifact(Buffer.from('legacy passing output'));
  const receipt = createVerificationReceipt({ candidate: report.candidate, policy: f.policy, checkId: 'integration',
    producer: f.service, execution: f.execution(report), artifactRef });
  await f.src._asyncWrite(`${root}/${input.candidateId}/receipts/${receipt.id}.json`, receipt);
  await f.src._asyncWrite(`${root}/${input.candidateId}/acceptance.json`, { candidateId: input.candidateId,
    policyHash: report.policyHash, principalId: f.human.id, receipts: [receipt.id] });
  await assert.rejects(() => f.src.integration.evaluate(input), /assembly contract changed/);
  await assert.rejects(() => f.src.integration.accept(input), /assembly contract changed/);
  await assert.rejects(() => f.src.integration.promote(input), /assembly contract changed/);
  await assert.rejects(() => f.verify({ input, report }), /assembly contract changed/);
  const status = await f.src.integration.status(input);
  assert.equal(status.evaluation.ok, false);
  assert.match(status.evaluation.reason, /assembly contract changed/);
  assert.ok(status.acceptance, 'historical acceptance is retained for inspection');
  assert.equal(f.src.gitRepo(f.org.id, f.project.id, f.repo.id).revParse('main'), f.baseCommit);
  const fresh = await f.src.planIntegrationAsync({ ...f.scope, changeIds: [item.change.id] });
  assert.notEqual(fresh.candidate.id, input.candidateId);
  const next = { ...input, candidateId: fresh.candidate.id };
  assert.equal((await f.src.integration.evaluate(next)).ok, false, 'fresh assembly requires fresh evidence');
  await f.verify({ input: next, report: fresh });
  await f.src.integration.accept(next);
  assert.equal((await f.src.integration.promote(next)).state, 'landed');
});

async function setup(t) {
  const state = freshSource();
  const { src, org, project, human, service, agent } = state;
  const { repo, work: cwd, head: baseCommit } = seedRepo(src, org.id, project.id);
  t.after(() => { rmSync(state.dir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });
  const scope = { orgId: org.id, projectId: project.id, repoId: repo.id, principalId: human.id };
  const policy = { version: '1', securityPolicyVersion: '1', checks: [{ id: 'integration', version: '1', command: ['node', '--test'], toolVersions: { node: process.version }, environment: 'fixture-image', inputs: {}, externalState: {}, deterministic: true, maxAgeMs: 60_000, producers: [service.id] }] };
  await src.integration.configure({ ...scope, policy });
  async function propose(name) {
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('checkout', '--detach', baseCommit);
    writeFileSync(path.join(cwd, name), name);
    git('add', '.'); git('commit', '-m', name);
    const headCommit = git('rev-parse', 'HEAD');
    git('push', 'origin', `HEAD:refs/heads/${name}`);
    const work = src.createWork({ ...scope, intent: name, requester: agent.id });
    src.claimWork({ ...scope, workId: work.id, principalId: agent.id });
    const session = src.startSession({ ...scope, workId: work.id, principalId: agent.id, baseCommit });
    const change = src.submitChange({ ...scope, workId: work.id, sessionId: session.id, repositories: [repo.id], baseCommit, headCommit });
    const report = await src.planIntegrationAsync({ ...scope, changeIds: [change.id] });
    return { change, report, input: { ...scope, candidateId: report.candidate.id } };
  }
  function execution(report, status = 'pass') {
    const check = policy.checks[0]; const now = Date.now();
    return { identity: verificationIdentity(report.candidate, policy, check.id), commit: report.candidate.headCommit, tree: report.candidate.tree, environment: check.environment, inputs: check.inputs, externalState: check.externalState, toolVersions: check.toolVersions, command: check.command, status, startedAt: now - 10, finishedAt: now, durationMs: 10 };
  }
  async function verify(item, status = 'pass') {
    return src.integration.record({ ...item.input, principalId: service.id, checkId: 'integration', execution: execution(item.report, status), output: 'original fixture output' });
  }
  return { ...state, scope, policy, repo, cwd, baseCommit, propose, verify, execution };
}

test('broker requires exact evidence and maintainer acceptance; atomic landed receipt makes repeats idempotent', async (t) => {
  const f = await setup(t); const item = await f.propose('feature');
  await assert.rejects(() => f.src.integration.accept(item.input), /verification/);
  await assert.rejects(() => f.src.integration.record({ ...item.input, principalId: f.service.id, checkId: 'integration', execution: f.execution(item.report), output: 'queued output', jobLease: { id: 'job', workerId: 'worker', leaseToken: 'lease' } }), /transactional lease fencing/);
  await assert.rejects(() => f.src.integration.record({ ...item.input, principalId: f.agent.id, checkId: 'integration', execution: f.execution(item.report), output: 'forged' }), /untrusted/);
  const saved = await f.verify(item);
  const repeated = await f.src.integration.record({ ...item.input, principalId: f.service.id, checkId: 'integration', execution: saved.execution, output: 'original fixture output' });
  assert.deepEqual(repeated, saved);
  assert.equal((await f.src.integration.status(item.input)).state, 'verified');
  await assert.rejects(() => f.src.integration.accept({ ...item.input, principalId: f.agent.id }), /maintainer/);
  await f.src.integration.accept(item.input);
  assert.equal((await f.src.integration.status(item.input)).state, 'accepted');
  const outcomes = await Promise.all([f.src.integration.promote(item.input), f.src.integration.promote(item.input)]);
  assert.ok(outcomes.every((result) => result.state === 'landed'));
  assert.equal(f.src.gitRepo(f.org.id, f.project.id, f.repo.id).revParse('main'), item.report.candidate.headCommit);
  assert.equal((await f.src.integration.promote(item.input)).recovered, true);
  assert.equal((await f.src.integration.status(item.input)).state, 'landed');
  await assert.rejects(() => f.src.updateRepositoryAsync({ ...f.scope, defaultBranch: 'other' }), /operator migration/);
});

test('competing candidates and stale evidence never overwrite the protected target', async (t) => {
  const f = await setup(t); const a = await f.propose('a'); const b = await f.propose('b');
  await f.verify(a); await f.verify(b);
  await f.src.integration.accept(a.input); await f.src.integration.accept(b.input);
  assert.equal((await f.src.integration.promote(a.input)).state, 'landed');
  assert.equal((await f.src.integration.promote(b.input)).state, 'rejected');
  assert.equal(f.src.gitRepo(f.org.id, f.project.id, f.repo.id).revParse('main'), a.report.candidate.headCommit);
  const updated = structuredClone(f.policy); updated.checks[0].inputs = { lock: 'new' };
  await f.src.integration.configure({ ...f.scope, policy: updated });
  await assert.rejects(() => f.src.integration.accept(b.input), /policy changed/);
  const replanned = await f.src.planIntegrationAsync({ ...f.scope, changeIds: [a.change.id] });
  assert.notEqual(replanned.candidate?.id, a.report.candidate.id);
});

test('Git success followed by lost database acknowledgment reconciles without another update', async (t) => {
  const f = await setup(t); const item = await f.propose('recovery');
  await f.verify(item); await f.src.integration.accept(item.input);
  const write = f.src._asyncWrite.bind(f.src);
  f.src._asyncWrite = (rel, value) => { if (rel.endsWith('/outcome.json')) throw new Error('injected lost outcome write'); return write(rel, value); };
  await assert.rejects(() => f.src.integration.promote(item.input), /lost outcome/);
  f.src._asyncWrite = write;
  assert.equal(f.src.gitRepo(f.org.id, f.project.id, f.repo.id).revParse('main'), item.report.candidate.headCommit);
  assert.equal((await f.src.integration.promote(item.input)).recovered, true);
  assert.ok(f.src.readAudit().some((entry) => entry.event === 'integration.intent'));
});

test('HTTP capabilities cannot forge service identity or bypass a protected branch', async (t) => {
  const f = await setup(t); const item = await f.propose('http');
  const server = await startServer(f.src, { port: 0 });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const prefix = `${base}/api/v1/orgs/${f.org.id}/projects/${f.project.id}/repositories/${f.repo.id}/integration/${item.input.candidateId}`;
  const cap = f.src.capabilities.issue({ principalId: f.agent.id, scope: { org: f.org.id, project: f.project.id }, allowed: ['record_verification'] });
  const result = await fetch(`${prefix}/verification`, { method: 'POST', headers: { Authorization: `Bearer ${cap.credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ principalId: f.service.id, checkId: 'integration', execution: f.execution(item.report), output: 'forged' }) });
  assert.notEqual(result.status, 201);
  assert.equal((await f.src.integration.evaluate(item.input)).ok, false);
  const gitCap = f.src.issueGitCapability({ ...f.scope, principalId: f.agent.id });
  const clone = mkdtempSync(path.join(tmpdir(), 'source-broker-client-')); t.after(() => rmSync(clone, { recursive: true, force: true }));
  const url = `${base}/git/${f.org.id}/${f.project.id}/${f.repo.id}.git`;
  const header = `http.extraHeader=Authorization: Basic ${Buffer.from(`source:${gitCap.credential}`).toString('base64')}`;
  await exec('git', ['-c', header, 'clone', url, clone]);
  await assert.rejects(() => exec('git', ['-c', header, 'push', 'origin', `${item.change.headCommit}:refs/heads/main`], { cwd: clone }), /hidden ref/);
  // Legacy accepted-change promotion is also blocked after integration opt-in.
  const change = f.src.getChange(f.org.id, f.project.id, item.change.id); change.decisionState = 'accepted'; f.src._saveChange(f.org.id, f.project.id, change);
  assert.throws(() => f.src.updateCanonicalState({ ...f.scope, changeId: change.id }), /integration broker/);
  await assert.rejects(() => f.src.updateCanonicalStateAsync({ ...f.scope, changeId: change.id }), /integration broker/);
  const serviceCap = f.src.capabilities.issue({ principalId: f.service.id, scope: { org: f.org.id, project: f.project.id }, allowed: ['record_verification'] });
  const record = await fetch(`${prefix}/verification`, { method: 'POST', headers: { Authorization: `Bearer ${serviceCap.credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ checkId: 'integration', execution: f.execution(item.report), output: 'trusted fixture output' }) });
  assert.equal(record.status, 201);
  const maintainerCap = f.src.capabilities.issue({ principalId: f.human.id, scope: { org: f.org.id, project: f.project.id }, allowed: ['accept_change', 'promote_integration', 'read_context'] });
  for (const action of ['accept', 'promote', 'status']) {
    const response = await fetch(`${prefix}/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${maintainerCap.credential}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (action !== 'accept') assert.equal(body.state, 'landed');
  }
});


test('changed verification policy creates a new immutable candidate identity', async (t) => {
  const f = await setup(t); const original = await f.propose('policy');
  await f.verify(original);
  const policy = structuredClone(f.policy); policy.version = '2';
  await f.src.integration.configure({ ...f.scope, policy });
  const updated = await f.src.planIntegrationAsync({ ...f.scope, changeIds: [original.change.id] });
  assert.notEqual(updated.candidate.id, original.report.candidate.id);
  assert.equal(updated.candidate.headCommit, original.report.candidate.headCommit);
  assert.deepEqual(await f.src.getIntegrationAsync(original.input), original.report);
  await assert.rejects(() => f.src.integration.accept(original.input), /policy changed/);
  assert.equal((await f.src.integration.evaluate({ ...original.input, candidateId: updated.candidate.id })).ok, false);
});

test('independent CLI processes race two verified candidates through Git compare-and-swap', async (t) => {
  const f = await setup(t); const a = await f.propose('process-a'); const b = await f.propose('process-b');
  await f.verify(a); await f.verify(b); await f.src.integration.accept(a.input); await f.src.integration.accept(b.input);
  const outcomes = await Promise.all([a, b].map(async (item) => {
    const result = await exec(process.execPath, ['bin/source.js', '--store', 'json', 'integration', 'promote', '--org', f.org.id, '--project', f.project.id, '--repo', f.repo.id, '--candidate', item.input.candidateId, '--principal', f.human.id], { env: { ...process.env, SOURCE_DATA: f.dir } });
    return JSON.parse(result.stdout);
  }));
  assert.deepEqual(outcomes.map((result) => result.state).sort(), ['landed', 'rejected']);
  const winner = outcomes.find((result) => result.state === 'landed');
  assert.equal(f.src.gitRepo(f.org.id, f.project.id, f.repo.id).revParse('main'), winner.headCommit);
});


test('a promoter process exits after Git commit and a fresh process reconciles the durable result', async (t) => {
  const f = await setup(t); const item = await f.propose('crash');
  await f.verify(item); await f.src.integration.accept(item.input);
  const script = `import { Source } from './src/source.js';
    const src = new Source(process.argv[1]);
    const write = src._asyncWrite.bind(src);
    src._asyncWrite = (rel, value) => { if (rel.endsWith('/outcome.json')) process.exit(23); return write(rel, value); };
    await src.integration.promote(JSON.parse(process.argv[2]));`;
  await assert.rejects(() => exec(process.execPath, ['--input-type=module', '-e', script, f.dir, JSON.stringify(item.input)]), (error) => error.code === 23);
  const result = await exec(process.execPath, ['bin/source.js', '--store', 'json', 'integration', 'promote', '--org', f.org.id, '--project', f.project.id, '--repo', f.repo.id, '--candidate', item.input.candidateId, '--principal', f.human.id], { env: { ...process.env, SOURCE_DATA: f.dir } });
  assert.equal(JSON.parse(result.stdout).recovered, true);
  assert.equal(f.src.gitRepo(f.org.id, f.project.id, f.repo.id).revParse('main'), item.report.candidate.headCommit);
});

test('failed integration checks split a batch without transferring evidence or acceptance', async (t) => {
  const f = await setup(t); const a = await f.propose('split-a'); const b = await f.propose('split-b');
  const report = await f.src.planIntegrationAsync({ ...f.scope, changeIds: [a.change.id, b.change.id] });
  const item = { report, input: { ...f.scope, candidateId: report.candidate.id } };
  await assert.rejects(() => f.src.integration.split(item.input), /recorded failed/);
  await f.verify(item, 'fail');
  await assert.rejects(() => f.src.integration.accept(item.input), /not satisfied/);
  const split = await f.src.integration.split(item.input);
  assert.equal(split.children.length, 2);
  for (const child of split.children) {
    const input = { ...f.scope, candidateId: child.candidate.id };
    assert.equal((await f.src.integration.status(input)).state, 'proposed');
    assert.equal((await f.src.integration.evaluate(input)).ok, false);
    await assert.rejects(() => f.src.integration.accept(input), /not satisfied/);
  }
  assert.equal(f.src.gitRepo(f.org.id, f.project.id, f.repo.id).revParse('main'), f.baseCommit);
});

test('tool gate parses original artifacts; context-only checks and contradictory green claims are denied', async (t) => {
  const f = await setup(t);
  f.policy.checks[0].adapter = 'fence';
  await f.src.integration.configure({ ...f.scope, policy: f.policy });
  const item = await f.propose('adapter');
  const output = { schema_version: 1, version: '1.0.0', status: 'passed', summary: { errors: 0, skipped_files: 0 }, violations: [], skipped_files: [] };
  const record = (report, status = 'pass') => f.src.integration.record({ ...item.input, principalId: f.service.id, checkId: 'integration', execution: f.execution(item.report, status), output: typeof report === 'string' ? report : JSON.stringify(report) });
  await assert.rejects(() => record({ ...output, status: 'failed' }), /does not support/);
  await assert.rejects(() => record({ ...output, schema_version: 99 }), /contract/);
  await record(output);
  assert.equal((await f.src.integration.evaluate(item.input)).ok, true);
  // A crashed tool may produce no JSON, but its failed execution must still supersede a pass.
  await record('tool crashed before producing JSON', 'fail');
  assert.equal((await f.src.integration.evaluate(item.input)).ok, false);
  f.policy.checks[0].adapter = 'casefile';
  await assert.rejects(() => f.src.integration.configure({ ...f.scope, policy: f.policy }), /context-only/);
});
