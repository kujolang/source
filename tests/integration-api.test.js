import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { freshSource, seedRepo } from './helpers.js';
import { startServer } from '../src/api.js';

test('integration API scopes planning, uses persisted proposal heads, retains inspectable snapshots', async (t) => {
  const { src, dir, org, project, agent } = freshSource();
  const { repo, work: cwd, head: baseCommit } = seedRepo(src, org.id, project.id);
  const work = src.createWork({ orgId: org.id, projectId: project.id, intent: 'test integration', requester: agent.id });
  src.claimWork({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const session = src.startSession({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id, baseCommit });
  writeFileSync(path.join(cwd, 'feature'), 'feature');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('add', '.'); git('commit', '-m', 'feature');
  const headCommit = git('rev-parse', 'HEAD');
  git('push', 'origin', 'HEAD:refs/heads/feature');
  const change = src.submitChange({ orgId: org.id, projectId: project.id, workId: work.id, sessionId: session.id, baseCommit, headCommit, repositories: [repo.id] });
  const server = await startServer(src, { port: 0 });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/v1/orgs/${org.id}/projects/${project.id}/repositories/${repo.id}/integration`;
  const issue = (scope, allowed) => src.capabilities.issue({ principalId: agent.id, scope, allowed }).credential;
  const credential = issue({ org: org.id, project: project.id }, ['plan_integration', 'read_context']);
  const post = (token) => fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ changeIds: [change.id], headCommit: baseCommit }) });
  assert.equal((await post('invalid')).status, 401);
  assert.equal((await post(issue({ org: 'O2' }, ['plan_integration']))).status, 403);
  assert.equal((await post(issue({ org: org.id, project: project.id, work: work.id }, ['plan_integration']))).status, 403);
  const response = await post(credential);
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal(report.candidate.proposals[0].headCommit, headCommit);
  assert.equal(report.candidate.state, 'proposed');
  const read = await fetch(`${endpoint}/${report.candidate.id}`, { headers: { Authorization: `Bearer ${credential}` } });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), report);
  for (const args of [['plan', '--changes', change.id], ['show', '--candidate', report.candidate.id]]) {
    const output = execFileSync(process.execPath, ['bin/source.js', '--store', 'json', 'integration', ...args, '--org', org.id, '--project', project.id, '--repo', repo.id], {
      encoding: 'utf8', env: { ...process.env, SOURCE_DATA: dir },
    });
    assert.deepEqual(JSON.parse(output), report);
  }
  assert.deepEqual(await (await post(credential)).json(), report);
  assert.equal(src.gitRepo(org.id, project.id, repo.id).revParse('main'), baseCommit);
  assert.ok(src.readAudit().some((event) => event.event === 'integration.plan'));
});
