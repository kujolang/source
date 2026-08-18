// Source — domain object model and lifecycle state machines.
//
// Pure functions: no I/O. The application service (source.js) wires these to
// the store, git, policy, and capability layers.

export const WORK_STATES = [
  'open',
  'claimed',
  'in_progress',
  'submitted',
  'in_review',
  'accepted',
  'rejected',
  'revision_requested',
  'closed',
];

export const DECISIONS = [
  'accepted',
  'rejected',
  'revision_requested',
  'superseded',
  'deferred',
  'released',
];

export const PRINCIPAL_TYPES = ['human', 'agent', 'service', 'organization'];

export const EVIDENCE_TYPES = [
  'test',
  'eval',
  'spec',
  'scent',
  'shipcheck',
  'runledger',
  'casefile',
  'patchbrief',
  'changebucket',
  'static_analysis',
  'security',
  'benchmark',
  'human_review',
  'agent_review',
  'runtime',
  'reproduction',
  'policy_check',
  'external',
];

// --- factories ----------------------------------------------------------

export function createProject({ id, slug, name, description = '', visibility = 'private', ownerOrg }) {
  return {
    id,
    slug,
    name,
    description,
    visibility,
    ownerOrg,
    repositories: [],
    policyRef: null,
    createdAt: new Date().toISOString(),
  };
}

export function createWork({ id, type = 'task', intent, requester, requirements = [], acceptanceConditions = [], requiredEvidence = [], priority = 'medium' }) {
  return {
    id,
    type,
    intent,
    requester,
    requirements,
    constraints: [],
    context: '',
    priority,
    dependencies: [],
    assignee: null,
    requiredEvidence,
    acceptanceConditions,
    status: 'open',
    sessions: [],
    changes: [],
    decisions: [],
    createdAt: new Date().toISOString(),
  };
}

export function createSession({ id, workId, principal, environment = {}, baseCommit = '' }) {
  return {
    id,
    workId,
    principal,
    environment,
    startedAt: new Date().toISOString(),
    endedAt: null,
    baseCommit,
    tools: [],
    skills: [],
    workflow: null,
    model: null,
    events: [],
    artifacts: [],
    result: null,
    evidence: [],
    changes: [],
  };
}

export function createChange({ id, workId, sessionId, baseCommit, headCommit, repositories = [] }) {
  return {
    id,
    workId,
    sessionId,
    baseCommit,
    headCommit,
    repositories,
    diffRef: null,
    evidence: [],
    reviewState: 'pending',
    conflictState: 'unknown',
    decisionState: 'undecided',
    createdAt: new Date().toISOString(),
  };
}

export function createEvidence({ id, subject, claim, type, producer, artifactRef = null, result = null, provenance = {}, environment = {}, sourceRevision = null }) {
  return {
    id,
    subject,
    claim,
    type,
    producer,
    artifactRef,
    result,
    provenance,
    environment,
    sourceRevision,
    validity: 'valid',
    expiresAt: null,
    relationships: [],
    integrity: artifactRef ? artifactRef.hash : null,
    createdAt: new Date().toISOString(),
  };
}

export function createDecision({ id, changeId, decision, decider, authority, policyRef, evidenceSnapshot = [], reasoning = '', sourceState = '' }) {
  return {
    id,
    changeId,
    decision,
    decider,
    authority,
    policyRef,
    evidenceSnapshot,
    reasoning,
    sourceState,
    timestamp: new Date().toISOString(),
  };
}

export function createPrincipal({ id, type, name }) {
  if (!PRINCIPAL_TYPES.includes(type)) throw new Error(`invalid principal type: ${type}`);
  return { id, type, name, createdAt: new Date().toISOString() };
}

export function createCapability({ id, principalId, scope, allowed = [], denied = [], expiresAt, credential }) {
  return {
    id,
    principalId,
    scope,
    allowed,
    denied,
    expiresAt,
    credential,
    issuedAt: new Date().toISOString(),
    revoked: false,
  };
}

// --- Work state machine -------------------------------------------------

const WORK_TRANSITIONS = {
  open: ['claimed'],
  claimed: ['in_progress', 'open'],
  in_progress: ['submitted', 'claimed'],
  submitted: ['in_review'],
  in_review: ['accepted', 'rejected', 'revision_requested'],
  revision_requested: ['in_progress'],
  accepted: ['closed'],
  rejected: ['closed'],
  closed: [],
};

export function transitionWork(work, to) {
  const allowed = WORK_TRANSITIONS[work.status] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`invalid work transition: ${work.status} -> ${to}`);
  }
  work.status = to;
  return work;
}

// --- Change state machine ------------------------------------------------

export function transitionChange(change, reviewState) {
  const allowed = {
    pending: ['in_review', 'rejected'],
    in_review: ['approved', 'changes_requested', 'rejected'],
    changes_requested: ['pending', 'in_review'],
    approved: [],
    rejected: [],
  };
  const ok = allowed[change.reviewState] ?? [];
  if (!ok.includes(reviewState)) {
    throw new Error(`invalid change review transition: ${change.reviewState} -> ${reviewState}`);
  }
  change.reviewState = reviewState;
  return change;
}

// Map a Decision to a Change decisionState.
export function decisionToChangeState(decision) {
  switch (decision) {
    case 'accepted':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    case 'revision_requested':
      return 'changes_requested';
    case 'superseded':
      return 'superseded';
    case 'deferred':
      return 'deferred';
    case 'released':
      return 'released';
    default:
      return 'undecided';
  }
}
