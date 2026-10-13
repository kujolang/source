// Explicit isolated execution seam for imported workflow jobs.
//
// Source never executes repository-provided workflow commands in its API or
// worker process. Operators must provide a container runtime and image. The
// default profile is network-less, read-only, capability-dropped, and bounded
// by CPU, memory, PIDs, output, and wall-clock limits.

import { spawn } from 'node:child_process';
import { randomBytes, verify as verifySignature } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Semaphore } from './concurrency.js';

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function safeImage(image) {
  if (typeof image !== 'string' || !image || image.length > 240 || /[\s\0]/.test(image) || image.startsWith('-')) throw new Error('isolated runner image is invalid');
  return image;
}

function safeWorkspace(root, workspace) {
  const rootPath = path.resolve(root || '');
  const workspacePath = path.resolve(workspace || '');
  const relative = path.relative(rootPath, workspacePath);
  if (!root || !workspace || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('workflow workspace must be inside the configured workspace root');
  return workspacePath;
}

function workflowScript(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 100) throw new Error('workflow job must contain 1-100 steps');
  const lines = ['set -eu'];
  for (const step of steps) {
    if (step?.uses) throw new Error('GitHub action must be resolved before isolated execution');
    if (typeof step?.run !== 'string' || !step.run.trim()) throw new Error('isolated runner requires run steps');
    if (step.run.length > 16 * 1024) throw new Error('workflow run step is too large');
    lines.push(step.run);
  }
  return `${lines.join('\n')}\n`;
}

function safeEnvironment(env) {
  return Object.fromEntries(Object.entries(env || {}).filter(([key, value]) => (
    /^[A-Z_][A-Z0-9_]{0,63}$/.test(key)
    && !/^(?:LD_|BASH_ENV$|ENV$|NODE_OPTIONS$|PYTHONPATH$|PERL5OPT$|RUBYOPT$|GIT_CONFIG_)/.test(key)
    && typeof value === 'string'
    && value.length <= 4096
  )).slice(0, 128));
}

// Deployment-owned secret broker boundary. Secrets are resolved per job (no
// process cache), bound to an explicit workload identity, and audited without
// recording secret values. Providers should implement rotation and revocation
// behind `resolve` rather than handing Source a long-lived secret store.
export class SecretLeaseBroker {
  constructor({ resolve, identity, audit, healthCheck = null, revoke = null, leaseMs = 15 * 60_000, maxActiveLeases = 10_000 } = {}) {
    if (typeof resolve !== 'function') throw new Error('secret broker resolve function is required');
    if (typeof audit !== 'function') throw new Error('secret broker audit function is required');
    if (typeof identity !== 'string' && typeof identity !== 'function') throw new Error('secret broker identity is required');
    this.resolve = resolve;
    this.identity = identity;
    this.audit = audit;
    this.healthCheck = typeof healthCheck === 'function' ? healthCheck : null;
    this.revokeLease = typeof revoke === 'function' ? revoke : null;
    this.leaseMs = Math.min(60 * 60_000, Math.max(1_000, Math.trunc(leaseMs)));
    this.maxActiveLeases = Math.min(100_000, Math.max(1, Math.trunc(maxActiveLeases)));
    this.activeLeases = new Map();
    this.counters = { issued: 0, denied: 0, healthChecks: 0, healthFailures: 0, revoked: 0 };
  }

  async checkHealth() {
    this.counters.healthChecks += 1;
    if (!this.healthCheck) {
      this.counters.healthFailures += 1;
      throw new Error('secret broker health check is not configured');
    }
    try {
      const healthy = await this.healthCheck();
      if (healthy !== true && healthy?.ok !== true) throw new Error('secret broker health check failed');
      return true;
    } catch (error) {
      this.counters.healthFailures += 1;
      throw error;
    }
  }

  _pruneLeases(now = Date.now()) {
    for (const [leaseId, lease] of this.activeLeases) if (Date.parse(lease.expiresAt) <= now) this.activeLeases.delete(leaseId);
  }

  metrics() {
    this._pruneLeases();
    return { ...this.counters, activeLeases: this.activeLeases.size, maxActiveLeases: this.maxActiveLeases };
  }

  async issue(payload, job) {
    const resolvedIdentity = typeof this.identity === 'function' ? await this.identity(payload, job) : this.identity;
    if (typeof resolvedIdentity !== 'string' || !resolvedIdentity || resolvedIdentity.length > 256) throw new Error('secret broker identity is invalid');
    const requested = payload?.parameters?.secretRefs ?? payload?.parameters?.secrets ?? [];
    if (!Array.isArray(requested) || requested.length > 64 || requested.some((reference) => typeof reference !== 'string' || !reference || reference.length > 256)) throw new Error('secret references are invalid');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + this.leaseMs).toISOString();
    this._pruneLeases(issuedAt.getTime());
    if (this.activeLeases.size >= this.maxActiveLeases) throw new Error('secret broker lease capacity exhausted');
    const leaseId = randomBytes(24).toString('hex');
    try {
      const supplied = await this.resolve({ identity: resolvedIdentity, references: requested, payload, job, expiresAt, leaseId });
      const environment = supplied?.env && typeof supplied.env === 'object' ? supplied.env : supplied;
      const safe = safeEnvironment(environment);
      this.activeLeases.set(leaseId, { identity: resolvedIdentity, jobId: String(job?.id || ''), references: requested, expiresAt });
      this.counters.issued += 1;
      await this.audit({ event: 'secret_lease_issued', leaseId, identity: resolvedIdentity, jobId: String(job?.id || ''), references: requested, issuedAt: issuedAt.toISOString(), expiresAt, keyCount: Object.keys(safe).length });
      return { env: safe, leaseId };
    } catch (error) {
      this.counters.denied += 1;
      await Promise.resolve(this.audit({ event: 'secret_lease_denied', identity: resolvedIdentity, jobId: String(job?.id || ''), references: requested, issuedAt: issuedAt.toISOString(), reason: error?.message ? 'provider_error' : 'provider_failure' })).catch(() => {});
      throw error;
    }
  }

  async get(payload, job) {
    return (await this.issue(payload, job)).env;
  }

  async revoke(leaseId, reason = 'worker_finished') {
    if (typeof leaseId !== 'string' || !/^[a-f0-9]{48}$/.test(leaseId)) throw new Error('secret lease ID is invalid');
    const lease = this.activeLeases.get(leaseId);
    if (!lease) return false;
    if (!this.revokeLease) throw new Error('secret broker revocation is not configured');
    await this.revokeLease({ leaseId, reason });
    this.activeLeases.delete(leaseId);
    this.counters.revoked += 1;
    await this.audit({ event: 'secret_lease_revoked', leaseId, identity: lease.identity, jobId: lease.jobId, reason });
    return true;
  }
}

export async function loadSecretLeaseBroker({ modulePath, leaseMs = 15 * 60_000 } = {}) {
  if (typeof modulePath !== 'string' || !modulePath || modulePath.length > 4_096) throw new Error('secret provider module path is required');
  const loaded = await import(pathToFileURL(path.resolve(modulePath)).href);
  const provider = loaded.secretProvider || loaded.default || loaded;
  const resolve = provider.resolveSecretLease || provider.resolve;
  const identity = provider.resolveIdentity || provider.identity;
  const audit = provider.auditSecretLease || provider.audit;
  const healthCheck = provider.checkHealth || provider.healthCheck;
  const revoke = provider.revokeSecretLease || provider.revoke;
  return new SecretLeaseBroker({ resolve, identity, audit, healthCheck, revoke, leaseMs });
}

export class HttpSecretProvider {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 5_000, allowInsecureLocalhost = false } = {}) {
    if (typeof baseUrl !== 'string' || !baseUrl) throw new Error('secret provider base URL is required');
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new Error('secret provider base URL is invalid'); }
    if (parsed.protocol !== 'https:' && !(allowInsecureLocalhost === true && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))) throw new Error('secret provider must use HTTPS');
    if (typeof token !== 'string' && typeof token !== 'function') throw new Error('secret provider token is required');
    if (typeof fetchImpl !== 'function') throw new Error('secret provider fetch implementation is required');
    const root = parsed.toString().endsWith('/') ? parsed.toString() : `${parsed}/`;
    this.endpoint = new URL('v1/leases', root);
    this.healthEndpoint = new URL('v1/health', root);
    this.revokeEndpoint = new URL('v1/leases/', root);
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.min(60_000, Math.max(100, Math.trunc(timeoutMs)));
  }

  async resolve({ identity, references, expiresAt, job, leaseId } = {}) {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    if (typeof token !== 'string' || !token || token.length > 16 * 1024) throw new Error('secret provider token is invalid');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST', redirect: 'error',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ identity, references, expiresAt, leaseId, jobId: String(job?.id || '') }),
          signal: controller.signal,
        });
      } catch { throw new Error('secret provider request failed'); }
      if (!response?.ok) {
        await response?.body?.cancel();
        throw new Error(`secret provider rejected lease (${Number(response?.status) || 0})`);
      }
      let body;
      try {
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 1024 * 1024) {
              await reader.cancel();
              throw new Error('response too large');
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      } catch { throw new Error('secret provider response is invalid'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !body.env || typeof body.env !== 'object' || Array.isArray(body.env)) throw new Error('secret provider response is invalid');
      const providerExpiry = Date.parse(body.expiresAt);
      const requestedExpiry = Date.parse(expiresAt);
      if (!Number.isFinite(providerExpiry) || providerExpiry <= Date.now() || providerExpiry > requestedExpiry) throw new Error('secret provider lease expiry is invalid');
      return { env: body.env };
    } finally { clearTimeout(timer); }
  }

  async checkHealth() {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    if (typeof token !== 'string' || !token || token.length > 16 * 1024) throw new Error('secret provider token is invalid');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.healthEndpoint, {
        method: 'GET', redirect: 'error',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      await response?.body?.cancel();
      if (!response?.ok) throw new Error(`secret provider health rejected (${Number(response?.status) || 0})`);
      return true;
    } catch {
      throw new Error('secret provider health check failed');
    } finally {
      clearTimeout(timer);
    }
  }

  async revoke({ leaseId, reason } = {}) {
    if (typeof leaseId !== 'string' || !/^[a-f0-9]{48}$/.test(leaseId)) throw new Error('secret lease ID is invalid');
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    if (typeof token !== 'string' || !token || token.length > 16 * 1024) throw new Error('secret provider token is invalid');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(new URL(`${encodeURIComponent(leaseId)}/revoke`, this.revokeEndpoint), {
        method: 'POST', redirect: 'error',
        headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: typeof reason === 'string' ? reason.slice(0, 240) : 'revoked' }),
        signal: controller.signal,
      });
      await response?.body?.cancel();
      if (!response?.ok) throw new Error(`secret provider revocation rejected (${Number(response?.status) || 0})`);
      return true;
    } catch {
      throw new Error('secret provider revocation failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createHttpSecretBroker({ identity, audit, leaseMs, ...providerOptions } = {}) {
  const provider = new HttpSecretProvider(providerOptions);
  return new SecretLeaseBroker({ identity, audit, leaseMs, resolve: provider.resolve.bind(provider), healthCheck: provider.checkHealth.bind(provider), revoke: provider.revoke.bind(provider) });
}

function redactSecretOutput(result, env) {
  if (!result || typeof result !== 'object') return result;
  const secrets = Object.values(env).filter((value) => value.length >= 4);
  const redact = (value) => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), String(value));
  return {
    ...result,
    ...(typeof result.stdout === 'string' ? { stdout: redact(result.stdout) } : {}),
    ...(typeof result.stderr === 'string' ? { stderr: redact(result.stderr) } : {}),
  };
}

function killRuntimeProcess(child) {
  if (!child || child.killed) return;
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process may have already exited */ }
  }
  try { child.kill('SIGKILL'); } catch { /* process may have already exited */ }
}

function removeRuntimeContainer(runtime, name) {
  return new Promise((resolve) => {
    if (!name) return resolve();
    const stopper = spawn(runtime, ['rm', '--force', name], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      try { stopper.kill('SIGKILL'); } catch { /* process may have already exited */ }
      resolve();
    }, 5_000);
    timer.unref?.();
    const finish = () => { clearTimeout(timer); resolve(); };
    stopper.once('error', finish);
    stopper.once('close', finish);
  });
}

const IMMUTABLE_ACTION_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-fA-F]{40}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('action manifest contains an unsupported value');
  return serialized;
}

function signedManifestPayload(manifest) {
  const { signature: _signature, ...payload } = manifest;
  return Buffer.from(canonicalJson(payload));
}

export function canonicalActionManifestPayload(manifest) {
  return signedManifestPayload(manifest);
}

// A deployment-owned action catalog. Source never downloads or evaluates an
// action reference implicitly; operators bind immutable references to steps
// already present in the runner image (or to a resolver function they own).
export class StaticActionRegistry {
  constructor({ actions = {}, allowMutableRefs = false, maxActions = 10_000 } = {}) {
    const entries = actions instanceof Map ? [...actions.entries()] : Object.entries(actions || {});
    if (entries.length > Math.min(100_000, Math.max(1, Math.trunc(maxActions)))) throw new Error('action registry exceeds configured limit');
    this.allowMutableRefs = allowMutableRefs === true;
    this.actions = new Map();
    for (const [reference, action] of entries) {
      this._validateReference(reference);
      if (typeof action !== 'function' && !Array.isArray(action)) throw new Error(`action registry entry is invalid: ${reference}`);
      this.actions.set(reference, action);
    }
  }

  static fromSignedManifest(manifest, { publicKey, allowMutableRefs = false, maxActions = 10_000, now = Date.now() } = {}) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('action manifest is invalid');
    const fields = Object.keys(manifest).sort();
    if (fields.join(',') !== 'actions,expiresAt,issuedAt,keyId,signature,version') throw new Error('action manifest fields are invalid');
    if (manifest.version !== 1 || typeof manifest.keyId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(manifest.keyId)) throw new Error('action manifest metadata is invalid');
    if (!Array.isArray(manifest.actions) && (!manifest.actions || typeof manifest.actions !== 'object')) throw new Error('action manifest actions are invalid');
    const issuedAt = Date.parse(manifest.issuedAt);
    const expiresAt = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt <= now) throw new Error('action manifest is expired or has invalid validity');
    if (typeof manifest.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.signature)) throw new Error('action manifest signature is invalid');
    if (!publicKey) throw new Error('action manifest public key is required');
    let signature;
    try { signature = Buffer.from(manifest.signature, 'base64'); } catch { throw new Error('action manifest signature is invalid'); }
    if (signature.length !== 64 || !verifySignature(null, signedManifestPayload(manifest), publicKey, signature)) throw new Error('action manifest signature verification failed');
    return new StaticActionRegistry({ actions: manifest.actions, allowMutableRefs, maxActions });
  }

  _validateReference(reference) {
    if (typeof reference !== 'string' || reference.length < 3 || reference.length > 500 || /[\0\s]/.test(reference)) throw new Error('action reference is invalid');
    if (!this.allowMutableRefs && !IMMUTABLE_ACTION_REF.test(reference)) throw new Error(`action reference must be immutable: ${reference}`);
  }

  async resolve({ uses, with: inputs = {} } = {}) {
    this._validateReference(uses);
    const action = this.actions.get(uses);
    if (!action) throw new Error(`action is not allowlisted: ${uses}`);
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || JSON.stringify(inputs).length > 64 * 1024) throw new Error('action inputs are invalid or too large');
    return typeof action === 'function' ? action({ uses, with: inputs }) : action;
  }
}

export async function loadSignedActionRegistry({ manifestPath, keyring, allowMutableRefs = false, maxActions = 10_000, maxManifestBytes = 4 * 1024 * 1024, now = Date.now() } = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath || manifestPath.length > 4_096) throw new Error('action manifest path is required');
  const safeMaxBytes = Math.min(16 * 1024 * 1024, Math.max(1, Math.trunc(maxManifestBytes)));
  const metadata = await stat(manifestPath);
  if (!metadata.isFile() || metadata.size > safeMaxBytes) throw new Error('action manifest exceeds configured size or is not a file');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('action manifest JSON is invalid');
  }
  const publicKey = keyring instanceof Map ? keyring.get(manifest?.keyId) : keyring?.[manifest?.keyId];
  if (!publicKey) throw new Error(`action manifest key is not in the configured keyring: ${String(manifest?.keyId || '')}`);
  return StaticActionRegistry.fromSignedManifest(manifest, { publicKey, allowMutableRefs, maxActions, now });
}

export async function loadActionKeyring({ keyringPath, maxKeyringBytes = 1 * 1024 * 1024, maxKeys = 100 } = {}) {
  if (typeof keyringPath !== 'string' || !keyringPath || keyringPath.length > 4_096) throw new Error('action keyring path is required');
  const safeMaxBytes = Math.min(4 * 1024 * 1024, Math.max(1, Math.trunc(maxKeyringBytes)));
  const metadata = await stat(keyringPath);
  if (!metadata.isFile() || metadata.size > safeMaxBytes) throw new Error('action keyring exceeds configured size or is not a file');
  let keyring;
  try {
    keyring = JSON.parse(await readFile(keyringPath, 'utf8'));
  } catch {
    throw new Error('action keyring JSON is invalid');
  }
  if (!keyring || typeof keyring !== 'object' || Array.isArray(keyring)) throw new Error('action keyring must be an object');
  const entries = Object.entries(keyring);
  if (entries.length > Math.min(1_000, Math.max(1, Math.trunc(maxKeys)))) throw new Error('action keyring exceeds configured key limit');
  for (const [keyId, publicKey] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(keyId) || typeof publicKey !== 'string' || publicKey.length > 16 * 1024) throw new Error('action keyring entry is invalid');
  }
  return keyring;
}

export class EphemeralWorkspaceManager {
  constructor({ root, maxActive = 256, queue = 512 } = {}) {
    if (typeof root !== 'string' || !root) throw new Error('workspace root is required');
    this.root = path.resolve(root);
    this.slots = new Semaphore({ capacity: boundedInteger(maxActive, 256, 1, 10_000), queue: boundedInteger(queue, 512, 0, 100_000) });
    this.active = new Map();
  }

  async acquire(job) {
    let releaseSlot = await this.slots.acquire();
    if (!releaseSlot) throw new Error('workflow workspace capacity exhausted');
    try {
      await mkdir(this.root, { recursive: true });
      const prefix = `source-${String(job?.id || 'job').replace(/[^A-Za-z0-9_-]/g, '_')}-`;
      const workspace = await mkdtemp(path.join(this.root, prefix));
      this.active.set(job?.id || workspace, { workspace, releaseSlot });
      return workspace;
    } catch (error) {
      releaseSlot();
      throw error;
    }
  }

  async release(job) {
    const key = job?.id;
    const entry = this.active.get(key);
    if (!entry) return false;
    this.active.delete(key);
    try { await rm(entry.workspace, { recursive: true, force: true }); }
    finally { entry.releaseSlot(); }
    return true;
  }
}

export class IsolatedActionRunner {
  constructor({ runtime = 'podman', image, workspaceRoot, timeoutMs = 15 * 60_000, maxOutputBytes = 8 * 1024 * 1024, memory = '1g', cpus = 2, pidsLimit = 256, allowNetwork = false, user = '65532:65532', maxActive = 256, queue = 512, actionResolver = null, spawnProcess = spawn } = {}) {
    if (runtime !== 'podman' && runtime !== 'docker') throw new Error('isolated runner runtime must be podman or docker');
    this.runtime = runtime;
    this.image = safeImage(image);
    this.workspaceRoot = workspaceRoot;
    this.timeoutMs = boundedInteger(timeoutMs, 15 * 60_000, 1_000, 24 * 60 * 60_000);
    this.maxOutputBytes = boundedInteger(maxOutputBytes, 8 * 1024 * 1024, 1_024, 128 * 1024 * 1024);
    this.memory = safeImage(memory);
    this.cpus = boundedInteger(cpus, 2, 1, 64);
    this.pidsLimit = boundedInteger(pidsLimit, 256, 16, 10_000);
    this.allowNetwork = allowNetwork === true;
    this.user = safeImage(user);
    this.actionResolver = typeof actionResolver === 'function' ? actionResolver : null;
    this.spawnProcess = typeof spawnProcess === 'function' ? spawnProcess : spawn;
    this.slots = new Semaphore({ capacity: boundedInteger(maxActive, 256, 1, 10_000), queue: boundedInteger(queue, 512, 0, 100_000) });
  }

  async resolveSteps(steps) {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 100) throw new Error('workflow job must contain 1-100 steps');
    const resolved = [];
    for (const step of steps) {
      if (!step?.uses) {
        resolved.push(step);
        continue;
      }
      if (!this.actionResolver) throw new Error(`GitHub action is not configured: ${String(step.uses).slice(0, 500)}`);
      if (typeof step.uses !== 'string' || step.uses.length > 500) throw new Error('GitHub action reference is invalid');
      const actionSteps = await this.actionResolver({
        uses: step.uses,
        with: step.with && typeof step.with === 'object' ? step.with : {},
        step,
      });
      if (!Array.isArray(actionSteps) || actionSteps.length < 1 || actionSteps.length > 20) throw new Error('resolved GitHub action must contain 1-20 run steps');
      for (const actionStep of actionSteps) {
        if (!actionStep || actionStep.uses || typeof actionStep.run !== 'string' || !actionStep.run.trim()) throw new Error('resolved GitHub action may only contain non-empty run steps');
        if (actionStep.run.length > 16 * 1024) throw new Error('resolved GitHub action run step is too large');
        resolved.push(actionStep);
      }
      if (resolved.length > 100) throw new Error('resolved workflow job contains too many steps');
    }
    return resolved;
  }

  buildArgs({ steps, envKeys = [], containerName = null }, workspace) {
    const workspacePath = safeWorkspace(this.workspaceRoot, workspace);
    const args = ['run', '--rm', '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--pids-limit=${this.pidsLimit}`, `--memory=${this.memory}`, `--cpus=${this.cpus}`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--user', this.user];
    if (containerName) args.push('--name', containerName);
    if (!this.allowNetwork) args.push('--network=none');
    args.push('--env', 'CI=true', '--env', 'GITHUB_ACTIONS=true', '--env', 'GITHUB_WORKSPACE=/workspace');
    for (const key of envKeys) args.push('--env', key);
    args.push('-v', `${workspacePath}:/workspace:rw`, '-w', '/workspace', this.image, '/bin/sh', '-lc', workflowScript(steps));
    return args;
  }

  async run({ steps }, { workspace, env = {} } = {}) {
    const resolvedSteps = await this.resolveSteps(steps);
    const safeEnv = safeEnvironment(env);
    let releaseSlot = await this.slots.acquire();
    if (!releaseSlot) throw new Error('isolated runner capacity exhausted');
    const containerName = `source-action-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
    let child;
    try {
      const args = this.buildArgs({ steps: resolvedSteps, envKeys: Object.keys(safeEnv), containerName }, workspace);
      child = this.spawnProcess(this.runtime, args, {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          ...safeEnv,
        },
      });
    } catch (error) {
      releaseSlot();
      throw error;
    }
    return new Promise((resolve, reject) => {
      let outputBytes = 0;
      const stdout = [];
      const stderr = [];
      let settled = false;
      const release = () => {
        if (releaseSlot) {
          releaseSlot();
          releaseSlot = null;
        }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        killRuntimeProcess(child);
        settled = true;
        void removeRuntimeContainer(this.runtime, containerName).finally(() => {
          release();
          reject(new Error('isolated workflow timed out'));
        });
      }, this.timeoutMs);
      timer.unref?.();
      const collect = (target, chunk) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > this.maxOutputBytes && !settled) {
          settled = true;
          killRuntimeProcess(child);
          clearTimeout(timer);
          void removeRuntimeContainer(this.runtime, containerName).finally(() => {
            release();
            reject(new Error('isolated workflow output exceeded configured limit'));
          });
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', (chunk) => collect(stdout, chunk));
      child.stderr.on('data', (chunk) => collect(stderr, chunk));
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        release();
        reject(error);
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        release();
        resolve({ ok: code === 0, code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      });
    });
  }
}

export function createGitHubActionsHandler({ runner, workspaceForJob, workspaceManager = null, secretProvider = async () => ({}), secretBroker = null } = {}) {
  if (!runner || typeof runner.run !== 'function') throw new Error('runner is required');
  if (!workspaceManager && typeof workspaceForJob !== 'function') throw new Error('workspaceForJob is required');
  if (secretBroker && typeof secretBroker.get !== 'function') throw new Error('secret broker must expose get(payload, job)');
  return async (payload, job) => {
    const parameters = payload?.parameters;
    if (!parameters) throw new Error('workflow job parameters are missing');
    const workspace = workspaceManager
      ? await workspaceManager.acquire(job)
      : await workspaceForJob(payload, job);
    let leaseId = null;
    try {
      const leased = secretBroker?.issue ? await secretBroker.issue(payload, job) : null;
      leaseId = leased?.leaseId || null;
      const env = safeEnvironment(leased ? leased.env : await (secretBroker ? secretBroker.get(payload, job) : secretProvider(payload, job)));
      const result = await runner.run({ steps: parameters.steps }, { workspace, env });
      return redactSecretOutput(result, env);
    } finally {
      try {
        if (leaseId && secretBroker?.revokeLease) await secretBroker.revoke(leaseId);
      } finally {
        if (workspaceManager) await workspaceManager.release(job);
      }
    }
  };
}
