#!/usr/bin/env node

// Bounded, resumable Git object/ref replication between two Source Git roots.
// Git remains the replication protocol and each repository can be retried
// independently after a peer outage.

import { access, mkdir, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

async function findGitRepos(root) {
  const repos = [];
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name.endsWith('.git')) repos.push(full);
      else await visit(full);
    }
  }
  await visit(path.resolve(root));
  return repos.sort();
}

function relativeRepoPath(root, repo) {
  const relative = path.relative(path.resolve(root), path.resolve(repo));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('repository is outside source root');
  return relative;
}

async function ensureMirror(destination, source, timeoutMs) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await access(path.join(destination, 'HEAD'), fsConstants.R_OK);
  } catch {
    await execFileAsync('git', ['init', '--bare', destination], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  }
  const remotes = await execFileAsync('git', ['--git-dir', destination, 'remote'], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  if (!String(remotes.stdout).split('\n').includes('source')) {
    await execFileAsync('git', ['--git-dir', destination, 'remote', 'add', '--mirror=fetch', 'source', source], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  } else {
    await execFileAsync('git', ['--git-dir', destination, 'remote', 'set-url', 'source', source], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  }
  await execFileAsync('git', ['--git-dir', destination, 'fetch', '--prune', 'source'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  await execFileAsync('git', ['--git-dir', destination, 'fsck', '--full', '--no-reflogs'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !flag(args, '--source-root') || !flag(args, '--target-root')) {
    process.stdout.write('Usage: node scripts/replicate-git.js --source-root <git-root> --target-root <git-root> [--concurrency N] [--timeout-ms N]\n');
    return;
  }
  const sourceRoot = path.resolve(flag(args, '--source-root'));
  const targetRoot = path.resolve(flag(args, '--target-root'));
  if (sourceRoot === targetRoot || targetRoot.startsWith(`${sourceRoot}${path.sep}`) || sourceRoot.startsWith(`${targetRoot}${path.sep}`)) {
    throw new Error('source and target Git roots must be distinct and non-nested');
  }
  const concurrency = bounded(flag(args, '--concurrency'), 4, 1, 64);
  const timeoutMs = bounded(flag(args, '--timeout-ms'), 10 * 60_000, 1_000, 60 * 60_000);
  await access(sourceRoot, fsConstants.R_OK);
  await mkdir(targetRoot, { recursive: true });
  const repositories = await findGitRepos(sourceRoot);
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < repositories.length) {
      const index = cursor++;
      const source = repositories[index];
      const relative = relativeRepoPath(sourceRoot, source);
      const destination = path.join(targetRoot, relative);
      await ensureMirror(destination, source, timeoutMs);
      results[index] = { repository: relative, status: 'replicated' };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, repositories.length)) }, worker));
  process.stdout.write(`${JSON.stringify({ status: 'replicated', sourceRoot, targetRoot, repositories: results, concurrency }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
