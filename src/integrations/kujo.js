// Source — Kujo tool integration adapters.
//
// Normalizes artifacts from Kujo's Control layer (Eval, Spec, ShipCheck) into
// Source Evidence descriptors, and provides a pluggable runner that invokes the
// Kujo runtime. Source consumes versioned JSON artifacts; it does not link Kujo
// code. The original artifact is always preserved content-addressed so the
// normalized summary never replaces the underlying proof.
//
// Each normalizer is a pure function: parsed JSON in, an Evidence descriptor
// out. The descriptor matches the `addEvidence`/`ingestEvidence` parameter
// shape so the application service can store it directly.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// --- Eval ---------------------------------------------------------------
//
// Eval emits (per the kujo-eval-workflows skill) these artifacts in its output
// directory: summary.json, artifact-manifest.json, last_run.json,
// last_failures.json, cli-summary.json, history.json, eval-report.<ext>.
// The three below are the ones Source normalizes into first-class Evidence.

// summary.json -> the policy-relevant pass/fail evidence.
export function normalizeEvalSummary(summary) {
  const passed = summary.status === 'PASS';
  return {
    subject: `eval:${summary.suite_name ?? 'unknown'}`,
    claim: 'deterministic checks pass',
    type: 'eval',
    result: {
      status: summary.status,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      total: summary.total,
      passRate: summary.pass_rate,
      durationMs: summary.duration_ms,
    },
    validity: passed ? 'valid' : 'invalid',
    provenance: {
      tool: 'eval',
      suiteName: summary.suite_name,
      suiteVersion: summary.suite_version,
      generatedAtMs: summary.generated_at_ms,
    },
  };
}

// artifact-manifest.json -> integrity evidence that the run's artifacts exist.
export function normalizeEvalManifest(manifest) {
  const artifacts = (manifest.artifacts ?? []).map((a) => ({
    path: a.path,
    type: a.type,
    exists: a.exists,
  }));
  const allPresent = artifacts.length > 0 && artifacts.every((a) => a.exists);
  return {
    subject: `eval-manifest:${manifest.suite_name ?? 'unknown'}`,
    claim: 'eval artifacts are present and accounted for',
    type: 'eval',
    result: { command: manifest.command, artifacts },
    validity: allPresent ? 'valid' : 'invalid',
    provenance: {
      tool: 'eval',
      suiteName: manifest.suite_name,
      suiteVersion: manifest.suite_version,
      generatedAtMs: manifest.generated_at_ms,
    },
  };
}

// last_run.json -> per-check detail. The full per-check results are preserved in
// the artifact; the normalized result carries a compact summary.
export function normalizeEvalRun(lastRun) {
  const data = lastRun.data ?? lastRun;
  const results = (data.test_results ?? []).map((r) => ({
    name: r.name,
    check: r.check,
    passed: r.passed,
    skipped: r.skipped,
    message: r.message,
  }));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed && !r.skipped).length;
  return {
    subject: `eval-run:${data.suite_name ?? 'unknown'}`,
    claim: 'eval run recorded with per-check results',
    type: 'eval',
    result: { passed, failed, total: results.length, checks: results },
    validity: failed === 0 ? 'valid' : 'invalid',
    provenance: {
      tool: 'eval',
      suiteName: data.suite_name,
      suiteVersion: data.suite_version,
      durationMs: data.duration_ms,
    },
  };
}

// --- Spec ---------------------------------------------------------------
//
// `spec export --format envelope` emits { metadata, payload } where metadata
// carries source_file, schema_version, checksum_sha256, generated_at, and
// payload_format. Source records the contract's existence and checksum.

export function normalizeSpecEnvelope(envelope) {
  const meta = envelope.metadata ?? {};
  return {
    subject: `spec:${meta.source_file ?? 'unknown'}`,
    claim: 'spec contract is defined and checksummed',
    type: 'spec',
    result: {
      schemaVersion: meta.schema_version,
      payloadFormat: meta.payload_format,
      checksumSha256: meta.checksum_sha256,
    },
    validity: 'valid',
    provenance: {
      tool: 'spec',
      sourceFile: meta.source_file,
      generatedAt: meta.generated_at,
    },
  };
}

// --- ShipCheck ----------------------------------------------------------
//
// `shipcheck scan|gate --format json` emits a report conforming to
// schemas/shipcheck-report.schema.json: { tool, version, dir, project_type,
// summary: { total_checks, passed, failed_errors, warnings, gate_passed },
// checks: [...] }. gate_passed is 0|1.

export function normalizeShipCheck(report) {
  const s = report.summary ?? {};
  const gatePassed = s.gate_passed === 1;
  return {
    subject: `shipcheck:${report.dir ?? 'unknown'}`,
    claim: 'release-readiness gate passes',
    type: 'shipcheck',
    result: {
      totalChecks: s.total_checks,
      passed: s.passed,
      failedErrors: s.failed_errors,
      warnings: s.warnings,
      gatePassed,
    },
    validity: gatePassed ? 'valid' : 'invalid',
    provenance: {
      tool: 'shipcheck',
      version: report.version,
      projectType: report.project_type,
    },
  };
}

// --- artifact reading ---------------------------------------------------

// Read an Eval output directory and return parsed artifacts plus their raw
// bytes (so the original artifact can be preserved content-addressed).
export function readEvalArtifacts(outputDir) {
  const read = (name) => {
    const p = path.join(outputDir, name);
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };
  const parse = (name) => {
    const raw = read(name);
    return raw == null ? null : JSON.parse(raw);
  };
  return {
    summary: parse('summary.json'),
    summaryRaw: read('summary.json'),
    manifest: parse('artifact-manifest.json'),
    manifestRaw: read('artifact-manifest.json'),
    lastRun: parse('last_run.json'),
    lastRunRaw: read('last_run.json'),
    lastFailures: parse('last_failures.json'),
    cliSummary: parse('cli-summary.json'),
  };
}

// --- runner -------------------------------------------------------------

// Invokes the Kujo runtime. The `exec` function is injectable so tests can run
// offline without a Kujo binary. In production this shells out to
// `kujo run main.kujo run <suite> --output-dir <dir> --json --artifact-checksums`.
export class KujoRunner {
  constructor({ kujoBin = 'kujo', exec = execFileSync } = {}) {
    this.kujoBin = kujoBin;
    this.exec = exec;
  }

  runEval(suitePath, { outputDir, cwd = process.cwd() } = {}) {
    const args = [
      'run',
      'main.kujo',
      'run',
      suitePath,
      '--output-dir',
      outputDir,
      '--json',
      '--artifact-checksums',
    ];
    this.exec(this.kujoBin, args, { cwd, encoding: 'utf8' });
    return readEvalArtifacts(outputDir);
  }
}
