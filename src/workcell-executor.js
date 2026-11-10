// Operator-configured Workcell bridge. Workcell owns provisioning, execution,
// integrity manifests and provider recovery; Source owns candidate/policy binding.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { digest } from './integration-planner.js';
import { exportCandidate } from './candidate-executor.js';
import { normalizeControlArtifact } from './integrations/control-tools.js';
import { Semaphore } from './concurrency.js';

const exec = promisify(execFile);
const cleanEnv = () => ({ PATH: process.env.PATH || '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' });

async function invoke(binary, args, options) {
  try { return { ...(await exec(binary, args, options)), code: 0 }; }
  catch (error) {
    if (!Number.isInteger(error.code) || error.killed || error.signal) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function boundedFile(root, file, maxBytes) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workcell evidence path escapes attempt');
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes || await realpath(absolute) !== absolute) throw new Error('Workcell evidence is unsafe or exceeds limit');
  return readFile(absolute, 'utf8');
}

export class WorkcellExecutor {
  constructor({ root, executable, kujo, workcellRevision, definition, profiles, profile, manifest = null, toolVersions, maxActive = 4, queue = 32, invokeProcess = invoke } = {}) {
    if (![root, executable, kujo].every((value) => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Workcell requires absolute root, executable and Kujo paths');
    if (!/^[a-f0-9]{40}$/.test(workcellRevision || '') || !toolVersions || !Object.keys(toolVersions).length || !Object.values(toolVersions).every((value) => typeof value === 'string' && value)) throw new Error('Workcell requires pinned revision and tool versions');
    if (definition?.schema !== 'workcell-definition/v2alpha1' || !profiles?.profiles?.[profile]) throw new Error('Workcell requires portable definition and explicit host profile');
    if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(definition.workload?.image?.reference || '')) throw new Error('Workcell image must be digest-pinned');
    if (definition.requirements?.network?.mode !== 'none' || definition.secrets?.length || definition.environment?.allow?.length) throw new Error('Source Workcell bridge requires offline execution without ambient environment or secrets');
    const duration = definition.requirements?.execution?.timeout_ms;
    const output = definition.requirements?.execution?.max_output_bytes;
    if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 900000 || !Number.isSafeInteger(output) || output < 1 || output > 1024 * 1024) throw new Error('Workcell execution limits must be bounded');
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 64 || !Number.isSafeInteger(queue) || queue < 0 || queue > 1000) throw new Error('invalid Workcell concurrency limits');
    if (!Number.isInteger(process.getuid?.()) || process.getuid() === 0) throw new Error('Workcell executor requires a non-root POSIX worker');
    this.root = path.resolve(root); this.executable = executable; this.kujo = kujo;
    this.config = structuredClone({ workcellRevision, definition, profiles, profile, manifest, toolVersions });
    this.environment = `source-workcell-v1:${digest(this.config)}`;
    this.timeoutMs = duration + 120000;
    this.slots = new Semaphore({ capacity: maxActive, queue });
    this.invokeProcess = invokeProcess;
  }

  async execute({ candidate, check, repository, identity, job, signal }) {
    signal?.throwIfAborted();
    if (digest(this.config) !== this.environment.slice('source-workcell-v1:'.length)) throw new Error('Workcell executor configuration changed');
    if (check.environment !== this.environment || digest(check.toolVersions) !== digest(this.config.toolVersions)) throw new Error('verification environment differs from configured Workcell executor');
    if (Object.keys(check.inputs || {}).length || Object.keys(check.externalState || {}).length) throw new Error('Workcell bridge requires self-contained candidate inputs');
    if (!Array.isArray(check.command) || !check.command.length || !check.command.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) throw new Error('invalid Workcell command');
    if (typeof job?.id !== 'string' || !job.id || typeof job?.leaseToken !== 'string' || !job.leaseToken) throw new Error('Workcell requires a leased job attempt');
    const release = await this.slots.acquire();
    if (!release) throw new Error('Workcell executor capacity exhausted');
    let attempt; let clean = false; let removeSource = false; let cancelError; let cancellation = Promise.resolve();
    const onAbort = () => { cancellation = writeFile(path.join(attempt, 'cancel'), 'cancel\n', { mode: 0o600 }).catch((error) => { cancelError = error; }); };
    const startedAt = Date.now();
    try {
      signal?.throwIfAborted();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const root = await realpath(this.root);
      attempt = await mkdtemp(path.join(root, 'source-workcell-'));
      const workspace = path.join(attempt, 'source'); await mkdir(workspace, { mode: 0o700 });
      await exportCandidate({ candidate, repository, workspace, signal });
      // Reconstitute a clean repository without checkout, hooks, filters, remotes,
      // shared object alternates or untracked content from the canonical checkout.
      const git = async (args) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: workspace, env: cleanEnv(), timeout: 30000, maxBuffer: 1024 * 1024, signal });
      await git(['init', `--object-format=${candidate.headCommit.length === 64 ? 'sha256' : 'sha1'}`]);
      await git(['fetch', '--depth=1', '--no-tags', '--no-write-fetch-head', path.resolve(repository), candidate.headCommit]);
      await git(['read-tree', candidate.headCommit]);
      await git(['update-ref', 'HEAD', candidate.headCommit]);
      const status = await git(['status', '--porcelain']);
      if (status.stdout.trim()) throw new Error('Workcell source materialization is not clean');
      const definition = structuredClone(this.config.definition);
      definition.workload.command = [...check.command];
      const context = { schema: 'workcell-caller-context/v1', caller: 'source', correlation_id: candidate.id, attempt_id: digest([job.id, job.leaseToken]), step_id: digest(identity) };
      for (const [name, value] of Object.entries({ definition, profiles: this.config.profiles, context, ...(this.config.manifest ? { manifest: this.config.manifest } : {}) })) {
        await writeFile(path.join(attempt, `${name}.json`), JSON.stringify(value), { mode: 0o600 });
      }
      const output = path.join(attempt, 'runs');
      const args = ['run', '--file', path.join(attempt, 'definition.json'), '--repo', workspace, '--output', output, '--profiles', path.join(attempt, 'profiles.json'), '--profile', this.config.profile, '--context', path.join(attempt, 'context.json'), '--cancel-file', path.join(attempt, 'cancel'), '--summary'];
      if (this.config.manifest) args.push('--manifest', path.join(attempt, 'manifest.json'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      // Workcell restricts absolute output paths to TMPDIR or repository .workcell.
      // Give it this private attempt, never the worker's ambient temporary root.
      const options = { cwd: attempt, env: { ...cleanEnv(), KUJO: this.kujo, TMPDIR: attempt }, timeout: this.timeoutMs, maxBuffer: 2 * 1024 * 1024, killSignal: 'SIGKILL' };
      const inspectArgs = ['inspect', '--file', path.join(attempt, 'definition.json'), '--repo', workspace, '--profiles', path.join(attempt, 'profiles.json'), '--profile', this.config.profile, '--summary'];
      if (this.config.manifest) inspectArgs.push('--manifest', path.join(attempt, 'manifest.json'));
      const inspection = await this.invokeProcess(this.executable, inspectArgs, { ...options, timeout: 30000 });
      await writeFile(path.join(attempt, 'workcell-inspect.json'), JSON.stringify(inspection), { mode: 0o600 });
      const inspected = JSON.parse(inspection.stdout);
      if (inspection.code !== 0 || inspected.schema_version !== 'workcell-inspect-summary/v1' || inspected.ok !== true || inspected.profile?.id !== this.config.profile || !/^[a-f0-9]{64}$/.test(inspected.profile?.fingerprint || '') || inspected.controls?.rejected !== 0 || typeof inspected.backend?.adapter_id !== 'string' || typeof inspected.backend?.provider_id !== 'string') throw new Error('Workcell profile resolution failed');
      signal?.throwIfAborted();
      const run = await this.invokeProcess(this.executable, args, options);
      await writeFile(path.join(attempt, 'workcell-cli.json'), JSON.stringify(run), { mode: 0o600 });
      await cancellation;
      if (cancelError) throw cancelError;
      const summary = JSON.parse(run.stdout);
      if (summary.schema_version !== 'workcell-run-summary/v1' || typeof summary.receipt_path !== 'string') throw new Error('Workcell returned no inspectable receipt');
      const receiptText = await boundedFile(attempt, summary.receipt_path, 2 * 1024 * 1024);
      const receipt = JSON.parse(receiptText);
      const runDir = path.dirname(path.resolve(attempt, summary.receipt_path));
      if (path.basename(summary.receipt_path) !== 'receipt.json') throw new Error('unexpected Workcell receipt path');
      const verification = await this.invokeProcess(this.executable, ['verify', '--run', runDir, '--json'], { ...options, timeout: 30000 });
      await writeFile(path.join(attempt, 'workcell-verify.json'), JSON.stringify(verification), { mode: 0o600 });
      if (verification.code !== 0 || JSON.parse(verification.stdout).ok !== true) throw new Error('Workcell evidence integrity verification failed');
      if (receipt.schema_version !== 'workcell-receipt/v2alpha1' || receipt.source?.commit !== candidate.headCommit || receipt.source?.clean !== true || digest(receipt.execution?.argv) !== digest(check.command) || digest(receipt.caller) !== digest(context)) throw new Error('Workcell receipt does not bind the exact candidate, command and attempt');
      if (receipt.backend?.profile_id !== inspected.profile.id || receipt.backend?.profile_fingerprint !== inspected.profile.fingerprint || receipt.backend?.adapter_id !== inspected.backend.adapter_id || receipt.backend?.provider_id !== inspected.backend.provider_id) throw new Error('Workcell execution environment differs from resolved profile');
      const normalized = normalizeControlArtifact('workcell', receipt);
      clean = ['complete', 'preserved'].includes(receipt.cleanup.status) && Array.isArray(receipt.cleanup.remaining) && receipt.cleanup.remaining.length === 0;
      removeSource = clean && receipt.cleanup.status === 'complete' && receipt.preservation?.actual_mode !== 'filesystem';
      const stdout = await boundedFile(attempt, path.join(runDir, 'stdout.log'), 1024 * 1024);
      const stderr = await boundedFile(attempt, path.join(runDir, 'stderr.log'), 1024 * 1024);
      signal?.throwIfAborted();
      const passed = run.code === 0 && summary.ok === true && normalized.validity === 'valid' && clean;
      const finishedAt = Date.now();
      // Preserve the original receipt and logs together in Source's immutable
      // output artifact. Workcell's full run directory stays available locally.
      return { output: JSON.stringify({ ...receipt, source_capture: { stdout, stderr } }), execution: {
        identity, commit: candidate.headCommit, tree: candidate.tree, command: check.command,
        environment: this.environment, inputs: check.inputs, externalState: check.externalState, toolVersions: this.config.toolVersions,
        status: passed ? 'pass' : 'fail', startedAt, finishedAt, durationMs: finishedAt - startedAt,
        workcell: { runId: receipt.run.id, runDirectory: runDir, cleanupConfirmed: clean, integrityVerified: true },
      } };
    } catch (error) {
      if (attempt) error.message += `; retained Workcell attempt: ${attempt}`;
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await cancellation;
      try { if (removeSource) await rm(path.join(attempt, 'source'), { recursive: true, force: true }); }
      finally { release(); }
    }
  }
}
