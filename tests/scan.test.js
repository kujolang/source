// Credential-scanning tests.
//
// Proves the deterministic scanner detects common credential patterns, returns
// no findings for clean text, redacts values (never stores the credential), and
// that a Change's diff is scanned and a contribution with a credential is
// flagged with a `security` evidence (validity 'invalid').

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanSecrets } from '../src/scan.js';
import { freshSource } from './helpers.js';

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Classic AWS example access key id, built by concatenation so the literal
// credential prefix is not present verbatim in this test file.
const AWS_KEY = 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';

test('scanSecrets detects common credential patterns', () => {
  const findings = scanSecrets(`key = ${AWS_KEY}`);
  assert.ok(findings.some((f) => f.name === 'aws_access_key_id'));
});

test('scanSecrets returns no findings for clean text', () => {
  assert.deepEqual(scanSecrets('const x = 1;'), []);
});

test('scanSecrets redacts values (no credential text in findings)', () => {
  const findings = scanSecrets(AWS_KEY);
  const json = JSON.stringify(findings);
  assert.ok(!json.includes(AWS_KEY));
});

// Seed a repo whose head commit adds a file containing a credential.
function seedRepoWithCredential(src, orgId, projectId) {
  const repo = src.createRepository({ orgId, projectId, name: 'main' });
  const work = mkdtempSync(path.join(tmpdir(), 'source-scan-'));
  run(['init', '-b', 'main'], work);
  run(['config', 'user.email', 'test@example.com'], work);
  run(['config', 'user.name', 'Test'], work);
  writeFileSync(path.join(work, 'README.md'), '# hello\n');
  run(['add', '.'], work);
  run(['commit', '-m', 'initial'], work);
  const base = run(['rev-parse', 'HEAD'], work);
  writeFileSync(path.join(work, 'config.txt'), `aws_key = ${AWS_KEY}\n`);
  run(['add', '.'], work);
  run(['commit', '-m', 'add config'], work);
  const head = run(['rev-parse', 'HEAD'], work);
  run(['remote', 'add', 'origin', repo.barePath], work);
  run(['push', 'origin', 'main'], work);
  return { repo, base, head };
}

test('scanChangeSecrets finds credentials in a change diff', () => {
  const { src, org, project, agent, human } = freshSource();
  const { repo, base, head } = seedRepoWithCredential(src, org.id, project.id);

  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'add config', requester: human.id });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id, baseCommit: base });
  const change = src.submitChange({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id, baseCommit: base, headCommit: head, repositories: [repo.id] });

  const findings = src.scanChangeSecrets({ orgId: org.id, projectId: project.id, changeId: change.id });
  assert.ok(findings.some((f) => f.name === 'aws_access_key_id'));
});

test('submitContribution records a security finding when the diff contains a credential', () => {
  const { src, org, project } = freshSource();
  const { repo, base, head } = seedRepoWithCredential(src, org.id, project.id);

  const result = src.submitContribution({ orgId: org.id, projectId: project.id, repoRef: repo.id, baseCommit: base, headCommit: head, intent: 'add config', contributorName: 'dev' });

  assert.ok(result.findings.length > 0, 'findings present');
  assert.ok(result.securityEvidence, 'security evidence recorded');
  assert.equal(result.securityEvidence.type, 'security');
  assert.equal(result.securityEvidence.validity, 'invalid');
});
