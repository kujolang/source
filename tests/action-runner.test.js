import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalActionManifestPayload, createGitHubActionsHandler, EphemeralWorkspaceManager, IsolatedActionRunner, loadSignedActionRegistry, StaticActionRegistry } from '../src/action-runner.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
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

test('isolated runner requires resolved actions and rejects workspace escapes', () => {
  const runner = new IsolatedActionRunner({ image: 'kujo/runner:latest', workspaceRoot: '/srv/workspaces' });
  assert.throws(() => runner.buildArgs({ steps: [{ uses: 'actions/checkout@v4' }] }, '/srv/workspaces/job-1'), /must be resolved/);
  assert.throws(() => runner.buildArgs({ steps: [{ run: 'echo unsafe' }] }, '/srv/other'), /workspace root/);
});

test('isolated runner expands only bounded operator-configured uses actions', async () => {
  const calls = [];
  const runner = new IsolatedActionRunner({
    image: 'kujo/runner:latest', workspaceRoot: '/srv/workspaces',
    actionResolver: async (action) => {
      calls.push(action);
      return [{ run: `kujo action ${action.with.target}` }];
    },
  });
  const steps = await runner.resolveSteps([
    { uses: 'kujo/setup@v1', with: { target: 'source' } },
    { run: 'kujo check' },
  ]);
  assert.deepEqual(steps, [{ run: 'kujo action source' }, { run: 'kujo check' }]);
  assert.deepEqual(calls[0].with, { target: 'source' });
  await assert.rejects(
    new IsolatedActionRunner({ image: 'kujo/runner:latest', workspaceRoot: '/srv/workspaces' }).resolveSteps([{ uses: 'actions/checkout@v4' }]),
    /not configured/,
  );
});

test('static action registry requires immutable allowlisted references', async () => {
  const reference = `kujo/setup@${'a'.repeat(40)}`;
  const registry = new StaticActionRegistry({ actions: { [reference]: ({ with: inputs }) => [{ run: `kujo setup ${inputs.target}` }] } });
  assert.deepEqual(await registry.resolve({ uses: reference, with: { target: 'source' } }), [{ run: 'kujo setup source' }]);
  await assert.rejects(registry.resolve({ uses: 'kujo/setup@v1' }), /immutable/);
  await assert.rejects(registry.resolve({ uses: reference.replace(/a+$/, 'b'.repeat(40)) }), /not allowlisted/);
  assert.throws(() => new StaticActionRegistry({ actions: { 'kujo/setup@v1': [] } }), /immutable/);
});

test('signed action manifests require valid Ed25519 signatures and expiry', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const reference = `kujo/setup@${'c'.repeat(40)}`;
  const manifest = {
    version: 1,
    keyId: 'runner-key-1',
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    actions: { [reference]: [{ run: 'kujo setup source' }] },
  };
  manifest.signature = sign(null, canonicalActionManifestPayload(manifest), privateKey).toString('base64');
  const registry = StaticActionRegistry.fromSignedManifest(manifest, { publicKey });
  assert.deepEqual(await registry.resolve({ uses: reference }), [{ run: 'kujo setup source' }]);
  const tampered = { ...manifest, actions: { [reference]: [{ run: 'kujo setup tampered' }] } };
  await assert.rejects(Promise.resolve().then(() => StaticActionRegistry.fromSignedManifest(tampered, { publicKey })), /signature verification failed/);
  const expired = { ...manifest, expiresAt: new Date(Date.now() - 1).toISOString() };
  await assert.rejects(Promise.resolve().then(() => StaticActionRegistry.fromSignedManifest(expired, { publicKey })), /expired/);
});

test('signed action registry loader selects keys from a rotatable keyring', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const reference = `kujo/setup@${'d'.repeat(40)}`;
  const manifest = {
    version: 1,
    keyId: 'old-runner-key',
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    actions: { [reference]: [{ run: 'kujo setup source' }] },
  };
  manifest.signature = sign(null, canonicalActionManifestPayload(manifest), privateKey).toString('base64');
  const root = await mkdtemp(path.join(tmpdir(), 'source-action-manifest-'));
  const manifestPath = path.join(root, 'actions.json');
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  const registry = await loadSignedActionRegistry({
    manifestPath,
    keyring: new Map([['old-runner-key', publicKey], ['new-runner-key', generateKeyPairSync('ed25519').publicKey]]),
  });
  assert.deepEqual(await registry.resolve({ uses: reference }), [{ run: 'kujo setup source' }]);
  await assert.rejects(loadSignedActionRegistry({ manifestPath, keyring: { 'new-runner-key': publicKey } }), /not in the configured keyring/);
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
