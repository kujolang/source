import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Source } from '../src/source.js';
import { PostgresStore } from '../src/postgres-store.js';
import { createVerificationHandler } from '../src/verification-dispatcher.js';
import { startServer } from '../src/api.js';
const exec = promisify(execFile);
const dsn = process.env.SOURCE_TEST_DATABASE_URL;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'source-dispatch-'));
  const schema = `source_dispatch_${process.pid}_${Date.now()}`;
  const store = new PostgresStore({ dsn, schema });
  const peerStore = new PostgresStore({ dsn, schema });
  const src = new Source(root, { store }); const peer = new Source(root, { store: peerStore });
  t.after(async () => { await peerStore.closeAsync(); await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.closeAsync(); await rm(root, { recursive: true, force: true }); });
  const org = await src.createOrgAsync({ name: 'test', slug: 'test' });
  const project = await src.createProjectAsync({ orgId: org.id, name: 'test', slug: 'test' });
  const human = await src.createPrincipalAsync({ type: 'human', name: 'maintainer', password: 'test-password-123' });
  const service = await src.createPrincipalAsync({ type: 'service', name: 'verifier' });
  await src.addOrgMemberAsync({ orgId: org.id, principalId: human.id, role: 'maintainer' });
  const scope = { orgId: org.id, projectId: project.id };
  const repo = await src.createRepositoryAsync({ ...scope, name: 'repo' });
  const cwd = await mkdtemp(path.join(root, 'checkout-'));
  const git = async (...args) => (await exec('git', args, { cwd })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(cwd, 'value'), 'base'); await git('add', '.'); await git('commit', '-m', 'base');
  const baseCommit = await git('rev-parse', 'HEAD'); await git('remote', 'add', 'origin', repo.barePath); await git('push', 'origin', 'main');
  const check = { version: '1', command: ['fixture-check'], toolVersions: { fixture: '1' }, environment: 'controlled-test-fixture', inputs: {}, externalState: {}, deterministic: true, maxAgeMs: 600000, producers: [service.id] };
  const policy = { version: '1', securityPolicyVersion: '1', checks: [{ ...check, id: 'preflight', tier: 0 }, { ...check, id: 'combined', tier: 2, dependsOn: ['preflight'] }, { ...check, id: 'staging', tier: 3, deterministic: false, dependsOn: ['combined'] }] };
  await src.integration.configure({ ...scope, repoId: repo.id, principalId: human.id, policy });
  await writeFile(path.join(cwd, 'value'), 'candidate'); await git('commit', '-am', 'proposal');
  const headCommit = await git('rev-parse', 'HEAD'); await git('push', 'origin', 'HEAD:refs/heads/proposal');
  const work = await src.createWorkAsync({ ...scope, intent: 'candidate', requester: human.id });
  await src.claimWorkAsync({ ...scope, workId: work.id, principalId: human.id });
  const session = await src.startSessionAsync({ ...scope, workId: work.id, principalId: human.id, baseCommit });
  const change = await src.submitChangeAsync({ ...scope, workId: work.id, sessionId: session.id, repositories: [repo.id], baseCommit, headCommit });
  const report = await src.planIntegrationAsync({ ...scope, repoId: repo.id, changeIds: [change.id] });
  const input = { ...scope, repoId: repo.id, candidateId: report.candidate.id, principalId: human.id };
  const execute = async ({ candidate, check, identity, repository }) => {
    const startedAt = Date.now();
    const output = (await exec('git', ['--git-dir', repository, 'show', `${candidate.headCommit}:value`])).stdout;
    assert.equal(output, 'candidate');
    const finishedAt = Date.now();
    return { output, execution: { identity, commit: candidate.headCommit, tree: candidate.tree, command: check.command, environment: check.environment, inputs: check.inputs, toolVersions: check.toolVersions, externalState: check.externalState, status: 'pass', startedAt, finishedAt, durationMs: finishedAt - startedAt } };
  };
  const handler = createVerificationHandler({ source: peer, principalId: service.id, executor: { execute } });
  const run = async () => {
    const [job] = await src.jobs.claim({ workerId: 'fixture', limit: 1 }); assert.ok(job);
    const result = await handler(job.payload, job);
    assert.equal(await src.jobs.complete({ id: job.id, workerId: job.workerId, leaseToken: job.leaseToken, result }), true);
    return { job, result };
  };
  return { src, peer, store, schema, scope, input, policy, report, service, execute, handler, run };
}

test('concurrent dispatch coalesces exact checks, enforces dependencies and reuses deterministic receipts', { skip: !dsn }, async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? f.peer : f.src).verification.dispatch(f.input)));
  assert.equal(await f.src.jobs.count(f.scope), 3);
  for (const id of ['preflight', 'combined', 'staging']) assert.equal(new Set(results.map((result) => result.checks.find((check) => check.checkId === id).jobId)).size, 1);
  // Simulate a crash after persisting evidence but before acknowledging the job.
  const [unfinished] = await f.src.jobs.claim({ workerId: 'crashed', limit: 1 });
  assert.equal(unfinished.payload.checkId, 'preflight');
  const saved = await f.handler(unfinished.payload, unfinished);
  const inFlight = await f.peer.verification.dispatch(f.input);
  assert.equal(inFlight.checks[0].action, 'coalesced');
  assert.equal(inFlight.checks[0].jobId, unfinished.id);
  await f.store.pool.query(`UPDATE "${f.schema}".jobs SET leased_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [unfinished.id]);
  const recovered = await f.run();
  assert.equal(recovered.job.id, unfinished.id);
  assert.equal(recovered.result.reused, true);
  assert.equal(recovered.result.receiptId, saved.receiptId);
  for (const id of ['combined', 'staging']) assert.equal((await f.run()).job.payload.checkId, id);
  assert.equal((await f.src.integration.evaluate(f.input)).ok, true);
  const repeated = await f.peer.verification.dispatch(f.input);
  assert.deepEqual(repeated.checks.map((check) => check.action), ['reused', 'reused', 'scheduled']);
  assert.match(repeated.checks[2].reason, /environment-dependent/);
  assert.equal(repeated.checks[2].epoch, 2);
  assert.equal((await f.src.integration.evaluate(f.input)).ok, false, 'a requested rerun must not be satisfied by a prior generation');
  await assert.rejects(() => f.src.integration.accept(f.input), /verification requirements/);
  const pending = await f.src.jobs.claim({ workerId: 'cancelled', limit: 1 });
  await f.src.jobs.cancel({ ...f.scope, id: pending[0].id });
  await assert.rejects(() => f.handler(pending[0].payload, pending[0]), /cancelled/);
  const replacement = await f.src.verification.dispatch(f.input);
  assert.equal(replacement.checks[2].epoch, 3);
  assert.notEqual(replacement.checks[2].jobId, pending[0].id);
  await f.run();
  await f.src.integration.accept(f.input);
  assert.equal((await f.peer.integration.promote(f.input)).state, 'landed');
  await assert.rejects(() => f.src.verification.dispatch(f.input), /target changed/);
});

test('dispatch API requires explicit authority and cannot substitute client execution configuration', { skip: !dsn }, async (t) => {
  const f = await fixture(t);
  const server = await startServer(f.src, { port: 0 });
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/orgs/${f.scope.orgId}/projects/${f.scope.projectId}/repositories/${f.input.repoId}/integration/${f.input.candidateId}/dispatch`;
  const send = async (allowed) => {
    const cap = await f.src.capabilities.issueAsync({ principalId: f.service.id, allowed, scope: { org: f.scope.orgId, project: f.scope.projectId } });
    return fetch(url, { method: 'POST', headers: { authorization: `Bearer ${cap.credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ command: ['untrusted'], principalId: 'forged', priority: 100 }) });
  };
  assert.equal((await send(['enqueue_job'])).status, 403);
  const response = await send(['dispatch_verification']); assert.equal(response.status, 200, await response.clone().text());
  const [job] = await f.src.jobs.claim({ workerId: 'owner', limit: 1 });
  assert.equal(job.payload.command, undefined);
  assert.equal(job.payload.principalId, undefined);
  assert.equal(job.priority, 0);
  const result = await f.handler(job.payload, job);
  assert.ok(result.receiptId);
});

test('cancelled execution cannot save evidence, forged jobs cannot run, and failed prerequisites rerun descendants', { skip: !dsn }, async (t) => {
  const f = await fixture(t);
  const first = await f.src.verification.dispatch(f.input);
  const [cancelled] = await f.src.jobs.claim({ workerId: 'cancelled-during-run', limit: 1 });
  const cancelling = createVerificationHandler({ source: f.peer, principalId: f.service.id, executor: { execute: async (input) => {
    const result = await f.execute(input);
    await f.src.jobs.cancel({ ...f.scope, id: input.job.id });
    return result;
  } } });
  await assert.rejects(() => cancelling(cancelled.payload, cancelled), /cancelled/);
  assert.equal((await f.src.integration.evaluate(f.input)).checks[0].satisfied, false);
  const next = await f.src.verification.dispatch(f.input);
  assert.ok(next.checks.every((check, i) => check.epoch === 2 && check.jobId !== first.checks[i].jobId));
  await assert.rejects(() => f.handler(cancelled.payload, { ...cancelled, id: 'forged' }), /superseded/);
  const [failed] = await f.src.jobs.claim({ workerId: 'failed-check', limit: 1 });
  const failing = createVerificationHandler({ source: f.peer, principalId: f.service.id, executor: { execute: async (input) => {
    const result = await f.execute(input); result.execution.status = 'fail'; return result;
  } } });
  await assert.rejects(() => failing(failed.payload, failed), /verification fail; receipt/);
  await f.src.jobs.fail({ id: failed.id, workerId: failed.workerId, leaseToken: failed.leaseToken, error: 'fixture failure', maxAttempts: 1 });
  assert.equal((await f.src.integration.evaluate(f.input)).checks[0].reason, 'latest execution fail');
  const retry = await f.src.verification.dispatch(f.input);
  assert.ok(retry.checks.every((check) => check.action === 'scheduled' && check.epoch === 3));
  for (let i = 0; i < 3; i++) await f.run();
  assert.equal((await f.src.integration.evaluate(f.input)).ok, true);
});
