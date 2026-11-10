import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IntegrationPlanner } from '../src/integration-planner.js';
const exec = promisify(execFile);
async function git(cwd, ...args) { return (await exec('git', args, { cwd })).stdout.trim(); }

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'source-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = path.join(root, 'seed');
  const bare = path.join(root, 'canonical.git');
  await git(root, 'init', '-b', 'main', seed);
  await git(seed, 'config', 'user.name', 'Test');
  await git(seed, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(seed, 'shared.txt'), Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n');
  await writeFile(path.join(seed, 'binary'), Buffer.from([0, 1, 2]));
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'base');
  const base = await git(seed, 'rev-parse', 'HEAD');
  await git(root, 'clone', '--bare', seed, bare);
  const planner = new IntegrationPlanner(bare);
  async function proposal(id, modify, parent = base) {
    const cwd = path.join(root, id);
    await git(root, 'clone', bare, cwd);
    await git(cwd, 'config', 'user.name', id); await git(cwd, 'config', 'user.email', `${id}@example.invalid`);
    await git(cwd, 'checkout', '--detach', parent);
    await modify(cwd);
    await git(cwd, 'add', '-A'); await git(cwd, 'commit', '-m', id);
    const head = await git(cwd, 'rev-parse', 'HEAD');
    await git(cwd, 'push', 'origin', `HEAD:refs/heads/proposal-${id}`);
    return { id, baseCommit: parent, headCommit: head };
  }
  return { root, seed, bare, base, planner, proposal };
}

test('ten concurrent Git clients assemble a deterministic candidate with complete ancestry', async (t) => {
  const { base, bare, planner, proposal } = await fixture(t);
  const proposals = await Promise.all(Array.from({ length: 10 }, (_, i) => proposal(`agent-${i}`, (cwd) => writeFile(path.join(cwd, `feature-${i}`), `${i}\n`))));
  const first = await planner.assemble({ baseCommit: base, proposals });
  const second = await planner.assemble({ baseCommit: base, proposals: [...proposals].reverse() });
  assert.deepEqual(first, second);
  assert.equal(first.candidate.proposals.length, 10);
  assert.deepEqual(first.conflicts, []);
  for (const p of proposals) assert.ok(await planner.ancestor(p.headCommit, first.candidate.headCommit));
  assert.equal(await git(bare, 'rev-parse', 'main'), base, 'assembly never promotes');
  assert.equal(await git(bare, 'rev-parse', `refs/source/candidates/${first.candidate.id}`), first.candidate.headCommit);
});

for (const boundary of ['commit-tree', 'update-ref']) test(`assembler SIGKILL after ${boundary} recovers deterministically in fresh processes`, { timeout: 30000 }, async (t) => {
  const { root, base, bare, planner, proposal } = await fixture(t);
  const proposals = await Promise.all(['first', 'second'].map((id) => proposal(id, (cwd) => writeFile(path.join(cwd, id), id))));
  const script = path.join(root, 'assembler.mjs');
  await writeFile(script, `
import { IntegrationPlanner } from ${JSON.stringify(new URL('../src/integration-planner.js', import.meta.url).href)};
const planner = new IntegrationPlanner(${JSON.stringify(bare)});
const git = planner.git.bind(planner);
planner.git = async (...args) => {
  const result = await git(...args);
  if (process.env.SOURCE_FIXTURE_KILL === '1' && args[0][0] === ${JSON.stringify(boundary)}) process.kill(process.pid, 'SIGKILL');
  return result;
};
console.log(JSON.stringify(await planner.assemble(${JSON.stringify({ baseCommit: base, proposals })})));
`);
  await assert.rejects(() => exec(process.execPath, [script], { env: { ...process.env, SOURCE_FIXTURE_KILL: '1' }, timeout: 15000 }), (error) => error.signal === 'SIGKILL');
  assert.equal(await git(bare, 'rev-parse', 'main'), base);
  const refs = (await git(bare, 'for-each-ref', '--format=%(refname)', 'refs/source/candidates')).split('\n').filter(Boolean);
  assert.equal(refs.length, boundary === 'commit-tree' ? 0 : 1);
  const recovered = await Promise.all([0, 1].map(() => exec(process.execPath, [script], { env: { ...process.env, SOURCE_FIXTURE_KILL: '0' }, timeout: 15000 }).then((result) => JSON.parse(result.stdout))));
  assert.deepEqual(recovered[0], recovered[1]);
  assert.deepEqual(recovered[0], await planner.assemble({ baseCommit: base, proposals }));
  const candidate = recovered[0].candidate;
  assert.equal(await git(bare, 'rev-parse', `refs/source/candidates/${candidate.id}`), candidate.headCommit);
  assert.equal(await git(bare, 'rev-parse', 'main'), base, 'interrupted assembly never promotes');
  for (const item of proposals) assert.ok(await planner.ancestor(item.headCommit, candidate.headCommit));
  for (const id of ['first', 'second']) assert.equal(await git(bare, 'show', `${candidate.headCommit}:${id}`), id);
});

test('same-file harmless edits merge but conflicting edits and binaries are reported', async (t) => {
  const { base, planner, proposal } = await fixture(t);
  const proposals = await Promise.all(Array.from({ length: 10 }, (_, i) => proposal(`agent-${i}`, (cwd) => writeFile(path.join(cwd, 'shared.txt'), Array.from({ length: 100 }, (_, j) => j === i * 10 ? `agent ${i}` : `line ${j}`).join('\n') + '\n'))));
  const result = await planner.assemble({ baseCommit: base, proposals });
  assert.equal(result.candidate.proposals.length, 10);
  assert.ok(result.risks.length > 0);
  const conflicting = await Promise.all(['a', 'b'].map((id) => proposal(id, async (cwd) => {
    await writeFile(path.join(cwd, 'shared.txt'), id);
    await writeFile(path.join(cwd, 'binary'), Buffer.from([0, id.charCodeAt(0)]));
  })));
  const conflict = await planner.assemble({ baseCommit: base, proposals: conflicting });
  assert.equal(conflict.candidate.proposals.length, 1);
  assert.equal(conflict.conflicts[0].kind, 'git-merge-conflict');
  assert.match(conflict.conflicts[0].report, /binary|shared.txt/);
});

test('dependencies are inferred, stale proposals rejected, missing/cyclic dependencies blocked', async (t) => {
  const { base, planner, proposal } = await fixture(t);
  const parent = await proposal('parent', (cwd) => writeFile(path.join(cwd, 'one'), '1'));
  const child = await proposal('child', (cwd) => writeFile(path.join(cwd, 'two'), '2'), parent.headCommit);
  const result = await planner.assemble({ baseCommit: base, proposals: [child, parent] });
  assert.deepEqual(result.candidate.proposals.map((p) => p.id), ['parent', 'child']);
  assert.deepEqual(result.candidate.proposals[1].dependsOn, ['parent']);
  const stale = await planner.assemble({ baseCommit: base, proposals: [child] });
  assert.equal(stale.candidate, null);
  assert.match(stale.rejected[0].reason, /stale/);
  const cycle = await planner.assemble({ baseCommit: base, proposals: [{ ...parent, dependsOn: ['child'] }, child] });
  assert.equal(cycle.candidate, null);
  assert.equal(cycle.rejected.length, 2);
});

test('rename/delete conflicts use Git semantics; shared dependency domains require combined checks', async (t) => {
  const { base, planner, proposal } = await fixture(t);
  const renamed = await proposal('rename', (cwd) => git(cwd, 'mv', 'shared.txt', 'renamed.txt'));
  const deleted = await proposal('delete', (cwd) => rm(path.join(cwd, 'shared.txt')));
  const conflict = await planner.assemble({ baseCommit: base, proposals: [renamed, deleted] });
  assert.equal(conflict.conflicts.length, 1);
  const a = await proposal('a', (cwd) => writeFile(path.join(cwd, 'api.txt'), 'a'));
  const b = await proposal('b', (cwd) => writeFile(path.join(cwd, 'consumer.txt'), 'b'));
  const combined = await planner.assemble({ baseCommit: base, proposals: [a, b], dependencyGroups: [['api.txt', 'consumer.txt']] });
  assert.equal(combined.risks[0].sharedDependencyGroups.length, 1);
  assert.ok(combined.candidate.requiredVerification.includes('integration'));
  const exclusive = await planner.assemble({ baseCommit: base, proposals: [a, b], exclusivePaths: [''] }).catch((error) => error);
  assert.match(exclusive.message, /exclusive paths/);
  const generated = await planner.assemble({ baseCommit: base, proposals: [a, b], exclusivePaths: ['api', 'consumer'] });
  assert.equal(generated.candidate.proposals.length, 2);
});


test('different migration files remain exclusive and failed dependencies cannot enter the candidate', async (t) => {
  const { base, planner, proposal } = await fixture(t);
  const proposals = await Promise.all(['a', 'b'].map((id) => proposal(id, async (cwd) => {
    await mkdir(path.join(cwd, 'migrations'));
    await writeFile(path.join(cwd, 'migrations', `${id}.sql`), `-- ${id}`);
  })));
  const result = await planner.assemble({ baseCommit: base, proposals });
  assert.equal(result.candidate.proposals.length, 1);
  assert.equal(result.conflicts[0].kind, 'exclusive-artifact-domain');
  const dependent = await proposal('child', (cwd) => writeFile(path.join(cwd, 'child'), 'child'));
  const blocked = await planner.assemble({ baseCommit: base, proposals: [...proposals, { ...dependent, dependsOn: ['b'] }] });
  assert.equal(blocked.candidate.proposals.length, 1);
  assert.equal(blocked.rejected[0].id, 'child');
});

test('failed-batch diagnostics split independently and retain dependency closure', async (t) => {
  const { base, planner, proposal } = await fixture(t);
  const a = await proposal('a', (cwd) => writeFile(path.join(cwd, 'a'), 'a'));
  const b = await proposal('b', (cwd) => writeFile(path.join(cwd, 'b'), 'b'));
  const c = await proposal('c', (cwd) => writeFile(path.join(cwd, 'c'), 'c'), a.headCommit);
  const assembled = await planner.assemble({ baseCommit: base, proposals: [a, b, c] });
  const first = await planner.split(assembled.candidate);
  assert.deepEqual(first, await planner.split(assembled.candidate));
  assert.equal(first.children.length, 1);
  assert.match(first.blocked[0].reason, /full failed batch/);
  assert.equal(first.children[0].candidate.proposals[0].id, 'a');
  assert.notEqual(first.children[0].candidate.id, assembled.candidate.id);
  const independent = await planner.assemble({ baseCommit: base, proposals: [a, b] });
  const split = await planner.split(independent.candidate);
  assert.deepEqual(split.children.map((child) => child.candidate.proposals.map((p) => p.id)), [['a'], ['b']]);
  assert.equal(split.children.every((child) => child.candidate.context.splitParent === independent.candidate.id), true);
  assert.equal((await planner.split(split.children[0].candidate)).children.length, 0);
});

test('ten concurrent incompatible edits retain one proposal and report every excluded conflict deterministically', async (t) => {
  const { base, bare, planner, proposal } = await fixture(t);
  const proposals = await Promise.all(Array.from({ length: 10 }, (_, i) => proposal(`conflict-${i}`, (cwd) => writeFile(path.join(cwd, 'shared.txt'), `incompatible owner ${i}\n`))));
  const report = await planner.assemble({ baseCommit: base, proposals });
  assert.deepEqual(await planner.assemble({ baseCommit: base, proposals: [...proposals].reverse() }), report);
  assert.equal(report.candidate.proposals.length, 1);
  assert.equal(report.conflicts.length, 9);
  const accepted = report.candidate.proposals[0].id;
  assert.deepEqual(report.conflicts.map(item => item.id).sort(), proposals.filter(item => item.id !== accepted).map(item => item.id).sort());
  for (const conflict of report.conflicts) assert.match(JSON.stringify(conflict), /shared\.txt/);
  const winner = proposals.find(item => item.id === accepted);
  assert.equal(await git(bare, 'show', `${report.candidate.headCommit}:shared.txt`), await git(bare, 'show', `${winner.headCommit}:shared.txt`));
  assert.equal(await git(bare, 'rev-parse', 'main'), base);
});
