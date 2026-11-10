// Host-owned OCI ownership journals. Recovery never uses age or job ID as
// authority to delete a container or workspace, and never reaps a live owner.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { open, mkdir, readdir, readFile, realpath, lstat, readlink, link, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const namePattern = /^source-action-[0-9]+-[0-9]+-[a-f0-9]{12}$/;
const filePattern = /^\.(source-action-[0-9]+-[0-9]+-[a-f0-9]{12})\.attempt\.json$/;
const lockName = '.source-recovery.lock';
const localNamespace = process.platform === 'linux'
  ? readlink('/proc/self/ns/pid').catch(() => 'unknown')
  : Promise.resolve(process.platform === 'darwin' ? 'darwin-host' : 'unknown');
export const workspaceIdentity = (workspace) => createHash('sha256').update(workspace).digest('hex');

export function runtimeCommand(runtime, args) {
  return new Promise((resolve) => {
    execFile(runtime, args, { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 262144,
      env: { PATH: process.env.PATH || '/usr/bin:/bin' } }, (error, stdout) => resolve(error ? null : stdout));
  });
}

export async function removeRuntimeContainer(runtime, target, run = runtimeCommand) {
  const byId = /^[a-f0-9]{64}$/.test(target);
  if (!['docker', 'podman'].includes(runtime) || (!byId && !namePattern.test(target))) throw new Error('invalid runtime cleanup identity');
  if (await run(runtime, ['rm', '--force', target]) !== null) return true;
  const args = ['ps', '--all', '--no-trunc', '--filter', `${byId ? 'id' : 'name'}=${target}`, '--format', byId ? '{{.ID}}' : '{{.Names}}'];
  const listed = await run(runtime, args);
  return listed !== null && !listed.trim().split('\n').includes(target);
}

function within(root, workspace) {
  const relative = path.relative(root, workspace);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function durableWrite(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}

export async function prepareExecutionAttempt({ workspaceRoot, workspace, runtime, image, containerName, jobId = null }) {
  const root = await realpath(workspaceRoot);
  workspace = await realpath(workspace);
  if (!within(root, workspace) || !(await lstat(workspace)).isDirectory() || !namePattern.test(containerName)) throw new Error('invalid managed execution workspace');
  const record = { version: 1, state: 'prepared', containerName, runtime, image, workspace,
    ownerPid: process.pid, ownerHost: hostname(), ownerNamespace: await localNamespace, jobId, createdAt: new Date().toISOString() };
  const recordPath = path.join(root, `.${containerName}.attempt.json`);
  const temp = `${recordPath}.${randomBytes(6).toString('hex')}.tmp`;
  try { await durableWrite(temp, record); await link(temp, recordPath); }
  finally { await rm(temp, { force: true }); }
  return { recordPath, record };
}

export async function updateExecutionAttempt(attempt, state) {
  const next = { ...attempt.record, state };
  const temp = `${attempt.recordPath}.${randomBytes(6).toString('hex')}.tmp`;
  try { await durableWrite(temp, next); await rename(temp, attempt.recordPath); attempt.record = next; }
  finally { await rm(temp, { force: true }); }
}

async function loadAttempt(root, file) {
  const match = file.match(filePattern);
  const recordPath = path.join(root, file);
  const metadata = await lstat(recordPath);
  if (!match || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16384) throw new Error('invalid attempt file');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.version !== 1 || !['prepared', 'container-removed'].includes(record.state) || record.containerName !== match[1]
      || !['docker', 'podman'].includes(record.runtime) || typeof record.image !== 'string' || !record.image
      || !Number.isSafeInteger(record.ownerPid) || record.ownerPid < 1 || record.ownerPid > 2147483647 || typeof record.ownerHost !== 'string'
      || typeof record.ownerNamespace !== 'string' || typeof record.workspace !== 'string' || !path.isAbsolute(record.workspace) || !within(root, record.workspace)) throw new Error('invalid attempt ownership');
  return { recordPath, record };
}

async function ownerState(record) {
  if (record.ownerHost !== hostname()) return 'foreign-host';
  const namespace = await localNamespace;
  if (namespace === 'unknown') return 'owner-unknown';
  if (record.ownerNamespace !== namespace) return 'foreign-namespace';
  try { process.kill(record.ownerPid, 0); return 'active'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'owner-unknown'; }
}

export async function assertExecutionAdmission(workspaceRoot) {
  let root; let files;
  try { root = await realpath(workspaceRoot); files = await readdir(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (files.includes(lockName)) throw new Error('execution recovery in progress');
  const records = files.filter(file => filePattern.test(file));
  if (records.length > 1000) throw new Error('execution attempt journal limit exceeded');
  for (const file of records) {
    let attempt;
    try { attempt = await loadAttempt(root, file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error('execution attempt recovery required'); }
    if (await ownerState(attempt.record) !== 'active') throw new Error('execution attempt recovery required');
  }
}

export async function acknowledgeExecutionCleanup(recordPath) {
  if (!recordPath) return;
  const root = await realpath(path.dirname(recordPath));
  let attempt;
  try { attempt = await loadAttempt(root, path.basename(recordPath)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (attempt.record.state !== 'container-removed') throw new Error('cannot acknowledge unconfirmed execution cleanup');
  try { await lstat(attempt.record.workspace); throw new Error('workspace must be removed before cleanup acknowledgment'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(recordPath, { force: true });
}

export async function recoverExecutionAttempts({ workspaceRoot, runCommand = runtimeCommand } = {}) {
  const started = Date.now();
  const root = await realpath(workspaceRoot);
  const lock = path.join(root, lockName);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('execution recovery lock already exists; another reaper or operator review required'); throw error; }
  const results = [];
  try {
    const files = (await readdir(root)).filter(file => filePattern.test(file)).sort();
    if (files.length > 1000) throw new Error('execution recovery journal limit exceeded');
    for (const file of files) {
      let attempt;
      try { attempt = await loadAttempt(root, file); }
      catch (error) { if (error.code !== 'ENOENT') results.push({ file, state: 'invalid-record' }); continue; }
      const record = attempt.record;
      const row = { containerName: record.containerName, jobId: record.jobId, ownerPid: record.ownerPid };
      const owner = await ownerState(record);
      if (owner !== 'dead') { results.push({ ...row, state: owner }); continue; }
      try {
        const raw = await runCommand(record.runtime, ['inspect', record.containerName]);
        if (raw !== null) {
          const [container] = JSON.parse(raw);
          const binds = container?.HostConfig?.Binds;
          if (!/^[a-f0-9]{64}$/.test(container?.Id) || container.Name !== `/${record.containerName}`
              || container.Config?.Image !== record.image || container.Config?.Labels?.['io.source.attempt'] !== record.containerName
              || container.Config?.Labels?.['io.source.workspace'] !== workspaceIdentity(record.workspace)
              || !Array.isArray(binds) || binds.length !== 1 || binds[0] !== `${record.workspace}:/workspace:rw`) {
            results.push({ ...row, state: 'ownership-mismatch' }); continue;
          }
          if (!await removeRuntimeContainer(record.runtime, container.Id, runCommand)) { results.push({ ...row, state: 'cleanup-unconfirmed' }); continue; }
          await updateExecutionAttempt(attempt, 'container-removed');
        } else {
          const listed = await runCommand(record.runtime, ['ps', '--all', '--filter', `name=${record.containerName}`, '--format', '{{.Names}}']);
          if (listed === null || listed.trim()) { results.push({ ...row, state: 'runtime-unconfirmed' }); continue; }
          // No resource may mean the dead worker's create request is still in
          // flight. Only a durable completed-removal phase resolves that ambiguity.
          if (record.state !== 'container-removed') { results.push({ ...row, state: 'absent-unconfirmed' }); continue; }
        }
        try {
          const metadata = await lstat(record.workspace);
          if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(record.workspace) !== record.workspace) throw new Error('workspace ownership changed');
          await rm(record.workspace, { recursive: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await acknowledgeExecutionCleanup(attempt.recordPath);
        await rm(path.join(root, `.${record.containerName}.cleanup.json`), { force: true });
        results.push({ ...row, state: 'recovered' });
      } catch { results.push({ ...row, state: 'recovery-unconfirmed' }); }
    }
    const remaining = await readdir(root);
    for (const file of remaining) {
      const match = file.match(/^\.(source-action-[0-9]+-[0-9]+-[a-f0-9]{12})\.cleanup\.json$/);
      if (match && !remaining.includes(`.${match[1]}.attempt.json`)) results.push({ file, state: 'legacy-cleanup-record' });
    }
    return { version: 1, results, durationMs: Date.now() - started };
  } finally { await rm(lock, { recursive: true }); }
}
