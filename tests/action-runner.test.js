import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalActionManifestPayload, createGitHubActionsHandler, createHttpSecretBroker, EphemeralWorkspaceManager, removeRuntimeContainer, HttpSecretProvider, IsolatedActionRunner, loadActionKeyring, loadSecretLeaseBroker, loadSignedActionRegistry, SecretLeaseBroker, StaticActionRegistry } from '../src/action-runner.js';
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

test('action keyring loader bounds and validates deployment key files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-action-keyring-'));
  const keyringPath = path.join(root, 'keys.json');
  await writeFile(keyringPath, JSON.stringify({ 'old-runner-key': '-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----' }), 'utf8');
  assert.deepEqual(await loadActionKeyring({ keyringPath }), { 'old-runner-key': '-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----' });
  const invalidPath = path.join(root, 'invalid.json');
  await writeFile(invalidPath, JSON.stringify({ 'bad key': 'x' }), 'utf8');
  await assert.rejects(loadActionKeyring({ keyringPath: invalidPath }), /entry is invalid/);
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
    runtime: 'docker', image: 'kujo/runner:latest', workspaceRoot: '/srv/workspaces', maxActive: 1, queue: 0, removeContainer: async () => true,
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

test('secret lease broker binds identity, avoids caching, and audits without values', async () => {
  const events = [];
  let resolutions = 0;
  const revoked = [];
  const broker = new SecretLeaseBroker({
    identity: async () => 'agent-42',
    resolve: async ({ identity, references }) => {
      resolutions += 1;
      assert.equal(identity, 'agent-42');
      assert.deepEqual(references, ['DEPLOY_TOKEN']);
      return { env: { TOKEN: `secret-${resolutions}`, NODE_OPTIONS: '--require unsafe' } };
    },
    audit: (event) => events.push(event),
    revoke: async ({ leaseId, reason }) => revoked.push({ leaseId, reason }),
  });
  const runnerCalls = [];
  const handler = createGitHubActionsHandler({
    runner: { run: async (_request, options) => { runnerCalls.push(options); return { ok: true, stdout: options.env.TOKEN }; } },
    workspaceForJob: async () => '/srv/workspaces/job-secret',
    secretBroker: broker,
  });
  const payload = { parameters: { secretRefs: ['DEPLOY_TOKEN'], steps: [{ run: 'deploy' }] } };
  const first = await handler(payload, { id: 'J-secret' });
  const second = await handler(payload, { id: 'J-secret' });
  assert.equal(first.stdout, '[REDACTED]');
  assert.equal(second.stdout, '[REDACTED]');
  assert.equal(resolutions, 2);
  assert.deepEqual(runnerCalls.map((call) => call.env), [{ TOKEN: 'secret-1' }, { TOKEN: 'secret-2' }]);
  assert.deepEqual(events.map((event) => event.event), ['secret_lease_issued', 'secret_lease_revoked', 'secret_lease_issued', 'secret_lease_revoked']);
  assert.equal(JSON.stringify(events).includes('secret-1'), false);
  const lease = await broker.issue(payload, { id: 'J-revoke' });
  assert.equal(await broker.revoke(lease.leaseId, 'rotation-drill'), true);
  assert.equal(revoked.length, 3);
  assert.deepEqual(revoked.at(-1), { leaseId: lease.leaseId, reason: 'rotation-drill' });
  assert.equal(broker.metrics().revoked, 3);
});

test('secret provider module loader enforces the production adapter contract', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-secret-provider-'));
  const modulePath = path.join(root, 'provider.mjs');
  await writeFile(modulePath, `export const resolveIdentity = async () => 'module-agent';\nexport const resolveSecretLease = async () => ({ TOKEN: 'module-secret' });\nexport const auditSecretLease = () => {};\nexport const checkHealth = async () => true;\nexport const revokeSecretLease = async () => true;\n`, 'utf8');
  const broker = await loadSecretLeaseBroker({ modulePath, leaseMs: 2_000 });
  assert.equal(await broker.checkHealth(), true);
  assert.deepEqual(await broker.get({ parameters: { secretRefs: [] } }, { id: 'J-module' }), { TOKEN: 'module-secret' });
  const invalidPath = path.join(root, 'invalid.mjs');
  await writeFile(invalidPath, 'export const resolveSecretLease = async () => ({});\n', 'utf8');
  await assert.rejects(loadSecretLeaseBroker({ modulePath: invalidPath }), /secret broker/);
});

test('HTTPS secret provider adapter rotates auth and enforces bounded lease responses', async () => {
  let tokenCalls = 0;
  let request;
  const provider = new HttpSecretProvider({
    baseUrl: 'https://secrets.example.test/api',
    token: async () => `rotated-token-${++tokenCalls}`,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return Response.json({ env: { TOKEN: 'provider-secret' }, expiresAt: new Date(Date.now() + 1_000).toISOString() });
    },
  });
  const expiresAt = new Date(Date.now() + 2_000).toISOString();
  const result = await provider.resolve({ identity: 'agent-1', references: ['TOKEN'], expiresAt, job: { id: 'J-http' } });
  assert.deepEqual(result, { env: { TOKEN: 'provider-secret' } });
  assert.equal(tokenCalls, 1);
  assert.equal(request.url, 'https://secrets.example.test/api/v1/leases');
  assert.match(request.options.headers.authorization, /^Bearer rotated-token-1$/);
  await provider.checkHealth();
  assert.equal(tokenCalls, 2);
  assert.equal(request.url, 'https://secrets.example.test/api/v1/health');
  await provider.revoke({ leaseId: 'e'.repeat(48), reason: 'rotation' });
  assert.equal(tokenCalls, 3);
  assert.equal(request.url, 'https://secrets.example.test/api/v1/leases/' + 'e'.repeat(48) + '/revoke');
  assert.throws(() => new HttpSecretProvider({ baseUrl: 'http://secrets.example.test', token: 'x' }), /HTTPS/);
  const broker = createHttpSecretBroker({
    baseUrl: 'https://secrets.example.test', token: 'x', identity: 'agent-1', audit: () => {},
    fetchImpl: async () => Response.json({ env: {}, expiresAt: new Date(Date.now() + 1_000).toISOString() }),
  });
  assert.deepEqual(await broker.get({ parameters: { secretRefs: [] } }, { id: 'J-http-broker' }), {});
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

test('revocation failure still releases the action workspace', async () => {
  let released = false;
  const handler = createGitHubActionsHandler({
    runner: { run: async () => ({ ok: true }) },
    workspaceManager: { acquire: async () => '/workspace/job', release: async () => { released = true; } },
    secretBroker: { get: async () => ({}), issue: async () => ({ env: {}, leaseId: 'a'.repeat(48) }), revokeLease: true, revoke: async () => { throw new Error('provider unavailable'); } },
  });
  await assert.rejects(handler({ parameters: { steps: [{ run: 'true' }] } }, { id: 'J1' }), /provider unavailable/);
  assert.equal(released, true);
});

test('secret provider stops reading oversized bodies', async () => {
  let cancelled = false;
  let pulls = 0;
  const provider = new HttpSecretProvider({ baseUrl: 'https://secrets.example.test', token: 'fixture', fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { if (++pulls > 3) controller.close(); else controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(provider.resolve({ expiresAt: new Date(Date.now() + 10000).toISOString() }), /response is invalid/);
  assert.equal(cancelled, true);
});

test('secret provider timeout covers a stalled response body', { timeout: 3000 }, async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  let receivedHeaders = false;
  const provider = new HttpSecretProvider({
    baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture', timeoutMs: 1000, allowInsecureLocalhost: true,
    async fetchImpl(...args) {
      const response = await fetch(...args);
      receivedHeaders = true;
      return response;
    },
  });
  await assert.rejects(provider.resolve({ expiresAt: new Date(Date.now() + 10000).toISOString() }), /response is invalid/);
  assert.equal(receivedHeaders, true, 'timeout must occur while reading the body');
});


test('rejected runner environment does not consume execution capacity', async () => {
  let spawned = false;
  const runner = new IsolatedActionRunner({ image: 'kujo/runner:latest', workspaceRoot: '/srv/workspaces', maxActive: 1, spawnProcess: () => { spawned = true; throw new Error('unexpected runtime spawn'); } });
  const env = Object.defineProperty({}, 'TOKEN', { enumerable: true, get() { throw new Error('environment unavailable'); } });
  await assert.rejects(runner.run({ steps: [{ run: 'true' }] }, { workspace: '/srv/workspaces/job', env }), /environment unavailable/);
  assert.equal(spawned, false);
  assert.equal(runner.slots.active, 0);
});

test('cancellation propagates to isolated runtime and rejects before spawning when already aborted', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; child.emit('close', null, 'SIGKILL'); };
  let spawned = 0; let ready; const started = new Promise(resolve => { ready = resolve; });
  const controller = new AbortController();
  const runner = new IsolatedActionRunner({ image: 'fixture@sha256:abc', workspaceRoot: '/srv/workspaces', spawnProcess: () => { spawned += 1; ready(); return child; } });
  const pending = runner.run({ steps: [{ run: 'sleep 60' }] }, { workspace: '/srv/workspaces/owned', signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(killed, true);
  await assert.rejects(runner.run({ steps: [{ run: 'true' }] }, { workspace: '/srv/workspaces/owned', signal: controller.signal }), /abort/i);
  assert.equal(spawned, 1);
});

test('workflow handler forwards cancellation through its workspace and secret cleanup boundary', async () => {
  const controller = new AbortController();
  let released = false;
  const handler = createGitHubActionsHandler({
    workspaceManager: { acquire: async () => '/srv/owned', release: async () => { released = true; } },
    runner: { run: async (_steps, context) => { assert.equal(context.signal, controller.signal); throw new Error('cancelled'); } },
  });
  await assert.rejects(handler({ parameters: { steps: [{ run: 'test' }] } }, { id: 'owned' }, { signal: controller.signal }), /cancelled/);
  assert.equal(released, true);
});

test('old attempt cleanup cannot remove a reclaimed job workspace', async (t) => {
  const { access, rm } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'source-attempt-workspaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new EphemeralWorkspaceManager({ root, maxActive: 2, queue: 0 });
  const old = { id: 'same-job', leaseToken: 'old-lease' };
  const current = { id: 'same-job', leaseToken: 'new-lease' };
  const oldPath = await manager.acquire(old);
  const pending = manager.acquire(current);
  await assert.rejects(manager.acquire(current), /already owns/);
  const currentPath = await pending;
  assert.notEqual(oldPath, currentPath);
  await writeFile(path.join(currentPath, 'result'), 'new attempt');
  assert.equal(await manager.release(old), true);
  await assert.rejects(access(oldPath));
  await access(path.join(currentPath, 'result'));
  assert.equal(await manager.release(old), false);
  await assert.rejects(manager.acquire(current), /already owns/);
  assert.equal(await manager.release(current), true);
  assert.equal(manager.active.size, 0);
  assert.equal(manager.slots.active, 0);
});


test('runtime cleanup distinguishes confirmed absence from an unreachable daemon', async () => {
  const name = 'source-action-123-456-abcdef012345';
  const calls = [];
  assert.equal(await removeRuntimeContainer('docker', name, async (_runtime, args) => { calls.push(args); return ''; }), true);
  assert.deepEqual(calls, [['rm', '--force', name]]);
  for (const [listed, expected] of [[null, false], [name + '\n', false], ['', true], [name + '-other\n', true]]) {
    let count = 0;
    assert.equal(await removeRuntimeContainer('docker', name, async () => ++count === 1 ? null : listed), expected);
    assert.equal(count, 2);
  }
  await assert.rejects(() => removeRuntimeContainer('docker', 'unrelated-container'), /cleanup identity/);
});

test('a successful runtime exit cannot report success when cleanup is unconfirmed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-cleanup-result-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const runner = new IsolatedActionRunner({ image: 'fixture', workspaceRoot: root, removeContainer: async () => { throw new Error('daemon unavailable'); },
    spawnProcess: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setImmediate(() => child.emit('close', 0, null)); return child;
    } });
  await assert.rejects(() => runner.run({ steps: [{ run: 'true' }] }, { workspace: root }), (error) =>
    /cleanup unconfirmed/.test(error.message) && error.cleanup.confirmed === false && error.cleanup.recorded === true);
  assert.equal(runner.slots.active, 0);
});

test('workflow handler preserves uncertain workspaces while revoking its secret lease', async () => {
  let preserved = false; let revoked = false;
  const failure = Object.assign(new Error('cleanup uncertain'), { cleanup: { confirmed: false } });
  const handler = createGitHubActionsHandler({
    runner: { async run() { throw failure; } },
    workspaceManager: { acquire: async () => '/owned', release: async () => assert.fail('must preserve'), preserve() { preserved = true; } },
    secretBroker: { get() {}, issue: async () => ({ env: {}, leaseId: 'fixture' }), revokeLease() {}, revoke: async () => { revoked = true; } },
  });
  await assert.rejects(() => handler({ parameters: { steps: [{ run: 'true' }] } }, { id: 'fixture' }), /cleanup uncertain/);
  assert.equal(preserved, true); assert.equal(revoked, true);
});

test('workload environment cannot redirect the host runtime but reaches the container unchanged', async () => {
  let invocation;
  const runner = new IsolatedActionRunner({ image: 'fixture', workspaceRoot: '/srv/workspaces', removeContainer: async () => true,
    spawnProcess: (_runtime, args, options) => {
      invocation = { args, options };
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setImmediate(() => child.emit('close', 0, null)); return child;
    } });
  const env = { PATH: '/fixture-container-path', DOCKER_HOST: 'https://fixture.invalid', TOKEN: 'fixture-token\nsecond-line', SOURCE_ACTION_ENV_0: 'collision-fixture' };
  await runner.run({ steps: [{ run: 'printf "%s|%s|%s|%s" "$PATH" "$DOCKER_HOST" "$TOKEN" "$SOURCE_ACTION_ENV_0"' }] }, { workspace: '/srv/workspaces/owned', env });
  assert.equal(invocation.options.env.PATH, process.env.PATH || '/usr/bin:/bin');
  for (const name of ['DOCKER_HOST', 'TOKEN', 'SOURCE_ACTION_ENV_0']) assert.equal(invocation.options.env[name], undefined);
  for (const value of Object.values(env)) assert.ok(!invocation.args.some(arg => arg.includes(value)), 'no values in runtime argv');
  // Execute only this fixed fixture script to verify exact multiline forwarding;
  // repository workflow commands remain container-only.
  const { execFile } = await import('node:child_process');
  const output = await new Promise((resolve, reject) => execFile('/bin/sh', ['-c', invocation.args.at(-1)], { env: invocation.options.env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.equal(output, Object.values(env).join('|'));
});


test('live container environment stays separate from host runtime configuration', { skip: !process.env.SOURCE_TEST_CONTAINER_IMAGE }, async (t) => {
  const { mkdir, rm } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'source-runtime-env-'));
  const workspace = path.join(root, 'owned'); await mkdir(workspace);
  let canRemove = true;
  t.after(async () => { if (canRemove) await rm(root, { recursive: true, force: true }); });
  const runner = new IsolatedActionRunner({ runtime: process.env.SOURCE_TEST_CONTAINER_RUNTIME || 'docker', image: process.env.SOURCE_TEST_CONTAINER_IMAGE,
    workspaceRoot: root, user: `${process.getuid()}:${process.getgid()}`, timeoutMs: 15000 });
  const script = String.raw`const assert=require('node:assert/strict'); assert.equal(process.env.DOCKER_HOST,'https://fixture.invalid'); assert.equal(process.env.HOME,'/fixture-home'); assert.equal(process.env.TOKEN,'first\nsecond'); assert.equal(Object.keys(process.env).some(k=>/^SOURCE_ACTION_[A-F0-9]{24}_/.test(k)),false); console.log('container environment isolated');`;
  const quotedScript = "'" + script.replaceAll("'", "'\\''") + "'";
  try {
    const result = await runner.run({ steps: [{ run: `node -e ${quotedScript}` }] }, { workspace,
      env: { DOCKER_HOST: 'https://fixture.invalid', HOME: '/fixture-home', TOKEN: 'first\nsecond' } });
    assert.equal(result.ok, true, result.stderr); assert.equal(result.cleanupConfirmed, true);
    assert.match(result.stdout, /container environment isolated/);
  } catch (error) { canRemove = error.cleanup?.confirmed !== false; throw error; }
});
