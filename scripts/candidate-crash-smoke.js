// Explicit real-worker/OCI crash drill. Never stops the shared runtime daemon.
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { digest } from '../src/integration-planner.js';
const exec = promisify(execFile);
const image = process.env.SOURCE_TEST_CONTAINER_IMAGE;
const nodeVersion = process.env.SOURCE_TEST_CONTAINER_NODE_VERSION;
const runtime = process.env.SOURCE_TEST_CONTAINER_RUNTIME || 'docker';
if (!image || !nodeVersion) throw new Error('set pinned SOURCE_TEST_CONTAINER_IMAGE and SOURCE_TEST_CONTAINER_NODE_VERSION');
const root = await mkdtemp(path.join(tmpdir(), 'source-crash-smoke-'));
const workspaceRoot = path.join(root, 'workspaces'); await mkdir(workspaceRoot);
const children = []; const names = new Set();
const bounded = async (promise, message, ms = 30000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
};
try {
  const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Source crash fixture'); await git('config', 'user.email', 'fixture@example.com');
  await writeFile(path.join(root, 'expected'), 'exact-candidate'); await git('add', 'expected'); await git('commit', '-m', 'fixture');
  const body = { headCommit: await git('rev-parse', 'HEAD'), tree: await git('rev-parse', 'HEAD^{tree}'), proposals: [] };
  const candidate = { ...body, id: digest(body) };
  const workerPath = path.join(root, 'worker.mjs');
  await writeFile(workerPath, `
import { CandidateContainerExecutor } from ${JSON.stringify(new URL('../src/candidate-executor.js', import.meta.url).href)};
import { spawn } from 'node:child_process';
const controller = new AbortController();
process.on('message', (message) => { if (message === 'stop') controller.abort(); });
const executor = new CandidateContainerExecutor({ workspaceRoot: ${JSON.stringify(workspaceRoot)}, runtime: ${JSON.stringify(runtime)}, image: ${JSON.stringify(image)}, toolVersions: { node: ${JSON.stringify(nodeVersion)} }, timeoutMs: 120000,
  spawnProcess: (command, args, options) => {
    const name = args[args.indexOf('--name') + 1];
    const workspace = args[args.indexOf('-v') + 1].slice(0, -':/workspace:rw'.length);
    process.send({ type: 'runtime', name, workspace });
    const child = spawn(command, args, options); let output = ''; let ready = false;
    child.stdout.on('data', (chunk) => { output += chunk; if (!ready && output.includes('SOURCE_CRASH_READY')) { ready = true; process.send({ type: 'ready', name, workspace }); } });
    return child;
  }
});
const check = { command: ['node', '-e', "const fs=require('node:fs'); if(fs.readFileSync('expected','utf8')!=='exact-candidate')process.exit(2); console.log('SOURCE_CRASH_READY'); setInterval(()=>{},1000)"], environment: executor.environment, toolVersions: executor.profile.toolVersions, inputs: {}, externalState: {} };
try {
  await executor.execute({ candidate: ${JSON.stringify(candidate)}, repository: ${JSON.stringify(path.join(root, '.git'))}, check, identity: 'crash-fixture', job: { id: 'same-job', leaseToken: process.argv[2] }, signal: controller.signal });
  process.exitCode = 1;
} catch(error) {
  if (!controller.signal.aborted) { console.error(error.message); process.exitCode = 1; }
}
process.disconnect();
`);
  const start = (attempt) => {
    const child = fork(workerPath, [attempt], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = ''; child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); }); child.stderr.on('data', chunk => { output = (output + chunk).slice(-8192); });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const ready = new Promise((resolve, reject) => {
      child.on('message', message => { if (message.name) names.add(message.name); if (message.type === 'ready') resolve(message); });
      child.once('error', reject); child.once('exit', () => reject(new Error('worker exited before ready: ' + output)));
    });
    const state = { child, closed, ready }; children.push(state); return state;
  };
  const a = start('old-lease'); const readyA = await bounded(a.ready, 'first worker did not start');
  const b = start('new-lease'); const readyB = await bounded(b.ready, 'second worker did not start');
  const records = (await readdir(workspaceRoot)).filter(name => name.endsWith('.attempt.json'));
  assert.equal(records.length, 2, 'every live container needs a durable pre-launch ownership record');
  const { recoverExecutionAttempts } = await import('../src/execution-attempts.js');
  const active = await recoverExecutionAttempts({ workspaceRoot });
  assert.equal(active.results.filter(row => row.state === 'active').length, 2);
  a.child.kill('SIGKILL'); assert.equal((await bounded(a.closed, 'killed worker did not exit')).signal, 'SIGKILL');
  assert.equal(JSON.parse((await exec(runtime, ['inspect', readyA.name])).stdout)[0].State.Running, true);
  const recovered = JSON.parse((await exec(process.execPath, [fileURLToPath(new URL('./recover-executions.js', import.meta.url)), workspaceRoot], { timeout: 30000 })).stdout);
  assert.equal(recovered.results.filter(row => row.state === 'recovered').length, 1);
  assert.equal(recovered.results.filter(row => row.state === 'active').length, 1);
  assert.equal(JSON.parse((await exec(runtime, ['inspect', readyB.name])).stdout)[0].State.Running, true);
  assert.equal(await readFile(path.join(readyB.workspace, 'expected'), 'utf8'), 'exact-candidate');
  await assert.rejects(() => readFile(path.join(readyA.workspace, 'expected')), { code: 'ENOENT' });
  assert.ok(!(await exec(runtime, ['ps', '--all', '--format', '{{.Names}}'])).stdout.trim().split('\n').includes(readyA.name));
  const repeated = await recoverExecutionAttempts({ workspaceRoot });
  assert.deepEqual(repeated.results.map(row => row.state), ['active']);
  b.child.send('stop'); assert.equal((await bounded(b.closed, 'surviving worker did not stop')).code, 0);
  assert.deepEqual(await readdir(workspaceRoot), []);
  console.log(JSON.stringify({ version: 1, ok: true, runtime, image, nodeVersion, candidate: candidate.id,
    killedWorkerSignal: 'SIGKILL', concurrentSameJobDifferentLease: true, leaseFixture: 'distinct caller tokens; no PostgreSQL queue in this drill', recoveryThroughOperatorCli: true, liveAttemptPreserved: true,
    orphanWasRunning: true, active, recovered, repeated, workspaceRootEmpty: true }, null, 2));
} finally {
  for (const state of children) {
    if (state.child.exitCode == null && state.child.signalCode == null) state.child.kill('SIGKILL');
    await bounded(state.closed, 'fixture child did not exit', 5000).catch(() => {});
  }
  for (const name of names) await exec(runtime, ['rm', '--force', name], { timeout: 15000 }).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
