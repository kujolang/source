#!/usr/bin/env node
// Real HTTP/Git submission and PostgreSQL verification benchmark. Only this
// test-owned data checker executes on the host; repository code never does.
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { authenticatedGit } from '../../src/remote.js';
import { StageTelemetry, HttpTelemetry, processResources } from './telemetry.js';
const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = async (cwd, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd, env: env(), timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (q) => sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
  return { samples: sorted.length, total: values.reduce((a, b) => a + b, 0), p50: p(.5), p95: p(.95), p99: p(.99) };
};

async function verify(repository, commit, expected) {
  const names = (await git(repository, 'ls-tree', '-r', '--name-only', commit)).split('\n');
  const features = names.filter((name) => /^features\/agent-[0-9]+\.txt$/.test(name));
  assert.equal(features.length, expected, 'exact expected contributor count');
  assert.equal(names.length, features.length + 1, 'no unexpected files');
  const blob = async (name) => (await exec('git', ['show', `${commit}:${name}`], { cwd: repository, env: env(), timeout: 30000, maxBuffer: 1024 })).stdout;
  for (const name of features) assert.equal(await blob(name), `${name.match(/agent-([0-9]+)/)[1]}\n`, 'exact contributor content');
  assert.equal(await blob('README.md'), 'Source integration benchmark fixture\n', 'base preserved');
  process.stdout.write(JSON.stringify({ verified: true, commit, features: features.length }));
}

async function agent(config) {
  const { submitFromWorkingDir } = await import('../../src/submit.js');
  const started = performance.now();
  if (config.privateProfile) await authenticatedGit(config.credential, config.url, config.root)(['clone', config.url, config.cwd]);
  else await git(config.root, 'clone', config.url, config.cwd);
  const cloneMs = performance.now() - started;
  await git(config.cwd, 'config', 'user.name', `agent-${config.index}`);
  await git(config.cwd, 'config', 'user.email', `agent-${config.index}@fixture.invalid`);
  await git(config.cwd, 'remote', 'rename', 'origin', 'source');
  await git(config.cwd, 'remote', 'add', 'origin', 'git@github.com:fixture/unchanged.git');
  await mkdir(path.join(config.cwd, 'features'), { recursive: true });
  await writeFile(path.join(config.cwd, 'features', `agent-${config.index}.txt`), `${config.index}\n`);
  await git(config.cwd, 'add', '.'); await git(config.cwd, 'commit', '-m', `agent ${config.index}`);
  const submitStarted = performance.now();
  const result = await submitFromWorkingDir({ cwd: config.cwd, credential: config.credential });
  if (config.privateProfile) assert.equal(result.session.principal, config.principalId, 'private submit retains authenticated principal');
  assert.equal(await git(config.cwd, 'remote', 'get-url', 'origin'), 'git@github.com:fixture/unchanged.git');
  return { index: config.index, repoIndex: config.repoIndex, changeId: result.change.id, workId: result.work.id, sessionId: result.session.id, evidenceId: result.evidence.id, baseCommit: result.change.baseCommit, headCommit: result.change.headCommit, cloneMs, submitMs: performance.now() - submitStarted, totalMs: performance.now() - started };
}

async function worker(config) {
  const { Source } = await import('../../src/source.js');
  const { PostgresStore } = await import('../../src/postgres-store.js');
  const { SourceWorker } = await import('../../src/worker.js');
  const { createVerificationHandler } = await import('../../src/verification-dispatcher.js');
  const store = new PostgresStore({ dsn: config.dsn, schema: config.schema, connectionOptions: { maxConnections: 4, user: config.databaseUser } });
  const source = new Source(config.root, { store, maxIntegrationProposals: config.maxIntegrationProposals });
  const handler = createVerificationHandler({ source, principalId: config.serviceId, executor: { execute: async ({ candidate, check, identity, repository, job, signal }) => {
    const startedAt = Date.now();
    const meta = await store.getJobAsync({ id: job.id, orgId: job.orgId, projectId: job.projectId });
    const pending = exec(check.command[0], check.command.slice(1), { env: env(), timeout: 120000, maxBuffer: 1024 * 1024, signal });
    pending.child.stdin.end(JSON.stringify({ repository, commit: candidate.headCommit, expected: candidate.proposals.length }));
    const result = await pending;
    const finishedAt = Date.now();
    process.send({ type: 'execution', value: { jobId: job.id, candidateId: candidate.id, workerId: config.workerId, queueMs: startedAt - Date.parse(meta.createdAt), executionMs: finishedAt - startedAt } });
    return { output: result.stdout, execution: { identity, commit: candidate.headCommit, tree: candidate.tree, command: check.command, environment: check.environment, inputs: check.inputs, externalState: check.externalState, toolVersions: check.toolVersions, status: 'pass', startedAt, finishedAt, durationMs: finishedAt - startedAt } };
  } } });
  const runtime = new SourceWorker({ queue: source.jobs, handlers: { 'integration.verify': handler }, workerId: config.workerId, concurrency: 2, leaseMs: 30000, pollMs: 20, maxPollMs: 100, onError: (error) => process.send({ type: 'workerError', error: error.message }) });
  process.send({ type: 'ready' });
  process.on('message', async (message) => {
    if (message.type === 'go') runtime.start();
    if (message.type === 'stop') {
      await runtime.stop(); await store.closeAsync();
      process.send({ type: 'stopped', metrics: runtime.metrics(), resources: processResources() }, () => process.disconnect());
    }
  });
}

async function main() {
  const args = process.argv.slice(2); const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  if (args.includes('--help')) { console.log('SOURCE_TEST_DATABASE_URL=<disposable database> node scripts/benchmarks/integration.js --agents 10 --repos 1 --profile default|private-load --output /absolute/report.json'); return; }
  const agents = Number(flag('--agents', 10)), repos = Number(flag('--repos', 1));
  if (![agents, repos].every(Number.isSafeInteger) || agents < 1 || agents > 1000 || repos < 1 || repos > agents) throw new Error('harness supports 1-1000 agents and 1..agents repositories');
  const maxIntegrationProposals = Math.max(100, Math.ceil(agents / repos));
  const profile = flag('--profile', 'default');
  if (!['default', 'private-load'].includes(profile)) throw new Error('unknown benchmark profile');
  const privateProfile = profile === 'private-load';
  const rateLimit = privateProfile ? { gitPush: { limit: 1000, windowMs: 60000 }, submit: { limit: 1000, windowMs: 60000 } } : {};
  const dsn = process.env.SOURCE_TEST_DATABASE_URL;
  const output = flag('--output');
  if (!dsn || !output || !path.isAbsolute(output)) throw new Error('SOURCE_TEST_DATABASE_URL and an absolute --output are required');
  const { Source } = await import('../../src/source.js');
  const { PostgresStore } = await import('../../src/postgres-store.js');
  const { startServer } = await import('../../src/api.js');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'source-lifecycle-bench-')));
  const schema = `source_bench_${process.pid}_${Date.now()}`;
  let store, server, httpTelemetry; const children = [], sockets = []; const executions = [], workerErrors = [];
  const cpuBefore = process.cpuUsage(); const began = Date.now();
  const report = { version: 2, status: 'running', phase: 'setup', httpStatuses: {}, date: new Date().toISOString(), agents, repositories: repos, concurrency: { agentProcesses: agents, workerProcesses: 2, workerConcurrency: 2 }, host: { platform: process.platform, arch: process.arch, node: process.version, cpuCount: cpus().length, memoryBytes: totalmem() }, fixture: 'compatible independent files; fixed host Git-content checker; no repository code execution', profile, rateLimits: privateProfile ? 'explicit private-load operator profile; not default capacity' : 'unchanged server defaults', admissionConfiguration: rateLimit, maxIntegrationProposals, stages: {}, raw: {}, limitations: ['loopback single host; no deployed TLS latency', 'fixed Git-content verification, not application CI or isolated staging', 'no induced worker crash in this measurement', 'maximum 1000 agents per harness run; operator batch bound recorded explicitly', privateProfile ? 'private repositories; explicit 1000/min push and submit limits per shared address; server queue/concurrency defaults unchanged' : 'default same-address submit/read/push rate limits apply'] };
  const telemetry = new StageTelemetry();
  const phase = (name) => { telemetry.begin(name); report.phase = name; };
  phase('setup');
  const spawnRole = (role, config) => {
    const child = fork(script, [`--${role}`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...env(), ...(role === 'worker' ? { PGUSER: config.databaseUser } : {}) } });
    let stderr = ''; child.stderr.on('data', (chunk) => { if (stderr.length < 16384) stderr += chunk; }); child.stdout.resume();
    const entry = { role, child, messages: [], error: null, closed: null };
    entry.closed = new Promise((resolve) => child.once('close', (code, signal) => { if (code !== 0) entry.error ||= new Error(`${role} exited ${code ?? signal}`); resolve(); }));
    child.on('error', (error) => { entry.error = error; });
    child.on('message', (message) => { entry.messages.push(message); if (message.type === 'execution') executions.push(message.value); if (message.type === 'workerError') workerErrors.push(message.error); if (message.type === 'error') entry.error = Object.assign(new Error(message.error), { diagnostic: message.diagnostic }); });
    children.push(entry); child.send({ type: 'config', config });
    entry.wait = async (type, timeout = 180000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = entry.messages.find((message) => message.type === type); if (found) return found;
        if (entry.error) throw entry.error;
        if (child.exitCode != null || child.signalCode != null) throw new Error(`${role} ended before ${type}`);
        await sleep(20);
      }
      throw new Error(`${role} timed out waiting for ${type}`);
    };
    return entry;
  };
  try {
    store = new PostgresStore({ dsn, schema }); const source = new Source(root, { store, maxIntegrationProposals });
    const databaseUser = (await store.pool.query('SELECT current_user AS name')).rows[0].name;
    report.sourceRevision = await git(path.resolve(path.dirname(script), '../..'), 'rev-parse', 'HEAD');
    report.harnessSha256 = createHash('sha256').update(await readFile(script)).digest('hex');
    report.telemetrySha256 = createHash('sha256').update(await readFile(new URL('./telemetry.js', import.meta.url))).digest('hex');
    report.host.git = await git(root, '--version');
    const org = await source.createOrgAsync({ name: 'benchmark', slug: 'benchmark' });
    const human = await source.createPrincipalAsync({ type: 'human', name: 'benchmark maintainer', password: 'fixture-password-only-123' });
    const service = await source.createPrincipalAsync({ type: 'service', name: 'benchmark verifier' });
    await source.addOrgMemberAsync({ orgId: org.id, principalId: human.id, role: 'maintainer' });
    const records = [];
    for (let i = 0; i < repos; i++) {
      const project = await source.createProjectAsync({ orgId: org.id, name: `project${i}`, slug: `project${i}`, visibility: privateProfile ? 'private' : 'public' });
      const scope = { orgId: org.id, projectId: project.id };
      const repo = await source.createRepositoryAsync({ ...scope, name: `repo${i}` });
      const cwd = path.join(root, `seed${i}`); await mkdir(cwd);
      await git(cwd, 'init', '-b', 'main'); await git(cwd, 'config', 'user.name', 'Fixture'); await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
      await writeFile(path.join(cwd, 'README.md'), 'Source integration benchmark fixture\n');
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'base'); await git(cwd, 'push', repo.barePath, 'main');
      const base = await git(cwd, 'rev-parse', 'HEAD');
      const policy = { version: '1', securityPolicyVersion: '1', checks: [{ id: 'combined', version: report.harnessSha256, command: [process.execPath, script, '--verify'], toolVersions: { node: process.version, git: report.host.git, checker: report.harnessSha256 }, environment: 'controlled-local-git-fixture-v1', inputs: {}, externalState: {}, deterministic: true, maxAgeMs: 3600000, producers: [service.id], tier: 2 }] };
      await source.integration.configure({ ...scope, repoId: repo.id, principalId: human.id, policy });
      records.push({ scope, repo, base, policy });
    }
    server = await startServer(source, { port: 0, host: '127.0.0.1', rateLimit });
    httpTelemetry = new HttpTelemetry(server);
    report.httpTimeouts = { headersMs: server.headersTimeout, requestMs: server.requestTimeout, keepAliveMs: server.keepAliveTimeout };
    server.on('connection', (socket) => sockets.push(socket));
    server.prependListener('request', (_req, res) => res.once('finish', () => { report.httpStatuses[res.statusCode] = (report.httpStatuses[res.statusCode] || 0) + 1; }));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const workers = Array.from({ length: 2 }, (_, i) => spawnRole('worker', { dsn, databaseUser, schema, root, maxIntegrationProposals, serviceId: service.id, workerId: `benchmark-${i}` }));
    await Promise.all(workers.map((entry) => entry.wait('ready')));
    const clients = []; const clientConfigs = [];
    if (privateProfile) {
      const record = records[0];
      const response = await globalThis.fetch(`${baseUrl}/git/${org.id}/${record.scope.projectId}/${record.repo.id}.git/info/refs?service=git-upload-pack`);
      assert.equal(response.status, 401, 'private load profile never grants anonymous Git access');
      await response.arrayBuffer();
      report.anonymousGitRejected = true;
    }
    for (let i = 0; i < agents; i++) {
      const record = records[i % repos];
      const principal = await source.createPrincipalAsync({ type: 'service', name: `agent-${i}` });
      const cap = await source.capabilities.issueAsync({ principalId: principal.id, allowed: ['read_source', 'git_push', ...(privateProfile ? ['submit_change'] : [])], scope: { org: record.scope.orgId, project: record.scope.projectId } });
      const config = { root, cwd: path.join(root, `agent${i}`), index: i, repoIndex: i % repos, url: `${baseUrl}/git/${org.id}/${record.scope.projectId}/${record.repo.id}.git`, credential: cap.credential, principalId: principal.id, privateProfile };
      clientConfigs.push(config); clients.push(spawnRole('agent', config));
    }
    await Promise.all(clients.map((entry) => entry.wait('ready')));
    phase('submission');
    const submittedAt = performance.now(); clients.forEach((entry) => entry.child.send({ type: 'go' }));
    const proposals = (await Promise.all(clients.map((entry) => entry.wait('result', 660000)))).map((message) => message.result);
    const submissionWallMs = performance.now() - submittedAt;
    await Promise.all(clients.map((entry) => entry.closed));
    assert.equal(new Set(proposals.map((item) => item.changeId)).size, agents);
    report.raw.proposals = proposals;
    report.stages.submission = { wallMs: submissionWallMs, proposalsPerSecond: agents * 1000 / submissionWallMs, cloneMs: stats(proposals.map((p) => p.cloneMs)), submitMs: stats(proposals.map((p) => p.submitMs)) };
    phase('assembly');
    const candidates = [], assembly = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i], selected = proposals.filter((p) => p.repoIndex === i);
      selected.forEach((p) => assert.equal(p.baseCommit, record.base));
      const at = performance.now();
      const plan = await source.planIntegrationAsync({ ...record.scope, repoId: record.repo.id, changeIds: selected.map((p) => p.changeId) });
      assembly.push(performance.now() - at);
      assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.rejected, []); assert.equal(plan.candidate.proposals.length, selected.length);
      assert.equal(await git(record.repo.barePath, 'rev-parse', 'main'), record.base);
      const input = { ...record.scope, repoId: record.repo.id, candidateId: plan.candidate.id, principalId: human.id };
      await assert.rejects(() => source.integration.accept(input), /verification requirements/);
      candidates.push({ record, plan, input, selected });
    }
    report.raw.assemblyMs = assembly; report.stages.assemblyMs = stats(assembly);
    phase('verification');
    const verificationStart = performance.now();
    for (const item of candidates) {
      const first = await source.verification.dispatch(item.input), second = await source.verification.dispatch(item.input);
      assert.equal(second.checks[0].action, 'coalesced'); assert.equal(first.checks[0].jobId, second.checks[0].jobId);
    }
    workers.forEach((entry) => entry.child.send({ type: 'go' }));
    const deadline = Date.now() + 180000;
    while (true) {
      const count = (await Promise.all(records.map((r) => source.jobs.count(r.scope)))).reduce((a, b) => a + b, 0);
      if (!count) break;
      if (Date.now() > deadline || workerErrors.length) throw new Error(`verification failed or timed out: ${workerErrors.join('; ')}`);
      await sleep(50);
    }
    workers.forEach((entry) => entry.child.send({ type: 'stop' }));
    report.workerMetrics = (await Promise.all(workers.map((entry) => entry.wait('stopped')))).map((m) => m.metrics);
    await Promise.all(workers.map((entry) => entry.closed));
    assert.equal(executions.length, repos);
    const jobs = (await Promise.all(records.map((r) => source.jobs.list(r.scope)))).flat();
    assert.equal(jobs.length, repos); assert.ok(jobs.every((job) => job.status === 'completed' && job.attempts === 1));
    report.raw.executions = executions;
    report.stages.verification = { wallMs: performance.now() - verificationStart, queueMs: stats(executions.map((e) => e.queueMs)), executionMs: stats(executions.map((e) => e.executionMs)), completed: jobs.length, failed: 0, abandoned: 0, recoveryMs: null };
    phase('promotion');
    const promotion = [], fetch = [];
    for (const { record, plan, input, selected } of candidates) {
      assert.equal((await source.integration.evaluate(input)).ok, true);
      const reuse = await source.verification.dispatch(input); assert.equal(reuse.checks[0].action, 'reused');
      await source.integration.accept(input); const at = performance.now();
      assert.equal((await source.integration.promote(input)).state, 'landed'); promotion.push(performance.now() - at);
      assert.equal((await source.integration.promote(input)).state, 'landed');
      assert.equal(await git(record.repo.barePath, 'rev-parse', 'main'), plan.candidate.headCommit);
      for (const proposal of selected) await git(record.repo.barePath, 'merge-base', '--is-ancestor', proposal.headCommit, plan.candidate.headCommit);
      const cwd = path.join(root, `agent${selected[0].index}`), fetchAt = performance.now();
      if (privateProfile) {
        const client = clientConfigs[selected[0].index];
        await authenticatedGit(client.credential, client.url, cwd)(['fetch', 'source']);
      } else await git(cwd, 'fetch', 'source');
      fetch.push(performance.now() - fetchAt);
      assert.equal(await git(cwd, 'rev-parse', 'source/main'), plan.candidate.headCommit);
    }
    report.raw.promotionMs = promotion; report.raw.fetchMs = fetch; report.stages.promotionMs = stats(promotion); report.stages.fetchMs = stats(fetch);
    report.stages.reuse = { requests: repos, hits: repos, coalescedRequests: repos, assertions: 'same job ID while active; same exact candidate receipts reused after completion' };
    // Conservative conventional baseline: verify each cumulative merge once,
    // without assuming speculative per-PR checks or stale-result retries.
    phase('baseline');
    const baselineChecks = [], baselineAssembly = [];
    for (const { record, selected, plan } of candidates) {
      const cwd = path.join(root, `baseline-${record.repo.id}`);
      await git(root, 'clone', record.repo.barePath, cwd); await git(cwd, 'config', 'user.name', 'Baseline'); await git(cwd, 'config', 'user.email', 'baseline@example.invalid');
      await git(cwd, 'checkout', '--detach', record.base);
      for (let i = 0; i < selected.length; i++) {
        const at = performance.now(); await git(cwd, 'merge', '--no-ff', '-m', 'baseline verified merge', selected[i].headCommit); baselineAssembly.push(performance.now() - at);
        const head = await git(cwd, 'rev-parse', 'HEAD'), checkedAt = performance.now();
        const pending = exec(process.execPath, [script, '--verify'], { env: env(), timeout: 120000 });
        pending.child.stdin.end(JSON.stringify({ repository: path.join(cwd, '.git'), commit: head, expected: i + 1 })); await pending;
        baselineChecks.push(performance.now() - checkedAt);
      }
      assert.equal(await git(cwd, 'rev-parse', 'HEAD^{tree}'), plan.candidate.tree, 'baseline and Source final trees identical');
    }
    report.raw.baselineChecksMs = baselineChecks; report.raw.baselineAssemblyMs = baselineAssembly;
    report.baseline = { method: 'sequential cumulative merge plus identical checker once per proposal; no speculative rerun penalty', checks: baselineChecks.length, executionMs: stats(baselineChecks), assemblyMs: stats(baselineAssembly), finalTreesEqual: true };
    report.comparison = { checksAvoided: baselineChecks.length - executions.length, sourceChecks: executions.length, baselineChecks: baselineChecks.length, sourceVerificationMs: executions.reduce((sum, e) => sum + e.executionMs, 0), baselineVerificationMs: baselineChecks.reduce((sum, n) => sum + n, 0) };
    report.storage = { filesystemAllocatedBytes: Number((await exec('du', ['-sk', root])).stdout.split(/\s/)[0]) * 1024, postgresRelationBytes: Number((await store.pool.query('SELECT COALESCE(SUM(pg_total_relation_size(c.oid)),0) AS bytes FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname=$1 AND c.relkind=\'r\'', [schema])).rows[0].bytes) };
    report.network = { serverReceivedBytes: sockets.reduce((sum, s) => sum + s.bytesRead, 0), serverSentBytes: sockets.reduce((sum, s) => sum + s.bytesWritten, 0), scope: 'all loopback HTTP/Git during run' };
    report.status = 'passed'; report.phase = 'complete'; report.correctness = { allProposalsRetained: true, exactVerifiedPromotion: true, unverifiedAcceptanceRejected: true, duplicatePromotionIdempotent: true, baselineTreeEquality: true, conflicts: 0, humanInterventions: 0, acceptance: 'automated harness acting as configured human maintainer' };
  } catch (error) { report.status = 'failed'; report.error = error.message; report.failureDiagnostic = error.diagnostic ?? null; report.raw.completedClients = children.flatMap((entry) => entry.messages.filter((message) => message.type === 'result').map((message) => message.result)); process.exitCode = 1; }
  finally {
    report.httpBeforeCleanup = httpTelemetry?.snapshot() || null;
    telemetry.begin('cleanup');
    for (const entry of children) if (entry.child.exitCode == null && entry.child.signalCode == null) entry.child.kill('SIGKILL');
    await Promise.all(children.map((entry) => entry.closed));
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    report.httpAfterCleanup = httpTelemetry?.snapshot() || null;
    if (store) { await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.closeAsync(); }
    await rm(root, { recursive: true, force: true });
    report.telemetry = telemetry.stop();
    report.childResources = children.map((entry) => ({ role: entry.role, completed: entry.messages.some((m) => m.type === 'result' || m.type === 'stopped'), resource: entry.messages.find((m) => m.resources)?.resources || null }));
    report.gitBackendOutcomes = Object.fromEntries(server?.metrics.gitBackendOutcomes || []);
    report.elapsedMs = Date.now() - began; report.parentCpuMicros = process.cpuUsage(cpuBefore); report.parentPeakRssBytes = process.resourceUsage().maxRSS * 1024;
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, output, elapsedMs: report.elapsedMs, error: report.error }));
  }
}

if (process.argv[2] === '--verify') {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 16384) throw new Error('checker input too large'); }
  const { repository, commit, expected } = JSON.parse(input);
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > 1000) throw new Error('invalid expected contributor count');
  await verify(repository, commit, expected);
} else if (process.argv[2] === '--agent' || process.argv[2] === '--worker') {
  process.once('message', async ({ config }) => {
    try {
      if (process.argv[2] === '--worker') { await worker(config); return; }
      process.send({ type: 'ready' });
      process.once('message', async () => {
        try { process.send({ type: 'result', result: await agent(config), resources: processResources() }, () => process.disconnect()); }
        catch (error) { process.send({ type: 'error', error: error.message, diagnostic: error.diagnostic, resources: processResources() }, () => process.disconnect()); process.exitCode = 1; }
      });
    } catch (error) { process.send({ type: 'error', error: error.message, diagnostic: error.diagnostic, resources: processResources() }, () => process.disconnect()); process.exitCode = 1; }
  });
} else await main();
