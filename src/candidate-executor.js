// Export Git objects without checkout filters, hooks, archive attributes, local
// credentials, or a .git directory. Repository commands run only in the runner.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, chmod, realpath, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { digest } from './integration-planner.js';
import { EphemeralWorkspaceManager, IsolatedActionRunner } from './action-runner.js';

const exec = promisify(execFile);
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function git(repository, args, { maxBuffer = 8 * 1024 * 1024, input, signal } = {}) {
  signal?.throwIfAborted();
  const pending = exec('git', ['-c', 'core.hooksPath=/dev/null', '--git-dir', repository, ...args], {
    encoding: 'buffer', maxBuffer, timeout: 30000, signal,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (input != null) pending.child.stdin.end(input);
  return (await pending).stdout;
}

export async function exportCandidate({ repository, candidate, workspace, signal, maxFiles = 10000, maxBytes = 256 * 1024 * 1024 }) {
  if (!path.isAbsolute(workspace) || !(await lstat(workspace)).isDirectory() || (await readdir(workspace)).length) throw new Error('candidate export requires an empty directory workspace');
  workspace = await realpath(workspace);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) throw new Error('invalid candidate export limits');
  const { id, ...body } = candidate || {};
  if (digest(body) !== id || !oid.test(candidate.headCommit) || !oid.test(candidate.tree)) throw new Error('invalid candidate snapshot');
  const tree = (await git(repository, ['rev-parse', `${candidate.headCommit}^{tree}`], { signal })).toString().trim();
  if (tree !== candidate.tree) throw new Error('candidate commit/tree mismatch');
  const listing = await git(repository, ['ls-tree', '-rlz', '--full-tree', candidate.tree], { signal });
  const text = listing.toString('utf8');
  if (!Buffer.from(text).equals(listing)) throw new Error('non-UTF-8 candidate paths are unsupported');
  const records = text.split('\0').filter(Boolean);
  if (records.length > maxFiles) throw new Error('candidate file count exceeds export limit');
  const seen = new Set(); const paths = new Map(); let bytes = 0;
  const files = records.map((record) => {
    const match = record.match(/^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?) +([0-9]+)\t([\s\S]+)$/);
    if (!match) throw new Error('candidate export supports regular files only; symlinks and submodules require a separate policy');
    const [, mode, object, size, name] = match;
    const parts = name.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || /[\\:\x00-\x1f\x7f]/.test(name)) throw new Error('unsafe candidate path');
    // Reject aliases on case-insensitive and Unicode-normalizing filesystems.
    const key = name.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('candidate path collision');
    for (let i = 1; i <= parts.length; i++) {
      const original = parts.slice(0, i).join('/'); const normalized = original.normalize('NFC').toLowerCase();
      if (paths.has(normalized) && paths.get(normalized) !== original) throw new Error('candidate path collision');
      paths.set(normalized, original);
    }
    seen.add(key); bytes += Number(size);
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new Error('candidate bytes exceed export limit');
    return { mode, object, size: Number(size), name };
  });
  // Detect file/directory aliases before touching the workspace.
  for (const file of files) {
    const parts = file.name.normalize('NFC').toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) throw new Error('candidate file/directory collision');
  }
  if (files.length) {
    const objects = await git(repository, ['cat-file', '--batch'], {
      input: files.map((file) => file.object).join('\n') + '\n', signal,
      maxBuffer: bytes + files.length * 128 + 1024,
    });
    let offset = 0;
    for (const file of files) {
      signal?.throwIfAborted();
      const newline = objects.indexOf(10, offset);
      if (newline < 0 || objects.subarray(offset, newline).toString() !== `${file.object} blob ${file.size}`) throw new Error('candidate blob header mismatch');
      offset = newline + 1;
      const content = objects.subarray(offset, offset + file.size);
      if (content.length !== file.size || objects[offset + file.size] !== 10) throw new Error('candidate blob length mismatch');
      const actual = createHash(file.object.length === 40 ? 'sha1' : 'sha256').update(`blob ${file.size}\0`).update(content).digest('hex');
      if (actual !== file.object) throw new Error('candidate blob content integrity mismatch');
      offset += file.size + 1;
      const destination = path.join(workspace, file.name);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, content, { flag: 'wx', mode: file.mode === '100755' ? 0o700 : 0o600 });
      await chmod(destination, file.mode === '100755' ? 0o700 : 0o600);
    }
    if (offset !== objects.length) throw new Error('candidate blob stream has trailing data');
  }
  await chmod(workspace, 0o700);
  return { files: files.length, bytes, commit: candidate.headCommit, tree };
}

export class CandidateContainerExecutor {
  constructor({ workspaceRoot, image, toolVersions, runtime = 'podman', timeoutMs = 900000, maxOutputBytes = 8 * 1024 * 1024, memory = '1g', cpus = 2, pidsLimit = 256, maxActive = 8, queue = 64, spawnProcess } = {}) {
    if (typeof image !== 'string' || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('candidate executor requires a digest-pinned image');
    if (!toolVersions || typeof toolVersions !== 'object' || Array.isArray(toolVersions) || !Object.keys(toolVersions).length || !Object.values(toolVersions).every((value) => typeof value === 'string' && value.length > 0)) throw new Error('candidate executor requires pinned tool versions');
    const uid = process.getuid?.(); const gid = process.getgid?.();
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) throw new Error('candidate executor requires a non-root POSIX worker');
    this.workspaces = new EphemeralWorkspaceManager({ root: workspaceRoot, maxActive, queue });
    this.runner = new IsolatedActionRunner({ runtime, image, workspaceRoot: this.workspaces.root, timeoutMs, maxOutputBytes, memory, cpus, pidsLimit, maxActive, queue, user: `${uid}:${gid}`, allowNetwork: false, spawnProcess });
    this.profile = { version: 1, runtime, image, toolVersions: structuredClone(toolVersions), timeoutMs: this.runner.timeoutMs, maxOutputBytes: this.runner.maxOutputBytes, memory: this.runner.memory, cpus: this.runner.cpus, pidsLimit: this.runner.pidsLimit, user: this.runner.user, network: 'none', export: 'git-blobs-regular-files-v1', cleanup: 'confirmed-removal-v1' };
    this.environment = `source-oci-v1:${digest(this.profile)}`;
  }

  async execute({ candidate, check, repository, identity, job, signal }) {
    signal?.throwIfAborted();
    if (check.environment !== this.environment || digest(check.toolVersions) !== digest(this.profile.toolVersions)) throw new Error('verification environment differs from configured executor');
    if (Object.keys(check.externalState || {}).length || Object.keys(check.inputs || {}).length) throw new Error('container executor requires self-contained candidate inputs and no external state');
    if (!Array.isArray(check.command) || !check.command.length || !check.command.every((arg) => typeof arg === 'string' && !arg.includes('\0')) || !check.command[0] || check.command[0].startsWith('-')) throw new Error('invalid candidate command arguments');
    const command = check.command.map(quote).join(' ');
    const startedAt = Date.now();
    const workspace = await this.workspaces.acquire(job);
    let result; let exported; let cleanupConfirmed = true;
    try {
      exported = await exportCandidate({ repository, candidate, workspace, signal });
      signal?.throwIfAborted();
      result = await this.runner.run({ steps: [{ run: command }] }, { workspace, signal });
    } catch (error) {
      cleanupConfirmed = error.cleanup?.confirmed !== false;
      throw error;
    } finally {
      if (cleanupConfirmed) await this.workspaces.release(job);
      else this.workspaces.preserve(job);
    }
    const finishedAt = Date.now();
    return { output: result.stdout || result.stderr || '(no output)', execution: {
      identity, commit: candidate.headCommit, tree: candidate.tree, command: check.command,
      environment: this.environment, inputs: check.inputs, externalState: check.externalState, toolVersions: this.profile.toolVersions,
      status: result.ok ? 'pass' : 'fail', startedAt, finishedAt, durationMs: finishedAt - startedAt,
      stderr: result.stderr, exitCode: result.code, runtimeSignal: result.signal, export: exported, cleanupConfirmed: result.cleanupConfirmed === true, workspaceRemoved: true,
    } };
  }
}
