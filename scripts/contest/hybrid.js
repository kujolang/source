import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { hybridFixture, runGit } from './lib/hybrid-fixture.js';

const f = await hybridFixture();
try {
  const head = f.commit('# Source hybrid contract rehearsal\n');
  const proposal = f.propose('', head);
  await assert.rejects(proposal.promote(), /not accepted/);
  assert.throws(() => f.src.makeDecision({ ...f.scope, changeId: proposal.change.id, decision: 'accepted', decider: f.agent.id }));
  assert.throws(() => runGit(['push', f.repo.barePath, `${head}:refs/heads/main`], f.writer));
  proposal.accept();
  let pushes = 0;
  f.transport.after = (args) => { if (args[0] === 'push') { pushes++; throw new Error('simulate lost acknowledgement after successful push'); } };
  assert.equal((await proposal.promote()).ok, false);
  assert.equal(f.src.getWork(f.scope.orgId, f.scope.projectId, proposal.work.id).status, 'accepted');
  const recovery = await proposal.promote(); assert.equal(recovery.ok, true); assert.equal(pushes, 1);
  const clone = path.join(f.root, 'independent-clone'); runGit(['clone', f.remotePath, clone], f.root);
  assert.equal(runGit(['rev-parse', 'HEAD'], clone), head);
  assert.equal(readFileSync(path.join(clone, 'README.md'), 'utf8'), '# Source hybrid contract rehearsal\n');
  console.log(JSON.stringify({ ok: true, mode: 'local-contract-only', liveCloudflare: false,
    commit: head, work: proposal.work.id, change: proposal.change.id,
    verified: ['Worker-create-and-short-lived-token-contract', 'staged-Git-proposal', 'unaccepted-promotion-denied', 'agent-approval-denied', 'direct-canonical-push-denied', 'evidence-and-maintainer-decision', 'uncertain-push-does-not-close-Work', 'retry-reconciles-without-repush', 'independent-clone-commit-and-content'],
    workStatus: f.src.getWork(f.scope.orgId, f.scope.projectId, proposal.work.id).status,
    limitation: 'Artifacts binding and remote URL are emulated; Source, Worker handlers, credentials protocol and Git operations execute locally.' }, null, 2));
} finally { f.cleanup(); }
