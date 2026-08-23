import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/api.js';
import { freshSource, seedRepo } from './helpers.js';

test('local management UI covers repositories, workflows, runs, and settings', async () => {
  const { src, org, project } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  const capability = src.capabilities.issue({
    principalId: 'U1',
    scope: { org: org.id, project: project.id },
    allowed: [
      'read_source', 'read_context', 'read_workflows', 'read_jobs',
      'manage_repository', 'manage_work', 'manage_workflows',
      'dispatch_workflow', 'enqueue_job', 'git_push', 'accept_change',
    ],
  });
  const server = await startServer(src, { port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${capability.credential}` };
  try {
    const projectPage = await fetch(`${base}/o/${org.id}/p/${project.id}`, { headers });
    assert.equal(projectPage.status, 200);
    const projectHtml = await projectPage.text();
    assert.match(projectHtml, /\/assets\/sitekit\/sitekit\.css/);
    assert.match(projectHtml, /class="[^"]*sk-card/);
    const siteKit = await fetch(`${base}/assets/sitekit/sitekit.css`);
    assert.equal(siteKit.status, 200);
    assert.match(await siteKit.text(), /--sk-color-black/);
    const sourceScript = await fetch(`${base}/assets/source.js`);
    assert.equal(sourceScript.status, 200);
    assert.match(await sourceScript.text(), /data-source-copy/);
    assert.match(projectHtml, /class="[^"]*sk-navigation/);
    assert.match(projectHtml, /class="[^"]*source-page/);
    assert.match(projectHtml, /Repositories/);
    assert.match(projectHtml, /Add repository/);
    assert.match(projectHtml, /Actions/);

    const repoResponse = await fetch(`${base}/o/${org.id}/p/${project.id}/repos`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'docs', defaultBranch: 'main' }),
      redirect: 'manual',
    });
    assert.equal(repoResponse.status, 303);
    assert.match(repoResponse.headers.get('location'), /\/r\/R2\/tree\/main$/);

    const workResponse = await fetch(`${base}/o/${org.id}/p/${project.id}/work`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ intent: 'Improve repository docs', requirements: 'read docs\nadd example', acceptanceConditions: 'tests pass' }),
      redirect: 'manual',
    });
    assert.equal(workResponse.status, 303);
    assert.match(workResponse.headers.get('location'), /\/w\/W1$/);

    const repoPage = await fetch(`${base}/o/${org.id}/p/${project.id}/r/${repo.id}/tree/main`, { headers });
    assert.equal(repoPage.status, 200);
    const repoHtml = await repoPage.text();
    assert.match(repoHtml, /Clone this repository/);
    assert.match(repoHtml, /data-source-copy="http:\/\/127\.0\.0\.1:/);
    assert.match(repoHtml, /git clone http:\/\/127\.0\.0\.1:/);
    assert.match(repoHtml, /data-source-branch-select/);
    assert.match(repoHtml, /data-source-repo-tab="contents"/);
    assert.match(repoHtml, /data-source-repo-tab="history"/);
    assert.match(repoHtml, /source-file-kind/);

    const readmePage = await fetch(`${base}/o/${org.id}/p/${project.id}/r/${repo.id}/blob/main/README.md`, { headers });
    assert.equal(readmePage.status, 200);
    const readmeHtml = await readmePage.text();
    assert.match(readmeHtml, /source-file-page/);
    assert.match(readmeHtml, /source-readme-content/);
    assert.match(readmeHtml, /View source/);

    const createWorkflow = await fetch(`${base}/o/${org.id}/p/${project.id}/actions`, { headers });
    const actionsHtml = await createWorkflow.text();
    assert.equal(createWorkflow.status, 200, actionsHtml);
    assert.match(actionsHtml, /Import GitHub Actions/);

    const settings = await fetch(`${base}/o/${org.id}/p/${project.id}/settings`, { headers });
    assert.equal(settings.status, 200);
    assert.match(await settings.text(), /Deployment/);

    const workflowResponse = await fetch(`${base}/o/${org.id}/p/${project.id}/actions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'checks', triggers: 'manual', jobs: '[{"kind":"agent.check","payload":{}}]' }),
      redirect: 'manual',
    });
    assert.equal(workflowResponse.status, 303);
    const workflowId = workflowResponse.headers.get('location').split('/').at(-1);
    const actionPage = await fetch(`${base}/o/${org.id}/p/${project.id}/actions/${workflowId}`, { headers });
    assert.equal(actionPage.status, 200);
    assert.match(await actionPage.text(), /Run workflow/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
