#!/usr/bin/env node
// Local JSON-store broker evaluation benchmark; no synthetic read delays.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { freshSource, seedRepo } from '../../tests/helpers.js';
import { verificationIdentity } from '../../src/verification.js';
const output = process.argv[2];
if (!output) throw new Error('provide a new output JSON path');
const baselineRevision = process.argv[3];
let BaselineBroker;
if (baselineRevision) {
  if (!/^[a-f0-9]{7,40}$/.test(baselineRevision)) throw new Error('baseline must be a commit hash');
  const old = execFileSync('git', ['show', `${baselineRevision}:src/integration-broker.js`], { encoding: 'utf8' });
  const resolved = old.replace(/from '(\.[^']+)'/g, (_, specifier) => `from '${new URL(specifier, new URL('../../src/integration-broker.js', import.meta.url)).href}'`);
  BaselineBroker = (await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`)).IntegrationBroker;
}
const results = [];
for (const [name, count, unique] of [['single', 1, false], ['repeated', 32, false], ['unique', 32, true]]) {
  const f = freshSource(); let cwd;
  try {
    const { src, org, project, human, service, agent } = f;
    const seeded = seedRepo(src, org.id, project.id); cwd = seeded.work;
    const repo = seeded.repo, scope = { orgId: org.id, projectId: project.id, repoId: repo.id, principalId: human.id };
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const policy = { version: '1', securityPolicyVersion: '1', checks: [{ id: 'check', version: '1', command: ['node', '--test'], toolVersions: { node: process.version }, environment: 'fixture', inputs: {}, externalState: {}, deterministic: true, maxAgeMs: 3600000, producers: [service.id] }] };
    await src.integration.configure({ ...scope, policy });
    writeFileSync(path.join(cwd, 'addition'), 'change'); git('add', '.'); git('commit', '-m', 'contribution'); git('push', 'origin', 'HEAD:refs/heads/proposal');
    const work = src.createWork({ ...scope, intent: name, requester: agent.id });
    src.claimWork({ ...scope, workId: work.id, principalId: agent.id });
    const session = src.startSession({ ...scope, workId: work.id, principalId: agent.id, baseCommit: seeded.head });
    const change = src.submitChange({ ...scope, workId: work.id, sessionId: session.id, repositories: [repo.id], baseCommit: seeded.head, headCommit: git('rev-parse', 'HEAD') });
    const report = await src.planIntegrationAsync({ ...scope, changeIds: [change.id] });
    const input = { ...scope, candidateId: report.candidate.id }; const check = policy.checks[0]; const now = Date.now() - count - 20;
    for (let i = 0; i < count; i++) {
      await src.integration.record({ ...input, principalId: service.id, checkId: check.id,
        execution: { identity: verificationIdentity(report.candidate, policy, check.id), commit: report.candidate.headCommit, tree: report.candidate.tree, environment: check.environment, inputs: {}, externalState: {}, toolVersions: check.toolVersions, command: check.command, status: 'pass', startedAt: now + i, finishedAt: now + i + 1, durationMs: 1 },
        output: (unique ? String(i).padStart(8, '0') : 'same-log') .padEnd(1024 * 1024, 'x') });
    }
    const original = src.store.getArtifactAsync.bind(src.store); let reads = 0, bytes = 0;
    src.store.getArtifactAsync = async hash => { const b = await original(hash); reads++; bytes += b?.length || 0; return b; };
    const expected = await src.integration.evaluate(input); assert.equal(expected.ok, true);
    const samples = [], baselineSamples = [];
    const baseline = BaselineBroker ? new BaselineBroker(src) : null;
    if (baseline) assert.deepEqual(await baseline.evaluate(input), expected);
    const measure = async (broker, destination) => {
      reads = 0; bytes = 0; const start = performance.now();
      const result = await broker.evaluate(input);
      const elapsedMs = performance.now() - start;
      assert.deepEqual(result, expected);
      destination.push({ elapsedMs, reads, bytes });
    };
    for (let i = 0; i < 7; i++) {
      if (baseline && i % 2 === 0) await measure(baseline, baselineSamples);
      await measure(src.integration, samples);
      if (baseline && i % 2 === 1) await measure(baseline, baselineSamples);
    }
    const summary = values => {
      const times = values.map(s => s.elapsedMs).sort((a,b) => a-b);
      return { samples: values, medianMs: times[3], minMs: times[0], maxMs: times[6] };
    };
    results.push({ name, receipts: count, uniqueArtifacts: unique ? count : 1, artifactBytes: 1024 * 1024, equivalentEvaluations: true, ...summary(samples), ...(baseline ? { baseline: summary(baselineSamples) } : {}) });
  } finally { rmSync(f.dir, { recursive: true, force: true }); if (cwd) rmSync(cwd, { recursive: true, force: true }); }
}
writeFileSync(output, JSON.stringify({ baselineRevision, pairedOrder: baselineRevision ? 'alternating baseline-first and current-first on identical fixture' : null, node: process.version, platform: process.platform, backend: 'local JSON/filesystem', warmupEvaluations: 1, samplesPerCase: 7, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), brokerSha256: createHash('sha256').update(readFileSync('src/integration-broker.js')).digest('hex'), results }, null, 2)+'\n', { flag: 'wx' });
console.log(JSON.stringify(results.map(({ name, medianMs, samples }) => ({ name, medianMs, reads: samples[0].reads, bytes: samples[0].bytes }))));
