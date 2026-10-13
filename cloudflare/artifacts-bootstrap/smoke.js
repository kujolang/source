// Live proof: Worker -> Artifacts -> Git push -> independent clone -> same commit.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const url = new URL(process.env.SOURCE_BOOTSTRAP_URL || 'http://localhost:8787');
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS or loopback HTTP');
const secret = process.env.SOURCE_BOOTSTRAP_SECRET;
if (!secret || secret.length < 32) throw new Error('SOURCE_BOOTSTRAP_SECRET must contain at least 32 characters');
const name = `source-smoke-${randomUUID()}`;
const response = await fetch(new URL('/repos', url), {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name })
});
if (response.status !== 201) throw new Error(`Repository creation returned HTTP ${response.status}; inspect upstream state before retrying`);
const created = await response.json();
const remote = new URL(created.remote);
if (remote.protocol !== 'https:' || !remote.hostname.endsWith('.artifacts.cloudflare.net') || remote.username || remote.password || remote.search) throw new Error('Unexpected Artifacts remote');
if (typeof created.token !== 'string' || !created.token.startsWith('art_v1_')) throw new Error('Missing Artifacts credential');
const root = mkdtempSync(path.join(tmpdir(), 'source-artifacts-'));
const writer = path.join(root, 'writer'), clone = path.join(root, 'clone');
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${created.token}` };
for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE' || key === 'SOURCE_BOOTSTRAP_SECRET') delete gitEnv[key];
const git = (args, cwd) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, env: gitEnv, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe']
}).trim();
try {
  mkdirSync(writer);
  git(['init', '-b', 'main'], writer);
  git(['config', 'user.name', 'Source integration smoke'], writer);
  git(['config', 'user.email', 'source-smoke@example.invalid'], writer);
  const content = '# Source Cloudflare integration\n\nWorker-created Artifacts repository; verified with a Git push and independent clone.\n';
  writeFileSync(path.join(writer, 'README.md'), content);
  git(['add', 'README.md'], writer);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Verify Source Artifacts bootstrap'], writer);
  git(['push', remote.href, 'HEAD:refs/heads/main'], writer);
  git(['clone', '--branch', 'main', remote.href, clone], root);
  const head = git(['rev-parse', 'HEAD'], writer);
  if (head !== git(['rev-parse', 'HEAD'], clone) || readFileSync(path.join(clone, 'README.md'), 'utf8') !== content) throw new Error('Clone verification failed');
  console.log(JSON.stringify({ ok: true, repository: name, remote: remote.href, commit: head, verified: ['worker-create', 'git-push', 'git-clone', 'commit-and-content-match'] }, null, 2));
} catch {
  // Git errors may contain credentials. Report only the repository identifier.
  throw new Error(`Git verification failed for ${name}; remote repository retained for inspection`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
// Retain the remote fixture for review. Credentials exist only in process memory.
