import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubActionsHandler, EphemeralWorkspaceManager, IsolatedActionRunner } from '../src/action-runner.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

test('isolated runner builds a bounded no-network container command', () => {
  const runner = new IsolatedActionRunner({ image: 'kujo/runner:latest', workspaceRoot: '/srv/workspaces' });
  const args = runner.buildArgs({ steps: [{ run: 'kujo check' }] }, '/srv/workspaces/job-1');
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--pids-limit=256'));
  assert.ok(args.includes('--env'));
  assert.ok(args.includes('CI=true'));
  assert.ok(args.includes('kujo/runner:latest'));
  assert.match(args.at(-1), /kujo check/);
});

test('isolated runner rejects composite actions and workspace escapes', () => {
  const runner = new IsolatedActionRunner({ image: 'kujo/runner:latest', workspaceRoot: '/srv/workspaces' });
  assert.throws(() => runner.buildArgs({ steps: [{ uses: 'actions/checkout@v4' }] }, '/srv/workspaces/job-1'), /composite actions/);
  assert.throws(() => runner.buildArgs({ steps: [{ run: 'echo unsafe' }] }, '/srv/other'), /workspace root/);
});

test('isolated runner bounds container admission independently of workspaces', async () => {
  const runner = new IsolatedActionRunner({ image: 'kujo/runner:latest', workspaceRoot: '/srv/workspaces', maxActive: 1, queue: 0 });
  const release = await runner.slots.acquire();
  await assert.rejects(
    runner.run({ steps: [{ run: 'kujo check' }] }, { workspace: '/srv/workspaces/job-1' }),
    /capacity exhausted/,
  );
  release();
});

test('isolated runner releases admission after a runtime exits', async () => {
  const child = new EventEmitter();
  child.pid = 1234;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  const runner = new IsolatedActionRunner({
    runtime: 'docker', image: 'kujo/runner:latest', workspaceRoot: '/srv/workspaces', maxActive: 1, queue: 0,
    spawnProcess: () => {
      setImmediate(() => child.emit('close', 0, null));
      return child;
    },
  });
  const result = await runner.run({ steps: [{ run: 'printf ok' }] }, { workspace: '/srv/workspaces/job-1' });
  assert.equal(result.ok, true);
  assert.equal(runner.slots.active, 0);
});

test('GitHub handler resolves an isolated workspace and passes brokered secrets by name', async () => {
  const calls = [];
  const handler = createGitHubActionsHandler({
    runner: { run: async (...args) => { calls.push(args); return { ok: true }; } },
    workspaceForJob: async () => '/srv/workspaces/job-2',
    secretProvider: async () => ({ TOKEN: 'redacted', NODE_OPTIONS: '--require evil' }),
  });
  const result = await handler({ parameters: { steps: [{ run: 'kujo check' }] } }, { id: 'J1' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0], [
    { steps: [{ run: 'kujo check' }] },
    { workspace: '/srv/workspaces/job-2', env: { TOKEN: 'redacted' } },
  ]);
});

test('GitHub handler redacts brokered secrets from runner output', async () => {
  const handler = createGitHubActionsHandler({
    runner: { run: async (_request, options) => ({ ok: true, stdout: `token=${options.env.TOKEN}`, stderr: options.env.NODE_OPTIONS || '' }) },
    workspaceForJob: async () => '/srv/workspaces/job-3',
    secretProvider: async () => ({ TOKEN: 'super-secret-token', NODE_OPTIONS: '--require evil' }),
  });
  const result = await handler({ parameters: { steps: [{ run: 'kujo check' }] } }, { id: 'J3' });
  assert.equal(result.stdout, 'token=[REDACTED]');
  assert.equal(result.stderr, '');
});

test('ephemeral workspace manager bounds and cleans action workspaces', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-workspaces-'));
  const manager = new EphemeralWorkspaceManager({ root, maxActive: 1, queue: 0 });
  const job = { id: 'J/unsafe' };
  const workspace = await manager.acquire(job);
  assert.match(workspace, /source-J_unsafe-/);
  assert.equal(manager.active.size, 1);
  assert.equal(await manager.release(job), true);
  assert.equal(manager.active.size, 0);
  assert.equal(await manager.release(job), false);
});

test('GitHub handler releases managed workspaces after runner failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-handler-workspaces-'));
  const manager = new EphemeralWorkspaceManager({ root, maxActive: 1, queue: 0 });
  const handler = createGitHubActionsHandler({
    runner: { run: async () => { throw new Error('runner failed'); } },
    workspaceManager: manager,
  });
  await assert.rejects(handler({ parameters: { steps: [{ run: 'false' }] } }, { id: 'J2' }), /runner failed/);
  assert.equal(manager.active.size, 0);
});
