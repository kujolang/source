// Local contract fixture: real Source + Worker handlers + real Git; no cloud calls.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Source } from '../../../src/source.js';
import { ArtifactsBridge, artifactsGit } from '../../../src/integrations/artifacts.js';
import worker from '../../../cloudflare/artifacts-bootstrap/worker.js';

export const runGit = (args, cwd) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export async function hybridFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'source-hybrid-'));
  const remotePath = path.join(root, 'remote.git');
  const writer = path.join(root, 'writer'); mkdirSync(writer);
  runGit(['init', '-b', 'main'], writer);
  runGit(['config', 'user.name', 'Source hybrid fixture'], writer);
  runGit(['config', 'user.email', 'hybrid@example.invalid'], writer);
  const name = 'source-hybrid-contract';
  const remote = `https://fixture.artifacts.cloudflare.net/git/source-bootstrap/${name}.git`;
  const token = 'art_v1_contract-fixture-only', secret = 'local-contract-worker-secret-32-characters';
  const calls = [];
  const env = { SOURCE_BOOTSTRAP_SECRET: secret, ARTIFACTS: {
    async create(repoName) { calls.push(['create', repoName]); runGit(['init', '--bare', '--initial-branch=main', remotePath], root); return { name, remote, token }; },
    async get(repoName) {
      calls.push(['get', repoName]);
      return { async info() { return { name, remote }; },
        async createToken(scope, ttl) { calls.push(['token', scope, ttl]); return { plaintext: token, expiresAt: Math.floor(Date.now() / 1000) + ttl }; },
        [Symbol.dispose]() { calls.push(['dispose']); }
      };
    },
  } };
  const transport = { before: null, after: null };
  const bridge = new ArtifactsBridge({ url: 'https://worker.example.invalid', secret,
    fetchImpl: (url, options) => worker.fetch(new Request(url, options), env),
    runGit: async (args, options) => {
      if (args.includes(remote) && options.token !== token) throw new Error('missing fixture credential');
      if (transport.before) await transport.before(args);
      const output = await artifactsGit(args.map((arg) => arg === remote ? remotePath : arg), options);
      if (transport.after) await transport.after(args);
      return output;
    },
  });
  const src = new Source(path.join(root, 'data'), { artifacts: bridge });
  src.initInstance({ name: 'hybrid fixture' });
  const org = src.createOrg({ name: 'Fixture', slug: 'fixture' });
  const project = src.createProject({ orgId: org.id, name: 'Hybrid', slug: 'hybrid' });
  const human = src.createPrincipal({ type: 'human', name: 'Maintainer' });
  src.addOrgMember({ orgId: org.id, principalId: human.id, role: 'maintainer' });
  const agent = src.createPrincipal({ type: 'agent', name: 'Scripted contributor' });
  const service = src.createPrincipal({ type: 'service', name: 'Fixture verifier' });
  const scope = { orgId: org.id, projectId: project.id };
  const repo = src.createRepository({ ...scope, name: 'hybrid' });
  await src.bindArtifactsRepositoryAsync({ ...scope, repoId: repo.id, name, createRemote: true });
  let serial = 0;
  function commit(content) {
    writeFileSync(path.join(writer, 'README.md'), content);
    runGit(['add', 'README.md'], writer); runGit(['commit', '-m', `Fixture ${++serial}`], writer);
    return runGit(['rev-parse', 'HEAD'], writer);
  }
  function propose(base, head) {
    runGit(['push', repo.barePath, `${head}:refs/heads/proposal-${serial}`], writer);
    const work = src.createWork({ ...scope, intent: 'Verify hybrid publication', requester: human.id });
    src.claimWork({ ...scope, workId: work.id, principalId: agent.id });
    const session = src.startSession({ ...scope, workId: work.id, principalId: agent.id, baseCommit: base });
    const change = src.submitChange({ ...scope, workId: work.id, sessionId: session.id, repositoryChanges: [{ repoId: repo.id, baseCommit: base, headCommit: head }] });
    // Verify the exact proposed Git object, then retain that executable evidence.
    const content = runGit(['show', `${head}:README.md`], repo.barePath);
    if (!content.startsWith('#')) throw new Error('fixture content check failed');
    for (const type of ['test', 'eval']) src.addEvidence({ ...scope, changeId: change.id, subject: 'README check', claim: type === 'test' ? 'tests pass' : 'deterministic checks pass', type, producer: service.id, result: { status: 'pass', commit: head }, artifact: JSON.stringify({ command: 'git show <head>:README.md; assert heading', commit: head, passed: true }) });
    return { work, change, accept: () => src.makeDecision({ ...scope, changeId: change.id, decision: 'accepted', decider: human.id }), promote: () => src.updateCanonicalStateAsync({ ...scope, changeId: change.id }) };
  }
  return { root, remotePath, writer, name, remote, token, secret, calls, transport, bridge, src, scope, repo, human, agent, commit, propose,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
