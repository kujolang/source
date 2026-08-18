import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freshSource, seedRepo } from './helpers.js';

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

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
