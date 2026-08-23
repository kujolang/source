import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubActionsHandler, EphemeralWorkspaceManager, IsolatedActionRunner } from '../src/action-runner.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
    { workspace: '/srv/workspaces/job-2', env: { TOKEN: 'redacted', NODE_OPTIONS: '--require evil' } },
  ]);
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
