import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalActionManifestPayload, createGitHubActionsHandler, createHttpSecretBroker, EphemeralWorkspaceManager, HttpSecretProvider, IsolatedActionRunner, loadActionKeyring, loadSecretLeaseBroker, loadSignedActionRegistry, SecretLeaseBroker, StaticActionRegistry } from '../src/action-runner.js';
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
  const provider = new HttpSecretProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture', timeoutMs: 100, allowInsecureLocalhost: true });
  await assert.rejects(provider.resolve({ expiresAt: new Date(Date.now() + 10000).toISOString() }), /response is invalid/);
});


test('rejected runner environment does not consume execution capacity', async () => {
  const runner = new IsolatedActionRunner({ image: 'kujo/runner:latest', workspaceRoot: '/srv/workspaces', maxActive: 1 });
  await assert.rejects(runner.run({ steps: [{ run: 'true' }] }, { workspace: '/srv/workspaces/job', env: { NODE_OPTIONS: '--inspect' } }));
  assert.equal(runner.slots.active, 0);
});
