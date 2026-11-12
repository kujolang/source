// Source-owned control-plane service; callers at HTTP boundaries must authorize
// capabilities and supply the authenticated principal, never a body producer ID.
import { createHash } from 'node:crypto';
import { normalizeControlArtifact } from './integrations/control-tools.js';
import { IntegrationPlanner, digest, ASSEMBLY_CONTRACT } from './integration-planner.js';
import { validateVerificationPolicy, createVerificationReceipt, evaluateVerification } from './verification.js';

export class IntegrationBroker {
  constructor(source) { this.source = source; }

  scope(input) {
    const { orgId, projectId, repoId, candidateId } = input;
    if (![orgId, projectId, repoId].every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id))) throw new Error('invalid integration scope');
    if (candidateId != null && !/^[a-f0-9]{64}$/.test(candidateId)) throw new Error('invalid candidate ID');
    return `orgs/${orgId}/projects/${projectId}/integration/${repoId}`;
  }

  async read(rel) {
    const store = this.source.store;
    return store.readJsonAsync ? store.readJsonAsync(rel) : store.readJson(rel);
  }

  async human(orgId, principalId) {
    const principal = await this.source.getPrincipalAsync(principalId);
    const membership = await this.source.getOrgMembershipAsync(orgId, principalId);
    if (principal?.type !== 'human' || !['admin', 'maintainer'].includes(membership?.role)) throw new Error('integration acceptance requires an organization maintainer');
    return principal;
  }

  async configure({ orgId, projectId, repoId, principalId, policy }) {
    this.scope({ orgId, projectId, repoId });
    validateVerificationPolicy(policy);
    await this.human(orgId, principalId);
    return this.source._projectMutationAsync(orgId, projectId, async () => {
      const repo = await this.source.getRepositoryAsync(orgId, projectId, repoId);
      if (!repo || repo.artifacts) throw new Error('integration broker requires a local repository');
      const planner = new IntegrationPlanner(repo.barePath, { maxProposals: this.source.maxIntegrationProposals });
      await planner.git(['rev-parse', '--verify', `refs/heads/${repo.defaultBranch}`]);
      repo.integrationPolicy = structuredClone(policy);
      await this.source._asyncWrite(`orgs/${orgId}/projects/${projectId}/repos/${repoId}.json`, repo);
      await this.source._asyncAudit({ event: 'integration.configure', orgId, projectId, repoId, principalId, policyHash: digest(policy) });
      return repo;
    });
  }

  async load(input, { currentPolicy = true } = {}) {
    const root = this.scope(input);
    const report = await this.source.getIntegrationAsync(input);
    const repo = await this.source.getRepositoryAsync(input.orgId, input.projectId, input.repoId);
    if (!report?.candidate || !repo?.integrationPolicy || repo.artifacts) throw new Error('configured integration candidate not found');
    const { id, ...body } = report.candidate;
    if (id !== input.candidateId || digest(body) !== id) throw new Error('candidate snapshot integrity mismatch');
    if (currentPolicy) {
      if (report.candidate.assemblyContract !== ASSEMBLY_CONTRACT) throw new Error('candidate assembly contract changed; replan and reverify');
      const retirement = await this.read(`${root}/${id}/retirement.json`);
      if (retirement) throw new Error(`candidate ${retirement.state}; verification and promotion are disabled`);
    }
    const policy = await this.source.getPolicyAsync(input.orgId, input.projectId);
    if (currentPolicy && report.policyHash !== digest({ project: policy, integration: repo.integrationPolicy })) throw new Error('candidate policy changed; replan and reverify');
    if (currentPolicy) {
      for (const proposal of report.candidate.proposals) {
        const change = await this.source.getChangeAsync(input.orgId, input.projectId, proposal.id);
        const revision = change?.repositoryChanges?.find((entry) => entry.repoId === input.repoId);
        if (!revision || revision.headCommit !== proposal.headCommit || revision.baseCommit !== proposal.baseCommit || ['rejected', 'revision_requested'].includes(change.decisionState)) throw new Error('candidate proposal changed or is no longer eligible');
      }
    }
    if (report.branch !== repo.defaultBranch) throw new Error('candidate target changed');
    const planner = new IntegrationPlanner(repo.barePath, { maxProposals: this.source.maxIntegrationProposals });
    if (await planner.git(['rev-parse', `refs/source/candidates/${id}`]) !== report.candidate.headCommit || await planner.git(['rev-parse', `${report.candidate.headCommit}^{tree}`]) !== report.candidate.tree) throw new Error('candidate Git identity mismatch');
    return { root, report, repo, planner };
  }

  async record(input) {
    const { orgId, projectId, principalId, checkId, execution, output } = input;
    return this.source._projectMutationAsync(orgId, projectId, async () => {
      const fence = async () => {
        if (!input.jobLease) return;
        if (!this.source.store.lockJobLeaseAsync) throw new Error('queued verification requires transactional lease fencing');
        const job = await this.source.store.lockJobLeaseAsync({ ...input.jobLease, orgId, projectId });
        if (job.kind !== 'integration.verify' || job.payload.repoId !== input.repoId || job.payload.candidateId !== input.candidateId || job.payload.checkId !== checkId || job.payload.identity !== execution.identity) throw new Error('verification job does not match exact candidate and check');
        const dispatch = await this.read(`${this.scope(input)}/${input.candidateId}/dispatch.json`);
        const current = dispatch?.checks.find((entry) => entry.checkId === checkId);
        if (!current || current.jobId !== job.id || current.epoch !== job.payload.epoch || current.identity !== execution.identity) throw new Error('verification dispatch was superseded');
        return job;
      };
      const leasedJob = await fence();
      const { root, report, repo } = await this.load(input);
      const producer = await this.source.getPrincipalAsync(principalId);
      // Validate producer and metadata before storing an untrusted artifact.
      createVerificationReceipt({ candidate: report.candidate, policy: repo.integrationPolicy, checkId, producer, execution, artifactRef: { hash: '0'.repeat(64) } });
      if (typeof output !== 'string' || !output.length) throw new Error('original execution output is required');
      const check = repo.integrationPolicy.checks.find((item) => item.id === checkId);
      if (check.adapter && execution.status === 'pass') {
        const artifact = normalizeControlArtifact(check.adapter, JSON.parse(output));
        if (!artifact.gate || artifact.validity !== 'valid') throw new Error('tool artifact does not support a passing verification');
        if (check.adapter === 'workcell') {
          const raw = JSON.parse(output);
          const revision = raw.source_commit ?? raw.source?.commit;
          if (revision !== report.candidate.headCommit) throw new Error('Workcell artifact revision differs from exact candidate');
        }
      }
      const receiptPath = `${root}/${input.candidateId}/receipts`;
      const receiptIds = this.source.store.listJsonAsync ? await this.source.store.listJsonAsync(receiptPath, { limit: 1001 }) : this.source.store.listJson(receiptPath, { limit: 1001 });
      const bytes = this.source._artifactBytes(output);
      const store = this.source.store;
      const artifactRef = { hash: createHash('sha256').update(bytes).digest('hex') };
      const receipt = createVerificationReceipt({ candidate: report.candidate, policy: repo.integrationPolicy, checkId, producer, execution, artifactRef,
        jobRef: leasedJob ? { id: leasedJob.id, epoch: leasedJob.payload.epoch } : null });
      const receiptRel = `${root}/${input.candidateId}/receipts/${receipt.id}.json`;
      const existing = await this.read(receiptRel);
      if (existing) return existing;
      if (receiptIds.length >= 1000) throw new Error('candidate receipt limit exceeded');
      if (store.putArtifactAsync) await store.putArtifactAsync(bytes); else store.putArtifact(bytes);
      await this.source._asyncWrite(receiptRel, receipt);
      await this.source._asyncAudit({ event: 'integration.verification', orgId, projectId, repoId: input.repoId, candidateId: input.candidateId, receiptId: receipt.id, status: execution.status, principalId });
      await fence();
      return receipt;
    });
  }

  async evaluate(input, { forReuse = false } = {}) {
    const { root, report, repo } = await this.load(input);
    const store = this.source.store;
    const rel = `${root}/${input.candidateId}/receipts`;
    const ids = store.listJsonAsync ? await store.listJsonAsync(rel, { limit: 1001 }) : store.listJson(rel, { limit: 1001 });
    if (ids.length > 1000) throw new Error('candidate receipt limit exceeded');
    const receipts = await Promise.all(ids.map((id) => this.read(`${rel}/${id}.json`)));
    // Request-local identities only: retain no artifact bytes and never reuse a
    // successful integrity check across evaluations. Historical receipts still
    // participate, even when dispatch selection later excludes them.
    const verifiedArtifacts = new Set();
    for (const receipt of receipts) {
      if (verifiedArtifacts.has(receipt.artifactRef.hash)) continue;
      const bytes = store.getArtifactAsync ? await store.getArtifactAsync(receipt.artifactRef.hash) : store.getArtifact(receipt.artifactRef.hash);
      if (!bytes) throw new Error('verification artifact missing');
      // Verify bytes here; not all store backends validate content on read.
      if (createHash('sha256').update(bytes).digest('hex') !== receipt.artifactRef.hash) throw new Error('verification artifact integrity mismatch');
      verifiedArtifacts.add(receipt.artifactRef.hash);
    }
    const dispatch = await this.read(`${root}/${input.candidateId}/dispatch.json`);
    const currentReceipts = receipts.filter((receipt) => {
      const check = dispatch?.checks.find((entry) => entry.checkId === receipt.checkId);
      return !check || check.action === 'reused' || (receipt.jobRef?.id === check.jobId && receipt.jobRef?.epoch === check.epoch);
    });
    return evaluateVerification({ candidate: report.candidate, policy: repo.integrationPolicy, receipts: currentReceipts, forReuse });
  }

  async status(input) {
    const { root, report } = await this.load(input, { currentPolicy: false });
    const acceptance = await this.read(`${root}/${input.candidateId}/acceptance.json`);
    const intent = await this.read(`${root}/${input.candidateId}/intent.json`);
    const outcome = await this.read(`${root}/${input.candidateId}/outcome.json`);
    const retirement = await this.read(`${root}/${input.candidateId}/retirement.json`);
    let evaluation;
    try { evaluation = await this.evaluate(input); }
    catch (error) { evaluation = { ok: false, reason: error.message }; }
    const accepted = acceptance && evaluation.ok && digest(acceptance.receipts) === digest(evaluation.checks.map((check) => check.receiptId));
    return { candidate: report.candidate, state: outcome?.state === 'landed' ? 'landed' : retirement?.state || (accepted ? 'accepted' : evaluation.ok ? 'verified' : 'proposed'), evaluation, acceptance, intent, outcome, retirement, reconciliationRequired: Boolean(intent && !outcome && !retirement) };
  }

  async split(input) {
    return this.source._projectMutationAsync(input.orgId, input.projectId, async () => {
      const { root, report, repo, planner } = await this.load(input);
      const evaluation = await this.evaluate(input);
      if (!evaluation.checks.some((check) => check.reason === 'latest execution fail')) throw new Error('batch splitting requires a recorded failed verification');
      if (await planner.git(['rev-parse', `refs/heads/${report.branch}`]) !== report.candidate.baseCommit) throw new Error('target changed; replan before splitting');
      const policy = await this.source.getPolicyAsync(input.orgId, input.projectId);
      const split = await planner.split(report.candidate, {
        exclusivePaths: policy.integration?.exclusivePaths ?? ['migrations/', 'generated/'],
        dependencyGroups: policy.integration?.dependencyGroups ?? [],
      });
      for (const child of split.children) {
        if (!child.candidate) continue;
        await this.source._asyncWrite(`${root}/${child.candidate.id}.json`, { ...child, orgId: input.orgId, projectId: input.projectId, repoId: input.repoId, branch: repo.defaultBranch, policyHash: report.policyHash, splitParent: input.candidateId });
      }
      await this.source._asyncWrite(`${root}/${input.candidateId}/split.json`, split);
      await this.source._asyncAudit({ event: 'integration.split', orgId: input.orgId, projectId: input.projectId, repoId: input.repoId, candidateId: input.candidateId, children: split.children.map((child) => child.candidate?.id).filter(Boolean), blocked: split.blocked });
      return split;
    });
  }

  async accept(input) {
    await this.human(input.orgId, input.principalId);
    return this.source._projectMutationAsync(input.orgId, input.projectId, async () => {
      const { root, report } = await this.load(input);
      const evaluation = await this.evaluate(input);
      if (!evaluation.ok) throw new Error('candidate verification requirements not satisfied');
      const acceptance = { candidateId: input.candidateId, headCommit: report.candidate.headCommit, policyHash: report.policyHash, principalId: input.principalId, receipts: evaluation.checks.map((check) => check.receiptId), acceptedAt: Date.now() };
      const existing = await this.read(`${root}/${input.candidateId}/acceptance.json`);
      if (existing && existing.policyHash === acceptance.policyHash && digest(existing.receipts) === digest(acceptance.receipts)) return existing;
      await this.source._asyncWrite(`${root}/${input.candidateId}/acceptance.json`, acceptance);
      await this.source._asyncAudit({ event: 'integration.accept', orgId: input.orgId, projectId: input.projectId, repoId: input.repoId, candidateId: input.candidateId, principalId: input.principalId, receipts: acceptance.receipts });
      return acceptance;
    });
  }

  async promote(input) {
    const { orgId, projectId, candidateId } = input;
    await this.human(orgId, input.principalId);
    // Commit the intent before touching Git. The second transaction may roll back
    // after Git commits; the atomic landed ref remains the reconciliation record.
    const prepared = await this.source._projectMutationAsync(orgId, projectId, async () => {
      const { root, report, planner } = await this.load(input, { currentPolicy: false });
      const landedRef = `refs/source/landed/${candidateId}`;
      let landed = '';
      try { landed = await planner.git(['rev-parse', '--verify', landedRef]); } catch { /* not landed */ }
      if (landed) {
        if (landed !== report.candidate.headCommit) throw new Error('landed receipt integrity mismatch');
        const outcome = { state: 'landed', candidateId, headCommit: landed, recovered: true };
        await this.source._asyncWrite(`${root}/${candidateId}/outcome.json`, outcome);
        await this.source._asyncAudit({ event: 'integration.recover', orgId, projectId, repoId: input.repoId, ...outcome });
        return outcome;
      }
      await this.load(input);
      const acceptance = await this.read(`${root}/${candidateId}/acceptance.json`);
      const evaluation = await this.evaluate(input);
      if (!acceptance || !evaluation.ok || acceptance.policyHash !== report.policyHash || digest(acceptance.receipts) !== digest(evaluation.checks.map((check) => check.receiptId))) throw new Error('current exact-candidate evidence and acceptance required');
      const intent = { state: 'promoting', candidateId, expected: report.candidate.baseCommit, headCommit: report.candidate.headCommit, branch: report.branch, acceptanceHash: digest(acceptance) };
      await this.source._asyncWrite(`${root}/${candidateId}/intent.json`, intent);
      await this.source._asyncAudit({ event: 'integration.intent', orgId, projectId, repoId: input.repoId, ...intent });
      return intent;
    });
    if (prepared.state === 'landed') return prepared;
    return this.source._projectMutationAsync(orgId, projectId, async () => {
      await this.human(orgId, input.principalId);
      const { root, report, planner } = await this.load(input);
      const acceptance = await this.read(`${root}/${candidateId}/acceptance.json`);
      const evaluation = await this.evaluate(input);
      if (!acceptance || digest(acceptance) !== prepared.acceptanceHash || !evaluation.ok || digest(acceptance.receipts) !== digest(evaluation.checks.map((check) => check.receiptId))) throw new Error('promotion authorization changed');
      const landedRef = `refs/source/landed/${candidateId}`;
      try {
        await planner.git(['update-ref', '--stdin'], {}, `start\nupdate refs/heads/${report.branch} ${prepared.headCommit} ${prepared.expected}\ncreate ${landedRef} ${prepared.headCommit}\nprepare\ncommit\n`);
      } catch (error) {
        let landed = '';
        try { landed = await planner.git(['rev-parse', '--verify', landedRef]); } catch { /* no outcome */ }
        if (landed !== prepared.headCommit) {
          await this.source._asyncAudit({ event: 'integration.reject', orgId, projectId, repoId: input.repoId, candidateId, reason: 'stale branch or Git transaction failure' });
          const outcome = { state: 'rejected', candidateId, reason: 'stale branch or Git transaction failure; replan before retry' };
          await this.source._asyncWrite(`${root}/${candidateId}/outcome.json`, outcome);
          return outcome;
        }
      }
      const outcome = { state: 'landed', candidateId, headCommit: prepared.headCommit, recovered: false };
      await this.source._asyncWrite(`${root}/${candidateId}/outcome.json`, outcome);
      await this.source._asyncAudit({ event: 'integration.land', orgId, projectId, repoId: input.repoId, ...outcome });
      return outcome;
    });
  }
}
