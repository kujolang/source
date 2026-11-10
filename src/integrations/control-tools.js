// Contract adapters inspected against sibling Kujo source; see the versioned
// inventory in docs/architecture/verification-planner.md. They classify artifacts,
// never grant producer authority or assert that an artifact proves execution.
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const string = (v) => typeof v === 'string' && v.length > 0;
export const gateAdapters = ['changebucket', 'fence', 'concord', 'eval', 'shipcheck', 'lens', 'workcell'];
const requireShape = (ok, tool) => { if (!ok) throw new Error(`unsupported or incomplete ${tool} artifact contract`); };
const descriptor = (tool, type, claim, passed, result, report, gate = true) => ({
  subject: `${tool}:artifact`, type, claim, validity: passed ? 'valid' : 'invalid', gate,
  result, provenance: { tool, adapterVersion: 1, version: report.version || report.metadata?.version || report.workcell_version || null, schemaVersion: report.schema_version ?? null },
});

export function normalizeControlArtifact(tool, report) {
  requireShape(object(report), tool);
  if (tool === 'changebucket') {
    requireShape((report.schema_version == null || [1, 2].includes(report.schema_version)) && object(report.summary) && Array.isArray(report.files) && report.summary.files_changed === report.files.length && report.files.every((f) => string(f.path) && Array.isArray(f.categories) && typeof f.binary === 'boolean') && object(report.budget) && typeof report.budget.checked === 'boolean' && typeof report.budget.passed === 'boolean', tool);
    return descriptor(tool, 'changebucket', 'change footprint budget passes', report.budget.checked && report.budget.passed, { ...report.summary, files: report.files, budget: report.budget }, report);
  }
  if (tool === 'fence') {
    requireShape(report.schema_version === 1 && string(report.version) && object(report.summary) && count(report.summary.errors) && count(report.summary.skipped_files) && Array.isArray(report.violations) && Array.isArray(report.skipped_files), tool);
    return descriptor(tool, 'static_analysis', 'architecture boundary policy passes', report.status === 'passed' && report.summary.errors === 0 && !report.violations.some((v) => v.severity === 'error') && report.summary.skipped_files === 0 && report.skipped_files.length === 0, report.summary, report);
  }
  if (tool === 'concord') {
    requireShape(report.tool === 'concord' && /^1\./.test(report.version) && object(report.summary) && Array.isArray(report.findings) && report.summary.total_findings === report.findings.length, tool);
    return descriptor(tool, 'policy_check', 'no artifact drift', report.findings.length === 0, report.summary, report);
  }
  if (tool === 'eval') {
    requireShape(['PASS', 'FAIL'].includes(report.status) && string(report.suite_name) && string(report.suite_version) && [report.passed, report.failed, report.skipped, report.total].every(count) && report.total === report.passed + report.failed + report.skipped, tool);
    return descriptor(tool, 'eval', 'deterministic checks pass', report.status === 'PASS' && report.failed === 0 && report.passed > 0, { status: report.status, passed: report.passed, failed: report.failed, skipped: report.skipped, total: report.total }, report);
  }
  if (tool === 'shipcheck') {
    requireShape(report.tool === 'shipcheck' && /^1\./.test(report.version) && object(report.summary) && [report.summary.total_checks, report.summary.passed, report.summary.failed_errors].every(count) && Array.isArray(report.checks) && report.checks.length === report.summary.total_checks, tool);
    return descriptor(tool, 'shipcheck', 'release-readiness gate passes', report.summary.gate_passed === 1 && report.summary.failed_errors === 0 && report.summary.total_checks > 0 && report.checks.every((check) => check.severity !== 'error' || check.passed === true || check.passed === 1), report.summary, report);
  }
  if (tool === 'spec') {
    requireShape(object(report.metadata) && report.metadata.schema_version === '1.0.0' && /^[a-f0-9]{64}$/.test(report.metadata.checksum_sha256) && (object(report.payload) || string(report.payload)), tool);
    return descriptor(tool, 'spec', 'acceptance contract recorded', true, { metadata: report.metadata, payload: report.payload }, report, false);
  }
  if (tool === 'runledger') {
    requireShape(string(report.id) && ['in_progress', 'pass', 'partial', 'fail', 'abandoned'].includes(report.status) && Array.isArray(report.commands) && Array.isArray(report.tests) && object(report.usage) && object(report.cost), tool);
    return descriptor(tool, 'runledger', 'execution receipt recorded', true, { id: report.id, status: report.status, startCommit: report.start_commit, endCommit: report.end_commit, tests: report.tests, usage: report.usage, cost: report.cost }, report, false);
  }
  if (tool === 'casefile') {
    requireShape(/^1\./.test(report.version) && object(report.case) && string(report.case.id) && object(report.command) && Array.isArray(report.command.argv) && Number.isInteger(report.command.exit_code) && object(report.repository) && object(report.logs), tool);
    return descriptor(tool, 'casefile', 'failure evidence package recorded', true, { id: report.case.id, exitCode: report.command.exit_code, revision: report.repository.head, logs: report.logs, classification: report.classification }, report, false);
  }
  if (tool === 'lens') {
    requireShape(report.schema_version === '1' && report.metadata?.tool === 'lens' && object(report.summary) && count(report.summary.checks_run) && Array.isArray(report.checks) && Array.isArray(report.artifacts) && Number.isInteger(report.exit_code), tool);
    return descriptor(tool, 'runtime', 'configured browser checks pass', report.status === 'PASS' && report.exit_code === 0 && report.summary.checks_run > 0 && report.checks.every((check) => ['pass', 'skipped'].includes(check.status)), { status: report.status, summary: report.summary, checks: report.checks, visual: report.visual, accessibility: report.accessibility }, report);
  }
  if (tool === 'workcell') {
    if (report.schema_version === 'workcell-receipt/v1') {
      requireShape(string(report.run_id) && string(report.source_commit) && object(report.verification) && Array.isArray(report.exported_artifacts), tool);
      const passed = report.final_status === 'completed' && report.exit_code === 0 && report.timeout === false && report.cancelled === false && report.stdout_truncated === false && report.stderr_truncated === false && ['complete', 'preserved'].includes(report.cleanup_status) && ['execution_succeeded', 'verification_succeeded', 'artifacts_exported', 'cleanup_succeeded'].every((key) => report.verification[key] === true);
      return descriptor(tool, 'runtime', 'isolated execution lifecycle completed', passed, { runId: report.run_id, revision: report.source_commit, verification: report.verification, cleanup: report.cleanup_status, environment: report.container_image_digest }, report);
    }
    requireShape(report.schema_version === 'workcell-receipt/v2alpha1' && object(report.run) && object(report.execution?.terminal) && object(report.verification) && object(report.artifacts) && object(report.cleanup) && object(report.logs), tool);
    const terminal = report.execution.terminal;
    const passed = report.run.status === 'completed' && report.run.failure_category === null && terminal.status === 'exited' && terminal.exit_code === 0 && terminal.certainty === 'terminal' && terminal.timed_out === false && terminal.cancelled === false && report.verification.status === 'passed' && ['collected', 'not-requested'].includes(report.artifacts.status) && ['complete', 'preserved'].includes(report.cleanup.status) && report.logs.truncated === false;
    return descriptor(tool, 'runtime', 'isolated execution lifecycle completed', passed, { run: report.run, terminal, verification: report.verification, cleanup: report.cleanup, backend: report.backend, controls: report.controls }, report);
  }
  throw new Error(`unsupported verification adapter: ${tool}`);
}
