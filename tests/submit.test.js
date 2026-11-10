// `source submit` contribution-flow tests.
//
// Proves that a developer who knows Git but not Source can clone a repository,
// make a modification, and submit it through a minimal Source-specific step,
// and that Source creates the correct Work → Session → Change → Evidence
// lifecycle. Also proves the contribution can be completed end-to-end by a
// maintainer, and that empty changes are rejected.
//
// The contribution flow uses a public repository (anonymous clone) plus a
// `git_push` capability credential for the push. The developer needs a git
// credential but does not need to understand Source concepts.
//
// Note: the git client runs in the same process as the server, so git commands
// must be invoked asynchronously (execFile, not execFileSync) to avoid blocking
// the event loop that serves the HTTP requests.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { freshSource, seedRepo } from './helpers.js';
import { startServer } from '../src/api.js';
import { submitFromWorkingDir } from '../src/submit.js';

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve(stdout.trim());
    });
  });
}

async function withServer(src, fn) {
  const server = await startServer(src, { port: 0 });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

// A public project + seeded repo + a git_push capability for the contributor.
function publicSetup() {
  const { src, org, human, service } = freshSource();
  const project = src.createProject({ orgId: org.id, slug: 'public', name: 'Public', visibility: 'public' });
  const { repo, head: seedHead } = seedRepo(src, org.id, project.id);
  const cap = src.issueGitCapability({ orgId: org.id, projectId: project.id, principalId: human.id });
  return { src, org, project, human, service, repo, seedHead, cap };
}

// Clone a public Source repo over HTTP, make a change, and return the working dir.
async function cloneAndModify(base, orgId, projectId, repoName) {
  const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-submit-'));
  await run(['clone', `${base}/git/${orgId}/${projectId}/${repoName}.git`, cloneDir]);
  await run(['config', 'user.email', 'dev@example.com'], cloneDir);
  await run(['config', 'user.name', 'Dev Contributor'], cloneDir);
  writeFileSync(path.join(cloneDir, 'FEATURE.md'), '# feature\n');
  await run(['add', '.'], cloneDir);
  await run(['commit', '-m', 'add feature doc'], cloneDir);
  return cloneDir;
}

test('source submit: a Git-only developer contributes without knowing Source', async () => {
  const { src, org, project, repo, seedHead, cap } = publicSetup();

  await withServer(src, async (base) => {
    const cloneDir = await cloneAndModify(base, org.id, project.id, repo.name);

    // The minimal Source-specific step (with a git_push credential for the push).
    const result = await submitFromWorkingDir({ cwd: cloneDir, baseUrl: base, credential: cap.credential });

    // Source created the correct lifecycle.
    assert.ok(result.work, 'work created');
    assert.equal(result.work.type, 'contribution');
    assert.ok(result.session, 'session created');
    assert.ok(result.change, 'change created');
    assert.ok(result.evidence, 'evidence created');

    // The Change is tied to the exact base source state (the remote tip at
    // clone time) and a distinct head commit.
    assert.equal(result.change.baseCommit, seedHead);
    assert.notEqual(result.change.headCommit, seedHead);
    assert.equal(result.change.repositories[0], repo.id);

    // The head commit is present in the bare repo (pushed by submit).
    const git = src.gitRepo(org.id, project.id, repo.id);
    assert.ok(git.hasCommit(result.change.headCommit));

    // The lifecycle is reconstructable: Work → Session → Change → Evidence.
    const work = src.getWork(org.id, project.id, result.work.id);
    assert.ok(work.sessions.includes(result.session.id));
    assert.ok(work.changes.includes(result.change.id));

    const change = src.getChange(org.id, project.id, result.change.id);
    assert.ok(change.evidence.includes(result.evidence.id));
    assert.equal(change.sessionId, result.session.id);

    // The footprint evidence is preserved, not reduced to PASS/FAIL.
    const artifact = src.getArtifact(result.evidence.artifactRef.hash).toString('utf8');
    assert.ok(artifact.includes('changedFiles'));

    // Missing evidence (tests/eval) is visible — the maintainer's verification
    // service fills those.
    assert.equal(result.evaluation.ok, false);
    assert.ok(result.evaluation.missing.length > 0);
  });
});

test('source submit: a contribution can be completed end-to-end by a maintainer', async () => {
  const { src, org, project, human, service, repo, cap } = publicSetup();

  await withServer(src, async (base) => {
    const cloneDir = await cloneAndModify(base, org.id, project.id, repo.name);
    const result = await submitFromWorkingDir({ cwd: cloneDir, baseUrl: base, credential: cap.credential });

    // The maintainer's verification service fills the required evidence.
    src.addEvidence({ orgId: org.id, projectId: project.id, changeId: result.change.id, subject: 'tests', claim: 'tests pass', type: 'test', producer: service.id, result: { status: 'pass' } });
    src.addEvidence({ orgId: org.id, projectId: project.id, changeId: result.change.id, subject: 'eval', claim: 'deterministic checks pass', type: 'eval', producer: service.id, result: { status: 'pass' } });

    const evaluation = src.evaluateChange({ orgId: org.id, projectId: project.id, changeId: result.change.id });
    assert.equal(evaluation.evaluation.ok, true, 'evidence now satisfies policy');

    const decision = src.makeDecision({ orgId: org.id, projectId: project.id, changeId: result.change.id, decision: 'accepted', decider: human.id, reasoning: 'contribution verified' });
    assert.equal(decision.decision, 'accepted');

    const update = src.updateCanonicalState({ orgId: org.id, projectId: project.id, changeId: result.change.id, repoId: repo.id });
    assert.equal(update.ok, true);

    const git = src.gitRepo(org.id, project.id, repo.id);
    assert.equal(git.revParse('main'), result.change.headCommit);

    // The full chain is reconstructable from the audit log.
    const events = src.readAudit().map((e) => e.event);
    for (const ev of ['work.create', 'session.start', 'change.submit', 'evidence.add', 'decision.make', 'canonical.update']) {
      assert.ok(events.includes(ev), `audit includes ${ev}`);
    }
  });
});

test('source submit: empty change is rejected', async () => {
  const { src, org, project, repo } = publicSetup();

  await withServer(src, async (base) => {
    // Clone without modifying.
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-submit-empty-'));
    await run(['clone', `${base}/git/${org.id}/${project.id}/${repo.name}.git`, cloneDir]);
    await run(['config', 'user.email', 'dev@example.com'], cloneDir);
    await run(['config', 'user.name', 'Dev Contributor'], cloneDir);

    await assert.rejects(
      () => submitFromWorkingDir({ cwd: cloneDir, baseUrl: base }),
      /no changes to submit/,
    );
  });
});

test('secondary remote submit uses fresh Source history even when GitHub origin already has HEAD', async () => {
  const { src, org, project, repo, seedHead, cap } = publicSetup();
  await withServer(src, async (base) => {
    const cwd = await cloneAndModify(base, org.id, project.id, repo.name);
    await run(['remote', 'rename', 'origin', 'source'], cwd);
    await run(['remote', 'add', 'origin', 'git@github.com:example/repo.git'], cwd);
    await run(['update-ref', 'refs/remotes/origin/main', 'HEAD'], cwd);
    // Even stale Source tracking refs must not influence the proposal base.
    await run(['update-ref', 'refs/remotes/source/main', 'HEAD'], cwd);
    const result = await submitFromWorkingDir({ cwd, credential: cap.credential });
    assert.equal(result.change.baseCommit, seedHead);
    assert.equal(await run(['remote', 'get-url', 'origin'], cwd), 'git@github.com:example/repo.git');
    assert.equal(src.gitRepo(org.id, project.id, repo.id).revParse('main'), seedHead);
  });
});

test('explicit and configured remote selection supports a nonstandard default branch', async () => {
  const { src, org, project, repo, seedHead, cap } = publicSetup();
  await run(['branch', 'release', seedHead], repo.barePath);
  await run(['symbolic-ref', 'HEAD', 'refs/heads/release'], repo.barePath);
  await withServer(src, async (base) => {
    const cwd = await cloneAndModify(base, org.id, project.id, repo.name);
    await run(['remote', 'rename', 'origin', 'backup'], cwd);
    await run(['remote', 'add', 'origin', 'git@github.com:example/repo.git'], cwd);
    // Explicit selection wins over an invalid configured choice.
    await run(['config', 'source.remote', 'missing'], cwd);
    const result = await submitFromWorkingDir({ cwd, remote: 'backup', credential: cap.credential });
    assert.equal(result.change.baseCommit, seedHead);
    await run(['config', 'source.remote', 'backup'], cwd);
    await assert.rejects(() => submitFromWorkingDir({ cwd, remote: 'origin' }), /expected a Source/);
    // Reach the selected remote via config, then reject an empty proposal.
    await run(['reset', '--hard', seedHead], cwd);
    await assert.rejects(() => submitFromWorkingDir({ cwd, credential: cap.credential }), /no changes to submit/);
  });
});

for (const credentialSource of ['argument', 'environment']) test(`private secondary-remote submit authenticates API using ${credentialSource} credential`, async () => {
  const { src, org, project, human } = freshSource();
  const { repo, work: cwd } = seedRepo(src, org.id, project.id);
  const scope = { org: org.id, project: project.id };
  const cap = src.capabilities.issue({ principalId: human.id, scope, allowed: ['read_source', 'git_push', 'submit_change'] });
  await withServer(src, async (base) => {
    await run(['remote', 'set-url', 'origin', 'git@github.com:example/private.git'], cwd);
    await run(['remote', 'add', 'source', `${base}/git/${org.id}/${project.id}/${repo.id}.git`], cwd);
    writeFileSync(path.join(cwd, 'private-feature'), 'private feature\n');
    await run(['add', '.'], cwd); await run(['commit', '-m', 'private feature'], cwd);
    const previous = process.env.SOURCE_CREDENTIAL;
    try {
      if (credentialSource === 'environment') process.env.SOURCE_CREDENTIAL = cap.credential;
      const result = await submitFromWorkingDir({ cwd, ...(credentialSource === 'argument' ? { credential: cap.credential } : {}) });
      assert.equal(result.session.principal, human.id);
      assert.equal(result.change.repositories[0], repo.id);
      assert.equal(await run(['remote', 'get-url', 'origin'], cwd), 'git@github.com:example/private.git');
    } finally {
      if (previous == null) delete process.env.SOURCE_CREDENTIAL; else process.env.SOURCE_CREDENTIAL = previous;
    }
    const gitOnly = src.issueGitCapability({ orgId: org.id, projectId: project.id, principalId: human.id });
    await assert.rejects(() => submitFromWorkingDir({ cwd, credential: gitOnly.credential }), /not allowed|denied|capability|unauthorized/i);
  });
});

test('authenticated submit refuses a different API origin before pushing', async () => {
  const { src, org, project, human } = freshSource();
  const { repo, work: cwd } = seedRepo(src, org.id, project.id);
  await run(['remote', 'add', 'source', `https://source.example/git/${org.id}/${project.id}/${repo.id}.git`], cwd);
  const cap = src.issueGitCapability({ orgId: org.id, projectId: project.id, principalId: human.id });
  await assert.rejects(() => submitFromWorkingDir({ cwd, credential: cap.credential, baseUrl: 'https://different.example' }), /same origin/);
  assert.equal(await run(['for-each-ref', '--format=%(refname)', 'refs/heads/source-submit-'], repo.barePath), '');
});
