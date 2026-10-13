// Scripted autonomous API client. No LLM, cloud service or paid provider is used.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

process.once('message', async (job) => {
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: job.directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  }).trim();
  const api = async (route, body, method = 'POST') => {
    const response = await fetch(`${job.api}${route}`, { method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${job.credential}`, 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : {body: JSON.stringify(body || {})}) });
    if (!response.ok) throw new Error(`API ${route}: ${response.status}`);
    return response.json();
  };
  try {
    await api(`/work/${job.workId}/claim`);
    const session = await api(`/work/${job.workId}/sessions`, { baseCommit: job.base, environment: { client: 'scripted-contest-client', label: job.label } });
    const context = await api(`/work/${job.workId}/context`, null, 'GET');
    git('clone', job.barePath, '.');
    git('checkout', '-b', job.label, job.base);
    git('config', 'user.name', job.label);
    git('config', 'user.email', `${job.label}@example.invalid`);
    process.send({ type: 'ready', label: job.label, sessionId: session.id, contextIntent: context.intent });
    await new Promise((resolve) => process.once('message', resolve));
    const started = Date.now();
    writeFileSync(path.join(job.directory, job.file), job.content);
    git('add', job.file);
    git('commit', '-m', context.intent);
    const head = git('rev-parse', 'HEAD');
    git('push', 'origin', `HEAD:refs/heads/${job.label}`);
    const change = await api(`/work/${job.workId}/changes`, { sessionId: session.id, baseCommit: job.base, headCommit: head });
    const denied = await fetch(`${job.api}/changes/${change.id}/decision`, { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${job.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'accepted', decider: job.principalId }) });
    await denied.arrayBuffer();
    if (denied.status !== 403) throw new Error('agent approval was not denied');
    process.send({ type: 'done', label: job.label, sessionId: session.id, changeId: change.id, head,
      started, ended: Date.now(), unauthorizedApprovalStatus: denied.status });
    process.disconnect();
  } catch (error) { process.send({ type: 'error', message: error.message }); process.exitCode = 1; process.disconnect(); }
});
