// Source — deterministic policy evaluation.
//
// Policy is data, evaluated deterministically. It never invokes an LLM.
// Evaluation answers: which required evidence is satisfied, which is missing,
// and whether a Decision may accept the Change.

export function defaultPolicy() {
  return {
    id: 'policy:default',
    requiredEvidence: [
      { type: 'test', claim: 'tests pass' },
      { type: 'eval', claim: 'deterministic checks pass' },
    ],
    approvalRequirements: [{ principalType: 'human', action: 'accept_change' }],
    agentRestrictions: {
      denied: ['accept_change', 'modify_policy', 'publish_release'],
    },
    changeBoundaries: {},
    releaseRules: [],
    securityRequirements: [],
    escalationRules: [],
  };
}

// Evaluate a Change's evidence against a policy's required evidence.
// Returns { satisfied: [...], missing: [...], ok: boolean }.
export function evaluateEvidence(policy, evidenceList) {
  const required = policy.requiredEvidence ?? [];
  const satisfied = [];
  const missing = [];

  for (const req of required) {
    const match = evidenceList.find(
      (e) => e.type === req.type && (req.claim ? e.claim === req.claim : true) && e.validity === 'valid',
    );
    if (match) satisfied.push({ requirement: req, evidence: match });
    else missing.push(req);
  }

  return { satisfied, missing, ok: missing.length === 0 };
}

// Produce a human-readable interpretation of an evaluation.
export function interpret(evaluation) {
  const lines = [];
  if (evaluation.ok) {
    lines.push('Ready for review');
    lines.push('Requirements satisfied');
  } else {
    lines.push('Not ready for review');
    lines.push(`Missing evidence: ${evaluation.missing.length}`);
  }
  for (const m of evaluation.missing) {
    lines.push(`- missing ${m.type}: ${m.claim}`);
  }
  for (const s of evaluation.satisfied) {
    lines.push(`- satisfied ${s.requirement.type}: ${s.requirement.claim}`);
  }
  return lines;
}

// Does a principal (with a given type) satisfy the approval requirements?
export function canApprove(policy, principalType) {
  const reqs = policy.approvalRequirements ?? [];
  if (reqs.length === 0) return true;
  return reqs.some((r) => r.principalType === principalType);
}
