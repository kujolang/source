import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { monitorClient } from './client-lifecycle.js';
import { Source } from '../../src/source.js';
import { startServer } from '../../src/api.js';

const trace = (...message) => { if (process.argv.includes('--trace')) console.log('[Source]', ...message); };

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.join(repoRoot, '.contest-demo');
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = mkdtempSync(path.join(parent, 'run-'));
const password = randomBytes(24).toString('base64url');
const src = new Source(path.join(root, 'data'));
src.initInstance({ name: 'Source local contest rehearsal' });
const org = src.createOrg({ name: 'Source rehearsal', slug: 'source-rehearsal' });
const project = src.createProject({ orgId: org.id, name: 'Concurrent changes', slug: 'concurrent-changes', description: 'Three scripted clients; real Git, API, evidence and conflict recovery. No live Cloudflare integration.' });
const human = src.createPrincipal({ type: 'human', name: 'Demo maintainer (scripted approvals)', password });
src.addOrgMember({ orgId: org.id, principalId: human.id, role: 'admin' });
const verifier = src.createPrincipal({ type: 'service', name: 'Actual Node and Git checks' });
const repo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'demo' });
const scope = {orgId: org.id, projectId: project.id};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true'}
}).trim();
const seed = path.join(root, 'seed'); mkdirSync(seed);
git(seed, 'init', '-b', 'main'); git(seed, 'config', 'user.name', 'Source demo'); git(seed, 'config', 'user.email', 'demo@example.invalid');
writeFileSync(path.join(seed, 'settings.json'), '{"theme":"light","pageSize":10}\n');
writeFileSync(path.join(seed, 'README.md'), '# Concurrent collaboration example\n');
writeFileSync(path.join(seed, 'verify.mjs'), `import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nconst s=JSON.parse(readFileSync('settings.json'));\nassert.ok(['light','dark'].includes(s.theme));\nassert.ok(Number.isInteger(s.pageSize)&&s.pageSize>0&&s.pageSize<=100);\nconsole.log('settings contract passed');\n`);
git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Seed contest fixture'); git(seed, 'push', repo.barePath, 'main');
const base = git(seed, 'rev-parse', 'HEAD');
trace('Seed Git repository ready: light theme, page size 10.');
const server = await startServer(src, {host: '127.0.0.1', port: 0});
const origin = `http://127.0.0.1:${server.address().port}`;
const api = `${origin}/api/v1/orgs/${org.id}/projects/${project.id}`;
const jobs = [
  {label: 'agent-theme', file: 'settings.json', content: '{"theme":"dark","pageSize":10}\n', intent: 'Enable dark theme'},
  {label: 'agent-docs', file: 'README.md', content: '# Concurrent collaboration example\n\nChanges require evidence and review.\n', intent: 'Document evidence and review'},
  {label: 'agent-pages', file: 'settings.json', content: '{"theme":"light","pageSize":20}\n', intent: 'Increase page size to twenty'},
];
const children = [];
const decisions = [];
let report;
try {
  const tasks = jobs.map((job) => {
    const principal = src.createPrincipal({type: 'agent', name: job.label});
    const work = src.createWork({...scope, intent: job.intent, requester: human.id, requirements: [job.intent], acceptanceConditions: ['settings contract and diff whitespace pass']});
    const capability = src.capabilities.issue({principalId: principal.id, scope: {org: org.id, project: project.id, work: work.id},
      allowed: ['read_context','claim_work','start_session','submit_change'], denied: ['accept_change','modify_policy','publish_release']});
    const directory = path.join(root, job.label); mkdirSync(directory);
    const child = fork(new URL('./client.js', import.meta.url), [], {stdio: ['ignore','pipe','pipe','ipc']});
    children.push(child);
    const { ready, done } = monitorClient(child, job.label);
    child.stdout.resume(); child.stderr.resume();
    child.send({...job, directory, api, barePath: repo.barePath, base, workId: work.id, principalId: principal.id, credential: capability.credential});
    return {ready,done,child,workId:work.id,directory,principalId:principal.id};
  });
  await Promise.all(tasks.map(t=>t.ready));
  trace('Three clients claimed Work and started sessions.');
  for(const task of tasks) task.child.send({type:'go'});
  const results = await Promise.all(tasks.map(async (task) => ({
    ...await task.done, workId: task.workId, directory: task.directory, principalId: task.principalId,
  })));
  assert.ok(Math.max(...results.map(r=>r.started)) < Math.min(...results.map(r=>r.ended)), 'three execution intervals must overlap');
  for (const r of results) trace(r.label, 'submitted', r.changeId, '| self-approval HTTP', r.unauthorizedApprovalStatus);
  trace('Concurrent execution confirmed.');
  const verify = async (changeId, directory, oldBase, head) => {
    const output = execFileSync(process.execPath, ['verify.mjs'], {cwd:directory,encoding:'utf8',timeout:10000});
    git(directory, 'diff', '--check', oldBase, head);
    for(const [type,claim,artifact] of [['test','tests pass',output],['eval','deterministic checks pass',JSON.stringify({command:'git diff --check',base:oldBase,head,exitCode:0})]]) {
      await src.addEvidenceAsync({...scope,changeId,subject:'executed demo verification',claim,type,producer:verifier.id,artifact,result:{status:'pass'}});
    }
    assert.equal((await src.evaluateChangeAsync({...scope,changeId})).evaluation.ok,true);
    trace(changeId, 'tests and diff check passed; policy evidence satisfied.');
  };
  const accept = async (changeId) => {
    const d=await src.makeDecisionAsync({...scope,changeId,decision:'accepted',decider:human.id,reasoning:'Scripted demo maintainer: executed verification passed; review is simulated.'});
    decisions.push(d.id);
    assert.equal((await src.updateCanonicalStateAsync({...scope,changeId,repoId:repo.id})).ok,true);
    trace(changeId, 'accepted by scripted maintainer; canonical Git advanced.');
  };
  const first=results[0];
  await verify(first.changeId,first.directory,base,first.head);
  await accept(first.changeId);
  const recovery=[];
  for(const result of results.slice(1)) {
    const tip=git(repo.barePath,'rev-parse','main');
    await verify(result.changeId,result.directory,base,result.head);
    const stale=await src.gitRepo(org.id,project.id,repo.id).fastForwardAsync(base,result.head,'main');
    assert.equal(stale.ok,false);
    trace(result.changeId, 'stale proposal blocked; canonical Git unchanged.');
    assert.equal(git(repo.barePath,'rev-parse','main'),tip,'stale change must not move canonical state');
    await src.makeDecisionAsync({...scope,changeId:result.changeId,decision:'revision_requested',decider:human.id,reasoning:'Canonical base advanced; retain original proposal and rebase.'});
    git(result.directory,'fetch','origin','main');
    let conflict=false;
    try {git(result.directory,'rebase','origin/main');}
    catch {
      conflict=true;
      trace(result.label, 'rebase stopped on a real settings.json conflict.');
      assert.equal(result.label,'agent-pages');
      assert.ok(existsSync(path.join(result.directory,'.git','rebase-merge')));
      assert.equal(git(result.directory,'diff','--name-only','--diff-filter=U'),'settings.json');
      writeFileSync(path.join(result.directory,'settings.json'),'{"theme":"dark","pageSize":20}\n');
      git(result.directory,'add','settings.json');
      git(result.directory,'rebase','--continue');
      trace('Conflict resolved: keep dark theme and page size 20.');
    }
    assert.equal(conflict,result.label==='agent-pages');
    const head=git(result.directory,'rev-parse','HEAD');
    git(result.directory,'push','origin',`HEAD:refs/heads/${result.label}-recovered`);
    const session=await src.startSessionAsync({...scope,workId:result.workId,principalId:result.principalId,baseCommit:tip,environment:{client:'scripted-recovery',originalChange:result.changeId}});
    const revised=await src.submitChangeAsync({...scope,workId:result.workId,sessionId:session.id,baseCommit:tip,headCommit:head});
    await verify(revised.id,result.directory,tip,head);
    await accept(revised.id);
    recovery.push({originalChange:result.changeId,revisedChange:revised.id,staleRejected:true,mergeConflict:conflict});
  }
  trace('Recovery complete; reading canonical files.');
  const final=JSON.parse(git(repo.barePath,'show','main:settings.json'));
  assert.deepEqual(final,{theme:'dark',pageSize:20});
  trace('Canonical settings:', JSON.stringify(final));
  assert.match(git(repo.barePath,'show','main:README.md'),/evidence and review/);
  const login=await fetch(`${origin}/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({principalId:human.id,password,orgId:org.id,projectId:project.id,management:'1'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0]; await login.arrayBuffer();
  const uiPaths=[`/o/${org.id}/p/${project.id}`,`/o/${org.id}/p/${project.id}/r/${repo.id}/tree/main`,`/o/${org.id}/p/${project.id}/w/${first.workId}`,`/o/${org.id}/p/${project.id}/c/${first.changeId}`,'/assets/source.css','/assets/sitekit/sitekit.css','/assets/sitekit/fonts/DepartureMono-Regular.woff2'];
  for(const url of uiPaths){const response=await fetch(`${origin}${url}`,{headers:{Cookie:cookie}});assert.equal(response.status,200,url);await response.arrayBuffer();}
  report={ok:true,runtime:process.version,sourceCommit:git(repoRoot,'rev-parse','HEAD'),sourceTreeDirty:Boolean(git(repoRoot,'status','--porcelain','--untracked-files=no')),profile:'local-scripted-clients',cloudflareVerified:false,llmAgents:false,approvals:'scripted maintainer',
    concurrentClients:3,overlapMs:Math.min(...results.map(r=>r.ended))-Math.max(...results.map(r=>r.started)),
    clients:results.map(({directory,...r})=>r),recovery,decisions,finalCommit:git(repo.barePath,'rev-parse','main'),finalSettings:final,uiRoutesVerified:uiPaths,
    auditEvents:src.readAudit().map(({event})=>event)};
  writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  writeFileSync(path.join(root,'operator.json'),JSON.stringify({principalId:human.id,orgId:org.id,projectId:project.id,password},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({ok:true,root,data:path.join(root,'data'),report:path.join(root,'report.json'),profile:report.profile,concurrentClients:3,overlapMs:report.overlapMs,conflictRecovered:true,finalCommit:report.finalCommit},null,2));
} finally {
  for(const child of children) if(!child.killed) child.kill();
  server.closeAllConnections?.(); await new Promise(resolve=>server.close(resolve));
}
