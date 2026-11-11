import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { Source } from '../src/source.js';
import { PostgresStore } from '../src/postgres-store.js';
import { startServer } from '../src/api.js';
import { submitFromWorkingDir } from '../src/submit.js';
import { submitRequest } from '../src/client-retry.js';
const exec = promisify(execFile);
const dsn = process.env.SOURCE_TEST_DATABASE_URL;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'source-submit-recovery-'));
  const schema = `submission_${process.pid}_${Date.now()}`;
  const store = new PostgresStore({ dsn, schema });
  const peerStore = new PostgresStore({ dsn, schema });
  const src = new Source(root, { store });
  const peer = new Source(root, { store: peerStore });
  t.after(async () => { await peerStore.closeAsync(); await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.closeAsync(); await rm(root, { recursive: true, force: true }); });
  const org = await src.createOrgAsync({ name: 'test', slug: 'test' });
  const project = await src.createProjectAsync({ orgId: org.id, name: 'test', slug: 'test', visibility: 'public' });
  const human = await src.createPrincipalAsync({ type: 'human', name: 'contributor' });
  await src.addOrgMemberAsync({ orgId: org.id, principalId: human.id, role: 'maintainer' });
  const scope = { orgId: org.id, projectId: project.id };
  const repo = await src.createRepositoryAsync({ ...scope, name: 'repo' });
  const cwd = await mkdtemp(path.join(root, 'clone-'));
  const git = async (...args) => (await exec('git', args, { cwd })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(cwd, 'value'), 'base'); await git('add', '.'); await git('commit', '-m', 'base');
  const baseCommit = await git('rev-parse', 'HEAD'); await git('remote', 'add', 'origin', repo.barePath); await git('push', 'origin', 'main');
  await writeFile(path.join(cwd, 'value'), 'proposal'); await git('commit', '-am', 'proposal');
  const headCommit = await git('rev-parse', 'HEAD'); await git('push', 'origin', 'HEAD:refs/heads/proposal');
  const input = { ...scope, repoRef: repo.id, principalId: human.id, baseCommit, headCommit, intent: 'proposal', submissionKey: 'test-key' };
  return { root, schema, src, peer, store, input, scope, human, repo, cwd, git };
}

async function submissionCounts(f) {
  const counts = {};
  for (const table of ['works', 'sessions', 'changes', 'evidence', 'artifacts', 'audit', 'records', 'replication_events']) {
    counts[table] = (await f.store.pool.query(`SELECT count(*)::int AS count FROM "${f.schema}"."${table}"`)).rows[0].count;
  }
  return counts;
}

test('keyed submissions serialize across stores and retain the original result', { skip: !dsn }, async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? f.src : f.peer).submitContributionAsync(f.input)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal((await f.src.listWorkAsync(f.scope.orgId, f.scope.projectId)).length, 1);
  assert.equal((await f.src.listChangesAsync(f.scope.orgId, f.scope.projectId)).length, 1);
  await assert.rejects(() => f.peer.submitContributionAsync({ ...f.input, intent: 'different' }), { code: 'SUBMISSION_KEY_CONFLICT' });
  const changed = { ...results[0].change, description: 'later state' };
  await f.src._asyncWrite(`orgs/${f.scope.orgId}/projects/${f.scope.projectId}/changes/${changed.id}.json`, changed);
  assert.deepEqual(await f.peer.getSubmissionAsync(f.input), results[0]);
  assert.equal(await f.peer.getSubmissionAsync({ ...f.input, principalId: 'another-principal' }), null);
});

test('failure after evidence insertion rolls back the entire keyed submission', { skip: !dsn }, async (t) => {
  const f = await fixture(t);
  const before = await submissionCounts(f);
  const original = f.src.addEvidenceAsync.bind(f.src);
  f.src.addEvidenceAsync = async (...args) => { await original(...args); throw new Error('injected failure after evidence'); };
  await assert.rejects(() => f.src.submitContributionAsync(f.input), /injected failure/);
  assert.deepEqual(await submissionCounts(f), before);
  assert.equal((await f.peer.listWorkAsync(f.scope.orgId, f.scope.projectId)).length, 0);
  assert.equal((await f.peer.listChangesAsync(f.scope.orgId, f.scope.projectId)).length, 0);
  assert.equal(await f.peer.getSubmissionAsync(f.input), null);
  const result = await f.peer.submitContributionAsync(f.input);
  assert.equal(result.submission.committed, true);
  assert.equal((await f.peer.listWorkAsync(f.scope.orgId, f.scope.projectId)).length, 1);
});

test('SIGKILL after actual evidence insertion leaves no partial submission and permits retry', { skip: !dsn }, async (t) => {
  const f = await fixture(t);
  const before = await submissionCounts(f);
  const childFile = path.join(f.root, 'crash.mjs');
  await writeFile(childFile, `import {Source} from ${JSON.stringify(new URL('../src/source.js', import.meta.url).href)};
import {PostgresStore} from ${JSON.stringify(new URL('../src/postgres-store.js', import.meta.url).href)};
const store = new PostgresStore({dsn:process.env.SOURCE_TEST_DATABASE_URL,schema:process.env.SUBMISSION_SCHEMA});
const src = new Source(process.env.SUBMISSION_ROOT,{store});
const original=src.addEvidenceAsync.bind(src);
src.addEvidenceAsync=async (...args)=>{await original(...args);process.send('evidence-written');await new Promise(()=>{});};
await src.submitContributionAsync(JSON.parse(process.env.SUBMISSION_INPUT));`);
  const child = fork(childFile, [], { env: { ...process.env, SUBMISSION_SCHEMA: f.schema, SUBMISSION_ROOT: f.root, SUBMISSION_INPUT: JSON.stringify(f.input) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  const milestone = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('child exited before evidence'); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('child milestone timeout')), 15000); timer.unref(); })]);
  assert.equal(milestone[0], 'evidence-written');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.deepEqual(await submissionCounts(f), before);
  assert.equal((await f.peer.listWorkAsync(f.scope.orgId, f.scope.projectId)).length, 0);
  assert.equal(await f.peer.getSubmissionAsync(f.input), null);
  const result = await f.peer.submitContributionAsync(f.input);
  assert.equal(result.submission.committed, true);
});

test('HTTP key requires authentication on public projects and CLI recovery does no Git transfer', { skip: !dsn }, async (t) => {
  const f = await fixture(t);
  const capability = await f.src.capabilities.issueAsync({ principalId: f.human.id, scope: { org: f.scope.orgId, project: f.scope.projectId }, allowed: ['read_source', 'git_push', 'submit_change'] });
  const server = await startServer(f.src, { port: 0 });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/v1/orgs/${f.scope.orgId}/projects/${f.scope.projectId}`;
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'http-key' };
  const post = async (extra = {}, body = f.input) => fetch(`${endpoint}/submit`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post()).status, 401);
  headers.authorization = `Bearer ${capability.credential}`;
  const response = await post(); assert.equal(response.status, 201);
  const result = await response.json();
  assert.deepEqual(await (await post()).json(), result);
  assert.equal((await post({}, { ...f.input, intent: 'conflict' })).status, 409);
  // The raw body key is ignored; only the authenticated HTTP header defines it.
  assert.equal(await f.src.getSubmissionAsync(f.input), null);
  await f.git('remote', 'add', 'source', `${base}/git/${f.scope.orgId}/${f.scope.projectId}/${f.repo.id}.git`);
  const cliResult = await submitFromWorkingDir({ cwd: f.cwd, credential: capability.credential, submissionKey: 'cli-key' });
  assert.equal(cliResult.submission.committed, true);
  // Remove local HEAD: recovery must not inspect commits or transfer Git objects.
  await f.git('update-ref', '-d', 'refs/heads/main');
  const recovered = await submitFromWorkingDir({ cwd: f.cwd, credential: capability.credential, submissionKey: 'http-key', recover: true });
  assert.deepEqual(recovered, result);
  const cli = await exec(process.execPath, [new URL('../bin/source.js', import.meta.url).pathname, 'submit', '--cwd', f.cwd, '--submission-key', 'cli-key', '--recover'], { env: { ...process.env, SOURCE_CREDENTIAL: capability.credential } });
  assert.deepEqual(JSON.parse(cli.stdout), cliResult);
  assert.equal((await fetch(`${endpoint}/submissions/http-key`)).status, 401);
  const other = await f.src.createPrincipalAsync({ type: 'human', name: 'other' });
  const otherCap = await f.src.capabilities.issueAsync({ principalId: other.id, scope: { org: f.scope.orgId, project: f.scope.projectId }, allowed: ['submit_change'] });
  assert.equal((await fetch(`${endpoint}/submissions/http-key`, { headers: { authorization: `Bearer ${otherCap.credential}` } })).status, 404);
  f.src.capabilities.revoke(capability.id);
  assert.equal((await fetch(`${endpoint}/submissions/http-key`, { headers })).status, 401);
});


test('lost HTTP acknowledgment recovers a committed result without duplicate lifecycle records', { skip: !dsn }, async (t) => {
  const f = await fixture(t);
  const cap = await f.src.capabilities.issueAsync({ principalId: f.human.id, scope: { org: f.scope.orgId, project: f.scope.projectId }, allowed: ['submit_change'] });
  const server = await startServer(f.src, { port: 0 });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let responseSocket;
  server.prependListener('request', (req, res) => { if (req.method === 'POST' && req.url.endsWith('/submit')) responseSocket = res.socket; });
  const original = f.src.submitContributionAsync.bind(f.src);
  let committed;
  f.src.submitContributionAsync = async (input) => {
    committed = await original(input);
    responseSocket.destroy(); // Real transaction has committed; lose only the acknowledgment.
    return committed;
  };
  const endpoint = `http://127.0.0.1:${server.address().port}/api/v1/orgs/${f.scope.orgId}/projects/${f.scope.projectId}`;
  const headers = { authorization: `Bearer ${cap.credential}`, 'content-type': 'application/json', 'idempotency-key': 'lost-ack' };
  await assert.rejects(() => submitRequest(`${endpoint}/submit`, { method: 'POST', headers, body: JSON.stringify(f.input) }), /outcome unknown/);
  const recovered = await submitRequest(`${endpoint}/submissions/lost-ack`, { method: 'GET', headers });
  assert.deepEqual(recovered, committed);
  f.src.submitContributionAsync = original;
  assert.deepEqual(await submitRequest(`${endpoint}/submit`, { method: 'POST', headers, body: JSON.stringify(f.input) }), committed);
  assert.equal((await f.peer.listWorkAsync(f.scope.orgId, f.scope.projectId)).length, 1);
});

test('independent submission processes deduplicate and fresh processes retrieve the receipt', { skip: !dsn }, async (t) => {
  const f = await fixture(t);
  const program = `import {Source} from ${JSON.stringify(new URL('../src/source.js', import.meta.url).href)};
import {PostgresStore} from ${JSON.stringify(new URL('../src/postgres-store.js', import.meta.url).href)};
const store=new PostgresStore({dsn:process.env.SOURCE_TEST_DATABASE_URL,schema:process.env.SUBMISSION_SCHEMA});
try {const src=new Source(process.env.SUBMISSION_ROOT,{store}); const input=JSON.parse(process.env.SUBMISSION_INPUT);
const result=await src[process.env.SUBMISSION_READ ? 'getSubmissionAsync' : 'submitContributionAsync'](input); console.log(JSON.stringify(result));}
finally{await store.closeAsync();}`;
  const env = { ...process.env, SUBMISSION_ROOT: f.root, SUBMISSION_SCHEMA: f.schema, SUBMISSION_INPUT: JSON.stringify(f.input) };
  const run = (extra = {}) => exec(process.execPath, ['--input-type=module', '-e', program], { env: { ...env, ...extra }, timeout: 30000 });
  const attempts = await Promise.allSettled([run(), run()]);
  for (const attempt of attempts) assert.equal(attempt.status, 'fulfilled', attempt.reason?.message);
  const first = JSON.parse(attempts[0].value.stdout);
  assert.deepEqual(JSON.parse(attempts[1].value.stdout), first);
  assert.deepEqual(JSON.parse((await run({ SUBMISSION_READ: '1' })).stdout), first);
  assert.equal((await f.src.listWorkAsync(f.scope.orgId, f.scope.projectId)).length, 1);
});
