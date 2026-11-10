// Durable scheduling only. Execution belongs to a separately configured worker;
// queue payloads never supply commands, environments, or producer identities.
import { digest } from './integration-planner.js';
import { verificationIdentity } from './verification.js';

export class VerificationDispatcher {
  constructor(source) { this.source = source; }

  async dispatch(input) {
    const source = this.source;
    if (!source.store.getJobAsync || !source.store.lockJobLeaseAsync) throw new Error('verification dispatch requires PostgreSQL');
    const { orgId, projectId, repoId, candidateId } = input;
    return source._projectMutationAsync(orgId, projectId, async () => {
      const { root, report, repo, planner } = await source.integration.load(input);
      if (await planner.git(['rev-parse', `refs/heads/${report.branch}`]) !== report.candidate.baseCommit) throw new Error('target changed; replan before dispatch');
      const evaluation = await source.integration.evaluate(input, { forReuse: true });
      const rel = `${root}/${candidateId}/dispatch.json`;
      const prior = await source.integration.read(rel);
      const definitions = repo.integrationPolicy.checks;
      const selected = new Set(evaluation.checks.map((check) => check.checkId));
      const ordered = []; const visited = new Set();
      const visit = (id) => {
        if (visited.has(id)) return;
        visited.add(id);
        const check = definitions.find((entry) => entry.id === id);
        for (const dependency of check.dependsOn || []) visit(dependency);
        ordered.push(check);
      };
      for (const id of selected) visit(id);
      const checks = [];
      for (const check of ordered) {
        const validity = evaluation.checks.find((entry) => entry.checkId === check.id);
        const identity = verificationIdentity(report.candidate, repo.integrationPolicy, check.id);
        const previous = prior?.checks.find((entry) => entry.checkId === check.id);
        const job = previous?.jobId ? await source.store.getJobAsync({ orgId, projectId, id: previous.jobId }) : null;
        const dependencies = (check.dependsOn || []).map((id) => checks.find((entry) => entry.checkId === id));
        const pending = dependencies.filter((entry) => entry.action !== 'reused').map((entry) => entry.jobId);
        const active = job && ['queued', 'leased'].includes(job.status);
        const same = previous?.identity === identity;
        // A receipt may already exist while its worker is still completing the
        // job. Keep that job alive: downstream jobs depend on its completion.
        if (active && same && pending.every((id) => job.dependsOn.includes(id))) {
          checks.push({ checkId: check.id, identity, epoch: previous.epoch, jobId: job.id, action: 'coalesced', reason: 'equivalent verification is already queued or leased' });
          continue;
        }
        if (validity?.satisfied && !pending.length) {
          // Existing work may race a newly available external receipt. Cancel it
          // under the same project lock used by queued broker writes.
          if (active) await source.jobs.cancel({ orgId, projectId, id: job.id, reason: 'exact deterministic evidence already available' });
          checks.push({ checkId: check.id, identity, epoch: previous?.epoch || 0, action: 'reused', receiptId: validity.receiptId, reason: validity.reason });
          continue;
        }
        if (active) await source.jobs.cancel({ orgId, projectId, id: job.id, reason: 'verification prerequisites superseded' });
        const epoch = (previous?.epoch || 0) + 1;
        if (!Number.isSafeInteger(epoch)) throw new Error('verification dispatch epoch exhausted');
        const payload = { repoId, candidateId, checkId: check.id, identity, epoch };
        const queued = await source.jobs.enqueue({ orgId, projectId, kind: 'integration.verify', payload,
          dedupeKey: `verification:${digest({ orgId, projectId, ...payload })}`,
          dependsOn: pending, priority: check.priority ?? (check.tier === 3 ? 50 : 0), maxAttempts: check.maxAttempts ?? 3, maxQueueDepth: 10000 });
        checks.push({ checkId: check.id, identity, epoch, jobId: queued.id, action: 'scheduled', reason: pending.length ? 'prerequisite verification is being rerun' : validity?.reason || 'required prerequisite needs verification' });
      }
      const result = { version: 1, candidateId, checks, plan: evaluation.plan, dispatchedAt: Date.now() };
      await source._asyncWrite(rel, result);
      await source._asyncAudit({ event: 'integration.dispatch', orgId, projectId, repoId, candidateId, principalId: input.principalId,
        checks: checks.map(({ checkId, action, jobId, receiptId, reason }) => ({ checkId, action, jobId, receiptId, reason })) });
      return result;
    });
  }
}

// The operator supplies an isolated executor and a trusted service identity.
// No executor is installed by default, and no command is run by the API server.
export function createVerificationHandler({ source, principalId, executor }) {
  if (!executor || typeof executor.execute !== 'function') throw new Error('verification requires an operator-configured isolated executor');
  return async (payload, job, { signal } = {}) => {
    signal?.throwIfAborted();
    const scope = { orgId: job.orgId, projectId: job.projectId, repoId: payload.repoId, candidateId: payload.candidateId };
    const { root, report, repo } = await source.integration.load(scope);
    const dispatch = await source.integration.read(`${root}/${payload.candidateId}/dispatch.json`);
    const current = dispatch?.checks.find((entry) => entry.checkId === payload.checkId);
    if (job.kind !== 'integration.verify' || current?.jobId !== job.id || current?.epoch !== payload.epoch || current?.identity !== payload.identity) throw new Error('verification dispatch was superseded');
    const check = repo.integrationPolicy.checks.find((entry) => entry.id === payload.checkId);
    const producer = await source.getPrincipalAsync(principalId);
    if (!check || verificationIdentity(report.candidate, repo.integrationPolicy, check.id) !== payload.identity || producer?.type !== 'service' || !check.producers.includes(principalId)) throw new Error('verification executor is not authorized for this exact check');
    const jobLease = { id: job.id, workerId: job.workerId, leaseToken: job.leaseToken };
    // Verify ownership before allocating execution resources as well as during
    // receipt persistence. The heartbeat handles later cancellation promptly.
    await source._projectMutationAsync(scope.orgId, scope.projectId, () => source.store.lockJobLeaseAsync({ ...scope, ...jobLease }));
    const reusable = (await source.integration.evaluate(scope, { forReuse: true })).checks.find((entry) => entry.checkId === check.id);
    if (reusable?.satisfied) return { candidateId: payload.candidateId, checkId: check.id, receiptId: reusable.receiptId, durationMs: 0, reused: true };
    const result = await executor.execute({ candidate: structuredClone(report.candidate), check: structuredClone(check), repository: repo.barePath, identity: payload.identity, job, signal });
    signal?.throwIfAborted();
    const receipt = await source.integration.record({ ...scope, principalId, checkId: check.id, jobLease, execution: result.execution, output: result.output });
    if (receipt.execution.status !== 'pass') throw new Error(`verification ${receipt.execution.status}; receipt ${receipt.id}`);
    return { candidateId: payload.candidateId, checkId: check.id, receiptId: receipt.id, durationMs: receipt.execution.durationMs };
  };
}
