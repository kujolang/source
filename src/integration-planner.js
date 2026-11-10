// Candidate assembly only: this module never updates a canonical branch or runs
// repository code. Actual Git merges establish textual compatibility; required
// combined-candidate verification must establish semantic compatibility.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export class IntegrationPlanner {
  constructor(barePath, { maxProposals = 100, timeoutMs = 30_000 } = {}) {
    this.barePath = barePath;
    if (!Number.isSafeInteger(maxProposals) || maxProposals < 1 || maxProposals > 1000) throw new Error('maxProposals must be an integer from 1 to 1000');
    this.maxProposals = maxProposals;
    this.timeoutMs = timeoutMs;
  }

  async git(args, env = {}, input = null) {
    // Do not inherit Git object-directory, config injection or tracing variables.
    const clean = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT']) if (process.env[key]) clean[key] = process.env[key];
    const pending = exec('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
      cwd: this.barePath, encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024,
      env: { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', ...env },
    });
    if (input != null) pending.child.stdin.end(input);
    const result = await pending;
    return result.stdout.trim();
  }

  async ancestor(base, head) {
    try { await this.git(['merge-base', '--is-ancestor', base, head]); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  }

  async independentHeads(proposals) {
    const heads = new Set(proposals.map((proposal) => proposal.headCommit));
    if (heads.size < 2) return heads;
    try {
      // Git returns the supplied heads not reachable from any other supplied
      // head. Such heads cannot be inferred ancestors of a distinct proposal.
      const result = (await this.git(['merge-base', '--independent', ...heads])).split('\n').filter(Boolean);
      if (!result.length || result.some((head) => !heads.has(head))) return new Set();
      return new Set(result);
    } catch (error) {
      if (error.killed || error.code === 'ENOBUFS') throw error;
      // Missing/corrupt objects retain the existing per-proposal diagnostics.
      // Failure to establish independence never permits skipping ancestry checks.
      return new Set();
    }
  }

  async changes(base, head) {
    // -z handles spaces, tabs and newlines without confusing conflict grouping.
    const raw = await this.git(['diff', '--name-status', '-z', '--find-renames', base, head]);
    const fields = raw.split('\0');
    const result = [];
    for (let i = 0; i < fields.length && fields[i];) {
      const status = fields[i++];
      const from = fields[i++];
      const to = /^[RC]/.test(status) ? fields[i++] : from;
      result.push({ status, from, to });
    }
    return result;
  }

  // Split diagnostics always create new candidates requiring their own evidence.
  // A child includes all proposal prerequisites, even across the split boundary.
  async split(candidate, options = {}) {
    const { id, ...body } = candidate || {};
    if (!id || digest(body) !== id || !Array.isArray(candidate.proposals)) throw new Error('invalid split candidate');
    if (candidate.proposals.length < 2) return { parentId: id, children: [], blocked: [{ proposals: candidate.proposals.map((p) => p.id), reason: 'single proposal requires agent revision' }] };
    const byId = new Map(candidate.proposals.map((p) => [p.id, p]));
    const midpoint = Math.floor(candidate.proposals.length / 2);
    const partitions = [candidate.proposals.slice(0, midpoint), candidate.proposals.slice(midpoint)];
    const children = [];
    const blocked = [];
    for (const partition of partitions) {
      const included = new Set();
      const visit = (proposal) => {
        if (included.has(proposal.id)) return;
        included.add(proposal.id);
        for (const dependency of proposal.dependsOn) {
          if (!byId.has(dependency)) throw new Error('split dependency missing from parent candidate');
          visit(byId.get(dependency));
        }
      };
      partition.forEach(visit);
      if (included.size === candidate.proposals.length) {
        blocked.push({ proposals: partition.map((p) => p.id), reason: 'dependency closure requires the full failed batch; compare the other child before revising dependent proposals' });
        continue;
      }
      const proposals = candidate.proposals.filter((p) => included.has(p.id));
      const report = await this.assemble({ ...options, baseCommit: candidate.baseCommit, proposals,
        context: { ...candidate.context, splitParent: id, splitProposals: proposals.map((p) => p.id) },
      });
      children.push(report);
    }
    return { parentId: id, children, blocked };
  }

  async assemble({ baseCommit, proposals, exclusivePaths = ['migrations/', 'generated/'], dependencyGroups = [], context = {} }) {
    if (!oid.test(baseCommit)) throw new Error('baseCommit must be a full Git object ID');
    if (!Array.isArray(proposals) || !proposals.length || proposals.length > this.maxProposals) throw new Error('invalid proposal batch size');
    if (!Array.isArray(exclusivePaths) || !exclusivePaths.every((p) => typeof p === 'string' && p.length)) throw new Error('invalid exclusive paths');
    if (!Array.isArray(dependencyGroups) || !dependencyGroups.every((group) => Array.isArray(group) && group.every((p) => typeof p === 'string' && p.length))) throw new Error('invalid dependency groups');
    await this.git(['cat-file', '-e', `${baseCommit}^{commit}`]);
    const byId = new Map();
    for (const proposal of proposals) {
      if (!idPattern.test(proposal.id) || byId.has(proposal.id) || !oid.test(proposal.headCommit) || !oid.test(proposal.baseCommit)) throw new Error('invalid or duplicate proposal identity');
      if (proposal.dependsOn && (!Array.isArray(proposal.dependsOn) || !proposal.dependsOn.every((id) => idPattern.test(id)))) throw new Error('invalid proposal dependencies');
      byId.set(proposal.id, { ...proposal, dependsOn: [...new Set(proposal.dependsOn || [])].sort() });
    }
    const independent = await this.independentHeads([...byId.values()]);
    const rejected = [];
    const eligible = new Map();
    for (const proposal of [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
      try {
        await this.git(['cat-file', '-e', `${proposal.headCommit}^{commit}`]);
        await this.git(['cat-file', '-e', `${proposal.baseCommit}^{commit}`]);
        if (['rejected', 'revision_requested'].includes(proposal.decisionState)) throw new Error('proposal is not eligible for integration');
        if (proposal.headCommit === proposal.baseCommit || !await this.ancestor(proposal.baseCommit, proposal.headCommit)) throw new Error('invalid proposal history');
        if (proposal.baseCommit !== baseCommit) {
          const parent = [...byId.values()].find((p) => p.id !== proposal.id && p.headCommit === proposal.baseCommit);
          if (!parent) throw new Error('stale proposal base; rebase against the current target or include its dependency');
          if (!proposal.dependsOn.includes(parent.id)) proposal.dependsOn.push(parent.id);
        }
        // An included proposal's head in this history is an inferred dependency.
        for (const other of byId.values()) {
          if (other.id !== proposal.id && other.headCommit !== proposal.headCommit && !independent.has(other.headCommit) && await this.ancestor(other.headCommit, proposal.headCommit)) {
            if (!proposal.dependsOn.includes(other.id)) proposal.dependsOn.push(other.id);
          }
        }
        proposal.dependsOn.sort();
        proposal.files = await this.changes(proposal.baseCommit, proposal.headCommit);
        eligible.set(proposal.id, proposal);
      } catch (error) {
        if (error.killed || error.code === 'ENOBUFS') throw error;
        rejected.push({ id: proposal.id, reason: error.code ? 'Git object/history inspection failed' : error.message });
      }
    }
    let current = baseCommit;
    const accepted = [];
    const conflicts = [];
    const risks = [];
    while (eligible.size) {
      const ready = [...eligible.values()].find((p) => p.dependsOn.every((id) => accepted.some((a) => a.id === id)));
      if (!ready) {
        for (const p of eligible.values()) rejected.push({ id: p.id, reason: 'dependency missing, rejected, conflicting, or cyclic', dependencies: p.dependsOn });
        break;
      }
      eligible.delete(ready.id);
      const paths = ready.files.flatMap((f) => [f.from, f.to]);
      const exclusive = accepted.find((p) => exclusivePaths.some((prefix) => paths.some((f) => f.startsWith(prefix)) && p.files.some((f) => f.from.startsWith(prefix) || f.to.startsWith(prefix))));
      if (exclusive) {
        conflicts.push({ id: ready.id, with: exclusive.id, kind: 'exclusive-artifact-domain', paths });
        continue;
      }
      for (const previous of accepted) {
        const previousPaths = previous.files.flatMap((f) => [f.from, f.to]);
        const overlap = [...new Set(paths.filter((p) => previousPaths.includes(p)))];
        const shared = dependencyGroups.filter((group) => group.some((prefix) => paths.some((p) => p.startsWith(prefix))) && group.some((prefix) => previousPaths.some((p) => p.startsWith(prefix))));
        if (overlap.length || shared.length) risks.push({ proposals: [previous.id, ready.id], overlap, sharedDependencyGroups: shared, required: 'combined integration verification' });
      }
      let tree;
      try {
        tree = (await this.git(['merge-tree', '--write-tree', '--messages', current, ready.headCommit])).split('\n')[0];
      } catch (error) {
        if (error.code !== 1) throw error;
        conflicts.push({ id: ready.id, kind: 'git-merge-conflict', report: String(error.stdout || '').slice(0, 65536) });
        continue;
      }
      if (!oid.test(tree)) throw new Error('Git returned an invalid candidate tree');
      accepted.push(ready);
      const timestamp = Number(await this.git(['show', '-s', '--format=%ct', baseCommit])) + accepted.length;
      const message = canonicalJson({ version: 1, baseCommit, proposals: accepted.map(({ id, baseCommit, headCommit, dependsOn }) => ({ id, baseCommit, headCommit, dependsOn })) });
      current = await this.git(['commit-tree', tree, '-p', current, '-p', ready.headCommit, '-m', message], {
        GIT_AUTHOR_NAME: 'Source Integration', GIT_AUTHOR_EMAIL: 'integration@source.invalid',
        GIT_COMMITTER_NAME: 'Source Integration', GIT_COMMITTER_EMAIL: 'integration@source.invalid',
        GIT_AUTHOR_DATE: `@${timestamp} +0000`, GIT_COMMITTER_DATE: `@${timestamp} +0000`,
      });
    }
    if (!accepted.length) return { candidate: null, rejected, conflicts, risks };
    const candidate = {
      version: 1, context, baseCommit, headCommit: current,
      tree: await this.git(['rev-parse', `${current}^{tree}`]),
      proposals: accepted.map(({ id, baseCommit, headCommit, dependsOn, files }) => ({ id, baseCommit, headCommit, dependsOn, files })),
      requiredVerification: ['preflight', 'integration'],
      state: 'proposed',
    };
    candidate.id = digest(candidate);
    // A retained immutable ref makes interrupted callers reproducible and keeps
    // candidate objects from GC. Equal inputs always produce the same ref/value.
    const ref = `refs/source/candidates/${candidate.id}`;
    try { await this.git(['update-ref', ref, current, '0'.repeat(current.length)]); }
    catch (error) {
      if (await this.git(['rev-parse', ref]) !== current) throw error;
    }
    return { candidate, rejected, conflicts, risks };
  }
}
