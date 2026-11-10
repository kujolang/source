// Explicit live OCI validation; never substitutes host execution.
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { CandidateContainerExecutor } from '../src/candidate-executor.js';
import { removeRuntimeContainer } from '../src/action-runner.js';
import { digest } from '../src/integration-planner.js';
const exec = promisify(execFile);
const image = process.env.SOURCE_TEST_CONTAINER_IMAGE;
const nodeVersion = process.env.SOURCE_TEST_CONTAINER_NODE_VERSION;
const runtime = process.env.SOURCE_TEST_CONTAINER_RUNTIME || 'docker';
if (!image || !nodeVersion) throw new Error('set SOURCE_TEST_CONTAINER_IMAGE to a digest-pinned Node image and SOURCE_TEST_CONTAINER_NODE_VERSION to its exact process.version');
const root = await mkdtemp(path.join(tmpdir(), 'source-container-smoke-'));
const containers = new Set();
const report = { version: 2, runtime, image, nodeVersion, cases: [] };
const previousCanary = process.env.SOURCE_SMOKE_HOST_ONLY;
process.env.SOURCE_SMOKE_HOST_ONLY = 'test-only-not-a-secret';
try {
  const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.email', 'fixture@example.com'); await git('config', 'user.name', 'Source smoke');
  await writeFile(path.join(root, 'expected'), 'exact-candidate');
  await writeFile(path.join(root, 'app.cjs'), `const http=require('node:http'),fs=require('node:fs'); module.exports=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({value:fs.readFileSync('expected','utf8')}))});`);
  await git('add', 'expected', 'app.cjs'); await git('commit', '-m', 'fixture');
  const body = { headCommit: await git('rev-parse', 'HEAD'), tree: await git('rev-parse', 'HEAD^{tree}'), proposals: [] };
  const candidate = { ...body, id: digest(body) };
  // These host-side changes must never appear in the candidate environment.
  await writeFile(path.join(root, 'expected'), 'uncommitted substitution');
  await writeFile(path.join(root, 'host-only'), 'untracked fixture');
  const clean = async (names, executor) => {
    const existing = (await exec(runtime, ['ps', '-a', '--format', '{{.Names}}'], { timeout: 15000 })).stdout.trim().split('\n');
    for (const name of names) assert.ok(!existing.includes(name), `container still exists: ${name}`);
    assert.deepEqual(await readdir(executor.workspaces.root), []);
    assert.equal(executor.workspaces.slots.active, 0);
    assert.equal(executor.runner.slots.active, 0);
  };
  const runCase = async (name, script, { timeoutMs = 30000, maxOutputBytes = 65536, expectedError, expectedStatus = 'pass', cancelOnReady = false, cleanupUnavailable = false } = {}) => {
    const controller = new AbortController(); const names = []; let ready = false; let inspection; let inspected;
    const executor = new CandidateContainerExecutor({
      workspaceRoot: path.join(root, 'workspaces'), runtime, image, toolVersions: { node: nodeVersion }, timeoutMs, maxOutputBytes,
      spawnProcess: (command, args, options) => {
        const containerName = args[args.indexOf('--name') + 1];
        assert.ok(containerName.startsWith('source-action-')); names.push(containerName); containers.add(containerName);
        const child = spawn(command, args, options);
        let output = '';
        child.stdout.on('data', (chunk) => {
          output = (output + chunk.toString()).slice(-1024);
          if (!ready && output.includes('SOURCE_SMOKE_READY')) {
            ready = true;
            if (cancelOnReady) {
              inspection = exec(runtime, ['inspect', containerName], { timeout: 15000 }).then(({ stdout }) => {
                const actual = JSON.parse(stdout)[0];
                const config = actual.HostConfig;
                assert.equal(config.NetworkMode, 'none');
                assert.equal(config.ReadonlyRootfs, true);
                assert.equal(config.Memory, 1024 * 1024 * 1024);
                assert.equal(config.NanoCpus, 2 * 1e9);
                assert.equal(config.PidsLimit, 256);
                assert.ok(config.CapDrop.some(value => value.toUpperCase() === 'ALL'));
                assert.ok(config.SecurityOpt.some(value => value.startsWith('no-new-privileges')));
                assert.equal(actual.Config.User, executor.profile.user);
                assert.equal(actual.Mounts.filter(mount => mount.Type === 'bind').length, 1);
                assert.equal(actual.Mounts.find(mount => mount.Type === 'bind').Destination, '/workspace');
                inspected = { network: config.NetworkMode, readOnlyRoot: config.ReadonlyRootfs, memoryBytes: config.Memory, nanoCpus: config.NanoCpus, pids: config.PidsLimit, user: actual.Config.User };
              }).finally(() => controller.abort());
              // The awaited inspection below propagates assertion/runtime failures.
              inspection.catch(() => {});
            }
          }
        });
        return child;
      },
    });
    if (cleanupUnavailable) executor.runner.removeContainer = async () => false;
    const command = ['node', '-e', script];
    const check = { command, environment: executor.environment, toolVersions: executor.profile.toolVersions, inputs: {}, externalState: {} };
    const started = Date.now();
    let result;
    try {
      result = await executor.execute({ repository: path.join(root, '.git'), candidate, check, identity: digest({ candidate, check }), job: { id: name, leaseToken: 'live-attempt' }, signal: controller.signal });
      assert.ok(!expectedError, `expected ${expectedError}`);
      assert.equal(result.execution.status, expectedStatus, result.output);
    } catch (error) {
      if (!expectedError) throw error;
      assert.match(error.message, expectedError);
      result = { error: error.message, ...(error.cleanup ? { cleanup: error.cleanup } : {}) };
    }
    if (inspection) await inspection;
    if (cancelOnReady || name === 'timeout') assert.equal(ready, true, 'workload must start before termination');
    if (cleanupUnavailable) {
      assert.equal(result.cleanup?.confirmed, false);
      assert.equal(result.cleanup.recorded, true);
      const record = JSON.parse(await readFile(result.cleanup.recordPath, 'utf8'));
      const actual = JSON.parse((await exec(runtime, ['inspect', record.containerName], { timeout: 15000 })).stdout)[0];
      assert.equal(actual.State.Running, true, 'failure injection must leave a real running container');
      assert.equal(await readFile(path.join(record.workspace, 'expected'), 'utf8'), 'exact-candidate');
      await assert.rejects(() => executor.runner.run({ steps: [{ run: 'true' }] }, { workspace: record.workspace }), /cleanup recovery required/);
      const recovered = new CandidateContainerExecutor({ workspaceRoot: executor.workspaces.root, runtime, image, toolVersions: { node: nodeVersion } });
      await assert.rejects(() => recovered.runner.run({ steps: [{ run: 'true' }] }, { workspace: record.workspace }), /cleanup recovery required/);
      assert.equal(await removeRuntimeContainer(runtime, record.containerName), true);
      await rm(record.workspace, { recursive: true });
      await rm(result.cleanup.recordPath);
      if (result.cleanup.attemptRecord) await rm(result.cleanup.attemptRecord);
      result.recovery = { fault: 'injected unavailable cleanup boundary; real running OCI container', containerRemovalConfirmed: true,
        workspacePreservedUntilRemoval: true, currentAndRestartedWorkerBlocked: true };
    }
    await clean(names, executor);
    report.cases.push({ name, durationMs: Date.now() - started, profile: executor.profile, result, ...(inspected ? { runtimeInspection: inspected } : {}), cleanupVerified: true });
  };
  await runCase('endpoint-and-isolation', `
    const fs=require('node:fs'),assert=require('node:assert/strict'),os=require('node:os');
    (async()=>{
      assert.equal(process.version,${JSON.stringify(nodeVersion)});
      assert.notEqual(process.getuid(),0);
      assert.equal(fs.readFileSync('expected','utf8'),'exact-candidate');
      assert.equal(fs.existsSync('.git'),false);
      assert.equal(fs.existsSync('host-only'),false);
      assert.equal(process.env.SOURCE_SMOKE_HOST_ONLY,undefined);
      assert.equal(fs.existsSync('/var/run/docker.sock'),false);
      assert.throws(()=>fs.writeFileSync('/source-escape','bad'));
      assert.ok(Object.values(os.networkInterfaces()).flat().every(x=>x.internal));
      const status=fs.readFileSync('/proc/self/status','utf8');
      assert.match(status,/CapEff:\\s+0+\\n/); assert.match(status,/NoNewPrivs:\\s+1\\n/);
      const server=require('./app.cjs');
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      try { const response=await fetch('http://127.0.0.1:'+server.address().port); assert.equal(response.status,200); assert.deepEqual(await response.json(),{value:'exact-candidate'}); }
      finally { await new Promise(r=>server.close(r)); }
      fs.writeFileSync('temporary-result','ok'); console.log('candidate endpoint and isolation passed');
    })().catch(e=>{console.error(e);process.exitCode=1});
  `);
  await runCase('failed-check', `console.error('controlled integration failure'); process.exitCode=7`, { expectedStatus: 'fail' });
  await runCase('cancel', `console.log('SOURCE_SMOKE_READY'); setInterval(()=>{},1000)`, { cancelOnReady: true, expectedError: /cancelled/ });
  await runCase('timeout', `console.log('SOURCE_SMOKE_READY'); setInterval(()=>{},1000)`, { timeoutMs: 5000, expectedError: /timed out/ });
  await runCase('output-limit', `console.log('x'.repeat(8192)); setInterval(()=>{},1000)`, { maxOutputBytes: 1024, expectedError: /output exceeded/ });
  await runCase('cleanup-outage', `console.log('SOURCE_SMOKE_READY'); setInterval(()=>{},1000)`, { cancelOnReady: true, cleanupUnavailable: true, expectedError: /cleanup unconfirmed/ });
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (previousCanary === undefined) delete process.env.SOURCE_SMOKE_HOST_ONLY;
  else process.env.SOURCE_SMOKE_HOST_ONLY = previousCanary;
  // Only this run's exact randomly assigned names; never sweep other workloads.
  for (const name of containers) await exec(runtime, ['rm', '--force', name], { timeout: 15000 }).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
