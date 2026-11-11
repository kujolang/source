// Actual Source history and tests, private HTTP/Git, PostgreSQL and CLI worker.
// Disposable copy only: never pushes to GitHub or modifies the source checkout.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Source } from '../src/source.js';
import { PostgresStore } from '../src/postgres-store.js';
import { startServer } from '../src/api.js';
import { CandidateContainerExecutor } from '../src/candidate-executor.js';
import { authenticatedGit } from '../src/remote.js';
import { restoreDrill } from './restore-drill.js';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(repository, 'bin/source.js');
const [baseRef, headRef, imageReport, output, restoreFlag] = process.argv.slice(2);
if (restoreFlag && restoreFlag !== '--restore') throw new Error('optional final argument must be --restore');
const dsn = process.env.SOURCE_TEST_DATABASE_URL;
if (!dsn || !baseRef || !headRef || !imageReport || !path.isAbsolute(output || '')) throw new Error('SOURCE_TEST_DATABASE_URL=<disposable DB> node scripts/real-project-lifecycle.js BASE HEAD image-report.json /absolute/result.json');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = async (cwd, ...args) => (await exec('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = await mkdtemp(path.join(tmpdir(), 'source-real-project-'));
const data = path.join(root, 'data'), cwd = path.join(root, 'clone'), workspaces = path.join(root, 'workspaces');
const schema = `source_real_${process.pid}_${Date.now()}`;
const report = { version: 1, status: 'running', startedAt: new Date().toISOString(), limitations: ['local disposable deployment, no TLS/SSH or production failover', 'scripted maintainer authorization, not an independent human review', 'targeted Source runtime and API/Git suites, not the full production acceptance suite', 'no Docker socket in verification; nested live-container test intentionally excluded', 'no backup/restore or worker-crash injection in this lifecycle'] };
let store, server, worker, workerClosed, workerOutput = '', workerError = '', workerFailure = '';
try {
  report.sourceRevision = await git(repository, 'rev-parse', 'HEAD');
  report.hostGit = { version: await git(repository, '--version'), execPath: await git(repository, '--exec-path') };
  report.harnessSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  report.base = await git(repository, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`);
  report.proposal = await git(repository, 'rev-parse', '--verify', '--end-of-options', `${headRef}^{commit}`);
  await git(repository, 'merge-base', '--is-ancestor', report.base, report.proposal);
  assert.notEqual(report.base, report.proposal);
  report.dependencyImage = JSON.parse(await readFile(imageReport, 'utf8'));
  for (const [file, field] of [['package.json', 'packageSha256'], ['package-lock.json', 'lockSha256']]) {
    const contents = (await exec('git', ['--no-replace-objects', 'show', `${report.proposal}:${file}`], { cwd: repository })).stdout;
    assert.equal(hash(contents), report.dependencyImage[field], 'image manifests must match actual proposal');
  }
  const config = { workspaceRoot: workspaces, runtime: 'docker', image: report.dependencyImage.image, toolVersions: report.dependencyImage.toolVersions, timeoutMs: 180000, memory: '2g', maxActive: 1 };
  const executor = new CandidateContainerExecutor(config);
  report.executorProfile = executor.profile;
  store = new PostgresStore({ dsn, schema });
  const source = new Source(data, { store });
  const databaseUser = (await store.pool.query('SELECT current_user AS name')).rows[0].name;
  const org = await source.createOrgAsync({ name: 'Source real-project validation', slug: 'source-real' });
  const human = await source.createPrincipalAsync({ type: 'human', name: 'scripted maintainer', password: 'fixture-only-password-123' });
  const contributor = await source.createPrincipalAsync({ type: 'service', name: 'Source contributor' });
  const service = await source.createPrincipalAsync({ type: 'service', name: 'isolated Source verifier' });
  await source.addOrgMemberAsync({ orgId: org.id, principalId: human.id, role: 'maintainer' });
  const project = await source.createProjectAsync({ orgId: org.id, name: 'Source itself', slug: 'source', visibility: 'private' });
  const scope = { orgId: org.id, projectId: project.id };
  const branch = 'codex/agent-native-integration';
  const repo = await source.createRepositoryAsync({ ...scope, name: 'source', defaultBranch: branch });
  const capability = async (principalId, allowed) => (await source.capabilities.issueAsync({ principalId, allowed, scope: { org: org.id, project: project.id } })).credential;
  const contributorCredential = await capability(contributor.id, ['read_source', 'git_push', 'submit_change']);
  const maintainerCredential = await capability(human.id, ['read_source', 'read_context', 'plan_integration', 'dispatch_verification', 'accept_change', 'promote_integration']);
  server = await startServer(source, { host: '127.0.0.1', port: 0 });
  report.http = [];
  server.prependListener('request', (req, res) => res.once('finish', () => report.http.push({ method: req.method, path: req.url, status: res.statusCode })));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const remote = `${baseUrl}/git/${org.id}/${project.id}/${repo.id}.git`;
  const endpoint = `${baseUrl}/api/v1/orgs/${org.id}/projects/${project.id}/repositories/${repo.id}/integration`;
  const request = async (url, body, credential = maintainerCredential, expected = 200) => {
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30000) });
    const result = await res.json();
    assert.equal(res.status, expected, JSON.stringify(result)); return result;
  };
  const anonymous = await fetch(`${remote}/info/refs?service=git-upload-pack`);
  assert.equal(anonymous.status, 401); await anonymous.arrayBuffer();
  await git(root, 'clone', '--no-hardlinks', '--single-branch', '--no-tags', '--branch', branch, repository, cwd);
  await git(cwd, 'reset', '--hard', report.base);
  const origin = await git(repository, 'remote', 'get-url', 'origin');
  await git(cwd, 'remote', 'set-url', 'origin', origin);
  const upstream = await git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}');
  const client = async (...args) => JSON.parse((await exec(process.execPath, [cli, '--store', 'json', ...args], { cwd, env: { ...env, SOURCE_CREDENTIAL: contributorCredential }, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout);
  report.sync = await client('sync', '--url', remote);
  assert.equal(await git(repo.barePath, 'rev-parse', branch), report.base);
  assert.equal(await git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}'), upstream);
  // Bootstrap policy activation is performed with no concurrent writer/worker.
  const commands = [
    { id: 'preflight', tier: 0, command: ['node', 'scripts/lint.js'] },
    { id: 'runtime', tier: 1, command: ['node', '--test', '--test-concurrency=1', '--test-reporter=tap', '--test-name-pattern=^(?!live container environment)', 'tests/action-runner.test.js', 'tests/candidate-executor.test.js', 'tests/execution-attempts.test.js', 'tests/github-actions.test.js'] },
    { id: 'git-api', tier: 2, command: ['node', '--test', '--test-concurrency=1', '--test-reporter=tap', 'tests/integration-api.test.js', 'tests/integration-broker.test.js', 'tests/submit.test.js', 'tests/sync.test.js', 'tests/git.test.js', 'tests/backup.test.js'] },
  ];
  const policy = { version: 'source-real-project-v1', securityPolicyVersion: '1', checks: commands.map(check => ({ ...check, version: '1', toolVersions: executor.profile.toolVersions, environment: executor.environment, inputs: {}, externalState: {}, deterministic: true, maxAgeMs: 3600000, maxAttempts: 1, producers: [service.id] })) };
  await source.integration.configure({ ...scope, repoId: repo.id, principalId: human.id, policy });
  report.policy = policy;
  await git(cwd, 'checkout', '-b', 'local-image-support', report.proposal);
  await assert.rejects(() => authenticatedGit(contributorCredential, remote, cwd)(['push', remote, `HEAD:refs/heads/${branch}`]), /Source Git push failed/);
  report.submission = await client('submit', '--intent', 'Support full immutable local verification images and operator dependency builds');
  assert.equal(report.submission.change.headCommit, report.proposal);
  assert.equal(report.submission.change.baseCommit, report.base);
  assert.equal(report.submission.session.principal, contributor.id);
  assert.equal(await git(cwd, 'remote', 'get-url', 'origin'), origin);
  const plan = await request(endpoint, { changeIds: [report.submission.change.id] }, maintainerCredential, 201);
  assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.rejected, []);
  report.candidate = plan.candidate;
  const candidateUrl = `${endpoint}/${plan.candidate.id}`;
  await request(`${candidateUrl}/promote`, {}, contributorCredential, 403);
  const denied = await fetch(`${candidateUrl}/accept`, { method: 'POST', headers: { authorization: `Bearer ${maintainerCredential}` } });
  assert.ok(denied.status >= 400 && denied.status < 500); await denied.arrayBuffer();
  report.dispatch = await request(`${candidateUrl}/dispatch`);
  const second = await request(`${candidateUrl}/dispatch`);
  assert.ok(second.checks.every(check => check.action === 'coalesced'));
  assert.deepEqual(second.checks.map(check => check.jobId), report.dispatch.checks.map(check => check.jobId));
  const handlerPath = path.join(root, 'handler.mjs');
  await writeFile(handlerPath, `import { CandidateContainerExecutor } from ${JSON.stringify(pathToFileURL(path.join(repository, 'src/candidate-executor.js')).href)};\nimport { createVerificationHandler } from ${JSON.stringify(pathToFileURL(path.join(repository, 'src/verification-dispatcher.js')).href)};\nconst executor = new CandidateContainerExecutor(${JSON.stringify(config)});\nexport function createHandlers({ source }) { return { 'integration.verify': createVerificationHandler({ source, principalId: ${JSON.stringify(service.id)}, executor }) }; }\n`, { mode: 0o600 });
  worker = spawn(process.execPath, [cli, '--store', 'postgres', '--schema', schema, 'worker', '--handler-module', handlerPath, '--worker-id', 'real-project', '--worker-concurrency', '1', '--worker-lease-ms', '60000', '--worker-poll-ms', '100', '--worker-max-poll-ms', '500'], { env: { ...env, SOURCE_DATA: data, SOURCE_DATABASE_URL: dsn, PGUSER: databaseUser }, stdio: ['ignore', 'pipe', 'pipe'] });
  workerClosed = new Promise(resolve => worker.once('close', (code, signal) => resolve({ code, signal })));
  worker.on('error', error => { workerFailure = error.message; });
  worker.stdout.on('data', chunk => { workerOutput = (workerOutput + chunk).slice(-16384); });
  worker.stderr.on('data', chunk => { workerError = (workerError + chunk).slice(-16384); });
  const deadline = Date.now() + 600000;
  while (await source.jobs.count(scope)) {
    if (worker.exitCode !== null || worker.signalCode !== null || workerFailure || /worker real-project:/.test(workerError)) throw new Error(`worker unavailable: ${workerFailure || workerError}`);
    if (Date.now() > deadline) throw new Error('real-project verification deadline exceeded');
    await sleep(250);
  }
  report.jobs = await source.jobs.list(scope);
  worker.kill('SIGTERM'); report.workerExit = await workerClosed;
  assert.equal(report.workerExit.code, 0);
  assert.match(workerOutput, /worker real-project started/);
  report.evaluation = await request(`${candidateUrl}/evaluate`);
  const input = { ...scope, repoId: repo.id, candidateId: plan.candidate.id };
  const loaded = await source.integration.load(input);
  report.receipts = [];
  for (const check of report.evaluation.checks) {
    if (!check.receiptId) continue;
    const receipt = await source.integration.read(`${loaded.root}/${plan.candidate.id}/receipts/${check.receiptId}.json`);
    const bytes = await store.getArtifactAsync(receipt.artifactRef.hash);
    assert.equal(hash(bytes), receipt.artifactRef.hash);
    report.receipts.push({ receipt, output: bytes.toString('utf8') });
  }
  assert.equal(report.jobs.length, commands.length);
  assert.ok(report.jobs.every(job => job.status === 'completed' && job.attempts === 1), 'all real-project checks must complete on their first attempt');
  assert.equal(report.evaluation.ok, true, JSON.stringify(report.evaluation));
  report.reuse = await request(`${candidateUrl}/dispatch`);
  assert.ok(report.reuse.checks.every(check => check.action === 'reused'));
  report.acceptance = await request(`${candidateUrl}/accept`);
  report.promotion = await request(`${candidateUrl}/promote`);
  assert.equal(report.promotion.state, 'landed');
  assert.equal((await request(`${candidateUrl}/promote`)).state, 'landed');
  const fresh = path.join(root, 'fresh');
  await authenticatedGit(contributorCredential, remote, root)(['clone', remote, fresh]);
  assert.equal(await git(fresh, 'rev-parse', 'HEAD'), plan.candidate.headCommit);
  assert.equal(await git(fresh, 'rev-parse', 'HEAD^{tree}'), plan.candidate.tree);
  await git(fresh, 'merge-base', '--is-ancestor', report.proposal, 'HEAD');
  assert.deepEqual(await readdir(workspaces), []);
  report.assertions = { privateGitDenied: true, protectedPushDenied: true, unauthorizedPromotionDenied: true, unverifiedAcceptanceDenied: true, originAndUpstreamPreserved: true, actualCliSyncAndSubmit: true, separateCliWorker: true, coalesced: true, immutableArtifactsVerified: true, exactEvidenceReused: true, idempotentPromotion: true, freshCloneMatchesCandidate: true, proposalAncestryPreserved: true, workspacesEmpty: true };
  if (restoreFlag) {
    report.limitations = report.limitations.filter(value => !value.startsWith('no backup/restore'));
    report.limitations.push('quiesced local backup/restore, not online snapshots, power-loss or replicated-primary failover; no worker-crash injection');
    const status = await source.integration.status(input);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    report.gitBackendOutcomes = Object.fromEntries(server.metrics.gitBackendOutcomes); server = null;
    await store.closeAsync(); store = null;
    const backupAt = Date.now();
    const backup = JSON.parse((await exec(process.execPath, [path.join(repository, 'scripts/backup.js'), '--data-root', data, '--schema', schema, '--output', path.join(root, 'backups')], { env: { ...env, SOURCE_DATABASE_URL: dsn, PGUSER: databaseUser }, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout);
    const manifest = JSON.parse(await readFile(backup.manifest, 'utf8'));
    // The source's filesystem path disappears before the restore starts. This
    // proves restored operations cannot accidentally read the original Git root.
    await rename(data, `${data}-offline`);
    const restored = await restoreDrill({ backup: backup.backup, dsn, validateRestored: async config => {
      const pending = exec(process.execPath, [path.join(repository, 'scripts/check-restored-project.js')], { env: { ...env, SOURCE_RESTORED_DATABASE_URL: config.dsn, PGUSER: databaseUser }, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
      pending.child.stdin.end(JSON.stringify({ dataRoot: config.dataRoot, gitRoot: config.gitRoot, schema: config.schema,
        expected: { originalDataRoot: data, scope: { ...scope, repoId: repo.id }, candidate: plan.candidate, status,
          receipts: report.receipts.map(entry => entry.receipt), maintainerId: human.id,
          jobs: report.jobs.map(({ id, status, attempts, result }) => ({ id, status, attempts, result })),
          gitCredential: contributorCredential, maintainerCredential } }));
      return JSON.parse((await pending).stdout);
    } });
    assert.equal(restored.gitRepositories, 1);
    assert.equal(await git(path.join(`${data}-offline`, 'orgs', org.id, 'projects', project.id, 'repos', `${repo.id}.git`), 'rev-parse', branch), plan.candidate.headCommit);
    store = new PostgresStore({ dsn, schema });
    const original = new Source(`${data}-offline`, { store });
    assert.deepEqual(await original.integration.status(input), status, 'original control-plane records unchanged');
    report.backupRestore = { quiesced: true, workerStopped: true, apiStopped: true, originalPoolClosed: true,
      manifest, restore: restored, originalStateUnchanged: true, elapsedMs: Date.now() - backupAt,
      checkerSha256: hash(await readFile(path.join(repository, 'scripts/check-restored-project.js'))) };
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; report.failureDiagnostic = error.diagnostic || null;
  if (error.restoreState) report.retainedRestore = error.restoreState;
  process.exitCode = 1;
} finally {
  if (worker && worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGTERM'); await workerClosed; }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.gitBackendOutcomes ||= Object.fromEntries(server?.metrics.gitBackendOutcomes || []);
  if (store) {
    if (report.status === 'passed') await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    else report.retainedSchema = schema;
    await store.closeAsync();
  }
  else if (report.status !== 'passed') report.retainedSchema = schema;
  // Keep failed-run workspaces/journals for explicit recovery, never delete a
  // potentially live container's bind mount after a worker/runtime failure.
  if (report.status === 'passed') await rm(root, { recursive: true, force: true });
  else report.retainedRoot = root;
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, output, error: report.error }));
}
