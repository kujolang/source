import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeControlArtifact, gateAdapters } from '../src/integrations/control-tools.js';

// Minimal contracts grounded in the source revisions recorded in the adapter inventory.
const reports = {
  changebucket: { schema_version: 2, summary: { files_changed: 1 }, files: [{ path: 'a.js', categories: ['source'], binary: false }], budget: { checked: true, passed: true } },
  fence: { schema_version: 1, version: '1.0.0', status: 'passed', summary: { errors: 0, skipped_files: 0 }, violations: [], skipped_files: [] },
  concord: { tool: 'concord', version: '1.0.0', summary: { total_findings: 0 }, findings: [] },
  eval: { status: 'PASS', suite_name: 'checks', suite_version: '1', passed: 1, failed: 0, skipped: 0, total: 1 },
  shipcheck: { tool: 'shipcheck', version: '1.0.0', summary: { total_checks: 1, passed: 1, failed_errors: 0, gate_passed: 1 }, checks: [{ severity: 'error', passed: true }] },
  lens: { schema_version: '1', metadata: { tool: 'lens' }, status: 'PASS', exit_code: 0, summary: { checks_run: 1 }, checks: [{ status: 'pass' }], artifacts: [], visual: { compare_enabled: false }, accessibility: { enabled: false } },
  workcell: { schema_version: 'workcell-receipt/v1', run_id: 'run', source_commit: 'a'.repeat(40), final_status: 'completed', exit_code: 0, timeout: false, cancelled: false, stdout_truncated: false, stderr_truncated: false, cleanup_status: 'complete', exported_artifacts: [], verification: { execution_succeeded: true, verification_succeeded: true, artifacts_exported: true, cleanup_succeeded: true } },
};

test('supported gate adapters classify actual contract fields and reject missing contracts', () => {
  for (const tool of gateAdapters) {
    assert.equal(normalizeControlArtifact(tool, reports[tool]).validity, 'valid', tool);
    assert.throws(() => normalizeControlArtifact(tool, {}), /contract/, tool);
  }
  assert.throws(() => normalizeControlArtifact('unknown', {}), /unsupported/);
  for (const tool of ['changebucket', 'fence', 'lens', 'workcell']) {
    assert.throws(() => normalizeControlArtifact(tool, { ...reports[tool], schema_version: 'future' }), /contract/);
  }
});

test('unchecked budgets, hidden failures, skipped scans and dry runs cannot turn green', () => {
  const bad = structuredClone(reports);
  bad.changebucket.budget.checked = false;
  bad.fence.violations = [{ severity: 'error' }];
  bad.concord.findings = [{}]; bad.concord.summary.total_findings = 1;
  bad.eval.failed = 1; bad.eval.total = 2;
  bad.shipcheck.checks[0].passed = false;
  bad.lens.checks[0].status = 'fail';
  bad.workcell.final_status = 'dry-run';
  for (const tool of gateAdapters) assert.equal(normalizeControlArtifact(tool, bad[tool]).validity, 'invalid', tool);
  const lens = normalizeControlArtifact('lens', reports.lens);
  assert.equal(lens.result.visual.compare_enabled, false);
  assert.equal(lens.result.accessibility.enabled, false);
});

test('context-only artifacts never assert that execution or acceptance succeeded', () => {
  const context = {
    spec: { metadata: { schema_version: '1.0.0', checksum_sha256: 'a'.repeat(64) }, payload: 'plain contract' },
    runledger: { id: 'run', status: 'pass', commands: [], tests: [], usage: {}, cost: {} },
    casefile: { version: '1.0.2', case: { id: 'case' }, command: { argv: ['false'], exit_code: 1 }, repository: {}, logs: {} },
  };
  for (const [tool, report] of Object.entries(context)) assert.equal(normalizeControlArtifact(tool, report).gate, false);
  assert.equal(normalizeControlArtifact('casefile', context.casefile).result.exitCode, 1);
});

test('Workcell v2 requires terminal execution, verification, artifacts, logs and cleanup', () => {
  const receipt = { schema_version: 'workcell-receipt/v2alpha1', run: { status: 'completed', failure_category: null }, execution: { terminal: { status: 'exited', exit_code: 0, certainty: 'terminal', timed_out: false, cancelled: false } }, verification: { status: 'passed' }, artifacts: { status: 'not-requested' }, cleanup: { status: 'complete' }, logs: { truncated: false } };
  assert.equal(normalizeControlArtifact('workcell', receipt).validity, 'valid');
  for (const [section, field, value] of [['execution', 'terminal', { status: 'unknown' }], ['verification', 'status', 'not-run'], ['cleanup', 'status', 'failed'], ['logs', 'truncated', true]]) {
    const altered = structuredClone(receipt); altered[section][field] = value;
    assert.equal(normalizeControlArtifact('workcell', altered).validity, 'invalid');
  }
});
