// Exact-candidate verification contracts. Hashing proves identity/integrity;
// trusted service authorization (not the hash) establishes who may attest.
import { planVerification } from './impact-planner.js';
import { gateAdapters } from './integrations/control-tools.js';
import { digest } from './integration-planner.js';

const hash = /^[a-f0-9]{64}$/;
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const map = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function validateVerificationPolicy(policy) {
  if (!map(policy) || !text(policy.version) || !text(policy.securityPolicyVersion) || !Array.isArray(policy.checks) || !policy.checks.length || policy.checks.length > 100) throw new Error('verification policy requires version, security policy version and 1-100 checks');
  const ids = new Set();
  for (const check of policy.checks) {
    if (!text(check.id) || ids.has(check.id) || !text(check.version)) throw new Error('invalid or duplicate check identity');
    ids.add(check.id);
    if (check.adapter != null && !gateAdapters.includes(check.adapter)) throw new Error('unsupported or context-only verification adapter');
    if (check.tier != null && ![0, 1, 2, 3].includes(check.tier)) throw new Error('invalid verification tier');
    if (check.optionalByImpact != null && typeof check.optionalByImpact !== 'boolean') throw new Error('invalid applicability flag');
    if (!Array.isArray(check.command) || !check.command.length || !check.command.every(text)) throw new Error('check requires an explicit command argument array');
    if (!map(check.toolVersions) || !Object.keys(check.toolVersions).length || !Object.values(check.toolVersions).every(text)) throw new Error('check requires pinned tool versions');
    if (!text(check.environment) || !map(check.inputs) || !map(check.externalState)) throw new Error('check requires environment, input and external-state identities');
    if (typeof check.deterministic !== 'boolean' || !Number.isSafeInteger(check.maxAgeMs) || check.maxAgeMs <= 0 || check.maxAgeMs > 7 * 24 * 60 * 60 * 1000) throw new Error('invalid verification reuse lifetime');
    if (!Array.isArray(check.producers) || !check.producers.length || !check.producers.every(text)) throw new Error('check requires trusted producer identities');
  }
  return policy;
}

export function verificationIdentity(candidate, policy, checkId) {
  validateVerificationPolicy(policy);
  if (!candidate || !hash.test(candidate.id) || !oid.test(candidate.headCommit) || !oid.test(candidate.tree)) throw new Error('invalid exact candidate identity');
  const check = policy.checks.find((item) => item.id === checkId);
  if (!check) throw new Error('check is not required by active policy');
  return digest({
    version: 1, candidate: { id: candidate.id, commit: candidate.headCommit, tree: candidate.tree },
    policy: digest(policy), check,
  });
}

export function createVerificationReceipt({ candidate, policy, checkId, producer, execution, artifactRef, now = Date.now() }) {
  const identity = verificationIdentity(candidate, policy, checkId);
  const check = policy.checks.find((item) => item.id === checkId);
  if (!producer || producer.type !== 'service' || !check.producers.includes(producer.id)) throw new Error('untrusted verification producer');
  if (!execution || execution.identity !== identity || execution.commit !== candidate.headCommit || execution.tree !== candidate.tree) throw new Error('execution does not identify the exact candidate');
  if (execution.environment !== check.environment || digest(execution.command) !== digest(check.command) || digest(execution.inputs) !== digest(check.inputs) || digest(execution.toolVersions) !== digest(check.toolVersions) || digest(execution.externalState) !== digest(check.externalState)) throw new Error('execution inputs differ from verification policy');
  if (!['pass', 'fail', 'cancelled', 'timeout'].includes(execution.status) || !Number.isSafeInteger(execution.durationMs) || execution.durationMs < 0) throw new Error('invalid execution outcome');
  if (!Number.isSafeInteger(execution.startedAt) || !Number.isSafeInteger(execution.finishedAt) || execution.finishedAt < execution.startedAt || execution.finishedAt > now || now - execution.startedAt > check.maxAgeMs) throw new Error('execution time is invalid or expired');
  if (!artifactRef || !hash.test(artifactRef.hash)) throw new Error('original execution artifact is required');
  const receipt = {
    version: 1, identity, candidateId: candidate.id, commit: candidate.headCommit, tree: candidate.tree,
    policyHash: digest(policy), checkId, producer: producer.id, execution, artifactRef,
    recordedAt: now, expiresAt: execution.startedAt + check.maxAgeMs,
    provenance: 'authorized-service-attestation',
  };
  const { recordedAt, ...identityFields } = receipt;
  return { ...receipt, id: digest(identityFields) };
}

export function evaluateVerification({ candidate, policy, receipts, now = Date.now(), forReuse = false }) {
  validateVerificationPolicy(policy);
  const plan = planVerification(candidate, policy);
  const selected = new Set(plan.checks.map((check) => check.id));
  const checks = policy.checks.filter((check) => selected.has(check.id)).map((check) => {
    const identity = verificationIdentity(candidate, policy, check.id);
    if (forReuse && !check.deterministic) return { checkId: check.id, satisfied: false, reason: 'environment-dependent check must rerun' };
    const matching = receipts.filter((receipt) => {
      const { id, recordedAt, ...content } = receipt;
      return id === digest(content) && receipt.identity === identity && receipt.candidateId === candidate.id && receipt.commit === candidate.headCommit && receipt.tree === candidate.tree && receipt.policyHash === digest(policy) && check.producers.includes(receipt.producer) && receipt.provenance === 'authorized-service-attestation';
    }).sort((a, b) => b.execution.finishedAt - a.execution.finishedAt || Number(a.execution.status === 'pass') - Number(b.execution.status === 'pass') || b.recordedAt - a.recordedAt || a.id.localeCompare(b.id));
    const latest = matching[0];
    if (!latest) return { checkId: check.id, satisfied: false, reason: 'no receipt for exact candidate, policy and inputs' };
    if (latest.expiresAt <= now) return { checkId: check.id, satisfied: false, reason: 'receipt expired' };
    if (latest.execution.status !== 'pass') return { checkId: check.id, satisfied: false, reason: `latest execution ${latest.execution.status}`, receiptId: latest.id };
    return { checkId: check.id, satisfied: true, reason: forReuse ? 'identical deterministic verification identity remains valid' : 'exact candidate verified', receiptId: latest.id };
  });
  return { ok: checks.length > 0 && checks.every((check) => check.satisfied), checks, plan };
}
