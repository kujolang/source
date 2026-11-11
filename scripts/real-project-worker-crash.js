// Trusted operator drill: crash an actual CLI worker during an actual OCI check.
// The database is observed, never edited to expire a lease or simulate success.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function crashAndRecover({ source, store, schema, scope, input, workspaces, worker, closed, restart, assertWorker }) {
  const deadline = Date.now() + 180000;
  const inspect = async name => JSON.parse((await exec('docker', ['inspect', name], { timeout: 10000 })).stdout)[0];
  let interrupted, attempt, container, testStarted = false;
  while (!attempt) {
    assertWorker();
    if (Date.now() > deadline) throw new Error('worker did not reach the actual Git/API container');
    const jobs = await source.jobs.list(scope);
    interrupted = jobs.find(job => job.payload.checkId === 'git-api' && job.status === 'leased');
    if (interrupted) {
      for (const name of await readdir(workspaces)) {
        if (!name.endsWith('.attempt.json')) continue;
        const record = JSON.parse(await readFile(path.join(workspaces, name), 'utf8'));
        if (record.jobId !== interrupted.id || record.ownerPid !== worker.pid) continue;
        // A prepared journal precedes container creation. Do not crash until
        // the runtime independently confirms a running container.
        try { container = await inspect(record.containerName); } catch { continue; }
        if (container.State.Running) {
          const logs = await exec('docker', ['logs', record.containerName], { timeout: 10000, maxBuffer: 1024 * 1024 });
          testStarted = logs.stdout.includes('TAP version 13');
          if (testStarted) { attempt = record; break; }
        }
      }
    }
    if (!attempt) await sleep(100);
  }
  const beforeJobs = await source.jobs.list(scope);
  const completed = beforeJobs.filter(job => job.status === 'completed');
  assert.equal(completed.length, 2, 'preflight and runtime must finish before injection');
  const before = await source.integration.evaluate(input);
  assert.equal(before.ok, false);
  const preservedReceipts = before.checks.filter(check => check.satisfied).map(({ checkId, receiptId }) => ({ checkId, receiptId }));
  assert.equal(preservedReceipts.length, 2);
  const killedAt = Date.now();
  assert.equal(worker.kill('SIGKILL'), true);
  assert.equal((await closed).signal, 'SIGKILL');
  const orphan = await inspect(attempt.containerName);
  assert.equal(orphan.Id, container.Id);
  assert.equal(orphan.State.Running, true, 'SIGKILL must leave a real running orphan');
  const leaseQuery = () => store.pool.query(`SELECT status, attempts, worker_id, lease_token, leased_until,
    clock_timestamp() AS observed_at FROM "${schema}".jobs WHERE id = $1`, [interrupted.id]).then(result => result.rows[0]);
  const oldLease = await leaseQuery();
  assert.equal(oldLease.status, 'leased'); assert.equal(oldLease.attempts, 1);
  assert.ok(oldLease.leased_until > oldLease.observed_at, 'injection must precede natural lease expiry');
  const during = await source.integration.evaluate(input);
  assert.equal(during.ok, false);
  assert.equal(during.checks.find(check => check.checkId === 'git-api').receiptId, undefined);
  await assert.rejects(() => source.integration.accept(input), /verification requirements/);
  const recovery = JSON.parse((await exec(process.execPath,
    [fileURLToPath(new URL('./recover-executions.js', import.meta.url)), workspaces], { timeout: 30000 })).stdout);
  assert.deepEqual(recovery.results.map(row => row.state), ['recovered']);
  assert.equal(recovery.results[0].containerName, attempt.containerName);
  const containerRemovedAt = Date.now();
  assert.deepEqual(await readdir(workspaces), []);
  const repeated = JSON.parse((await exec(process.execPath,
    [fileURLToPath(new URL('./recover-executions.js', import.meta.url)), workspaces], { timeout: 30000 })).stdout);
  assert.deepEqual(repeated.results, []);
  restart();
  let replacement;
  while (true) {
    assertWorker();
    if (Date.now() > deadline) throw new Error('fresh CLI worker did not reclaim the naturally expired lease');
    replacement = await leaseQuery();
    if (replacement.attempts === 2) break;
    assert.equal(replacement.attempts, 1);
    await sleep(100);
  }
  const reclaimedAt = Date.now();
  assert.equal(replacement.status, 'leased');
  assert.notEqual(replacement.lease_token, oldLease.lease_token);
  assert.ok(replacement.observed_at >= oldLease.leased_until, 'no early lease takeover');
  const stale = { id: interrupted.id, workerId: oldLease.worker_id, leaseToken: oldLease.lease_token };
  assert.equal(await source.jobs.complete({ ...stale, result: { forged: true } }), false);
  assert.equal(await source.jobs.extend({ ...stale, leaseMs: 60000 }), null);
  assert.equal(await source.jobs.fail({ ...stale, error: 'stale crash fixture' }), false);
  await assert.rejects(() => source._projectMutationAsync(scope.orgId, scope.projectId,
    () => store.lockJobLeaseAsync({ ...scope, ...stale })), /lease expired, cancelled, or superseded/);
  const afterJobs = await source.jobs.list(scope);
  for (const job of completed) assert.deepEqual(afterJobs.find(row => row.id === job.id), job);
  return { injectedCheck: 'git-api', jobId: interrupted.id, killedWorkerPid: worker.pid, signal: 'SIGKILL',
    containerId: container.Id, journal: attempt, actualTestOutputObserved: testStarted, orphanWasRunning: true, leaseExpiredNaturally: true,
    oldLeaseExpiresAt: oldLease.leased_until.toISOString(), replacementObservedAt: replacement.observed_at.toISOString(),
    recovery, repeated, staleCompletionRejected: true, staleHeartbeatRejected: true, staleFailureRejected: true,
    staleReceiptLeaseRejected: true, acceptanceDeniedWithoutReceipt: true, completedJobsUnchanged: true,
    preservedReceipts, orphanRemovalMs: containerRemovedAt - killedAt, reclaimMs: reclaimedAt - killedAt };
}
