// Source — `source submit` contribution client.
//
// The low-friction path for a developer who knows Git but not Source:
//
//   git clone https://source.example.com/git/{org}/{project}/{repo}.git
//   # make changes
//   source submit
//
// This module runs inside the contributor's working clone. It inspects the
// local Git state, determines the exact base/head commits, pushes the head
// commit to a contribution ref (so it is present in the bare repository), and
// submits the contribution to the Source API. Source then creates the correct
// Work → Session → Change → Evidence lifecycle server-side.
//
// The push requires a `git_push` capability (Git transport is authenticated).
// The credential is passed via `credential` (or the SOURCE_CREDENTIAL env var)
// and sent as HTTP Basic auth. A contributor needs a credential but does not
// need to understand Source concepts.
//
// All Git operations are asynchronous (execFile) so this can run in the same
// process as a Source server during tests without blocking the event loop.

import { git, resolveRemote, authenticatedGit } from './remote.js';
import { ClientRetry, submitRequest } from './client-retry.js';

// Fetch the selected Source default branch, rather than relying on potentially
// stale tracking refs or the unrelated GitHub origin tip.
async function mergeBase(cwd, remote, run) {
  const refs = await run(['ls-remote', '--symref', remote.url, 'HEAD']);
  const branch = refs.match(/^ref: (refs\/heads\/[^\s]+)\s+HEAD$/m)?.[1];
  if (!branch) throw new Error('Source default branch is empty or missing; sync the repository first and check its default branch');
  await run(['fetch', '--no-tags', remote.url, branch]);
  try { return await git(['merge-base', 'HEAD', 'FETCH_HEAD'], cwd); }
  catch { throw new Error('HEAD and the Source default branch have no common history'); }
}

// Submit a contribution from a working clone. Returns the Source lifecycle
// objects created server-side: { work, session, change, evidence, evaluation,
// interpretation }.
export async function submitFromWorkingDir({ cwd = process.cwd(), intent = '', baseUrl = null, credential = null, remote = null, retry = new ClientRetry() } = {}) {
  const target = await resolveRemote(cwd, remote);
  const parsed = target;
  const apiBase = baseUrl || target.baseUrl;
  const submitCredential = credential || process.env.SOURCE_CREDENTIAL;
  // A Git credential must never be forwarded to an unrelated API override.
  if (submitCredential && new URL(apiBase).origin !== new URL(target.baseUrl).origin) {
    throw new Error('authenticated submit requires the API and Git remote to have the same origin');
  }
  const run = authenticatedGit(submitCredential, target.url, cwd, { retry });
  const head = await git(['rev-parse', 'HEAD'], cwd);
  const base = await mergeBase(cwd, target, run);
  if (base === head) throw new Error('no changes to submit (base == head)');
  await run(['push', target.url, `${head}:refs/heads/source-submit-${head.slice(0, 8)}`]);

  // 5. Contributor identity and intent (from Git, not Source concepts).
  let contributorName = 'contributor';
  try {
    contributorName = await git(['config', '--get', 'user.name'], cwd);
  } catch {
    // keep default
  }
  let resolvedIntent = intent;
  if (!resolvedIntent) {
    try {
      resolvedIntent = await git(['log', '-1', '--pretty=%s', 'HEAD'], cwd);
    } catch {
      resolvedIntent = 'contribution';
    }
  }

  // 6. Submit to the Source API (org-scoped).
  return submitRequest(`${apiBase}/api/v1/orgs/${parsed.orgId}/projects/${parsed.projectId}/submit`, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', ...(submitCredential ? { authorization: `Bearer ${submitCredential}` } : {}) },
    body: JSON.stringify({
      repoRef: parsed.repoRef,
      baseCommit: base,
      headCommit: head,
      intent: resolvedIntent,
      contributorName,
    }),
  }, { retry });
}
