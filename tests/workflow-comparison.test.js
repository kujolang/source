import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
test('matched serial and concurrent workflows preserve the same exact tree', { skip: !process.env.SOURCE_TEST_DATABASE_URL, timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-comparison-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reports = [];
  for (const mode of ['serial', 'concurrent']) {
    const output = path.join(root, `${mode}.json`);
    await exec(process.execPath, ['scripts/benchmarks/workflow-comparison.js', '--mode', mode, '--agents', '3', '--output', output], { env: process.env, timeout: 85000, maxBuffer: 4 * 1024 * 1024 });
    const r = JSON.parse(await readFile(output, 'utf8')); reports.push(r);
    assert.equal(r.status, 'passed'); assert.equal(r.proposals.length, 3);
    assert.equal(r.correctness.verificationJobs, mode === 'serial' ? 3 : 1);
    assert.equal(r.httpAfterCleanup.sockets.active, 0);
    assert.equal(r.httpBeforeCleanup.routes.submit.finished, 3);
    assert.equal(r.batches.reduce((n, b) => n + b.count, 0), 3);
    assert.ok(r.timings.workflowMs > 0);
    if (mode === 'serial') for (let i = 1; i < r.batches.length; i++) {
      assert.equal(r.batches[i].baseCommit, r.batches[i - 1].headCommit);
      assert.ok(r.batches[i].startedAfterMs >= r.batches[i - 1].finishedAfterMs);
    }
  }
  assert.equal(reports[0].finalTree, reports[1].finalTree);
  assert.equal(reports[0].finalContentSha256, reports[1].finalContentSha256);
});
