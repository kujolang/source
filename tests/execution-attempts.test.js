import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareExecutionAttempt, updateExecutionAttempt, acknowledgeExecutionCleanup, assertExecutionAdmission, recoverExecutionAttempts, workspaceIdentity } from '../src/execution-attempts.js';
const exec = promisify(execFile);
const name = 'source-action-123-456-abcdef012345';
const image = `fixture@sha256:${'a'.repeat(64)}`;
const containerId = 'c'.repeat(64);
async function fixture(t, dead = true) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'source-attempt-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'owned'); await mkdir(workspace); await writeFile(path.join(workspace, 'retained'), 'candidate');
  const attempt = await prepareExecutionAttempt({ workspaceRoot: root, workspace, runtime: 'docker', image, containerName: name, jobId: 'same-job' });
  if (dead) {
    attempt.record.ownerPid = Number((await exec(process.execPath, ['-p', 'process.pid'])).stdout.trim());
    await writeFile(attempt.recordPath, JSON.stringify(attempt.record));
  }
  const inspection = () => [{ Id: containerId, Name: '/' + name, Config: { Image: image, Labels: { 'io.source.attempt': name, 'io.source.workspace': workspaceIdentity(workspace) } }, HostConfig: { Binds: [`${workspace}:/workspace:rw`] } }];
  return { root, workspace, attempt, inspection };
}

test('journal precedes execution and live owners are never inspected or reaped', async t => {
  const f = await fixture(t, false);
  assert.equal((await lstat(f.attempt.recordPath)).mode & 0o777, 0o600);
  const record = JSON.parse(await readFile(f.attempt.recordPath));
  assert.equal(record.state, 'prepared'); assert.equal(record.ownerHost, hostname()); assert.equal(record.ownerPid, process.pid);
  await assert.rejects(() => prepareExecutionAttempt({ workspaceRoot: f.root, workspace: f.root, runtime: 'docker', image, containerName: name }), /invalid managed/);
  await assertExecutionAdmission(f.root);
  const report = await recoverExecutionAttempts({ workspaceRoot: f.root, runCommand: async () => assert.fail('must not touch active container') });
  assert.equal(report.results[0].state, 'active');
  assert.equal(await readFile(path.join(f.workspace, 'retained'), 'utf8'), 'candidate');
  await assert.rejects(() => acknowledgeExecutionCleanup(f.attempt.recordPath), /unconfirmed/);
});

test('dead-owner recovery removes only the inspected immutable container ID and is repeatable', async t => {
  const f = await fixture(t); const calls = [];
  await assert.rejects(() => assertExecutionAdmission(f.root), /recovery required/);
  const result = await recoverExecutionAttempts({ workspaceRoot: f.root, runCommand: async (_runtime, args) => {
    calls.push(args); return args[0] === 'inspect' ? JSON.stringify(f.inspection()) : '';
  } });
  assert.equal(result.results[0].state, 'recovered');
  assert.deepEqual(calls, [['inspect', name], ['rm', '--force', containerId]]);
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual((await recoverExecutionAttempts({ workspaceRoot: f.root })).results, []);
});

test('unknown runtime state, missing containers and ownership mismatches retain candidate bytes', async t => {
  for (const scenario of ['outage', 'absent', 'image', 'label', 'mount', 'remove-failure']) {
    const f = await fixture(t); const inspection = f.inspection();
    if (scenario === 'image') inspection[0].Config.Image = 'substituted';
    if (scenario === 'label') inspection[0].Config.Labels['io.source.attempt'] = 'other';
    if (scenario === 'mount') inspection[0].HostConfig.Binds = ['/outside:/workspace:rw'];
    const result = await recoverExecutionAttempts({ workspaceRoot: f.root, runCommand: async (_runtime, args) => {
      if (scenario === 'outage') return null;
      if (scenario === 'absent') return args[0] === 'ps' ? '' : null;
      if (args[0] === 'inspect') return JSON.stringify(inspection);
      assert.equal(scenario, 'remove-failure', 'mismatched ownership must never remove'); return null;
    } });
    assert.equal(result.results[0].state, { outage: 'runtime-unconfirmed', absent: 'absent-unconfirmed', image: 'ownership-mismatch', label: 'ownership-mismatch', mount: 'ownership-mismatch', 'remove-failure': 'cleanup-unconfirmed' }[scenario]);
    assert.equal(await readFile(path.join(f.workspace, 'retained'), 'utf8'), 'candidate');
    assert.equal(JSON.parse(await readFile(f.attempt.recordPath)).state, 'prepared');
  }
});

test('confirmed-removal phase recovers interrupted workspace cleanup without another delete', async t => {
  const f = await fixture(t);
  await updateExecutionAttempt(f.attempt, 'container-removed');
  await assert.rejects(() => acknowledgeExecutionCleanup(f.attempt.recordPath), /workspace must be removed/);
  const result = await recoverExecutionAttempts({ workspaceRoot: f.root, runCommand: async (_runtime, args) => {
    assert.notEqual(args[0], 'rm'); return args[0] === 'inspect' ? null : '';
  } });
  assert.equal(result.results[0].state, 'recovered'); assert.deepEqual(await readdir(f.root), []);
});

test('foreign owners, invalid records and symlink substitution never authorize filesystem deletion', async t => {
  const f = await fixture(t);
  f.attempt.record.ownerHost = 'different-host'; await writeFile(f.attempt.recordPath, JSON.stringify(f.attempt.record));
  assert.equal((await recoverExecutionAttempts({ workspaceRoot: f.root, runCommand: async () => assert.fail('foreign owner') })).results[0].state, 'foreign-host');
  await assert.rejects(() => assertExecutionAdmission(f.root), /recovery required/);
  f.attempt.record.ownerHost = hostname();
  const namespace = f.attempt.record.ownerNamespace; f.attempt.record.ownerNamespace = 'different-namespace';
  await writeFile(f.attempt.recordPath, JSON.stringify(f.attempt.record));
  assert.equal((await recoverExecutionAttempts({ workspaceRoot: f.root, runCommand: async () => assert.fail('foreign namespace') })).results[0].state, 'foreign-namespace');
  f.attempt.record.ownerNamespace = namespace; f.attempt.record.workspace = path.dirname(f.root);
  await writeFile(f.attempt.recordPath, JSON.stringify(f.attempt.record));
  assert.equal((await recoverExecutionAttempts({ workspaceRoot: f.root, runCommand: async () => assert.fail('invalid ownership') })).results[0].state, 'invalid-record');
  f.attempt.record.workspace = f.workspace; await writeFile(f.attempt.recordPath, JSON.stringify(f.attempt.record));
  const outside = path.join(f.root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'keep'), 'keep');
  await rm(f.workspace, { recursive: true }); await symlink(outside, f.workspace);
  const result = await recoverExecutionAttempts({ workspaceRoot: f.root, runCommand: async (_runtime, args) => args[0] === 'inspect' ? JSON.stringify(f.inspection()) : '' });
  assert.equal(result.results[0].state, 'recovery-unconfirmed');
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'keep');
});

test('recovery lock excludes competing reapers and new admissions', async t => {
  const f = await fixture(t); let entered; let release;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const pending = recoverExecutionAttempts({ workspaceRoot: f.root, runCommand: async () => { entered(); await gate; return null; } });
  await started;
  try {
    await assert.rejects(() => recoverExecutionAttempts({ workspaceRoot: f.root }), /lock already exists/);
    await assert.rejects(() => assertExecutionAdmission(f.root), /recovery in progress/);
  } finally { release(); await pending; }
  assert.ok(!(await readdir(f.root)).includes('.source-recovery.lock'));
});


test('legacy cleanup records remain visible for operator review without invented ownership', async t => {
  const f = await fixture(t, false);
  await rm(f.attempt.recordPath);
  const file = `.${name}.cleanup.json`;
  await writeFile(path.join(f.root, file), JSON.stringify({ runtime: 'docker', containerName: name, workspace: f.workspace }));
  const result = await recoverExecutionAttempts({ workspaceRoot: f.root, runCommand: async () => assert.fail('no ownership journal') });
  assert.deepEqual(result.results, [{ file, state: 'legacy-cleanup-record' }]);
  assert.equal(await readFile(path.join(f.workspace, 'retained'), 'utf8'), 'candidate');
});
