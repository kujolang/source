import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/benchmarks/integration.js', import.meta.url));

test('benchmark checker rejects missing, corrupted and unexpected candidate content', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-bench-check-')); t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'Source integration benchmark fixture\n');
  await mkdir(path.join(root, 'features')); await writeFile(path.join(root, 'features/agent-7.txt'), '7\n');
  const check = async (expected) => {
    await git('add', '.'); await git('commit', '--allow-empty', '-m', 'fixture');
    const commit = await git('rev-parse', 'HEAD');
    const pending = exec(process.execPath, [script, '--verify']);
    pending.child.stdin.end(JSON.stringify({ repository: path.join(root, '.git'), commit, expected }));
    return JSON.parse((await pending).stdout);
  };
  assert.equal((await check(1)).features, 1);
  await assert.rejects(() => check(2), /exact expected contributor count/);
  await writeFile(path.join(root, 'features/agent-7.txt'), '7 \n');
  await assert.rejects(() => check(1), /exact contributor content/);
  await writeFile(path.join(root, 'features/agent-7.txt'), '7\n'); await writeFile(path.join(root, 'extra'), 'unexpected');
  await assert.rejects(() => check(1), /no unexpected files/);
});

for (const profile of ['default', 'private-load']) test(`benchmark completes real HTTP submissions, separate workers and exact promotions across repositories: ${profile}`, { skip: !process.env.SOURCE_TEST_DATABASE_URL, timeout: 90000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-bench-lifecycle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'report.json');
  await exec(process.execPath, [script, '--profile', profile, '--agents', '2', '--repos', '2', '--output', output], { env: process.env, timeout: 80000, maxBuffer: 4 * 1024 * 1024 });
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.profile, profile);
  assert.equal(report.version, 2);
  assert.deepEqual(report.httpTimeouts, { headersMs: 15000, requestMs: 120000, keepAliveMs: 5000 });
  assert.deepEqual(report.telemetry.stages.map((s) => s.phase), ['setup', 'submission', 'assembly', 'verification', 'promotion', 'baseline', 'cleanup']);
  assert.ok(report.telemetry.stages.every((s) => s.wallMs >= 0 && s.samples >= 2 && s.parentSampledPeakRssBytes > 0));
  assert.equal(report.childResources.length, 4);
  assert.ok(report.childResources.every((c) => c.completed && c.resource.peakRssBytes > 0));
  assert.match(report.telemetrySha256, /^[a-f0-9]{64}$/);
  if (profile === 'private-load') {
    assert.equal(report.anonymousGitRejected, true);
    assert.deepEqual(report.admissionConfiguration, { gitPush: { limit: 1000, windowMs: 60000 }, submit: { limit: 1000, windowMs: 60000 } });
  }
  assert.equal(report.status, 'passed'); assert.equal(report.raw.proposals.length, 2); assert.equal(report.raw.executions.length, 2);
  assert.equal(report.stages.submission.cloneMs.samples, 2); assert.equal(report.stages.promotionMs.samples, 2);
  assert.equal(report.stages.verification.completed, 2); assert.equal(report.stages.reuse.hits, 2);
  assert.equal(report.comparison.sourceChecks, 2); assert.equal(report.comparison.baselineChecks, 2);
  assert.equal(report.baseline.finalTreesEqual, true); assert.equal(report.correctness.allProposalsRetained, true);
  assert.ok(report.network.serverReceivedBytes > 0); assert.ok(report.network.serverSentBytes > 0);
  assert.ok(report.storage.postgresRelationBytes > 0);
  assert.ok(report.raw.executions.every((row) => Number.isFinite(row.queueMs) && row.queueMs >= 0));
  assert.equal(report.workerMetrics.reduce((sum, worker) => sum + worker.completed, 0), 2);
});
