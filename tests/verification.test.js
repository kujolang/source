import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../src/integration-planner.js';
import { validateVerificationPolicy, verificationIdentity, createVerificationReceipt, evaluateVerification } from '../src/verification.js';

const candidate = { id: 'a'.repeat(64), headCommit: 'b'.repeat(40), tree: 'c'.repeat(40) };
const policy = { version: '1', securityPolicyVersion: '1', checks: [{
  id: 'integration', version: '1', command: ['npm', 'test'], toolVersions: { node: '26.12.1' },
  environment: 'image:sha256:exact', inputs: { lockfile: 'hash-1' }, externalState: { contract: 'v1' },
  deterministic: true, maxAgeMs: 60_000, producers: ['verifier'],
}] };
function receipt(status = 'pass', now = 10_000) {
  const check = policy.checks[0];
  return createVerificationReceipt({ candidate, policy, checkId: check.id, producer: { id: 'verifier', type: 'service' }, now,
    artifactRef: { hash: 'd'.repeat(64) }, execution: {
      identity: verificationIdentity(candidate, policy, check.id), commit: candidate.headCommit, tree: candidate.tree,
      command: check.command, environment: check.environment, inputs: check.inputs, toolVersions: check.toolVersions,
      externalState: check.externalState, status, durationMs: 100, startedAt: now - 100, finishedAt: now,
    },
  });
}

test('verification binds every policy input and exact candidate, not a similar diff', () => {
  const saved = receipt();
  assert.equal(evaluateVerification({ candidate, policy, receipts: [saved], now: 11_000 }).ok, true);
  for (const key of ['id', 'headCommit', 'tree']) {
    const modified = { ...candidate, [key]: 'e'.repeat(candidate[key].length) };
    assert.equal(evaluateVerification({ candidate: modified, policy, receipts: [saved], now: 11_000 }).ok, false);
  }
  for (const [key, value] of Object.entries({ version: '2', environment: 'new-image', inputs: { lockfile: 'hash-2' }, externalState: { contract: 'v2' }, toolVersions: { node: 'new' }, command: ['npm', 'run', 'other'] })) {
    const changed = structuredClone(policy); changed.checks[0][key] = value;
    assert.equal(evaluateVerification({ candidate, policy: changed, receipts: [saved], now: 11_000 }).ok, false, key);
  }
  assert.equal(evaluateVerification({ candidate, policy: { ...policy, securityPolicyVersion: '2' }, receipts: [saved], now: 11_000 }).ok, false);
});

test('expiry, later failure, corruption and environment-dependent reuse fail closed', () => {
  const saved = receipt();
  assert.equal(evaluateVerification({ candidate, policy, receipts: [saved], now: saved.expiresAt }).ok, false);
  assert.equal(evaluateVerification({ candidate, policy, receipts: [saved, receipt('fail', 11_000)], now: 11_000 }).ok, false);
  const corrupt = structuredClone(saved); corrupt.execution.status = 'fail';
  assert.equal(evaluateVerification({ candidate, policy, receipts: [corrupt], now: 11_000 }).ok, false);
  assert.equal(evaluateVerification({ candidate, policy, receipts: [saved], now: 11_000, forReuse: true }).ok, true);
  const dependent = structuredClone(policy); dependent.checks[0].deterministic = false;
  assert.match(evaluateVerification({ candidate, policy: dependent, receipts: [], forReuse: true }).checks[0].reason, /must rerun/);
});

test('producer and original execution metadata must match independently of artifact hashing', () => {
  const saved = receipt();
  const args = { candidate, policy, checkId: 'integration', producer: { id: 'verifier', type: 'service' }, execution: saved.execution, artifactRef: saved.artifactRef, now: 10_000 };
  for (const producer of [{ id: 'agent', type: 'agent' }, { id: 'other', type: 'service' }, { id: 'verifier', type: 'human' }]) {
    assert.throws(() => createVerificationReceipt({ ...args, producer }), /untrusted/);
  }
  assert.equal(createVerificationReceipt({ ...args, now: 11_000 }).id, saved.id, 'redelivery retains receipt identity');
  assert.throws(() => createVerificationReceipt({ ...args, artifactRef: null }), /artifact/);
  assert.throws(() => createVerificationReceipt({ ...args, execution: { ...saved.execution, tree: 'f'.repeat(40) } }), /exact candidate/);
  assert.throws(() => createVerificationReceipt({ ...args, execution: { ...saved.execution, inputs: {} } }), /inputs differ/);
  assert.throws(() => createVerificationReceipt({ ...args, execution: { ...saved.execution, finishedAt: 20_000 } }), /time/);
  assert.throws(() => validateVerificationPolicy({ ...policy, checks: [] }), /1-100/);
  assert.notEqual(digest(policy), digest({ ...policy, version: '2' }));
});
