// Dogfood test: run the full Source vertical slice against a real Kujo
// repository. Uses the `spec` repo (a real, active Kujo project) by default,
// overridable via KUJO_REPO. Skips cleanly if the repo is not present.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Source } from '../src/source.js';

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function realRepoPath() {
  return process.env.KUJO_REPO || path.resolve(process.cwd(), '../spec');
}

test('dogfood: a real Kujo repository lives in Source end-to-end', (t) => {
  const repoPath = realRepoPath();
  if (!existsSync(path.join(repoPath, '.git'))) {
    t.skip(`real Kujo repo not found at ${repoPath}`);
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'source-dogfood-'));
  const src = new Source(dir);
  src.initInstance({ name: 'source.kujolang.ai', hosted: true, domains: ['source.kujolang.ai'] });
  const org = src.createOrg({ name: 'kujolang', slug: 'kujolang' });
  const project = src.createProject({ orgId: org.id, slug: 'spec', name: 'Spec', description: 'Kujo task contracts' });
  const human = src.createPrincipal({ type: 'human', name: 'maintainer' });
  const agent = src.createPrincipal({ type: 'agent', name: 'implementation-agent' });
  const service = src.createPrincipal({ type: 'service', name: 'verification-service' });

  // 1. Host the real repo: create a bare repo and push the real history.
  const repo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'spec' });
  const bare = repo.barePath;
  run(['push', '--mirror', bare], repoPath);
  const git = src.gitRepo(org.id, project.id, repo.id);
  const base = git.revParse('HEAD');
  assert.ok(base.length === 40, 'real repo has a base commit');

  // 2. Create a real Work item.
  const work = src.createWork({
    orgId: org.id,
    projectId: project.id,
    intent: 'Add a dogfood marker file documenting the Source integration',
    requester: human.id,
    requirements: ['a new file is added', 'no existing files are modified'],
    acceptanceConditions: ['change is a single additive file'],
  });

  // 3. Agent claims and starts a session with a bounded capability.
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const cap = src.capabilities.issue({
    principalId: agent.id,
    scope: { project: project.id, work: work.id },
    allowed: ['read_source', 'read_context', 'submit_change', 'submit_evidence'],
    denied: ['accept_change', 'modify_policy', 'publish_release'],
  });
  assert.ok(src.capabilities.authorize(cap.credential, 'submit_change').ok);
  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id, baseCommit: base });

  // 4. Agent makes a real change in a working clone and pushes a branch.
  const workDir = mkdtempSync(path.join(tmpdir(), 'source-dogfood-work-'));
  run(['clone', bare, workDir]);
  run(['config', 'user.email', 'agent@kujolang.ai'], workDir);
  run(['config', 'user.name', 'Source Agent'], workDir);
  writeFileSync(path.join(workDir, 'SOURCE_DOGFOOD.md'), '# Source dogfood\n\nThis file was produced by the Source vertical slice.\n');
  run(['add', 'SOURCE_DOGFOOD.md'], workDir);
  run(['commit', '-m', 'add Source dogfood marker'], workDir);
  const head = run(['rev-parse', 'HEAD'], workDir);
  run(['push', 'origin', `HEAD:refs/heads/source-dogfood`], workDir);

  // 5. Submit the Change against the exact base state.
  const change = src.submitChange({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id, baseCommit: base, headCommit: head });

  // 6. Generate real evidence: a deterministic check that the change is a
  //    single additive file (mirrors what Eval/ChangeBucket would assert).
  const changed = git.changedFiles(base, head);
  const additive = changed.length === 1 && changed[0].startsWith('A\t');
  const evidenceArtifact = JSON.stringify({ changedFiles: changed, additiveOnly: additive });
  const testEvidence = src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'change footprint', claim: 'tests pass', type: 'test', producer: service.id, artifact: evidenceArtifact, result: { status: additive ? 'pass' : 'fail' } });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'deterministic gate', claim: 'deterministic checks pass', type: 'eval', producer: service.id, artifact: JSON.stringify({ checks: 1, failed: additive ? 0 : 1 }), result: { status: additive ? 'pass' : 'fail' } });

  // 7. Evaluate policy and make a Decision.
  const evaluation = src.evaluateChange({ orgId: org.id, projectId: project.id, changeId: change.id });
  assert.equal(evaluation.evaluation.ok, true, 'evidence satisfies policy');
  const decision = src.makeDecision({ orgId: org.id, projectId: project.id, changeId: change.id, decision: 'accepted', decider: human.id, reasoning: 'single additive file, evidence satisfied' });

  // 8. Update canonical Git state.
  const update = src.updateCanonicalState({ orgId: org.id, projectId: project.id, changeId: change.id, repoId: repo.id });
  assert.equal(update.ok, true);
  assert.equal(git.revParse('main'), head);

  // 9. Verify the audit chain is reconstructable.
  const audit = src.readAudit();
  const events = audit.map((e) => e.event);
  for (const ev of ['work.create', 'session.start', 'change.submit', 'evidence.add', 'decision.make', 'canonical.update']) {
    assert.ok(events.includes(ev), `audit includes ${ev}`);
  }

  // 10. The evidence artifact is preserved, not reduced to PASS/FAIL.
  const stored = src.getArtifact(testEvidence.artifactRef.hash).toString('utf8');
  assert.ok(stored.includes('changedFiles'));
});
