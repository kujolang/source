import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freshSource, seedRepo } from './helpers.js';
import { Source } from '../src/source.js';

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('Git repositories can live on a separate shared root', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'source-metadata-'));
  const gitRoot = mkdtempSync(path.join(tmpdir(), 'source-git-root-'));
  const src = new Source(dataRoot, { gitRoot });
  src.initInstance({ name: 'shared-git-root' });
  const org = src.createOrg({ name: 'org', slug: 'org' });
  const project = src.createProject({ orgId: org.id, name: 'project', slug: 'project' });
  const repo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'main' });
  assert.equal(repo.barePath.startsWith(gitRoot), true);
  assert.equal(repo.barePath.startsWith(dataRoot), false);
});

test('git clone works against a Source bare repository', () => {
  const { src, org, project } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-clone-'));
  run(['clone', repo.barePath, cloneDir]);
  const readme = execFileSync('cat', [path.join(cloneDir, 'README.md')], { encoding: 'utf8' });
  assert.ok(readme.includes('change'));
});

test('git fetch works', () => {
  const { src, org, project } = freshSource();
  const { repo, work } = seedRepo(src, org.id, project.id);
  // Make a new commit in the working repo and push, then fetch from a fresh clone.
  writeFileSync(path.join(work, 'NEW.md'), 'new\n');
  run(['add', '.'], work);
  run(['commit', '-m', 'new'], work);
  run(['push', 'origin', 'main'], work);

  const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-fetch-'));
  run(['clone', repo.barePath, cloneDir]);
  run(['fetch', 'origin'], cloneDir);
  const log = run(['log', '--oneline', 'origin/main'], cloneDir);
  assert.ok(log.includes('new'));
});

test('git push works (contribution transport)', () => {
  const { src, org, project } = freshSource();
  const { repo, work } = seedRepo(src, org.id, project.id);
  writeFileSync(path.join(work, 'CONTRIB.md'), 'contribution\n');
  run(['add', '.'], work);
  run(['commit', '-m', 'contribution'], work);
  run(['push', 'origin', 'main'], work);
  const git = src.gitRepo(org.id, project.id, repo.id);
  const tip = git.revParse('main');
  assert.ok(tip.length === 40);
});

test('revision inputs cannot inject Git options or create output files', async () => {
  const { src, dir, org, project } = freshSource();
  const { repo, base, head } = seedRepo(src, org.id, project.id);
  const git = src.gitRepo(org.id, project.id, repo.id);
  const target = path.join(dir, 'unexpected-output');
  await assert.rejects(() => git.diffAsync(`${base}..${head}`, `--output=${target}`), /invalid Git revision/);
  assert.throws(() => git.diff(`${base}..${head}`, `--output=${target}`), /invalid Git revision/);
  assert.equal(existsSync(target), false);
  assert.ok((await git.diffAsync(base, head)).includes('change'));
});


test('repository file reads preserve exact UTF-8 whitespace', async () => {
  const { src, org, project } = freshSource();
  const { repo, work } = seedRepo(src, org.id, project.id);
  const content = '\n  indented\n\ttrailing whitespace  \n\n';
  writeFileSync(path.join(work, 'spaces.txt'), content);
  run(['add', 'spaces.txt'], work);
  run(['commit', '-m', 'whitespace fixture'], work);
  run(['push', 'origin', 'main'], work);
  const git = src.gitRepo(org.id, project.id, repo.id);
  assert.equal(await git.showFileAsync('main', 'spaces.txt'), content);
});

test('replacement refs cannot hide committed credentials from contribution evidence or repository reads', async () => {
  const { src, org, project, human } = freshSource();
  const { repo, work, head: base } = seedRepo(src, org.id, project.id);
  const fixtureToken = 'gh' + 'p_' + 'x'.repeat(36); // synthetic, never a real credential
  writeFileSync(path.join(work, 'credential.txt'), `${fixtureToken}\n`);
  writeFileSync(path.join(work, 'feature.txt'), 'feature\n');
  run(['add', '.'], work); run(['commit', '-m', 'original proposal'], work);
  const original = run(['rev-parse', 'HEAD'], work);
  run(['push', 'origin', 'HEAD:refs/heads/original'], work);
  run(['reset', '--hard', base], work);
  writeFileSync(path.join(work, 'feature.txt'), 'feature\n');
  run(['add', '.'], work); run(['commit', '-m', 'replacement without credential'], work);
  const replacement = run(['rev-parse', 'HEAD'], work);
  run(['push', 'origin', 'HEAD:refs/heads/replacement'], work);
  run(['replace', original, replacement], repo.barePath);
  const contribution = await src.submitContributionAsync({ orgId: org.id, projectId: project.id, repoRef: repo.id, baseCommit: base, headCommit: original, principalId: human.id, intent: 'replacement fixture' });
  assert.ok(contribution.findings.some((finding) => finding.name === 'github_token'));
  assert.equal(contribution.securityEvidence.validity, 'invalid');
  assert.ok(src.scanChangeSecrets({ orgId: org.id, projectId: project.id, changeId: contribution.change.id }).some((f) => f.name === 'github_token'));
  const git = src.gitRepo(org.id, project.id, repo.id);
  assert.equal(await git.showFileAsync(original, 'credential.txt'), `${fixtureToken}\n`);
  assert.ok(git.diff(base, original).includes('credential.txt'));
  assert.ok((await git.changedFilesAsync(base, original)).some((name) => name.includes('credential.txt')));
});
