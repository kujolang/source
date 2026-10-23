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
