import test from 'node:test';
import assert from 'node:assert/strict';
import { translateGitHubActions } from '../src/integrations/github-actions.js';
import { freshSource } from './helpers.js';

test('GitHub Actions translation preserves bounded step data without executing it', () => {
  const workflow = translateGitHubActions(`
name: release checks
on:
  push:
  workflow_dispatch:
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - name: test
        run: kujo run main.kujo run --json
`, { repoId: 'R1', ref: 'abc123', path: '.github/workflows/release.yml' });
  assert.equal(workflow.name, 'release checks');
  assert.deepEqual(workflow.triggers, ['push', 'workflow_dispatch']);
  assert.equal(workflow.jobs[0].kind, 'github.actions.job');
  assert.equal(workflow.jobs[0].payload.steps[1].run, 'kujo run main.kujo run --json');
  assert.deepEqual(workflow.source, { provider: 'github-actions', repoId: 'R1', ref: 'abc123', path: '.github/workflows/release.yml' });
});

test('GitHub Actions translation rejects unsupported or oversized workflows', () => {
  assert.throws(() => translateGitHubActions('on: workflow_call\njobs:\n  test:\n    steps: []\n'), /supported GitHub event/);
  assert.throws(() => translateGitHubActions('on: push\njobs:\n  test:\n    steps:\n' + Array.from({ length: 101 }, (_, i) => `      - name: ${i}`).join('\n')), /too many steps/);
});

test('workflow import resolves repositories through project membership', async () => {
  const { src, org, project } = freshSource();
  src.getRepositoryAsync = async () => ({ barePath: '/outside/project.git' });
  await assert.rejects(
    src.importGitHubWorkflowAsync({
      orgId: org.id,
      projectId: project.id,
      repoId: '../../other-org/repos/R1',
      path: '.github/workflows/checks.yml',
    }),
    /repository not found/,
  );
});
