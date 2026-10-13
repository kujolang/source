// Kujo evidence integration tests.
//
// Validates that Source normalizes real Kujo Control-layer artifacts (Eval,
// Spec, ShipCheck) into first-class Evidence, preserves the original artifact
// content-addressed, and that a failing tool result correctly blocks policy
// satisfaction (validity: invalid) rather than being treated as a pass.
//
// Fixtures under tests/fixtures/kujo/ are faithful reproductions of the real
// artifacts in the eval/spec/shipcheck repos (see docs/source/17-*).

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  normalizeEvalSummary,
  normalizeEvalManifest,
  normalizeEvalRun,
  normalizeSpecEnvelope,
  normalizeShipCheck,
  readEvalArtifacts,
  KujoRunner,
} from '../src/integrations/kujo.js';
import { freshSource } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (p) => path.join(__dirname, 'fixtures', 'kujo', p);
const readJson = (p) => JSON.parse(fs.readFileSync(fixture(p), 'utf8'));

function setupChange(src, org, project, agent) {
  const w = src.createWork({ orgId: org.id, projectId: project.id, intent: 'fix', requester: 'U1' });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id });
  const s = src.startSession({ orgId: org.id, projectId: project.id, workId: w.id, principalId: agent.id, baseCommit: 'base' });
  const c = src.submitChange({ orgId: org.id, projectId: project.id, workId: w.id, sessionId: s.id, baseCommit: 'base', headCommit: 'head' });
  return { w, s, c };
}

// --- normalizers --------------------------------------------------------

test('normalizeEvalSummary maps a failing Eval to invalid evidence', () => {
  const d = normalizeEvalSummary(readJson('eval/summary.json'));
  assert.equal(d.type, 'eval');
  assert.equal(d.claim, 'deterministic checks pass');
  assert.equal(d.validity, 'invalid');
  assert.equal(d.result.status, 'FAIL');
  assert.equal(d.result.failed, 1);
  assert.equal(d.result.passed, 18);
  assert.equal(d.result.total, 19);
  assert.equal(d.provenance.tool, 'eval');
  assert.equal(d.provenance.suiteName, 'tribunal-kujo-native-gate');
});

test('normalizeEvalSummary maps a passing Eval to valid evidence', () => {
  const d = normalizeEvalSummary(readJson('eval-pass/summary.json'));
  assert.equal(d.validity, 'valid');
  assert.equal(d.result.status, 'PASS');
  assert.equal(d.result.failed, 0);
});

test('normalizeEvalManifest maps artifact presence to integrity evidence', () => {
  const d = normalizeEvalManifest(readJson('eval/artifact-manifest.json'));
  assert.equal(d.type, 'eval');
  assert.equal(d.validity, 'valid');
  assert.equal(d.result.artifacts.length, 7);
  assert.ok(d.result.artifacts.every((a) => a.exists));
});

test('normalizeEvalManifest flags a missing artifact as invalid', () => {
  const manifest = readJson('eval/artifact-manifest.json');
  manifest.artifacts[0].exists = false;
  const d = normalizeEvalManifest(manifest);
  assert.equal(d.validity, 'invalid');
});

test('normalizeEvalRun maps per-check results', () => {
  const d = normalizeEvalRun(readJson('eval/last_run.json'));
  assert.equal(d.type, 'eval');
  assert.equal(d.validity, 'valid');
  assert.equal(d.result.passed, 2);
  assert.equal(d.result.failed, 0);
  assert.equal(d.result.checks.length, 2);
  assert.equal(d.result.checks[0].name, 'Spec Kujo check passes');
});

test('normalizeShipCheck maps gate_passed to validity', () => {
  const d = normalizeShipCheck(readJson('shipcheck/report.json'));
  assert.equal(d.type, 'shipcheck');
  assert.equal(d.validity, 'valid');
  assert.equal(d.result.gatePassed, true);
  assert.equal(d.result.totalChecks, 16);
  assert.equal(d.provenance.tool, 'shipcheck');
});

test('normalizeShipCheck maps a failed gate to invalid', () => {
  const report = readJson('shipcheck/report.json');
  report.summary.gate_passed = 0;
  report.summary.failed_errors = 1;
  const d = normalizeShipCheck(report);
  assert.equal(d.validity, 'invalid');
  assert.equal(d.result.gatePassed, false);
});

test('normalizeSpecEnvelope maps the contract checksum', () => {
  const d = normalizeSpecEnvelope(readJson('spec/envelope.json'));
  assert.equal(d.type, 'spec');
  assert.equal(d.validity, 'valid');
  assert.equal(d.result.checksumSha256, 'abc123def456');
  assert.equal(d.provenance.sourceFile, 'specs/dark-mode.spec.yml');
});

// --- end-to-end ingestion ------------------------------------------------

test('ingestEvalEvidence stores a failing eval as invalid and blocks policy', () => {
  const { src, org, project, agent, service } = freshSource();
  const { c } = setupChange(src, org, project, agent);

  const evidence = src.ingestEvalEvidence({
    orgId: org.id,
    projectId: project.id,
    changeId: c.id,
    producer: service.id,
    artifactsDir: fixture('eval'),
  });

  assert.equal(evidence.length, 3); // summary + manifest + last_run
  const summaryEvidence = evidence.find((e) => e.claim === 'deterministic checks pass');
  assert.equal(summaryEvidence.validity, 'invalid');

  // The original artifact is preserved, not reduced to PASS/FAIL.
  const stored = src.getArtifact(summaryEvidence.artifactRef.hash).toString('utf8');
  assert.ok(stored.includes('"status":"FAIL"'));
  assert.ok(stored.includes('"suite_name":"tribunal-kujo-native-gate"'));

  // A failing eval must NOT satisfy the required 'eval' evidence.
  const r = src.evaluateChange({ orgId: org.id, projectId: project.id, changeId: c.id });
  assert.equal(r.evaluation.ok, false);
  assert.ok(r.evaluation.missing.some((m) => m.type === 'eval'));
});

test('ingestEvalEvidence stores a passing eval as valid and satisfies policy', () => {
  const { src, org, project, agent, service } = freshSource();
  const { c } = setupChange(src, org, project, agent);

  // The default policy also requires 'test' evidence; add it directly.
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: c.id, subject: 'tests', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } });

  const evidence = src.ingestEvalEvidence({
    orgId: org.id,
    projectId: project.id,
    changeId: c.id,
    producer: service.id,
    artifactsDir: fixture('eval-pass'),
  });

  const summaryEvidence = evidence.find((e) => e.claim === 'deterministic checks pass');
  assert.equal(summaryEvidence.validity, 'valid');

  const r = src.evaluateChange({ orgId: org.id, projectId: project.id, changeId: c.id });
  assert.equal(r.evaluation.ok, true);
  assert.equal(r.evaluation.missing.length, 0);
});

// --- runner --------------------------------------------------------------

test('KujoRunner invokes kujo and reads the output artifacts', () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'source-kujo-run-'));
  const mockExec = (bin, args) => {
    assert.equal(bin, 'kujo');
    assert.ok(args.includes('run'));
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--artifact-checksums'));
    const outputDir = args[args.indexOf('--output-dir') + 1];
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(fixture('eval/summary.json'), path.join(outputDir, 'summary.json'));
    fs.copyFileSync(fixture('eval/artifact-manifest.json'), path.join(outputDir, 'artifact-manifest.json'));
    fs.copyFileSync(fixture('eval/last_run.json'), path.join(outputDir, 'last_run.json'));
    return '';
  };

  const runner = new KujoRunner({ kujoBin: 'kujo', exec: mockExec });
  const artifacts = runner.runEval('eval.json', { outputDir: outDir });
  assert.equal(artifacts.summary.status, 'FAIL');
  assert.equal(artifacts.manifest.artifacts.length, 7);
  assert.equal(artifacts.lastRun.data.test_results.length, 2);
});

// --- real-artifact validation (skips when the eval repo is absent) ------

test('normalizes the real eval/eval_results artifact when present', (t) => {
  const real = path.resolve(process.cwd(), '../eval/eval_results/summary.json');
  if (!fs.existsSync(real)) {
    t.skip(`real eval artifacts not found at ${real}`);
    return;
  }
  const summary = JSON.parse(fs.readFileSync(real, 'utf8'));
  const d = normalizeEvalSummary(summary);
  assert.equal(d.type, 'eval');
  assert.equal(d.claim, 'deterministic checks pass');
  assert.equal(d.validity, summary.status === 'PASS' ? 'valid' : 'invalid');
  assert.equal(d.result.status, summary.status);
});

test('Eval parsed evidence and retained raw proof come from one read per artifact', () => {
  const original = fs.readFileSync;
  const calls = new Map();
  fs.readFileSync = (file) => {
    const name = path.basename(file);
    calls.set(name, (calls.get(name) || 0) + 1);
    return JSON.stringify({ artifact: name, version: calls.get(name) });
  };
  try {
    const result = readEvalArtifacts('/test-eval-artifacts');
    assert.deepEqual(result.summary, JSON.parse(result.summaryRaw));
    assert.deepEqual(result.manifest, JSON.parse(result.manifestRaw));
    assert.deepEqual(result.lastRun, JSON.parse(result.lastRunRaw));
    assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), 5);
  } finally { fs.readFileSync = original; }
});
