// Explicit, additive synchronization of local Git branches and tags to Source.
import { git, resolveRemote, authenticatedGit } from './remote.js';

export async function syncFromWorkingDir({ cwd = process.cwd(), remote = null, url = null, credential = null, dryRun = false } = {}) {
  // Dry runs must not add a remote or otherwise change repository configuration.
  if (dryRun && url) throw new Error('--dry-run requires an existing remote; add the remote first or omit --url');
  const target = await resolveRemote(cwd, remote, url);
  const refs = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags'], cwd)).split('\n').filter(Boolean);
  if (!refs.length) throw new Error('no local branches or tags to sync');
  const run = authenticatedGit(credential, target.url, cwd);
  // One atomic push prevents a rejected branch from leaving a partial sync.
  // Explicit refspecs ignore remote push/mirror config and never delete refs.
  await run(['push', '--atomic', ...(dryRun ? ['--dry-run'] : []), target.url, ...refs.map((ref) => `${ref}:${ref}`)]);
  return { ok: true, remote: target.name, refs, dryRun };
}
