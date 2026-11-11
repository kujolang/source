import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSource } from './helpers.js';
import { submitFromWorkingDir } from '../src/submit.js';

test('nontransactional stores reject keyed submission before creating work', async () => {
  const { src, org, project, human } = freshSource();
  const input = { orgId: org.id, projectId: project.id, principalId: human.id, submissionKey: 'safe-key' };
  await assert.rejects(() => src.submitContributionAsync(input), { code: 'SUBMISSION_STORE_UNSUPPORTED' });
  await assert.rejects(() => src.getSubmissionAsync(input), { code: 'SUBMISSION_STORE_UNSUPPORTED' });
  assert.deepEqual(src.listWork(org.id, project.id), []);
});

test('recovery client rejects absent or unsafe keys before repository access', async () => {
  await assert.rejects(() => submitFromWorkingDir({ cwd: '/nonexistent', recover: true }), /requires --submission-key/);
  await assert.rejects(() => submitFromWorkingDir({ cwd: '/nonexistent', submissionKey: 'unsafe/key' }), /invalid submission key/);
});

test('project transaction context cannot escape its scope or outlive its callback', async () => {
  const { src, org, project } = freshSource();
  let captured;
  await src._projectMutationAsync(org.id, project.id, async () => {
    await assert.rejects(() => src._projectMutationAsync(org.id, 'different', () => {}), /same project/);
    captured = src.projectMutationContext.getStore();
  });
  await src.projectMutationContext.run(captured, async () => {
    await assert.rejects(() => src._projectMutationAsync(org.id, project.id, () => {}), /no longer active/);
  });
});
