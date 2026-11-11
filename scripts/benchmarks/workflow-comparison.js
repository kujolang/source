#!/usr/bin/env node
// Controlled full-workflow comparison. Scripted edits, no repository code execution.
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Source } from '../../src/source.js';
import { PostgresStore } from '../../src/postgres-store.js';
import { startServer } from '../../src/api.js';
import { authenticatedGit } from '../../src/remote.js';
import { HttpTelemetry } from './telemetry.js';
const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const roles = fileURLToPath(new URL('./integration.js', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = async (cwd, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const hash = data => createHash('sha256').update(data).digest('hex');
const fixture = (count, complete = false) => Array.from({ length: count }, (_, n) => [`section ${n}`, `agent ${n}: ${complete ? 'complete' : 'pending'}`, ...Array.from({ length: 7 }, (_, j) => `context ${n}.${j + 2}`)].join('\n')).join('\n') + '\n';

if (process.argv[2] === '--verify') {
  let data = ''; for await (const chunk of process.stdin) data += chunk;
  const input = JSON.parse(data);
  assert.match(input.baseCommit, /^[a-f0-9]{40}$/);
  const base = await git(input.repository, 'show', `${input.baseCommit}:shared.txt`);
  input.expected += base.split('\n').filter(line => /^agent [0-9]+: complete$/.test(line)).length;
  const pending = exec(process.execPath, [roles, '--verify'], { timeout: 120000 });
  pending.child.stdin.end(JSON.stringify(input));
  process.stdout.write((await pending).stdout);
} else await main();

async function main() {
  const args = process.argv.slice(2), flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const mode = flag('--mode'), agents = Number(flag('--agents', '100')), output = flag('--output');
  assert.ok(['serial', 'concurrent'].includes(mode), '--mode serial|concurrent required');
  assert.ok(Number.isSafeInteger(agents) && agents >= 1 && agents <= 100);
  assert.ok(output && path.isAbsolute(output));
  try { await access(output); throw new Error('Refusing to overwrite report'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const dsn = process.env.SOURCE_TEST_DATABASE_URL; assert.ok(dsn, 'Disposable database required');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'source-workflow-compare-')));
  const schema = `source_compare_${process.pid}_${Date.now()}`;
  const began = performance.now(), children = [], executions = [], workerErrors = [], sockets = [];
  let store, server, telemetry;
  const report = { version: 1, status: 'running', date: new Date().toISOString(), mode, agents, host: { node: process.version, platform: process.platform, cpuCount: cpus().length, memoryBytes: totalmem() }, profile: 'private-load; 1000/min push and submit; server timeouts unchanged', workload: 'same tiny scripted edits in separate sections of shared.txt; real authenticated HTTP/Git and PostgreSQL workers', recording: false, concurrency: { maximumActiveContributors: mode === 'serial' ? 1 : agents, workers: 2, concurrencyPerWorker: 2 }, workflowBoundary: 'before spawning first contributor through last verified promotion, ancestry checks and fetch; excludes common setup, final independent audit and cleanup', semantics: mode === 'serial' ? 'one agent clones latest main, edits, submits, verifies and promotes before next agent starts' : 'all agents clone same main and submit concurrently; one combined candidate verifies and promotes', timings: {}, batches: [], proposals: [], executions };
  const event = (name, data = {}) => console.log(JSON.stringify({ event: name, ...data }));
  const spawn = (role, config) => {
    const child = fork(roles, [`--${role}`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PGUSER: config.databaseUser } });
    child.stdout.resume(); child.stderr.resume();
    const entry = { child, messages: [], error: null };
    entry.closed = new Promise(resolve => child.once('close', (code, signal) => { if (code !== 0) entry.error ||= new Error(`${role} exited ${code ?? signal}`); resolve(); }));
    child.on('error', error => { entry.error = error; });
    child.on('message', message => { entry.messages.push(message); if (message.type === 'error') entry.error = Object.assign(new Error(message.error), { diagnostic: message.diagnostic }); if (message.type === 'execution') executions.push(message.value); if (message.type === 'workerError') workerErrors.push(message.error); });
    entry.wait = async type => { const until = Date.now() + 660000; while (Date.now() < until) { const result = entry.messages.find(m => m.type === type); if (result) return result; if (entry.error) throw entry.error; if (child.exitCode != null) throw new Error(`closed before ${type}`); await sleep(20); } throw new Error(`timeout: ${role}/${type}`); };
    children.push(entry); child.send({ type: 'config', config }); return entry;
  };
  try {
    store = new PostgresStore({ dsn, schema });
    const source = new Source(root, { store, maxIntegrationProposals: 100 });
    const databaseUser = (await store.pool.query('SELECT current_user AS name')).rows[0].name;
    report.sourceRevision = await git(path.resolve(path.dirname(script), '../..'), 'rev-parse', 'HEAD');
    report.harnessSha256 = hash(await readFile(script)); report.rolesSha256 = hash(await readFile(roles)); report.host.git = await git(root, '--version');
    const org = await source.createOrgAsync({ name: 'comparison', slug: 'comparison' });
    const human = await source.createPrincipalAsync({ type: 'human', name: 'comparison maintainer', password: 'fixture-password-only-123' });
    const service = await source.createPrincipalAsync({ type: 'service', name: 'comparison verifier' });
    await source.addOrgMemberAsync({ orgId: org.id, principalId: human.id, role: 'maintainer' });
    const project = await source.createProjectAsync({ orgId: org.id, name: 'project', slug: 'project', visibility: 'private' });
    const scope = { orgId: org.id, projectId: project.id };
    const repo = await source.createRepositoryAsync({ ...scope, name: 'repo' });
    const seed = path.join(root, 'seed'); await mkdir(seed);
    await git(seed, 'init', '-b', 'main'); await git(seed, 'config', 'user.name', 'Fixture'); await git(seed, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(seed, 'README.md'), 'Source integration benchmark fixture\n'); await writeFile(path.join(seed, 'shared.txt'), fixture(agents));
    await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'base'); await git(seed, 'push', repo.barePath, 'main');
    const initialBase = await git(seed, 'rev-parse', 'HEAD');
    const policy = { version: '1', securityPolicyVersion: '1', checks: [{ id: 'combined', version: report.harnessSha256, command: [process.execPath, script, '--verify'], toolVersions: { node: process.version, git: report.host.git, checker: report.harnessSha256, roles: report.rolesSha256 }, environment: 'controlled-local-git-fixture-v1', inputs: {}, externalState: {}, deterministic: true, maxAgeMs: 3600000, producers: [service.id], tier: 2 }] };
    await source.integration.configure({ ...scope, repoId: repo.id, principalId: human.id, policy });
    server = await startServer(source, { port: 0, host: '127.0.0.1', rateLimit: { gitPush: { limit: 1000, windowMs: 60000 }, submit: { limit: 1000, windowMs: 60000 } } });
    telemetry = new HttpTelemetry(server); server.on('connection', socket => sockets.push(new Promise(resolve => socket.once('close', resolve))));
    report.httpTimeouts = { headersMs: server.headersTimeout, requestMs: server.requestTimeout };
    const url = `http://127.0.0.1:${server.address().port}/git/${org.id}/${project.id}/${repo.id}.git`;
    const denied = await fetch(`${url}/info/refs?service=git-upload-pack`); assert.equal(denied.status, 401); await denied.arrayBuffer();
    const configs = [];
    for (let index = 0; index < agents; index++) {
      const principal = await source.createPrincipalAsync({ type: 'service', name: `agent-${index}` });
      const cap = await source.capabilities.issueAsync({ principalId: principal.id, allowed: ['read_source', 'git_push', 'submit_change'], scope: { org: org.id, project: project.id } });
      configs.push({ sameFile: true, submissionKey: `comparison-${index}`, root, cwd: path.join(root, `agent${index}`), index, repoIndex: 0, url, credential: cap.credential, principalId: principal.id, privateProfile: true });
    }
    const workers = Array.from({ length: 2 }, (_, i) => spawn('worker', { dsn, databaseUser, schema, root, maxIntegrationProposals: 100, serviceId: service.id, workerId: `comparison-${i}` }));
    await Promise.all(workers.map(w => w.wait('ready'))); workers.forEach(w => w.child.send({ type: 'go' }));
    report.timings.setupMs = performance.now() - began;
    const workflowAt = performance.now(); let prior = initialBase;
    for (let batch = 0; batch < (mode === 'serial' ? agents : 1); batch++) {
      const at = performance.now(), selectedConfigs = mode === 'serial' ? [configs[batch]] : configs;
      const clients = selectedConfigs.map(config => spawn('agent', config));
      await Promise.all(clients.map(c => c.wait('ready'))); const readyAt = performance.now();
      clients.forEach(c => c.child.send({ type: 'go' }));
      const proposals = (await Promise.all(clients.map(c => c.wait('result')))).map(m => m.result); await Promise.all(clients.map(c => c.closed));
      assert.ok(proposals.every(p => p.baseCommit === prior)); report.proposals.push(...proposals);
      const submittedAt = performance.now();
      const plan = await source.planIntegrationAsync({ ...scope, repoId: repo.id, changeIds: proposals.map(p => p.changeId) });
      assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.rejected, []); assert.equal(plan.candidate.proposals.length, proposals.length);
      assert.equal(await git(repo.barePath, 'rev-parse', 'main'), prior);
      const input = { ...scope, repoId: repo.id, candidateId: plan.candidate.id, principalId: human.id };
      await assert.rejects(() => source.integration.accept(input), /verification requirements/);
      const assembledAt = performance.now(); await source.verification.dispatch(input);
      const deadline = Date.now() + 180000;
      while (await source.jobs.count(scope)) { if (Date.now() > deadline || workerErrors.length) throw new Error(`verification failed: ${workerErrors.join('; ')}`); await sleep(20); }
      assert.equal((await source.integration.evaluate(input)).ok, true);
      const verifiedAt = performance.now(); await source.integration.accept(input);
      assert.equal((await source.integration.promote(input)).state, 'landed');
      assert.equal(await git(repo.barePath, 'rev-parse', 'main'), plan.candidate.headCommit);
      for (const p of proposals) await git(repo.barePath, 'merge-base', '--is-ancestor', p.headCommit, plan.candidate.headCommit);
      const client = selectedConfigs[0]; await authenticatedGit(client.credential, client.url, client.cwd)(['fetch', 'source']);
      assert.equal(await git(client.cwd, 'rev-parse', 'source/main'), plan.candidate.headCommit);
      prior = plan.candidate.headCommit;
      report.batches.push({ batch, startedAfterMs: at - workflowAt, finishedAfterMs: performance.now() - workflowAt, count: proposals.length, spawnReadyMs: readyAt - at, contributionMs: submittedAt - readyAt, assemblyAndGateMs: assembledAt - submittedAt, verificationMs: verifiedAt - assembledAt, acceptancePromotionRetentionFetchMs: performance.now() - verifiedAt, totalMs: performance.now() - at, baseCommit: plan.candidate.baseCommit, headCommit: prior, tree: plan.candidate.tree });
      event('batch', { mode, completed: report.proposals.length, agents, elapsedMs: performance.now() - workflowAt });
    }
    report.timings.workflowMs = performance.now() - workflowAt;
    const validationAt = performance.now();
    assert.equal((await exec('git', ['show', `${prior}:shared.txt`], { cwd: repo.barePath })).stdout, fixture(agents, true));
    for (const p of report.proposals) await git(repo.barePath, 'merge-base', '--is-ancestor', p.headCommit, prior);
    assert.equal((await source.listWorkAsync(org.id, project.id)).length, agents); assert.equal((await source.listChangesAsync(org.id, project.id)).length, agents);
    const jobs = await source.jobs.list(scope); assert.equal(jobs.length, mode === 'serial' ? agents : 1); assert.ok(jobs.every(j => j.status === 'completed' && j.attempts === 1));
    assert.equal(executions.length, jobs.length);
    report.finalTree = await git(repo.barePath, 'rev-parse', 'main^{tree}'); report.finalContentSha256 = hash(fixture(agents, true));
    report.correctness = { exactFinalContent: true, allContributorAncestryRetained: true, noDuplicateWorkOrChanges: true, unverifiedAcceptanceRejectedEveryBatch: true, exactVerifiedPromotionEveryBatch: true, verificationJobs: jobs.length };
    report.timings.finalAuditMs = performance.now() - validationAt;
    workers.forEach(w => w.child.send({ type: 'stop' })); await Promise.all(workers.map(w => w.wait('stopped'))); await Promise.all(workers.map(w => w.closed));
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.message; report.diagnostic = error.diagnostic; process.exitCode = 1; }
  finally {
    report.httpBeforeCleanup = telemetry?.snapshot();
    for (const e of children) if (e.child.exitCode == null && e.child.signalCode == null) e.child.kill('SIGKILL');
    await Promise.all(children.map(e => e.closed));
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await Promise.all(sockets);
    report.httpAfterCleanup = telemetry?.snapshot();
    if (store) { await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.closeAsync(); }
    await rm(root, { recursive: true, force: true }); report.timings.totalIncludingSetupAuditCleanupMs = performance.now() - began;
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); event('result', { mode, status: report.status, timings: report.timings, error: report.error });
  }
}
