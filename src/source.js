// Source — application service layer.
//
// Wires the store, git, domain, policy, and capability layers into the
// Work → Session → Change → Evidence → Decision → Canonical State lifecycle.
// This is the single source of truth for all mutations; the CLI and API are
// thin clients over it.

import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
import { nextId, nextIdAsync, randomHex } from './ids.js';
import { normalizeEvalSummary, normalizeEvalManifest, normalizeEvalRun, readEvalArtifacts } from './integrations/kujo.js';
import { scanSecrets } from './scan.js';

const DEFAULT_HUMAN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HUMAN_SESSION_ACTIONS = ['read_source', 'read_context', 'accept_change'];

export class Source {
  // `store` is optional; defaults to the JSON-file store. Pass a SqliteStore
  // (see sqlite-store.js) for ACID transactions across records.
  constructor(dataRoot, { store } = {}) {
    this.dataRoot = dataRoot;
    this.store = store ?? new Store(dataRoot);
    this.capabilities = new CapabilityService(this.store);
  }

  _asyncWrite(rel, value) {
    return typeof this.store.writeJsonAsync === 'function' ? this.store.writeJsonAsync(rel, value) : this.store.writeJson(rel, value);
  }

  _asyncAudit(entry) {
    return typeof this.store.auditAsync === 'function' ? this.store.auditAsync(entry) : this.store.audit(entry);
  }

  _asyncTransaction(fn) {
    return typeof this.store.transactionAsync === 'function' ? this.store.transactionAsync(fn) : fn();
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

  async getInstanceAsync() {
    return typeof this.store.readJsonAsync === 'function' ? this.store.readJsonAsync('instance.json') : this.getInstance();
  }

  createOrg({ name, slug }) {
    const orgId = nextId(this.store, 'org');
    const org = { id: orgId, name, slug, visibility: 'private', createdAt: new Date().toISOString() };
    this.store.writeJson(`${this._orgRel(orgId)}/org.json`, org);
    this.store.audit({ event: 'org.create', orgId, name });
    return org;
  }

  async createOrgAsync({ name, slug }) {
    const id = await nextIdAsync(this.store, 'org');
    const org = { id, name, slug, visibility: 'private', createdAt: new Date().toISOString() };
    const write = typeof this.store.writeJsonAsync === 'function'
      ? (rel, value) => this.store.writeJsonAsync(rel, value)
      : (rel, value) => this.store.writeJson(rel, value);
    const audit = typeof this.store.auditAsync === 'function'
      ? (entry) => this.store.auditAsync(entry)
      : (entry) => this.store.audit(entry);
    const tx = typeof this.store.transactionAsync === 'function'
      ? (fn) => this.store.transactionAsync(fn)
      : (fn) => fn();
    await tx(async () => write(`${this._orgRel(id)}/org.json`, org));
    await audit({ event: 'org.create', orgId: id, name });
    return org;
  }

  getOrg(orgId) {
    return this.store.readJson(`${this._orgRel(orgId)}/org.json`);
  }

  async getOrgAsync(orgId) {
    const rel = `${this._orgRel(orgId)}/org.json`;
    return typeof this.store.readJsonAsync === 'function' ? this.store.readJsonAsync(rel) : this.getOrg(orgId);
  }

  listOrgs({ cursor, limit } = {}) {
    const ids = this.store.listJson('orgs', { cursor, limit, includeDirs: true });
    return ids.map((id) => this.getOrg(id)).filter(Boolean);
  }

  async listOrgsAsync({ cursor, limit } = {}) {
    const ids = typeof this.store.listJsonAsync === 'function'
      ? await this.store.listJsonAsync('orgs', { cursor, limit, includeDirs: true })
      : this.store.listJson('orgs', { cursor, limit, includeDirs: true });
    return Promise.all(ids.map((id) => this.getOrgAsync(id))).then((items) => items.filter(Boolean));
  }

  createProject({ orgId, slug, name, description = '', visibility = 'private' }) {
    const id = nextId(this.store, 'project');
    const project = createProject({ id, slug, name, description, visibility, ownerOrg: orgId });
    const rel = this._projectRel(orgId, id);
    this.store.transaction(() => {
      this.store.writeJson(`${rel}/project.json`, project);
      this.store.writeJson(`${rel}/policy.json`, defaultPolicy());
    });
    this.store.audit({ event: 'project.create', orgId, projectId: id, name });
    return project;
  }

  getProject(orgId, projectId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/project.json`);
  }

  async getProjectAsync(orgId, projectId) {
    const rel = `${this._projectRel(orgId, projectId)}/project.json`;
    return typeof this.store.readJsonAsync === 'function' ? this.store.readJsonAsync(rel) : this.getProject(orgId, projectId);
  }

  listProjects(orgId, { cursor, limit } = {}) {
    const ids = this.store.listJson(`${this._orgRel(orgId)}/projects`, { cursor, limit, includeDirs: true });
    return ids.map((id) => this.getProject(orgId, id)).filter(Boolean);
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
    project.repositories.push(id);
    this.store.transaction(() => {
      this.store.writeJson(`${this._projectRel(orgId, projectId)}/project.json`, project);
      this.store.writeJson(`${this._projectRel(orgId, projectId)}/repos/${id}.json`, repo);
    });
    this.store.audit({ event: 'repository.create', orgId, projectId, repoId: id, name });
    return repo;
  }

  getRepository(orgId, projectId, repoId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/repos/${repoId}.json`);
  }

  async getRepositoryAsync(orgId, projectId, repoId) {
    const rel = `${this._projectRel(orgId, projectId)}/repos/${repoId}.json`;
    return typeof this.store.readJsonAsync === 'function' ? this.store.readJsonAsync(rel) : this.getRepository(orgId, projectId, repoId);
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

  async resolveRepositoryAsync(orgId, projectId, repoRef) {
    const readJson = typeof this.store.readJsonAsync === 'function'
      ? (rel) => this.store.readJsonAsync(rel)
      : (rel) => this.store.readJson(rel);
    const project = await readJson(`${this._projectRel(orgId, projectId)}/project.json`);
    if (!project) return null;
    for (const id of project.repositories) {
      const repo = await readJson(`${this._projectRel(orgId, projectId)}/repos/${id}.json`);
      if (repo && (repo.id === repoRef || repo.name === repoRef)) return repo;
    }
    return null;
  }

  // --- principals -------------------------------------------------------
  createPrincipal({ type, name, password } = {}) {
    const id = nextId(this.store, 'principal');
    const passwordHash = type === 'human' && password ? this._hashPassword(password) : null;
    const principal = createPrincipal({ id, type, name, passwordHash });
    this.store.writeJson(`principals/${id}.json`, principal);
    this.store.audit({ event: 'principal.create', principalId: id, type, name });
    return this._publicPrincipal(principal);
  }

  async createPrincipalAsync({ type, name, password } = {}) {
    const id = await nextIdAsync(this.store, 'principal');
    const passwordHash = type === 'human' && password ? this._hashPassword(password) : null;
    const principal = createPrincipal({ id, type, name, passwordHash });
    await this._asyncWrite(`principals/${id}.json`, principal);
    await this._asyncAudit({ event: 'principal.create', principalId: id, type, name });
    return this._publicPrincipal(principal);
  }

  _publicPrincipal(principal) {
    if (!principal) return principal;
    const { passwordHash, ...publicPrincipal } = principal;
    return publicPrincipal;
  }

  _hashPassword(password) {
    if (typeof password !== 'string' || password.length < 12) throw new Error('human password must be at least 12 characters');
    const salt = randomBytes(16);
    return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`;
  }

  verifyPrincipalPassword(principalId, password) {
    const principal = this.store.readJson(`principals/${principalId}.json`);
    if (!principal?.passwordHash || typeof password !== 'string') return false;
    const [, saltHex, hashHex] = String(principal.passwordHash).split('$');
    if (!saltHex || !hashHex) return false;
    try {
      const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
      const expected = Buffer.from(hashHex, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  getPrincipal(id) {
    return this.store.readJson(`principals/${id}.json`);
  }

  async getPrincipalAsync(id) {
    const rel = `principals/${id}.json`;
    return typeof this.store.readJsonAsync === 'function' ? this.store.readJsonAsync(rel) : this.getPrincipal(id);
  }

  // --- capabilities -----------------------------------------------------
  // Issue a session-scoped capability for an agent working a specific Work item.
  // This is the "temporary session identity" grant: bounded to the org, project,
  // and work, expiring, and denied the authority to accept changes or modify
  // policy.
  issueSessionCapability({ orgId, projectId, workId, principalId }) {
    const cap = this.capabilities.issue({
      principalId,
      scope: { org: orgId, project: projectId, work: workId },
      allowed: ['read_source', 'read_context', 'submit_change', 'submit_evidence'],
      denied: ['accept_change', 'modify_policy', 'publish_release'],
    });
    this.store.audit({ event: 'capability.issue', orgId, projectId, workId, principalId, capabilityId: cap.id });
    return cap;
  }

  async issueSessionCapabilityAsync({ orgId, projectId, workId, principalId }) {
    const cap = await this.capabilities.issueAsync({
      principalId,
      scope: { org: orgId, project: projectId, work: workId },
      allowed: ['read_source', 'read_context', 'submit_change', 'submit_evidence'],
      denied: ['accept_change', 'modify_policy', 'publish_release'],
    });
    await this._asyncAudit({ event: 'capability.issue', orgId, projectId, workId, principalId, capabilityId: cap.id });
    return cap;
  }

  // Issue a project-scoped capability for Git transport (clone/fetch/push).
  // Read is always granted; push (`git_push`) is opt-in. This is the credential
  // a contributor or agent uses with `git clone`/`git push` over smart HTTP.
  issueGitCapability({ orgId, projectId, principalId, push = true }) {
    const allowed = ['read_source'];
    if (push) allowed.push('git_push');
    const cap = this.capabilities.issue({
      principalId,
      scope: { org: orgId, project: projectId },
      allowed,
    });
    this.store.audit({ event: 'capability.issue', orgId, projectId, principalId, capabilityId: cap.id, kind: 'git' });
    return cap;
  }

  // --- human sessions -------------------------------------------------
  _humanSessionRel(sessionId) {
    return `human-sessions/${sessionId}.json`;
  }

  createHumanSession({
    principalId,
    orgId,
    projectId,
    ttlMs = DEFAULT_HUMAN_SESSION_TTL_MS,
    allowed = DEFAULT_HUMAN_SESSION_ACTIONS,
  }) {
    const principal = this.getPrincipal(principalId);
    if (!principal) throw new Error(`principal not found: ${principalId}`);
    if (principal.type !== 'human') throw new Error(`principal is not human: ${principal.type}`);

    const scope = {};
    if (orgId) scope.org = orgId;
    if (projectId) scope.project = projectId;

    const capability = this.capabilities.issue({
      principalId,
      scope,
      allowed,
      ttlMs,
    });

    const sessionBase = {
      principalId,
      scope,
      credential: capability.credential,
      capabilityId: capability.id,
      createdAt: new Date().toISOString(),
      expiresAt: capability.expiresAt,
    };

    let session;
    if (typeof this.store.createHumanSessionRow === 'function') {
      session = this.store.createHumanSessionRow(principalId, capability.credential, ttlMs);
      session.scope = scope;
      session.capabilityId = capability.id;
      session.credential = capability.credential;
      session.principalId = principalId;
      session.createdAt = session.createdAt || sessionBase.createdAt;
    } else {
      session = {
        id: randomHex(24),
        ...sessionBase,
      };
      this.store.writeJson(this._humanSessionRel(session.id), session);
    }

    this.store.audit({ event: 'human.session.create', principalId, sessionId: session.id, capabilityId: capability.id, scope });
    return { ...session, principal: this._publicPrincipal(principal), capability };
  }

  getHumanSession(sessionId) {
    const session = typeof this.store.readHumanSession === 'function'
      ? this.store.readHumanSession(sessionId)
      : this.store.readJson(this._humanSessionRel(sessionId));

    if (!session) return null;
    if (!session.credential) {
      this.revokeHumanSession(sessionId);
      return null;
    }

    const capability = this.capabilities.lookup(session.credential);
    if (!capability) {
      this.revokeHumanSession(sessionId);
      return null;
    }
    if (capability.revoked) {
      this.revokeHumanSession(sessionId);
      return null;
    }
    if (capability.expiresAt && new Date(capability.expiresAt).getTime() < Date.now()) {
      this.revokeHumanSession(sessionId);
      return null;
    }

    if (session.revoked) {
      this.revokeHumanSession(sessionId);
      return null;
    }
    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
      this.revokeHumanSession(sessionId);
      return null;
    }
    return session;
  }

  revokeHumanSession(sessionId) {
    if (typeof this.store.deleteHumanSession === 'function') {
      this.store.deleteHumanSession(sessionId);
      return;
    }
    const rel = this._humanSessionRel(sessionId);
    const session = this.store.readJson(rel);
    if (!session) return;
    session.revoked = true;
    this.store.writeJson(rel, session);
  }

  // --- work -------------------------------------------------------------
  createWork({ orgId, projectId, intent, type = 'task', requester, requirements = [], acceptanceConditions = [], requiredEvidence = [], priority = 'medium' }) {
    const id = nextId(this.store, 'work');
    const work = createWork({ id, type, intent, requester, requirements, acceptanceConditions, requiredEvidence, priority });
    this.store.writeJson(`${this._projectRel(orgId, projectId)}/work/${id}.json`, work);
    this.store.audit({ event: 'work.create', orgId, projectId, workId: id, intent });
    return work;
  }

  async createWorkAsync({ orgId, projectId, intent, type = 'task', requester, requirements = [], acceptanceConditions = [], requiredEvidence = [], priority = 'medium' }) {
    const id = await nextIdAsync(this.store, 'work');
    const work = createWork({ id, type, intent, requester, requirements, acceptanceConditions, requiredEvidence, priority });
    await this._asyncWrite(`${this._projectRel(orgId, projectId)}/work/${id}.json`, work);
    await this._asyncAudit({ event: 'work.create', orgId, projectId, workId: id, intent });
    return work;
  }

  getWork(orgId, projectId, workId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/work/${workId}.json`);
  }

  async getWorkAsync(orgId, projectId, workId) {
    const rel = `${this._projectRel(orgId, projectId)}/work/${workId}.json`;
    return typeof this.store.readJsonAsync === 'function' ? this.store.readJsonAsync(rel) : this.getWork(orgId, projectId, workId);
  }

  listWork(orgId, projectId, { cursor, limit } = {}) {
    const ids = this.store.listJson(`${this._projectRel(orgId, projectId)}/work`, { cursor, limit });
    return ids.map((id) => this.getWork(orgId, projectId, id)).filter(Boolean);
  }

  async listWorkAsync(orgId, projectId, { cursor, limit } = {}) {
    const rel = `${this._projectRel(orgId, projectId)}/work`;
    const ids = typeof this.store.listJsonAsync === 'function'
      ? await this.store.listJsonAsync(rel, { cursor, limit })
      : this.store.listJson(rel, { cursor, limit });
    return Promise.all(ids.map((id) => this.getWorkAsync(orgId, projectId, id))).then((items) => items.filter(Boolean));
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

  async claimWorkAsync({ orgId, projectId, workId, principalId }) {
    const work = await this.getWorkAsync(orgId, projectId, workId);
    if (!work) throw new Error(`work not found: ${workId}`);
    transitionWork(work, 'claimed');
    work.assignee = principalId;
    await this._asyncWrite(`${this._projectRel(orgId, projectId)}/work/${work.id}.json`, work);
    await this._asyncAudit({ event: 'work.claim', orgId, projectId, workId, principalId });
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
    work.sessions.push(id);
    this.store.transaction(() => {
      this.store.writeJson(`${this._projectRel(orgId, projectId)}/sessions/${id}.json`, session);
      this._saveWork(orgId, projectId, work);
    });
    this.store.audit({ event: 'session.start', orgId, projectId, workId, sessionId: id, principalId });
    return session;
  }

  async startSessionAsync({ orgId, projectId, workId, principalId, environment = {}, baseCommit = '' }) {
    const work = await this.getWorkAsync(orgId, projectId, workId);
    if (!work) throw new Error(`work not found: ${workId}`);
    transitionWork(work, 'in_progress');
    const id = await nextIdAsync(this.store, 'session');
    const session = createSession({ id, workId, principal: principalId, environment, baseCommit });
    work.sessions.push(id);
    await this._asyncTransaction(async () => {
      await this._asyncWrite(`${this._projectRel(orgId, projectId)}/sessions/${id}.json`, session);
      await this._asyncWrite(`${this._projectRel(orgId, projectId)}/work/${work.id}.json`, work);
    });
    await this._asyncAudit({ event: 'session.start', orgId, projectId, workId, sessionId: id, principalId });
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
  submitChange({ orgId, projectId, workId, sessionId, baseCommit = '', headCommit = '', repositories = [], repositoryChanges = null }) {
    const work = this.getWork(orgId, projectId, workId);
    if (!work) throw new Error(`work not found: ${workId}`);
    transitionWork(work, 'submitted');
    const id = nextId(this.store, 'change');
    const change = createChange({ id, workId, sessionId, baseCommit, headCommit, repositories, repositoryChanges });
    work.changes.push(id);
    const session = this.getSession(orgId, projectId, sessionId);
    if (session) session.changes.push(id);
    this.store.transaction(() => {
      this.store.writeJson(`${this._projectRel(orgId, projectId)}/changes/${id}.json`, change);
      this._saveWork(orgId, projectId, work);
      if (session) this.store.writeJson(`${this._projectRel(orgId, projectId)}/sessions/${sessionId}.json`, session);
    });
    this.store.audit({ event: 'change.submit', orgId, projectId, workId, changeId: id, baseCommit, headCommit });
    return change;
  }

  async submitChangeAsync({ orgId, projectId, workId, sessionId, baseCommit = '', headCommit = '', repositories = [], repositoryChanges = null }) {
    const work = await this.getWorkAsync(orgId, projectId, workId);
    if (!work) throw new Error(`work not found: ${workId}`);
    transitionWork(work, 'submitted');
    const id = await nextIdAsync(this.store, 'change');
    const change = createChange({ id, workId, sessionId, baseCommit, headCommit, repositories, repositoryChanges });
    work.changes.push(id);
    const session = sessionId ? await this.store.readJsonAsync?.(`${this._projectRel(orgId, projectId)}/sessions/${sessionId}.json`) ?? this.getSession(orgId, projectId, sessionId) : null;
    if (session) session.changes.push(id);
    await this._asyncTransaction(async () => {
      await this._asyncWrite(`${this._projectRel(orgId, projectId)}/changes/${id}.json`, change);
      await this._asyncWrite(`${this._projectRel(orgId, projectId)}/work/${work.id}.json`, work);
      if (session) await this._asyncWrite(`${this._projectRel(orgId, projectId)}/sessions/${sessionId}.json`, session);
    });
    await this._asyncAudit({ event: 'change.submit', orgId, projectId, workId, changeId: id, baseCommit, headCommit });
    return change;
  }

  getChange(orgId, projectId, changeId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/changes/${changeId}.json`);
  }

  async getChangeAsync(orgId, projectId, changeId) {
    const rel = `${this._projectRel(orgId, projectId)}/changes/${changeId}.json`;
    return typeof this.store.readJsonAsync === 'function' ? this.store.readJsonAsync(rel) : this.getChange(orgId, projectId, changeId);
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
    change.evidence.push(id);
    this.store.transaction(() => {
      this.store.writeJson(`${this._projectRel(orgId, projectId)}/evidence/${id}.json`, evidence);
      this._saveChange(orgId, projectId, change);
    });
    this.store.audit({ event: 'evidence.add', orgId, projectId, changeId, evidenceId: id, type, claim, validity });
    return evidence;
  }

  async addEvidenceAsync({ orgId, projectId, changeId, subject, claim, type, producer, artifact = null, result = null, provenance = {}, environment = {}, sourceRevision = null, validity = 'valid' }) {
    const change = await this.getChangeAsync(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    const id = await nextIdAsync(this.store, 'evidence');
    let artifactRef = null;
    if (artifact != null) {
      const bytes = Buffer.isBuffer(artifact) ? artifact : Buffer.from(String(artifact), 'utf8');
      artifactRef = typeof this.store.putArtifactAsync === 'function' ? await this.store.putArtifactAsync(bytes) : this.store.putArtifact(bytes);
    }
    const evidence = createEvidence({ id, subject, claim, type, producer, artifactRef, result, provenance, environment, sourceRevision, validity });
    change.evidence.push(id);
    await this._asyncTransaction(async () => {
      await this._asyncWrite(`${this._projectRel(orgId, projectId)}/evidence/${id}.json`, evidence);
      await this._asyncWrite(`${this._projectRel(orgId, projectId)}/changes/${change.id}.json`, change);
    });
    await this._asyncAudit({ event: 'evidence.add', orgId, projectId, changeId, evidenceId: id, type, claim, validity });
    return evidence;
  }

  getEvidence(orgId, projectId, evidenceId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/evidence/${evidenceId}.json`);
  }

  async getEvidenceAsync(orgId, projectId, evidenceId) {
    const rel = `${this._projectRel(orgId, projectId)}/evidence/${evidenceId}.json`;
    return typeof this.store.readJsonAsync === 'function' ? this.store.readJsonAsync(rel) : this.getEvidence(orgId, projectId, evidenceId);
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

  async getPolicyAsync(orgId, projectId) {
    const rel = `${this._projectRel(orgId, projectId)}/policy.json`;
    const policy = typeof this.store.readJsonAsync === 'function' ? await this.store.readJsonAsync(rel) : this.getPolicy(orgId, projectId);
    return policy ?? defaultPolicy();
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

  async evaluateChangeAsync({ orgId, projectId, changeId }) {
    const change = await this.getChangeAsync(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    const policy = await this.getPolicyAsync(orgId, projectId);
    const evidenceList = (await Promise.all(change.evidence.map((id) => this.getEvidenceAsync(orgId, projectId, id)))).filter(Boolean);
    const evaluation = evaluateEvidence(policy, evidenceList);
    const interpretation = interpret(evaluation);
    if (change.reviewState === 'pending') {
      transitionChange(change, 'in_review');
      await this._asyncWrite(`${this._projectRel(orgId, projectId)}/changes/${change.id}.json`, change);
    }
    await this._asyncAudit({ event: 'policy.evaluate', orgId, projectId, changeId, ok: evaluation.ok, missing: evaluation.missing.length });
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
      sourceStates: change.repositoryChanges,
    });

    // A Decision may be made directly (without a prior evaluate step); ensure
    // the Change has entered review before recording the terminal state.
    if (change.reviewState === 'pending') {
      transitionChange(change, 'in_review');
    }
    change.decisionState = decisionToChangeState(decision);
    if (decision === 'accepted') transitionChange(change, 'approved');
    else if (decision === 'rejected') transitionChange(change, 'rejected');
    else if (decision === 'revision_requested') transitionChange(change, 'changes_requested');
    if (!change.decisions) change.decisions = [];
    if (!change.decisions.includes(id)) change.decisions.push(id);

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
    }

    // The Decision, Change, and Work records are written atomically.
    this.store.transaction(() => {
      this.store.writeJson(`${this._projectRel(orgId, projectId)}/decisions/${id}.json`, decisionRecord);
      this._saveChange(orgId, projectId, change);
      if (work) this._saveWork(orgId, projectId, work);
    });

    this.store.audit({ event: 'decision.make', orgId, projectId, changeId, decisionId: id, decision, decider });
    return decisionRecord;
  }

  async makeDecisionAsync({ orgId, projectId, changeId, decision, decider, reasoning = '' }) {
    const change = await this.getChangeAsync(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    const policy = await this.getPolicyAsync(orgId, projectId);
    const deciderPrincipal = await this.getPrincipalAsync(decider);
    if (!deciderPrincipal) throw new Error(`principal not found: ${decider}`);
    if (decision === 'accepted' && !canApprove(policy, deciderPrincipal.type)) {
      throw new Error(`principal type ${deciderPrincipal.type} may not accept (policy requires human)`);
    }
    const evidenceList = (await Promise.all(change.evidence.map((id) => this.getEvidenceAsync(orgId, projectId, id)))).filter(Boolean);
    if (decision === 'accepted') {
      const evaluation = evaluateEvidence(policy, evidenceList);
      if (!evaluation.ok) throw new Error(`cannot accept: missing evidence (${evaluation.missing.map((m) => m.type).join(', ')})`);
    }
    const id = await nextIdAsync(this.store, 'decision');
    const evidenceSnapshot = evidenceList.map((e) => ({ id: e.id, integrity: e.integrity }));
    const decisionRecord = createDecision({
      id, changeId, decision, decider, authority: 'policy', policyRef: policy.id,
      evidenceSnapshot, reasoning, sourceState: change.headCommit, sourceStates: change.repositoryChanges,
    });
    if (change.reviewState === 'pending') transitionChange(change, 'in_review');
    change.decisionState = decisionToChangeState(decision);
    if (decision === 'accepted') transitionChange(change, 'approved');
    else if (decision === 'rejected') transitionChange(change, 'rejected');
    else if (decision === 'revision_requested') transitionChange(change, 'changes_requested');
    if (!change.decisions) change.decisions = [];
    if (!change.decisions.includes(id)) change.decisions.push(id);
    const work = await this.getWorkAsync(orgId, projectId, change.workId);
    if (work) {
      work.decisions.push(id);
      if (work.status === 'submitted') transitionWork(work, 'in_review');
      if (decision === 'accepted') transitionWork(work, 'accepted');
      else if (decision === 'rejected') transitionWork(work, 'rejected');
      else if (decision === 'revision_requested') transitionWork(work, 'revision_requested');
    }
    await this._asyncTransaction(async () => {
      await this._asyncWrite(`${this._projectRel(orgId, projectId)}/decisions/${id}.json`, decisionRecord);
      await this._asyncWrite(`${this._projectRel(orgId, projectId)}/changes/${change.id}.json`, change);
      if (work) await this._asyncWrite(`${this._projectRel(orgId, projectId)}/work/${work.id}.json`, work);
    });
    await this._asyncAudit({ event: 'decision.make', orgId, projectId, changeId, decisionId: id, decision, decider });
    return decisionRecord;
  }

  getDecision(orgId, projectId, decisionId) {
    return this.store.readJson(`${this._projectRel(orgId, projectId)}/decisions/${decisionId}.json`);
  }

  async getDecisionAsync(orgId, projectId, decisionId) {
    const rel = `${this._projectRel(orgId, projectId)}/decisions/${decisionId}.json`;
    return typeof this.store.readJsonAsync === 'function' ? this.store.readJsonAsync(rel) : this.getDecision(orgId, projectId, decisionId);
  }

  // --- canonical state update (on accept) -------------------------------
  // Fast-forward each repository in the Change to its head commit, guarded by
  // the base commit (TOCTOU). Returns {ok, reason} for a single-repo update
  // (repoId provided) or {ok, results} for a multi-repo update (repoId omitted).
  updateCanonicalState({ orgId, projectId, changeId, repoId = null }) {
    const change = this.getChange(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    if (change.decisionState !== 'accepted') {
      throw new Error(`change not accepted (state: ${change.decisionState})`);
    }

    let targets;
    if (repoId) {
      const match = change.repositoryChanges.find((r) => r.repoId === repoId);
      if (match) {
        targets = [match];
      } else if (change.repositoryChanges.length === 0) {
        // Legacy single-repo change: the repository is implied by repoId and the
        // base/head are the top-level fields.
        targets = [{ repoId, baseCommit: change.baseCommit, headCommit: change.headCommit }];
      } else {
        targets = [];
      }
    } else {
      targets = change.repositoryChanges;
    }
    if (targets.length === 0) throw new Error('no repository changes to update');

    const results = [];
    for (const t of targets) {
      const git = this.gitRepo(orgId, projectId, t.repoId);
      if (!git.hasCommit(t.headCommit)) {
        results.push({ repoId: t.repoId, ok: false, reason: 'head commit not present in repository' });
        continue;
      }
      const branch = git.defaultBranch();
      const result = git.fastForward(t.baseCommit, t.headCommit, branch);
      this.store.audit({ event: 'canonical.update', orgId, projectId, changeId, repoId: t.repoId, branch, ...result });
      results.push({ repoId: t.repoId, ...result });
    }

    const ok = results.every((r) => r.ok);
    if (ok) {
      const work = this.getWork(orgId, projectId, change.workId);
      if (work && work.status === 'accepted') {
        transitionWork(work, 'closed');
        this._saveWork(orgId, projectId, work);
      }
    }

    if (repoId) return results[0];
    return { ok, results };
  }

  // --- credential scanning ----------------------------------------------
  // Scan a Change's diff (across all its repositories) for credentials.
  // Returns an array of { name, count } findings (redacted — no values).
  scanChangeSecrets({ orgId, projectId, changeId }) {
    const change = this.getChange(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    const findings = [];
    for (const rc of change.repositoryChanges) {
      const git = this.gitRepo(orgId, projectId, rc.repoId);
      const diff = git.diff(rc.baseCommit, rc.headCommit);
      findings.push(...scanSecrets(diff));
    }
    return findings;
  }

  // --- contribution flow -------------------------------------------------
  // The low-friction path for a developer who knows Git but not Source:
  // clone → modify → `source submit`. Creates contribution Work, a Session, a
  // Change against the exact base state, deterministic footprint evidence, a
  // deterministic credential scan, and evaluates policy. Returns the full
  // lifecycle for inspection.
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

    // Deterministic credential scan of the diff. If findings exist, record a
    // `security` evidence with validity 'invalid' so the finding is visible in
    // the Change's evidence chain (detective control; the maintainer's Decision
    // remains the gate).
    const findings = this.scanChangeSecrets({ orgId, projectId, changeId: change.id });
    let securityEvidence = null;
    if (findings.length > 0) {
      securityEvidence = this.addEvidence({
        orgId,
        projectId,
        changeId: change.id,
        subject: 'credential scan',
        claim: 'no credentials in change',
        type: 'security',
        producer: principal.id,
        artifact: JSON.stringify({ findings }),
        result: { status: 'fail', findings },
        validity: 'invalid',
      });
    }

    // Evaluate policy. The footprint evidence is real but does not satisfy the
    // project's full required evidence (tests/eval); the maintainer's
    // verification service fills those. Missing evidence is visible here.
    const evaluation = this.evaluateChange({ orgId, projectId, changeId: change.id });

    return {
      work,
      session,
      change,
      evidence: footprint,
      securityEvidence,
      findings,
      evaluation: evaluation.evaluation,
      interpretation: evaluation.interpretation,
    };
  }

  async updateCanonicalStateAsync({ orgId, projectId, changeId, repoId = null }) {
    const change = await this.getChangeAsync(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    if (change.decisionState !== 'accepted') throw new Error(`change not accepted (state: ${change.decisionState})`);
    let targets;
    if (repoId) {
      const match = change.repositoryChanges.find((r) => r.repoId === repoId);
      targets = match ? [match] : (change.repositoryChanges.length === 0 ? [{ repoId, baseCommit: change.baseCommit, headCommit: change.headCommit }] : []);
    } else targets = change.repositoryChanges;
    if (targets.length === 0) throw new Error('no repository changes to update');

    const results = await Promise.all(targets.map(async (target) => {
      const git = this.gitRepo(orgId, projectId, target.repoId);
      if (!(await git.hasCommitAsync(target.headCommit))) {
        return { repoId: target.repoId, ok: false, reason: 'head commit not present in repository' };
      }
      const branch = await git.defaultBranchAsync();
      const result = await git.fastForwardAsync(target.baseCommit, target.headCommit, branch);
      await this._asyncAudit({ event: 'canonical.update', orgId, projectId, changeId, repoId: target.repoId, branch, ...result });
      return { repoId: target.repoId, ...result };
    }));
    const ok = results.every((result) => result.ok);
    if (ok) {
      const work = await this.getWorkAsync(orgId, projectId, change.workId);
      if (work && work.status === 'accepted') {
        transitionWork(work, 'closed');
        await this._asyncTransaction(() => this._asyncWrite(`${this._projectRel(orgId, projectId)}/work/${work.id}.json`, work));
      }
    }
    return repoId ? results[0] : { ok, results };
  }

  async scanChangeSecretsAsync({ orgId, projectId, changeId }) {
    const change = this.getChange(orgId, projectId, changeId);
    if (!change) throw new Error(`change not found: ${changeId}`);
    const findings = [];
    for (const repositoryChange of change.repositoryChanges) {
      const git = this.gitRepo(orgId, projectId, repositoryChange.repoId);
      findings.push(...scanSecrets(await git.diffAsync(repositoryChange.baseCommit, repositoryChange.headCommit)));
    }
    return findings;
  }

  async submitContributionAsync({ orgId, projectId, repoRef, baseCommit, headCommit, intent = '', contributorName = 'contributor' }) {
    const repo = this.resolveRepository(orgId, projectId, repoRef);
    if (!repo) throw new Error(`repository not found: ${repoRef}`);
    const git = this.gitRepo(orgId, projectId, repo.id);
    if (!(await git.hasCommitAsync(headCommit))) throw new Error('head commit not present in repository');
    if (baseCommit && !(await git.hasCommitAsync(baseCommit))) throw new Error('base commit not present in repository');
    if (baseCommit === headCommit) throw new Error('no changes to submit (base == head)');

    const principal = await this.createPrincipalAsync({ type: 'human', name: contributorName });
    const work = await this.createWorkAsync({ orgId, projectId, intent: intent || `Contribution to ${repo.name}`, type: 'contribution', requester: principal.id });
    await this.claimWorkAsync({ orgId, projectId, workId: work.id, principalId: principal.id });
    const session = await this.startSessionAsync({ orgId, projectId, workId: work.id, principalId: principal.id, baseCommit });
    const change = await this.submitChangeAsync({ orgId, projectId, workId: work.id, sessionId: session.id, baseCommit, headCommit, repositories: [repo.id] });
    const changed = await git.changedFilesAsync(baseCommit, headCommit);
    const nonEmpty = changed.length > 0;
    const footprint = await this.addEvidenceAsync({
      orgId, projectId, changeId: change.id, subject: 'change footprint', claim: 'change is non-empty', type: 'test', producer: principal.id,
      artifact: JSON.stringify({ changedFiles: changed, nonEmpty }), result: { status: nonEmpty ? 'pass' : 'fail' }, validity: nonEmpty ? 'valid' : 'invalid',
    });
    const findings = await this.scanChangeSecretsAsync({ orgId, projectId, changeId: change.id });
    let securityEvidence = null;
    if (findings.length > 0) {
      securityEvidence = await this.addEvidenceAsync({
        orgId, projectId, changeId: change.id, subject: 'credential scan', claim: 'no credentials in change', type: 'security', producer: principal.id,
        artifact: JSON.stringify({ findings }), result: { status: 'fail', findings }, validity: 'invalid',
      });
    }
    const evaluation = await this.evaluateChangeAsync({ orgId, projectId, changeId: change.id });
    return { work, session, change, evidence: footprint, securityEvidence, findings, evaluation: evaluation.evaluation, interpretation: evaluation.interpretation };
  }

  // --- audit ------------------------------------------------------------
  queryWorkGraph(orgId, projectId, workId) {
    if (typeof this.store.queryWorkGraph === 'function') {
      return this.store.queryWorkGraph(orgId, projectId, workId);
    }

    const work = this.getWork(orgId, projectId, workId);
    if (!work) return null;
    const requester = this.getPrincipal(work.requester);

    const changes = this.listChanges(orgId, projectId)
      .filter((c) => c.workId === workId)
      .map((change) => {
        const session = change.sessionId ? this.getSession(orgId, projectId, change.sessionId) : null;
        return {
          id: change.id,
          change,
          session: session
            ? {
                id: session.id,
                principal: this.getPrincipal(session.principal)
                  ? {
                      id: session.principal,
                      name: this.getPrincipal(session.principal).name,
                    }
                  : null,
              }
            : null,
          evidence: change.evidence
            .map((id) => ({ id, evidence: this.getEvidence(orgId, projectId, id) }))
            .filter((entry) => entry.evidence)
            .map((entry) => ({ id: entry.id, evidence: entry.evidence })),
          decisions: (change.decisions || [])
            .map((id) => ({ id, decision: this.getDecision(orgId, projectId, id) }))
            .filter((entry) => entry.decision)
            .map((entry) => ({ id: entry.id, decision: entry.decision })),
        };
      });

    return {
      work,
      workId,
      requester,
      changes,
    };
  }

  queryPrincipalActivity(orgId, projectId, principalId) {
    if (typeof this.store.queryChangesForPrincipal === 'function') {
      return this.store.queryChangesForPrincipal(orgId, projectId, principalId);
    }

    const evidence = [];
    for (const change of this.listChanges(orgId, projectId)) {
      for (const evidenceId of change.evidence || []) {
        const e = this.getEvidence(orgId, projectId, evidenceId);
        if (e?.producer === principalId) {
          evidence.push({ id: e.id, workId: change.workId, changeId: change.id, evidence: e });
        }
      }
    }

    const decisions = this.store.listJson(`${this._projectRel(orgId, projectId)}/decisions`).map((decisionId) => {
      const d = this.getDecision(orgId, projectId, decisionId);
      if (!d || d.decider !== principalId) return null;
      const change = this.getChange(orgId, projectId, d.changeId);
      return change ? { id: d.id, changeId: d.changeId, decision: d } : null;
    }).filter(Boolean);

    return { principalId, evidence, decisions };
  }

  readAudit() {
    return this.store.readAudit();
  }
}
