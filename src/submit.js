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
// All Git operations are asynchronous (execFile) so this can run in the same
// process as a Source server during tests without blocking the event loop.

import { execFile } from 'node:child_process';

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve(stdout.trim());
    });
  });
}

// Parse a Source smart-HTTP remote URL into { baseUrl, orgId, projectId, repoRef }.
//   http://host:port/git/{org}/{project}/{repo}.git
function parseRemoteUrl(url) {
  const m = url.match(/^(https?:\/\/[^/]+)\/git\/([^/]+)\/([^/]+)\/([^/]+)\.git$/);
  if (!m) {
    throw new Error(`unrecognized remote URL: ${url} (expected .../git/{org}/{project}/{repo}.git)`);
  }
  return { baseUrl: m[1], orgId: m[2], projectId: m[3], repoRef: m[4] };
}

// Determine the base commit: the fork point between HEAD and the remote default
// branch. This is the exact source state the contribution is based on.
async function mergeBase(cwd) {
  for (const ref of ['origin/main', 'origin/master', 'origin/HEAD']) {
    try {
      return await git(['merge-base', 'HEAD', ref], cwd);
    } catch {
      // try the next candidate ref
    }
  }
  throw new Error('could not determine base commit (no origin/main, origin/master, or origin/HEAD)');
}

// Submit a contribution from a working clone. Returns the Source lifecycle
// objects created server-side: { work, session, change, evidence, evaluation,
// interpretation }.
export async function submitFromWorkingDir({ cwd = process.cwd(), intent = '', baseUrl = null } = {}) {
  // 1. Confirm we are inside a Git working tree.
  await git(['rev-parse', '--show-toplevel'], cwd);

  // 2. Resolve the origin remote and parse the Source org/project/repo.
  const remoteUrl = await git(['config', '--get', 'remote.origin.url'], cwd);
  const parsed = parseRemoteUrl(remoteUrl);
  const apiBase = baseUrl || parsed.baseUrl;

  // 3. Determine the exact base and head commits.
  const head = await git(['rev-parse', 'HEAD'], cwd);
  const base = await mergeBase(cwd);
  if (base === head) {
    throw new Error('no changes to submit (base == head)');
  }

  // 4. Push the head commit to a contribution ref so it is present in the bare
  //    repository (required for the later canonical-state update).
  await git(['push', 'origin', `HEAD:refs/heads/source-submit-${head.slice(0, 8)}`], cwd);

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
  const res = await fetch(`${apiBase}/api/v1/orgs/${parsed.orgId}/projects/${parsed.projectId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repoRef: parsed.repoRef,
      baseCommit: base,
      headCommit: head,
      intent: resolvedIntent,
      contributorName,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error || `submit failed (${res.status})`);
  }
  return body;
}
