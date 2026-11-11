// Trusted operator harness entry point. Reads configuration through stdin so
// restored capability tokens and the database URL never appear in argv/output.
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Source } from '../src/source.js';
import { PostgresStore } from '../src/postgres-store.js';
import { startServer } from '../src/api.js';
import { authenticatedGit } from '../src/remote.js';

const exec = promisify(execFile);
let raw = '';
for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 4 * 1024 * 1024) throw new Error('restore check input too large'); }
const { dataRoot, gitRoot, schema, expected } = JSON.parse(raw);
const dsn = process.env.SOURCE_RESTORED_DATABASE_URL;
if (!dsn || !path.isAbsolute(dataRoot) || !path.isAbsolute(gitRoot)) throw new Error('isolated restore configuration required');
await assert.rejects(() => access(expected.originalDataRoot), { code: 'ENOENT' }, 'original filesystem must be offline');
const store = new PostgresStore({ dsn, schema });
const source = new Source(dataRoot, { store, gitRoot, artifacts: null });
const cloneRoot = await mkdtemp(path.join(tmpdir(), 'source-restored-clone-'));
let server;
try {
  const { scope, candidate } = expected;
  const input = { ...scope, candidateId: candidate.id, principalId: expected.maintainerId };
  const repo = await source.getRepositoryAsync(scope.orgId, scope.projectId, scope.repoId);
  const expectedPath = path.join(gitRoot, 'orgs', scope.orgId, 'projects', scope.projectId, 'repos', `${scope.repoId}.git`);
  assert.equal(repo.barePath, expectedPath);
  assert.equal((await source.resolveRepositoryAsync(scope.orgId, scope.projectId, repo.name)).barePath, expectedPath);
  const git = async (cwd, ...args) => (await exec('git', ['--no-replace-objects', ...args], { cwd, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim();
  assert.equal(await git(repo.barePath, 'rev-parse', `refs/heads/${repo.defaultBranch}`), candidate.headCommit);
  assert.equal(await git(repo.barePath, 'rev-parse', `${candidate.headCommit}^{tree}`), candidate.tree);
  assert.equal(await git(repo.barePath, 'rev-parse', `refs/source/landed/${candidate.id}`), candidate.headCommit);
  const status = await source.integration.status(input);
  assert.deepEqual(status, expected.status);
  assert.equal(status.state, 'landed'); assert.equal(status.evaluation.ok, true);
  const loaded = await source.integration.load(input);
  for (const receipt of expected.receipts) {
    const restored = await source.integration.read(`${loaded.root}/${candidate.id}/receipts/${receipt.id}.json`);
    assert.deepEqual(restored, receipt);
    const bytes = await store.getArtifactAsync(receipt.artifactRef.hash);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.artifactRef.hash);
  }
  const jobs = (await source.jobs.list(scope)).map(({ id, status, attempts, result }) => ({ id, status, attempts, result }));
  assert.deepEqual(jobs, expected.jobs);
  assert.equal(await source.jobs.count(scope), 0);
  server = await startServer(source, { port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const remote = `${base}/git/${scope.orgId}/${scope.projectId}/${repo.id}.git`;
  const anonymous = await fetch(`${remote}/info/refs?service=git-upload-pack`);
  assert.equal(anonymous.status, 401); await anonymous.arrayBuffer();
  const clone = path.join(cloneRoot, 'clone');
  await authenticatedGit(expected.gitCredential, remote, cloneRoot)(['clone', remote, clone]);
  assert.equal(await git(clone, 'rev-parse', 'HEAD'), candidate.headCommit);
  for (const proposal of candidate.proposals) await git(clone, 'merge-base', '--is-ancestor', proposal.headCommit, 'HEAD');
  const endpoint = `${base}/api/v1/orgs/${scope.orgId}/projects/${scope.projectId}/repositories/${repo.id}/integration/${candidate.id}`;
  const promote = await fetch(`${endpoint}/promote`, { method: 'POST', headers: { authorization: `Bearer ${expected.maintainerCredential}` } });
  assert.equal(promote.status, 200);
  const result = await promote.json();
  assert.equal(result.state, 'landed'); assert.equal(result.headCommit, candidate.headCommit);
  assert.equal(await git(repo.barePath, 'rev-parse', `refs/heads/${repo.defaultBranch}`), candidate.headCommit);
  console.log(JSON.stringify({ status: 'passed', freshProcess: true, originalFilesystemOffline: true,
    relocatedRepository: true, exactCandidate: true, landedMarker: true, policyAcceptanceOutcomeMatch: true,
    receipts: expected.receipts.length, originalArtifactHashesVerified: true, completedJobsPreserved: true,
    authenticatedClone: true, anonymousRejected: true, proposalAncestryPreserved: true, idempotentPromotion: true }));
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await store.closeAsync(); await rm(cloneRoot, { recursive: true, force: true });
}
