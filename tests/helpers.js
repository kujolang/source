// Shared test helpers: a fresh Source instance in a temp directory.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Source } from '../src/source.js';

export function freshSource() {
  const dir = mkdtempSync(path.join(tmpdir(), 'source-test-'));
  const src = new Source(dir);
  src.initInstance({ name: 'test' });
  const org = src.createOrg({ name: 'test-org', slug: 'test-org' });
  const project = src.createProject({ orgId: org.id, slug: 'test', name: 'Test Project' });
  const human = src.createPrincipal({ type: 'human', name: 'maintainer' });
  const agent = src.createPrincipal({ type: 'agent', name: 'agent-1' });
  const service = src.createPrincipal({ type: 'service', name: 'verifier' });
  return { src, dir, org, project, human, agent, service };
}

// Build a minimal git history in a bare repo and return {base, head}.
// Creates two commits: base (initial) and head (a change on top).
export function seedRepo(src, orgId, projectId) {
  const repo = src.createRepository({ orgId, projectId, name: 'main' });
  const work = mkdtempSync(path.join(tmpdir(), 'source-git-'));
  const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  run(['init', '-b', 'main'], work);
  run(['config', 'user.email', 'test@example.com'], work);
  run(['config', 'user.name', 'Test'], work);
  writeFileSync(path.join(work, 'README.md'), '# hello\n');
  run(['add', '.'], work);
  run(['commit', '-m', 'initial'], work);
  const base = run(['rev-parse', 'HEAD'], work);

  writeFileSync(path.join(work, 'README.md'), '# hello\n\nchange\n');
  run(['add', '.'], work);
  run(['commit', '-m', 'change'], work);
  const head = run(['rev-parse', 'HEAD'], work);

  run(['remote', 'add', 'origin', repo.barePath], work);
  run(['push', 'origin', 'main'], work);

  return { repo, base, head, work };
}
