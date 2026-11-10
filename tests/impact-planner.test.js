import test from 'node:test';
import assert from 'node:assert/strict';
import { planVerification } from '../src/impact-planner.js';

const policy = { impact: { version: '1', complete: true, coverage: ['src/', 'docs/', 'package.json'], dependencies: [{ from: 'src/api/', to: 'src/shared/' }, { from: 'src/ui/', to: 'src/api/' }] }, checks: [
  { id: 'format', tier: 0, optionalByImpact: true, paths: ['unaffected/'] },
  { id: 'unit-api', tier: 1, optionalByImpact: true, paths: ['src/api/'] },
  { id: 'unit-ui', tier: 1, optionalByImpact: true, paths: ['src/ui/'] },
  { id: 'unit-other', tier: 1, optionalByImpact: true, paths: ['src/other/'] },
  { id: 'combined', tier: 2, optionalByImpact: true, paths: ['unaffected/'] },
  { id: 'always-security', tier: 3 },
] };
const candidate = (...paths) => ({ proposals: [{ files: paths.map((file) => ({ status: 'M', from: file, to: file })) }] });

test('impact follows transitive dependencies without dropping mandatory checks', () => {
  const plan = planVerification(candidate('src/shared/data.js'), policy);
  assert.deepEqual(plan.checks.map((check) => check.id), ['format', 'unit-api', 'unit-ui', 'combined', 'always-security']);
  assert.equal(plan.omitted[0].id, 'unit-other');
  assert.equal(plan.conservative, false);
});

test('unknown, sensitive, release, historical failure and incomplete inputs require every check', () => {
  for (const file of ['unknown.txt', 'package.json', 'src/auth/session.js', 'src/schema.sql', 'src/generated/result.js', 'src/public-api/index.js']) {
    assert.equal(planVerification(candidate(file), policy).checks.length, policy.checks.length, file);
  }
  for (const model of [{}, { ...policy.impact, complete: false }, { ...policy.impact, release: true }, { ...policy.impact, failurePaths: ['src/shared/'] }]) {
    assert.equal(planVerification(candidate('src/shared/a.js'), { ...policy, impact: model }).checks.length, policy.checks.length);
  }
  assert.equal(planVerification({ proposals: [{}] }, policy).checks.length, policy.checks.length);
  assert.equal(planVerification(candidate('../escape'), policy).checks.length, policy.checks.length);
});

test('rename source paths and dependency cycles remain conservatively accounted for', () => {
  const renamed = { proposals: [{ files: [{ status: 'R100', from: 'src/api/old.js', to: 'docs/new.md' }] }] };
  const cyclic = structuredClone(policy); cyclic.impact.dependencies.push({ from: 'src/shared/', to: 'src/ui/' });
  const plan = planVerification(renamed, cyclic);
  assert.ok(plan.checks.some((check) => check.id === 'unit-api'));
  assert.ok(plan.checks.some((check) => check.id === 'unit-ui'));
  const unspecified = structuredClone(policy); delete unspecified.checks[0].tier;
  assert.equal(planVerification(candidate('docs/readme.md'), unspecified).checks.length, policy.checks.length);
});

test('malformed inventory fails conservatively and sensitive transitive consumers select all checks', () => {
  for (const input of [{ proposals: [null] }, { proposals: [{ files: [null] }] }]) assert.equal(planVerification(input, policy).conservative, true);
  const model = structuredClone(policy);
  model.impact.dependencies.push({ from: 'src/auth/', to: 'src/shared/' });
  assert.equal(planVerification(candidate('src/shared/a.js'), model).checks.length, model.checks.length);
  model.impact.dependencies = [null];
  assert.equal(planVerification(candidate('src/shared/a.js'), model).conservative, true);
});
