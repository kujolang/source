// Multi-repository Change tests.
//
// Proves that a single Change can span multiple repositories, that the
// canonical `repositoryChanges` representation is populated, and that a
// multi-repo Change completes the full lifecycle and updates every repository's
// canonical state.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freshSource } from './helpers.js';

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Seed a repository (named) with two commits (base, head) and push to the bare repo.
function seedRepoNamed(src, orgId, projectId, name) {
  const repo = src.createRepository({ orgId, projectId, name });
  const work = mkdtempSync(path.join(tmpdir(), 'source-mr-'));
  run(['init', '-b', 'main'], work);
  run(['config', 'user.email', 'test@example.com'], work);
  run(['config', 'user.name', 'Test'], work);
  writeFileSync(path.join(work, 'README.md'), `# ${name}\n`);
  run(['add', '.'], work);
  run(['commit', '-m', 'initial'], work);
  const base = run(['rev-parse', 'HEAD'], work);
  writeFileSync(path.join(work, 'README.md'), `# ${name}\n\nchange\n`);
  run(['add', '.'], work);
  run(['commit', '-m', 'change'], work);
  const head = run(['rev-parse', 'HEAD'], work);
  run(['remote', 'add', 'origin', repo.barePath], work);
  run(['push', 'origin', 'main'], work);
  return { repo, base, head };
}

test('a Change can span multiple repositories', () => {
  const { src, org, project, agent, human } = freshSource();
  const a = seedRepoNamed(src, org.id, project.id, 'app');
  const b = seedRepoNamed(src, org.id, project.id, 'lib');

  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'change app and lib together', requester: human.id });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id, baseCommit: a.base });

  const change = src.submitChange({
    orgId: org.id,
    projectId: project.id,
    workId: work.id,
    sessionId: session.id,
    repositoryChanges: [
      { repoId: a.repo.id, baseCommit: a.base, headCommit: a.head },
      { repoId: b.repo.id, baseCommit: b.base, headCommit: b.head },
    ],
  });

  assert.equal(change.repositoryChanges.length, 2);
  assert.deepEqual(change.repositories, [a.repo.id, b.repo.id]);
  // Primary view = first repository.
  assert.equal(change.baseCommit, a.base);
  assert.equal(change.headCommit, a.head);
});

test('a multi-repository Change completes the full lifecycle and updates both repos', () => {
  const { src, org, project, agent, service, human } = freshSource();
  const a = seedRepoNamed(src, org.id, project.id, 'app');
  const b = seedRepoNamed(src, org.id, project.id, 'lib');

  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'coordinated change', requester: human.id });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id, baseCommit: a.base });

  const change = src.submitChange({
    orgId: org.id,
    projectId: project.id,
    workId: work.id,
    sessionId: session.id,
    repositoryChanges: [
      { repoId: a.repo.id, baseCommit: a.base, headCommit: a.head },
      { repoId: b.repo.id, baseCommit: b.base, headCommit: b.head },
    ],
  });

  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'tests', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } });
  src.addEvidence({ orgId: org.id, projectId: project.id, changeId: change.id, subject: 'eval', claim: 'deterministic checks pass', type: 'eval', producer: service.id, result: { status: 'pass' } });

  const decision = src.makeDecision({ orgId: org.id, projectId: project.id, changeId: change.id, decision: 'accepted', decider: human.id });
  assert.equal(decision.decision, 'accepted');
  // The Decision records the full multi-repo source state.
  assert.equal(decision.sourceStates.length, 2);

  const update = src.updateCanonicalState({ orgId: org.id, projectId: project.id, changeId: change.id });
  assert.equal(update.ok, true);
  assert.equal(update.results.length, 2);

  const gitA = src.gitRepo(org.id, project.id, a.repo.id);
  const gitB = src.gitRepo(org.id, project.id, b.repo.id);
  assert.equal(gitA.revParse('main'), a.head);
  assert.equal(gitB.revParse('main'), b.head);
});
