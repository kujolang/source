// Operator-side Artifacts transport. Credentials never enter Source records.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
const exec = promisify(execFile);
const marker = 'source-artifacts.json';
const namePattern = /^source-(?:smoke|hybrid)-[a-z0-9-]{1,48}$/;
const oidPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const hook = `#!/bin/sh
# Source Artifacts canonical branch: promote through the accepted-change API.
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    echo 'Source: canonical branch requires accepted-change promotion' >&2
    exit 1
  fi
done
`;

// Artifacts credentials are opaque; validate header safety, not a provider prefix.
export function isArtifactsToken(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
}

function remoteUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.artifacts\.cloudflare\.net$/.test(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash
      || !new RegExp(`^/git/[a-zA-Z0-9_-]+/${name}\\.git$`).test(url.pathname)) throw new Error('invalid Artifacts remote');
  return url.href;
}

export function artifactsBinding(git) {
  let raw;
  try { raw = readFileSync(path.join(git.barePath, marker), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Artifacts binding unreadable'); }
  try {
    const value = JSON.parse(raw);
    if (value.provider !== 'cloudflare-artifacts' || !namePattern.test(value.name) || value.branch !== 'main') throw new Error();
    return { provider: value.provider, name: value.name, remote: remoteUrl(value.remote, value.name), branch: value.branch };
  } catch { throw new Error('Artifacts binding invalid; refusing local fallback'); }
}

export function checkArtifactsProtection(git, expected) {
  const binding = artifactsBinding(git);
  if (expected && (!binding || ['name', 'remote', 'branch', 'provider'].some((key) => binding[key] !== expected[key]))) throw new Error('Artifacts binding missing or inconsistent; operator recovery required');
  if (binding) {
    const hookPath = path.join(git.barePath, 'hooks', 'pre-receive');
    if (!existsSync(hookPath) || readFileSync(hookPath, 'utf8') !== hook || !(statSync(hookPath).mode & 0o111)) throw new Error('Artifacts canonical guard missing; repeat operator binding');
  }
  return binding;
}

// An allowlisted environment prevents inherited trace/config/askpass hooks from
// logging or redirecting credentials. Git sees the header in its environment,
// never argv or persisted config. Host operators remain trusted.
export async function artifactsGit(args, { cwd, token } = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: token ? `Authorization: Bearer ${token}` : '',
  });
  try {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
      '-c', 'http.followRedirects=false', ...args], { cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch { throw new Error('Artifacts Git operation failed or timed out; retry accepted promotion to reconcile'); }
}

export class ArtifactsBridge {
  constructor({ url, secret, fetchImpl = fetch, runGit = artifactsGit }) {
    const worker = new URL(url);
    if ((worker.protocol !== 'https:' && !(worker.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(worker.hostname)))
        || worker.username || worker.password || worker.search || worker.hash || worker.pathname !== '/') throw new Error('invalid Artifacts Worker URL');
    if (typeof secret !== 'string' || secret.length < 32 || /[\r\n]/.test(secret)) throw new Error('Artifacts Worker secret must contain at least 32 characters');
    this.url = worker; this.secret = secret; this.fetch = fetchImpl; this.runGit = runGit;
  }

  async request(route, body) {
    try {
      const response = await this.fetch(new URL(route, this.url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error();
      // The Worker is operator-trusted, but bound its response before parsing.
      const reader = response.body.getReader(); let text = ''; let size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 16384) { await reader.cancel(); throw new Error(); }
          text += decoder.decode(value, { stream: true });
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(text + decoder.decode());
    } catch { throw new Error('Artifacts Worker request failed; inspect remote state before retrying creation'); }
  }

  async credentials(name, expectedRemote) {
    if (!namePattern.test(name)) throw new Error('invalid Artifacts repository name');
    const value = await this.request(`/repos/${name}/token`, {});
    const remote = remoteUrl(value.remote, name);
    if (value.name !== name || (expectedRemote && expectedRemote !== remote)
        || !isArtifactsToken(value.token)) throw new Error('unexpected Artifacts credential response');
    return { remote, token: value.token };
  }

  async tip(git, credentials) {
    const output = await this.runGit(['ls-remote', '--heads', credentials.remote, 'refs/heads/main'], { cwd: git.barePath, token: credentials.token });
    if (!output) return '';
    const [oid, ref, ...extra] = output.split(/\s+/);
    if (!oidPattern.test(oid) || ref !== 'refs/heads/main' || extra.length) throw new Error('invalid remote ref response');
    return oid;
  }

  // Run with the Source server stopped. Binding is operator-only and immutable;
  // repeat the same bind after an interruption, never silently rebind a repo.
  async bind(git, name, { createRemote = false, expectedBinding = null } = {}) {
    if (!namePattern.test(name)) throw new Error('invalid Artifacts repository name');
    if (await git.defaultBranchAsync() !== 'main') throw new Error('hybrid binding currently requires main');
    const existing = artifactsBinding(git);
    if (expectedBinding && (expectedBinding.name !== name || createRemote || (existing && expectedBinding.remote !== existing.remote))) throw new Error('repository binding conflicts with stored metadata');
    if (existing && (existing.name !== name || createRemote)) throw new Error('repository already bound');
    const hooksPath = await this.runGit(['config', '--local', '--get', 'core.hooksPath'], { cwd: git.barePath }).catch(() => '');
    if (hooksPath) throw new Error('custom hooksPath is not supported for hybrid binding');
    const hookPath = path.join(git.barePath, 'hooks', 'pre-receive');
    if (existsSync(hookPath) && readFileSync(hookPath, 'utf8') !== hook) throw new Error('existing pre-receive hook requires manual integration');
    const local = await git.revParseAsync('refs/heads/main');
    if (createRemote) {
      if (local) throw new Error('create-remote binding requires an empty local canonical branch');
      await this.request('/repos', { name }); // Do not persist the initial token.
    }
    const credentials = await this.credentials(name, existing?.remote || expectedBinding?.remote);
    const tip = await this.tip(git, credentials);
    if (local && local !== tip) throw new Error('local and remote canonical tips differ; inspect before binding');
    // Fail closed on interruption: the marker prevents local-only promotion.
    const binding = { provider: 'cloudflare-artifacts', name, remote: credentials.remote, branch: 'main' };
    if (!existing) writeFileSync(path.join(git.barePath, marker), JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(hookPath, hook, { mode: 0o755 });
    chmodSync(hookPath, 0o755);
    if (tip && !local) {
      await this.runGit(['fetch', '--no-tags', credentials.remote, 'refs/heads/main'], { cwd: git.barePath, token: credentials.token });
      const result = await git.fastForwardAsync('', tip, 'main');
      if (!result.ok) throw new Error('local canonical cache changed during binding; repeat bind after inspection');
    }
    return binding;
  }

  async promote(git, binding, base, head) {
    try {
      if (!oidPattern.test(head) || (base && !oidPattern.test(base))) throw new Error();
      if (await git.defaultBranchAsync() !== binding.branch) throw new Error();
      const credentials = await this.credentials(binding.name, binding.remote);
      const remoteTip = await this.tip(git, credentials);
      if (remoteTip && !(await git.hasCommitAsync(remoteTip))) {
        await this.runGit(['fetch', '--no-tags', credentials.remote, 'refs/heads/main'], { cwd: git.barePath, token: credentials.token });
      }
      if (remoteTip !== head) {
        if (remoteTip && (!(await git.isAncestorAsync(base, remoteTip)) || !(await git.isAncestorAsync(remoteTip, head)))) {
          return { ok: false, reason: 'remote canonical tip requires rebase' };
        }
        await this.runGit(['push', `--force-with-lease=refs/heads/main:${remoteTip}`, credentials.remote, `${head}:refs/heads/main`], { cwd: git.barePath, token: credentials.token });
      }
      if (await this.tip(git, credentials) !== head) return { ok: false, reason: 'remote changed before confirmation; inspect and retry' };
      const local = await git.fastForwardAsync(base, head, 'main');
      return local.ok ? { ok: true, reason: remoteTip === head ? 'remote confirmed and local cache reconciled' : 'Artifacts promoted and local cache updated', remoteCommit: head }
        : { ok: false, reason: 'remote confirmed but local cache diverged; inspect before retrying', remoteCommit: head };
    } catch {
      return { ok: false, reason: 'Artifacts promotion unconfirmed; retry accepted change to reconcile' };
    }
  }
}

export function artifactsFromEnv() {
  if (!process.env.SOURCE_ARTIFACTS_WORKER_URL) return null;
  return new ArtifactsBridge({ url: process.env.SOURCE_ARTIFACTS_WORKER_URL, secret: process.env.SOURCE_BOOTSTRAP_SECRET });
}
