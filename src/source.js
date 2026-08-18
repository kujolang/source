// Source — application service layer.
//
// Wires the store, git, domain, policy, and capability layers into the
// Work → Session → Change → Evidence → Decision → Canonical State lifecycle.
// This is the single source of truth for all mutations; the CLI and API are
// thin clients over it.

import path from 'node:path';
import fs from 'node:fs';
import { Store } from './store.js';
import { GitRepo } from './git.js';
import { CapabilityService } from './capability.js';
import {
  createProject,
  createWork,
  createSession,
  createChange,
  createEvidence,
  createDecision,
  createPrincipal,
  transitionWork,
  transitionChange,
  decisionToChangeState,
} from './domain.js';
import { defaultPolicy, evaluateEvidence, interpret, canApprove } from './policy.js';
import { nextId } from './ids.js';
import { normalizeEvalSummary, normalizeEvalManifest, normalizeEvalRun, readEvalArtifacts } from './integrations/kujo.js';

export class Source {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.store = new Store(dataRoot);
    this.capabilities = new CapabilityService(this.store);
  }

  // --- path helpers -----------------------------------------------------
  _orgRel(orgId) {
    return `orgs/${orgId}`;
  }
  _projectRel(orgId, projectId) {
    return `orgs/${orgId}/projects/${projectId}`;
  }
  _repoPath(orgId, projectId, repoId) {
    return path.join(this.dataRoot, this._projectRel(orgId, projectId), 'repos', `${repoId}.git`);
  }

  // --- instance / org / project ----------------------------------------
  initInstance({ name, hosted = false, domains = [] }) {
    if (this.store.readJson('instance.json')) {
      throw new Error('instance already initialized');
    }
    const instance = {
      id: 'instance',
      name,
      hosted,
      domains,
      apiVersion: '1',
      createdAt: new Date().toISOString(),
    };
    this.store.writeJson('instance.json', instance);
    this.store.audit({ event: 'instance.init', name });
    return instance;
  }

  getInstance() {
    return this.store.readJson('instance.json');
  }

  createOrg({ name, slug }) {
    const id = nextId(this.store, 'project'); // reuse a counter; org ids are O<n>
    const orgId = `O${id.slice(1)}`;
    const org = { id: orgId, name, slug, visibility: 'private', createdAt: new Date().toISOString() };
    this.store.writeJson(`${this._orgRel(orgId)}/org.json`, org);
    this.store.audit({ event: 'org.create', orgId, name });
    return org;
  }

  getOrg(orgId) {
    return this.store.readJson(`${this._orgRel(orgId)}/org.json`);
  }

  createProject({ orgId, slug, name, description = '', visibility = 'private' }) {
    const id = nextId(this.store, 'project');
    const project = createProject({ id, slug, name, description, visibility, ownerOrg: orgId });
    const rel = this._projectRel(orgId, id);
    this.store.writeJson(`${rel}/project.json`, project);
    this.store.writeJson(`${rel}/policy.json`, defaultPolicy());
    this.store.audit({ event: 'project.create', orgId, projectId: id, name });
    return project;
  }

  getProject(orgId, projectId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/project.json`);
  }

  listProjects(orgId) {
    const dir = path.join(this.dataRoot, this._orgRel(orgId), 'projects');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => this.getProject(orgId, e.name))
      .filter(Boolean);
  }

  // --- repository -------------------------------------------------------
  createRepository({ orgId, projectId, name, defaultBranch = 'main' }) {
    const project = this.getProject(orgId, projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const id = nextId(this.store, 'repository');
    const repo = {
      id,
      projectId,
      name,
      defaultBranch,
      barePath: this._repoPath(orgId, projectId, id),
      visibility: project.visibility,
      createdAt: new Date().toISOString(),
    };
    const git = new GitRepo(repo.barePath);
    git.init(defaultBranch);
    git.enableReceivePack();
    project.repositories.push(id);
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/project.json`, project);
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/repos/${id}.json`, repo);
    this.store.audit({ event: 'repository.create', orgId, projectId, repoId: id, name });
    return repo;
  }

  getRepository(orgId, projectId, repoId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/repos/${repoId}.json`);
  }

  gitRepo(orgId, projectId, repoId) {
    const repo = this.getRepository(orgId, projectId, repoId);
    if (!repo) throw new Error(`repository not found: ${repoId}`);
    return new GitRepo(repo.barePath);
  }

  // Absolute path to the directory containing a project's bare repositories.
  // This is the GIT_PROJECT_ROOT for the smart-HTTP transport.
  reposRoot(orgId, projectId) {
    return path.join(this.dataRoot, this._projectRel(orgId, projectId), 'repos');
  }

  // Resolve a repository by id (R1) or name (main) within a project.
  resolveRepository(orgId, projectId, repoRef) {
    const project = this.getProject(orgId, projectId);
    if (!project) return null;
    for (const id of project.repositories) {
      const repo = this.getRepository(orgId, projectId, id);
      if (repo && (repo.id === repoRef || repo.name === repoRef)) return repo;
    }
    return null;
  }

  // --- principals -------------------------------------------------------
  createPrincipal({ type, name }) {
    const id = nextId(this.store, 'principal');
    const principal = createPrincipal({ id, type, name });
    this.store.writeJson(`principals/${id}.json`, principal);
    this.store.audit({ event: 'principal.create', principalId: id, type, name });
    return principal;
  }

  getPrincipal(id) {
    return this.store.readJson(`principals/${id}.json`);
  }

  // --- work -------------------------------------------------------------
  createWork({ orgId, projectId, intent, type = 'task', requester, requirements = [], acceptanceConditions = [], requiredEvidence = [], priority = 'medium' }) {
    const id = nextId(this.store, 'work');
    const work = createWork({ id, type, intent, requester, requirements, acceptanceConditions, requiredEvidence, priority });
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/work/${id}.json`, work);
    this.store.audit({ event: 'work.create', orgId, projectId, workId: id, intent });
    return work;
  }

  getWork(orgId, projectId, workId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/work/${workId}.json`);
  }

  listWork(orgId, projectId) {
    const ids = this.store.listJson(`${this._projectRel(orgId, projectId)}/work`);
    return ids.map((id) => this.getWork(orgId, projectId, id)).filter(Boolean);
  }

  _saveWork(orgId, projectId, work) {
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/work/${work.id}.json`, work);
  }

  claimWork({ orgId, projectId, workId, principalId }) {
    const work = this.getWork(orgId, projectId, workId);
    if (!work) throw new Error(`work not found: ${workId}`);
    transitionWork(work, 'claimed');
    work.assignee = principalId;
    this._saveWork(orgId, projectId, work);
    this.store.audit({ event: 'work.claim', orgId, projectId, workId, principalId });
    return work;
  }

  assignWork({ orgId, projectId, workId, principalId }) {
    const work = this.getWork(orgId, projectId, workId);
    if (!work) throw new Error(`work not found: ${workId}`);
    work.assignee = principalId;
    this._saveWork(orgId, projectId, work);
    this.store.audit({ event: 'work.assign', orgId, projectId, workId, principalId });
    return work;
  }

  // --- session ----------------------------------------------------------
  startSession({ orgId, projectId, workId, principalId, environment = {}, baseCommit = '' }) {
    const work = this.getWork(orgId, projectId, workId);
    if (!work) throw new Error(`work not found: ${workId}`);
    transitionWork(work, 'in_progress');
    const id = nextId(this.store, 'session');
    const session = createSession({ id, workId, principal: principalId, environment, baseCommit });
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/sessions/${id}.json`, session);
    work.sessions.push(id);
    this._saveWork(orgId, projectId, work);
    this.store.audit({ event: 'session.start', orgId, projectId, workId, sessionId: id, principalId });
    return session;
  }

  getSession(orgId, projectId, sessionId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/sessions/${sessionId}.json`);
  }

  completeSession({ orgId, projectId, sessionId, result }) {
    const session = this.getSession(orgId, projectId, sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    session.endedAt = new Date().toISOString();
    session.result = result;
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/sessions/${sessionId}.json`, session);
    this.store.audit({ event: 'session.complete', orgId, projectId, sessionId, result });
    return session;
  }

  // --- change -----------------------------------------------------------
  submitChange({ orgId, projectId, workId, sessionId, baseCommit, headCommit, repositories = [] }) {
    const work = this.getWork(orgId, projectId, workId);
    if (!work) throw new Error(`work not found: ${workId}`);
    transitionWork(work, 'submitted');
    const id = nextId(this.store, 'change');
    const change = createChange({ id, workId, sessionId, baseCommit, headCommit, repositories });
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/changes/${id}.json`, change);
    work.changes.push(id);
    this._saveWork(orgId, projectId, work);
    const session = this.getSession(orgId, projectId, sessionId);
    if (session) {
      session.changes.push(id);
      this.store.writeJson(`${this._projectRel(orgId, projectId)}/sessions/${sessionId}.json`, session);
    }
    this.store.audit({ event: 'change.submit', orgId, projectId, workId, changeId: id, baseCommit, headCommit });
    return change;
  }

  getChange(orgId, projectId, changeId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/changes/${changeId}.json`);
  }

  listChanges(orgId, projectId) {
    const ids = this.store.listJson(`${this._projectRel(orgId, projectId)}/changes`);
    return ids.map((id) => this.getChange(orgId, projectId, id)).filter(Boolean);
  }

  _saveChange(orgId, projectId, change) {
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/changes/${change.id}.json`, change);
  }

  // --- evidence ---------------------------------------------------------
  addEvidence({ orgId, projectId, changeId, subject, claim, type, producer, artifact = null, result = null, provenance = {}, environment = {}, sourceRevision = null, validity = 'valid' }) {
    const change = this.getChange(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    const id = nextId(this.store, 'evidence');
    let artifactRef = null;
    if (artifact != null) {
      const bytes = Buffer.isBuffer(artifact) ? artifact : Buffer.from(String(artifact), 'utf8');
      artifactRef = this.store.putArtifact(bytes);
    }
    const evidence = createEvidence({ id, subject, claim, type, producer, artifactRef, result, provenance, environment, sourceRevision, validity });
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/evidence/${id}.json`, evidence);
    change.evidence.push(id);
    this._saveChange(orgId, projectId, change);
    this.store.audit({ event: 'evidence.add', orgId, projectId, changeId, evidenceId: id, type, claim, validity });
    return evidence;
  }

  getEvidence(orgId, projectId, evidenceId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/evidence/${evidenceId}.json`);
  }

  listEvidence(orgId, projectId) {
    const ids = this.store.listJson(`${this._projectRel(orgId, projectId)}/evidence`);
    return ids.map((id) => this.getEvidence(orgId, projectId, id)).filter(Boolean);
  }

  getArtifact(hash) {
    return this.store.getArtifact(hash);
  }

  // Ingest a normalized Evidence descriptor (from a Kujo adapter or any other
  // producer) plus its original artifact. The descriptor carries subject, claim,
  // type, result, provenance, and validity; the artifact is preserved verbatim.
  ingestEvidence({ orgId, projectId, changeId, producer, descriptor, artifact = null }) {
    return this.addEvidence({
      orgId,
      projectId,
      changeId,
      subject: descriptor.subject,
      claim: descriptor.claim,
      type: descriptor.type,
      producer,
      artifact,
      result: descriptor.result,
      provenance: descriptor.provenance,
      environment: descriptor.environment ?? {},
      sourceRevision: descriptor.sourceRevision ?? null,
      validity: descriptor.validity ?? 'valid',
    });
  }

  // Ingest a Kujo Eval output directory as first-class Evidence. Reads
  // summary.json, artifact-manifest.json, and last_run.json, normalizes each,
  // and preserves the original artifacts content-addressed. Returns the list of
  // created Evidence records.
  ingestEvalEvidence({ orgId, projectId, changeId, producer, artifactsDir }) {
    const a = readEvalArtifacts(artifactsDir);
    const out = [];
    if (a.summary) {
      out.push(this.ingestEvidence({ orgId, projectId, changeId, producer, descriptor: normalizeEvalSummary(a.summary), artifact: a.summaryRaw }));
    }
    if (a.manifest) {
      out.push(this.ingestEvidence({ orgId, projectId, changeId, producer, descriptor: normalizeEvalManifest(a.manifest), artifact: a.manifestRaw }));
    }
    if (a.lastRun) {
      out.push(this.ingestEvidence({ orgId, projectId, changeId, producer, descriptor: normalizeEvalRun(a.lastRun), artifact: a.lastRunRaw }));
    }
    return out;
  }

  // --- policy -----------------------------------------------------------
  getPolicy(orgId, projectId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/policy.json`) ?? defaultPolicy();
  }

  // Evaluate a Change's evidence against policy. Transitions submitted -> in_review.
  evaluateChange({ orgId, projectId, changeId }) {
    const change = this.getChange(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    const policy = this.getPolicy(orgId, projectId);
    const evidenceList = change.evidence.map((id) => this.getEvidence(orgId, projectId, id)).filter(Boolean);
    const evaluation = evaluateEvidence(policy, evidenceList);
    const interpretation = interpret(evaluation);
    if (change.reviewState === 'pending') {
      transitionChange(change, 'in_review');
      this._saveChange(orgId, projectId, change);
    }
    this.store.audit({ event: 'policy.evaluate', orgId, projectId, changeId, ok: evaluation.ok, missing: evaluation.missing.length });
    return { evaluation, interpretation, change };
  }

  // --- decision ---------------------------------------------------------
  makeDecision({ orgId, projectId, changeId, decision, decider, reasoning = '' }) {
    const change = this.getChange(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    const policy = this.getPolicy(orgId, projectId);
    const deciderPrincipal = this.getPrincipal(decider);
    if (!deciderPrincipal) throw new Error(`principal not found: ${decider}`);

    // Approval authority: only a principal of the required type may accept.
    if (decision === 'accepted' && !canApprove(policy, deciderPrincipal.type)) {
      throw new Error(`principal type ${deciderPrincipal.type} may not accept (policy requires human)`);
    }

    // Evidence must be satisfied before acceptance.
    if (decision === 'accepted') {
      const evidenceList = change.evidence.map((id) => this.getEvidence(orgId, projectId, id)).filter(Boolean);
      const evaluation = evaluateEvidence(policy, evidenceList);
      if (!evaluation.ok) {
        throw new Error(`cannot accept: missing evidence (${evaluation.missing.map((m) => m.type).join(', ')})`);
      }
    }

    const id = nextId(this.store, 'decision');
    const evidenceSnapshot = change.evidence.map((eid) => {
      const e = this.getEvidence(orgId, projectId, eid);
      return e ? { id: eid, integrity: e.integrity } : null;
    }).filter(Boolean);
    const decisionRecord = createDecision({
      id,
      changeId,
      decision,
      decider,
      authority: 'policy',
      policyRef: policy.id,
      evidenceSnapshot,
      reasoning,
      sourceState: change.headCommit,
    });
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/decisions/${id}.json`, decisionRecord);

    // A Decision may be made directly (without a prior evaluate step); ensure
    // the Change has entered review before recording the terminal state.
    if (change.reviewState === 'pending') {
      transitionChange(change, 'in_review');
    }
    change.decisionState = decisionToChangeState(decision);
    if (decision === 'accepted') transitionChange(change, 'approved');
    else if (decision === 'rejected') transitionChange(change, 'rejected');
    else if (decision === 'revision_requested') transitionChange(change, 'changes_requested');
    this._saveChange(orgId, projectId, change);

    const work = this.getWork(orgId, projectId, change.workId);
    if (work) {
      work.decisions.push(id);
      // Work must pass through in_review before a terminal decision state.
      if (work.status === 'submitted') {
        transitionWork(work, 'in_review');
      }
      if (decision === 'accepted') transitionWork(work, 'accepted');
      else if (decision === 'rejected') transitionWork(work, 'rejected');
      else if (decision === 'revision_requested') transitionWork(work, 'revision_requested');
      this._saveWork(orgId, projectId, work);
    }

    this.store.audit({ event: 'decision.make', orgId, projectId, changeId, decisionId: id, decision, decider });
    return decisionRecord;
  }

  getDecision(orgId, projectId, decisionId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/decisions/${decisionId}.json`);
  }

  // --- canonical state update (on accept) -------------------------------
  // Fast-forward the default branch to the Change's head commit, guarded by
  // the base commit (TOCTOU). Returns {ok, reason}.
  updateCanonicalState({ orgId, projectId, changeId, repoId }) {
    const change = this.getChange(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    if (change.decisionState !== 'accepted') {
      throw new Error(`change not accepted (state: ${change.decisionState})`);
    }
    const git = this.gitRepo(orgId, projectId, repoId);
    if (!git.hasCommit(change.headCommit)) {
      return { ok: false, reason: 'head commit not present in repository' };
    }
    const branch = git.defaultBranch();
    const result = git.fastForward(change.baseCommit, change.headCommit, branch);
    this.store.audit({ event: 'canonical.update', orgId, projectId, changeId, repoId, branch, ...result });
    if (result.ok) {
      const work = this.getWork(orgId, projectId, change.workId);
      if (work && work.status === 'accepted') {
        transitionWork(work, 'closed');
        this._saveWork(orgId, projectId, work);
      }
    }
    return result;
  }

  // --- contribution flow -------------------------------------------------
  // The low-friction path for a developer who knows Git but not Source:
  // clone → modify → `source submit`. Creates contribution Work, a Session, a
  // Change against the exact base state, deterministic footprint evidence, and
  // evaluates policy. Returns the full lifecycle for inspection.
  submitContribution({ orgId, projectId, repoRef, baseCommit, headCommit, intent = '', contributorName = 'contributor' }) {
    const repo = this.resolveRepository(orgId, projectId, repoRef);
    if (!repo) throw new Error(`repository not found: ${repoRef}`);
    const git = this.gitRepo(orgId, projectId, repo.id);
    if (!git.hasCommit(headCommit)) throw new Error('head commit not present in repository');
    if (baseCommit && !git.hasCommit(baseCommit)) throw new Error('base commit not present in repository');
    if (baseCommit === headCommit) throw new Error('no changes to submit (base == head)');

    // Contributor identity: a human principal (no auth in the MVP).
    const principal = this.createPrincipal({ type: 'human', name: contributorName });

    // Contribution Work → claim → Session → Change.
    const work = this.createWork({
      orgId,
      projectId,
      intent: intent || `Contribution to ${repo.name}`,
      type: 'contribution',
      requester: principal.id,
    });
    this.claimWork({ orgId, projectId, workId: work.id, principalId: principal.id });
    const session = this.startSession({ orgId, projectId, workId: work.id, principalId: principal.id, baseCommit });
    const change = this.submitChange({ orgId, projectId, workId: work.id, sessionId: session.id, baseCommit, headCommit, repositories: [repo.id] });

    // Deterministic footprint evidence (always available, no LLM, no test suite).
    const changed = git.changedFiles(baseCommit, headCommit);
    const nonEmpty = changed.length > 0;
    const footprint = this.addEvidence({
      orgId,
      projectId,
      changeId: change.id,
      subject: 'change footprint',
      claim: 'change is non-empty',
      type: 'test',
      producer: principal.id,
      artifact: JSON.stringify({ changedFiles: changed, nonEmpty }),
      result: { status: nonEmpty ? 'pass' : 'fail' },
      validity: nonEmpty ? 'valid' : 'invalid',
    });

    // Evaluate policy. The footprint evidence is real but does not satisfy the
    // project's full required evidence (tests/eval); the maintainer's
    // verification service fills those. Missing evidence is visible here.
    const evaluation = this.evaluateChange({ orgId, projectId, changeId: change.id });

    return {
      work,
      session,
      change,
      evidence: footprint,
      evaluation: evaluation.evaluation,
      interpretation: evaluation.interpretation,
    };
  }

  // --- audit ------------------------------------------------------------
  readAudit() {
    return this.store.readAudit();
  }
}
