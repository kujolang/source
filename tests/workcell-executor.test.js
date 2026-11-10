import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from '../src/integration-planner.js';
import { WorkcellExecutor } from '../src/workcell-executor.js';
const exec = promisify(execFile);

async function fixture(t, mode = 'pass') {
  const root = await mkdtemp(path.join(tmpdir(), 'source-workcell-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  const git = async (...args) => (await exec('git', args, { cwd: repo })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(repo, 'app.js'), 'committed candidate'); await git('add', '.'); await git('commit', '-m', 'candidate');
  const body = { headCommit: await git('rev-parse', 'HEAD'), tree: await git('rev-parse', 'HEAD^{tree}') };
  const candidate = { ...body, id: digest(body) };
  await writeFile(path.join(repo, 'app.js'), 'uncommitted substitution');
  const calls = []; let retained; let onRun;
  const invokeProcess = async (binary, args, options) => {
    calls.push({ binary, args, options });
    const flag = (name) => args[args.indexOf(name) + 1];
    if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify({ schema_version: 'workcell-inspect-summary/v1', ok: true, profile: { id: 'local', fingerprint: 'a'.repeat(64) }, controls: { rejected: 0 }, backend: { adapter_id: 'docker', provider_id: 'docker-engine' } }) };
    if (args[0] === 'verify') return { code: 0, stdout: JSON.stringify({ ok: mode !== 'integrity' }) };
    const workspace = flag('--repo'); retained = path.dirname(workspace);
    assert.equal(options.env.TMPDIR, retained, 'Workcell output must stay in its attempt-owned temporary boundary');
    assert.equal(await readFile(path.join(workspace, 'app.js'), 'utf8'), 'committed candidate');
    assert.equal((await exec('git', ['status', '--porcelain'], { cwd: workspace })).stdout, '');
    assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim(), candidate.headCommit);
    assert.equal((await exec('git', ['remote'], { cwd: workspace })).stdout, '');
    const definition = JSON.parse(await readFile(flag('--file'), 'utf8'));
    const context = JSON.parse(await readFile(flag('--context'), 'utf8'));
    const runDir = path.join(flag('--output'), 'fixture-run'); await mkdir(runDir, { recursive: true });
    const receipt = {
      schema_version: 'workcell-receipt/v2alpha1',
      run: { id: 'fixture-run', status: mode === 'failed' ? 'failed' : 'completed', failure_category: mode === 'failed' ? 'execution' : null },
      backend: { profile_id: 'local', profile_fingerprint: mode === 'profile' ? 'b'.repeat(64) : 'a'.repeat(64), adapter_id: 'docker', provider_id: 'docker-engine' },
      source: { commit: mode === 'substitute' ? 'b'.repeat(40) : candidate.headCommit, clean: true },
      caller: mode === 'attempt' ? { ...context, attempt_id: 'wrong' } : context,
      execution: { argv: mode === 'command' ? ['wrong'] : definition.workload.command, terminal: { status: 'exited', exit_code: mode === 'failed' ? 1 : 0, certainty: 'terminal', timed_out: false, cancelled: false } },
      verification: { status: 'passed' }, artifacts: { status: 'not-requested' },
      cleanup: { status: mode === 'preserved' ? 'preserved' : 'complete', remaining: mode === 'leaked' ? ['container'] : [] }, logs: { truncated: mode === 'truncated' },
    };
    await writeFile(path.join(runDir, 'receipt.json'), JSON.stringify(receipt));
    await writeFile(path.join(runDir, 'stdout.log'), 'original stdout'); await writeFile(path.join(runDir, 'stderr.log'), 'original stderr');
    await onRun?.(flag('--cancel-file'));
    return { code: mode === 'failed' ? 7 : 0, stdout: JSON.stringify({ schema_version: 'workcell-run-summary/v1', ok: mode !== 'failed', receipt_path: path.join(runDir, 'receipt.json') }) };
  };
  const executor = new WorkcellExecutor({
    root: path.join(root, 'attempts'), executable: '/operator/workcell', kujo: '/operator/kujo', workcellRevision: 'a'.repeat(40), toolVersions: { node: 'fixture' },
    definition: { schema: 'workcell-definition/v2alpha1', workload: { image: { reference: `node@sha256:${'a'.repeat(64)}` }, command: ['replaced'] }, requirements: { network: { mode: 'none' }, execution: { timeout_ms: 1000, max_output_bytes: 65536 } } },
    profiles: { profiles: { local: { backend: 'docker' } } }, profile: 'local', invokeProcess,
  });
  const input = { candidate, repository: path.join(repo, '.git'), identity: 'verification-id', job: { id: 'job1', leaseToken: 'lease1' }, check: { command: ['node', 'test.js'], environment: executor.environment, toolVersions: { node: 'fixture' }, inputs: {}, externalState: {} } };
  return { executor, input, calls, retained: () => retained, onRun: (fn) => { onRun = fn; } };
}

test('Workcell bridge materializes exact clean Git, verifies evidence and retains original logs', async (t) => {
  const f = await fixture(t); const result = await f.executor.execute(f.input);
  assert.equal(result.execution.status, 'pass'); assert.equal(result.execution.workcell.cleanupConfirmed, true);
  assert.deepEqual(JSON.parse(result.output).source_capture, { stdout: 'original stdout', stderr: 'original stderr' });
  assert.deepEqual(f.calls.map((call) => call.args[0]), ['inspect', 'run', 'verify']);
  assert.deepEqual(Object.keys(f.calls[0].options.env).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_REPLACE_OBJECTS', 'KUJO', 'PATH', 'TMPDIR']);
  await assert.rejects(() => stat(path.join(f.retained(), 'source')), { code: 'ENOENT' });
  assert.ok((await readdir(f.retained())).includes('runs'));
  assert.equal(f.executor.slots.active, 0);
});

for (const mode of ['substitute', 'attempt', 'command', 'integrity', 'profile']) test(`Workcell bridge rejects ${mode} evidence and retains recovery material`, async (t) => {
  const f = await fixture(t, mode);
  await assert.rejects(() => f.executor.execute(f.input), /retained Workcell attempt/);
  assert.ok((await stat(path.join(f.retained(), 'source'))).isDirectory());
  assert.equal(f.executor.slots.active, 0);
});

for (const mode of ['failed', 'leaked', 'truncated']) test(`Workcell ${mode} lifecycle cannot produce passing evidence`, async (t) => {
  const f = await fixture(t, mode); const result = await f.executor.execute(f.input);
  assert.equal(result.execution.status, 'fail');
  if (mode === 'leaked') assert.ok((await stat(path.join(f.retained(), 'source'))).isDirectory());
});

test('Workcell cancellation uses the control file and never returns passing evidence', async (t) => {
  const f = await fixture(t); const controller = new AbortController();
  f.onRun(async (cancel) => { controller.abort(new Error('cancelled')); await new Promise((resolve) => setImmediate(resolve)); assert.equal(await readFile(cancel, 'utf8'), 'cancel\n'); });
  await assert.rejects(() => f.executor.execute({ ...f.input, signal: controller.signal }), /cancelled/);
  assert.equal(f.executor.slots.active, 0);
});

test('Workcell rejects changed profile and external inputs before allocation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.executor.execute({ ...f.input, check: { ...f.input.check, externalState: { service: 'v1' } } }), /self-contained/);
  f.executor.config.profiles.profiles.local.backend = 'other';
  await assert.rejects(() => f.executor.execute(f.input), /configuration changed/);
  assert.equal(f.calls.length, 0);
});

 test('Workcell preserves source backing a retained Workcell workspace', async (t) => {
  const f = await fixture(t, 'preserved'); const result = await f.executor.execute(f.input);
  assert.equal(result.execution.status, 'pass');
  assert.ok((await stat(path.join(f.retained(), 'source'))).isDirectory());
});
