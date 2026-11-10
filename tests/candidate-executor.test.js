import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync, readdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { digest } from '../src/integration-planner.js';
import { exportCandidate, CandidateContainerExecutor } from '../src/candidate-executor.js';
const exec = promisify(execFile);
const image = `fixture/runner@sha256:${'a'.repeat(64)}`;

test('unconfirmed container cleanup preserves the workspace and a durable recovery record', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const executor = new CandidateContainerExecutor({ workspaceRoot: path.join(f.root, 'workspaces'), image,
    toolVersions: { node: 'fixture' }, spawnProcess: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => {};
      started(); return child;
    } });
  executor.runner.removeContainer = async () => false;
  const check = { command: ['sleep', '60'], environment: executor.environment, toolVersions: executor.profile.toolVersions, inputs: {}, externalState: {} };
  const pending = executor.execute({ candidate: await f.candidate(), check, repository: f.repository,
    identity: 'fixture', job: { id: 'cleanup', leaseToken: 'attempt' }, signal: controller.signal });
  await ready; controller.abort();
  let failure;
  await assert.rejects(pending, (error) => { failure = error; return /cancelled/.test(error.message); });
  assert.equal(failure.cleanup?.confirmed, false);
  assert.equal(failure.cleanup.recorded, true);
  const record = JSON.parse(await readFile(failure.cleanup.recordPath, 'utf8'));
  assert.equal(record.containerName, failure.cleanup.containerName);
  assert.equal(record.runtime, 'podman');
  assert.equal((await stat(path.join(record.workspace, 'binary'))).isFile(), true);
  assert.equal(record.state, 'cleanup-unconfirmed');
  assert.equal(executor.runner.slots.active, 0);
  assert.equal(executor.workspaces.slots.active, 0);
  assert.equal(executor.workspaces.active.size, 0);
  await assert.rejects(() => executor.runner.run({ steps: [{ run: 'true' }] }, { workspace: record.workspace }), /cleanup recovery required/);
  const restarted = new CandidateContainerExecutor({ workspaceRoot: executor.workspaces.root, image, toolVersions: { node: 'fixture' } });
  await assert.rejects(() => restarted.runner.run({ steps: [{ run: 'true' }] }, { workspace: record.workspace }), /cleanup recovery required/);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'source-executor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const git = async (...args) => (await exec('git', args, { cwd })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(cwd, 'binary'), Buffer.from([0, 255, 10, 0, 13]));
  await writeFile(path.join(cwd, 'script'), '#!/bin/sh\nprintf exact'); await chmod(path.join(cwd, 'script'), 0o755);
  await writeFile(path.join(cwd, '.gitattributes'), 'binary export-ignore\n');
  await git('add', '.'); await git('commit', '-m', 'candidate');
  const candidate = async () => {
    const body = { headCommit: await git('rev-parse', 'HEAD'), tree: await git('rev-parse', 'HEAD^{tree}'), proposals: [] };
    return { ...body, id: digest(body) };
  };
  const workspace = async () => mkdtemp(path.join(root, 'export-'));
  return { root, cwd, git, candidate, workspace, repository: path.join(cwd, '.git') };
}

test('candidate export preserves raw Git bytes and executable mode without working files, archive attributes or .git', async (t) => {
  const f = await fixture(t); const candidate = await f.candidate(); const workspace = await f.workspace();
  await writeFile(path.join(f.cwd, 'binary'), 'uncommitted substitution');
  await writeFile(path.join(f.cwd, 'secret.env'), 'untracked fixture');
  const result = await exportCandidate({ repository: f.repository, candidate, workspace });
  assert.equal(result.commit, candidate.headCommit); assert.equal(result.files, 3);
  assert.deepEqual(await readFile(path.join(workspace, 'binary')), Buffer.from([0, 255, 10, 0, 13]));
  assert.equal((await stat(path.join(workspace, 'script'))).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(workspace)).sort(), ['.gitattributes', 'binary', 'script']);
  await assert.rejects(() => exportCandidate({ repository: f.repository, candidate, workspace }), /empty directory/);
  const substituted = { ...candidate, tree: 'b'.repeat(40) }; const { id, ...body } = substituted; substituted.id = digest(body);
  const fresh = await f.workspace();
  await assert.rejects(() => exportCandidate({ repository: f.repository, candidate: substituted, workspace: fresh }), /commit\/tree mismatch/);
});

test('candidate export rejects symlinks and oversized trees before writing files', async (t) => {
  const f = await fixture(t);
  for (const limits of [{ maxFiles: 1 }, { maxBytes: 1 }]) {
    const workspace = await f.workspace();
    const candidate = await f.candidate();
    await assert.rejects(() => exportCandidate({ repository: f.repository, candidate, workspace, ...limits }), /exceeds? export limit/);
    assert.deepEqual(await readdir(workspace), []);
  }
  await symlink('/etc/passwd', path.join(f.cwd, 'escape')); await f.git('add', '.'); await f.git('commit', '-m', 'symlink');
  const candidate = await f.candidate(); const workspace = await f.workspace();
  await assert.rejects(() => exportCandidate({ repository: f.repository, candidate, workspace }), /regular files only/);
  assert.deepEqual(await readdir(workspace), []);
});

test('candidate export rejects filesystem aliases and corrupted blob bytes', async (t) => {
  const f = await fixture(t);
  const blob = await f.git('rev-parse', 'HEAD:binary');
  const pending = exec('git', ['mktree'], { cwd: f.cwd });
  pending.child.stdin.end(`100644 blob ${blob}\tA\n100644 blob ${blob}\ta\n`);
  const tree = (await pending).stdout.trim();
  const headCommit = await f.git('commit-tree', tree, '-m', 'case aliases');
  const body = { headCommit, tree, proposals: [] }; const candidate = { ...body, id: digest(body) };
  const workspace = await f.workspace();
  await assert.rejects(() => exportCandidate({ repository: f.repository, candidate, workspace }), /path collision/);
  assert.deepEqual(await readdir(workspace), []);
  const original = await f.candidate();
  const objectPath = path.join(f.repository, 'objects', blob.slice(0, 2), blob.slice(2));
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, deflateSync(Buffer.concat([Buffer.from('blob 5\0'), Buffer.from([1, 2, 3, 4, 5])])));
  await assert.rejects(() => exportCandidate({ repository: f.repository, candidate: original, workspace }), /blob content integrity mismatch/);
});

test('container executor pins its environment, quotes argv and cleans its exact workspace after success or runtime failure', async (t) => {
  const f = await fixture(t); const calls = [];
  const spawnProcess = (runtime, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const journal = readdirSync(path.join(f.root, 'workspaces')).find(name => name.endsWith('.attempt.json'));
    assert.ok(journal, 'journal must be published before runtime spawn');
    const record = JSON.parse(readFileSync(path.join(f.root, 'workspaces', journal), 'utf8'));
    assert.equal(record.state, 'prepared');
    assert.equal(record.containerName, args[args.indexOf('--name') + 1]);
    assert.ok(args.includes(`io.source.attempt=${record.containerName}`));
    calls.push({ runtime, args });
    setImmediate(() => { child.stdout.end('fixture output'); child.emit('close', 0, null); });
    return child;
  };
  const executor = new CandidateContainerExecutor({ workspaceRoot: path.join(f.root, 'workspaces'), image, toolVersions: { node: 'fixture' }, spawnProcess });
  executor.runner.removeContainer = async () => true;
  const check = { command: ['printf', "$(touch outside); 'quoted'"], environment: executor.environment, inputs: {}, externalState: {}, toolVersions: { node: 'fixture' } };
  const input = { candidate: await f.candidate(), check, repository: f.repository, identity: 'identity', job: { id: 'J1', leaseToken: 'attempt1' } };
  const result = await executor.execute(input);
  assert.equal(result.execution.status, 'pass'); assert.equal(result.execution.workspaceRemoved, true); assert.equal(result.execution.cleanupConfirmed, true);
  assert.equal(result.output, 'fixture output');
  assert.ok(calls[0].args.includes(image)); assert.ok(calls[0].args.includes('--network=none'));
  assert.match(calls[0].args.at(-1), /'printf' '\$\(touch outside\); '/);
  // Exercise only this test-owned printf fixture through the shell to prove
  // argument quoting; production commands remain container-only.
  const quoted = await exec('/bin/sh', ['-c', calls[0].args.at(-1)], { cwd: f.root });
  assert.equal(quoted.stdout, check.command[1]);
  await assert.rejects(() => stat(path.join(f.root, 'outside')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(executor.workspaces.root), []);
  assert.equal(executor.workspaces.slots.active, 0);
  await assert.rejects(() => executor.execute({ ...input, check: { ...check, environment: 'other' } }), /environment differs/);
  await assert.rejects(() => executor.execute({ ...input, check: { ...check, externalState: { service: 'v1' } } }), /self-contained/);
  const controller = new AbortController(); controller.abort(new Error('cancel before allocation'));
  await assert.rejects(() => executor.execute({ ...input, signal: controller.signal }), /cancel before allocation/);
  await assert.rejects(() => executor.execute({ ...input, candidate: { ...input.candidate, id: 'invalid' } }), /invalid candidate snapshot/);
  assert.deepEqual(await readdir(executor.workspaces.root), []);
  executor.runner.spawnProcess = () => { throw new Error('runtime unavailable'); };
  await assert.rejects(() => executor.execute(input), /runtime unavailable/);
  assert.deepEqual(await readdir(executor.workspaces.root), []);
  assert.equal(executor.workspaces.slots.active, 0);
  assert.throws(() => new CandidateContainerExecutor({ workspaceRoot: f.root, image: 'mutable:latest', toolVersions: { node: 'fixture' } }), /digest-pinned/);
});
