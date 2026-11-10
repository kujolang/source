// Explicit live OCI validation. Requires a locally available, digest-pinned
// image containing Node. Never silently substitutes a host execution fixture.
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { CandidateContainerExecutor } from '../src/candidate-executor.js';
import { digest } from '../src/integration-planner.js';
const exec = promisify(execFile);
const image = process.env.SOURCE_TEST_CONTAINER_IMAGE;
const nodeVersion = process.env.SOURCE_TEST_CONTAINER_NODE_VERSION;
if (!image || !nodeVersion) throw new Error('set SOURCE_TEST_CONTAINER_IMAGE to a digest-pinned Node image and SOURCE_TEST_CONTAINER_NODE_VERSION to its exact process.version');
const root = await mkdtemp(path.join(tmpdir(), 'source-container-smoke-'));
try {
  const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.email', 'fixture@example.com'); await git('config', 'user.name', 'Source smoke');
  await writeFile(path.join(root, 'expected'), 'exact-candidate');
  await git('add', 'expected'); await git('commit', '-m', 'fixture');
  const body = { headCommit: await git('rev-parse', 'HEAD'), tree: await git('rev-parse', 'HEAD^{tree}'), proposals: [] };
  const candidate = { ...body, id: digest(body) };
  const executor = new CandidateContainerExecutor({ workspaceRoot: path.join(root, 'workspaces'), runtime: process.env.SOURCE_TEST_CONTAINER_RUNTIME || 'docker', image, toolVersions: { node: nodeVersion }, timeoutMs: 30000 });
  const command = ['node', '-e', `const fs=require('node:fs'),assert=require('node:assert/strict'); assert.equal(process.version,${JSON.stringify(nodeVersion)}); assert.equal(fs.readFileSync('expected','utf8'),'exact-candidate'); assert.equal(fs.existsSync('.git'),false); fs.writeFileSync('temporary-result','ok'); console.log('candidate smoke passed')`];
  const check = { command, environment: executor.environment, toolVersions: executor.profile.toolVersions, inputs: {}, externalState: {} };
  const result = await executor.execute({ repository: path.join(root, '.git'), candidate, check, identity: digest({ candidate, check }), job: { id: 'smoke', leaseToken: 'live-attempt' } });
  assert.equal(result.execution.status, 'pass', result.output);
  assert.match(result.output, /candidate smoke passed/);
  assert.deepEqual(await readdir(executor.workspaces.root), []);
  console.log(JSON.stringify({ ok: true, environment: executor.environment, profile: executor.profile, execution: result.execution, output: result.output }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
