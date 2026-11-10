// Shared client-side remote selection. GitHub can remain origin.
import { execFile } from 'node:child_process';
import { ClientRetry } from './client-retry.js';

export function git(args, cwd, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) {
        err.httpStatus = Number(stderr.match(/The requested URL returned error: (\d{3})/i)?.[1]) || null;
        err.curlCode = Number(stderr.match(/\bcurl ([0-9]{1,3})\b/i)?.[1]) || null;
        // Classify known local/transport failures without retaining remote text.
        err.failureKind = /cannot fork|unable to fork|resource temporarily unavailable|cannot create thread/i.test(stderr) ? 'resource_exhausted'
          : /timed out|timeout/i.test(stderr) ? 'timeout'
            : /RPC failed|connection reset|failed to connect|empty reply|early EOF/i.test(stderr) ? 'transport' : 'git_exit';
        reject(err);
      }
      else resolve(stdout.trim());
    });
  });
}

export function parseRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('expected a Source HTTP(S) URL ending /git/{org}/{project}/{repo}.git'); }
  const match = url.pathname.match(/^\/git\/([^/]+)\/([^/]+)\/([^/]+)\.git$/);
  if (!['http:', 'https:'].includes(url.protocol) || !match || url.search || url.hash || url.username || url.password) {
    throw new Error('expected a Source HTTP(S) URL without embedded credentials ending /git/{org}/{project}/{repo}.git');
  }
  return { baseUrl: url.origin, orgId: match[1], projectId: match[2], repoRef: match[3] };
}

export async function resolveRemote(cwd, remote, url = null) {
  await git(['rev-parse', '--show-toplevel'], cwd);
  const names = (await git(['remote'], cwd)).split('\n');
  let configured;
  try { configured = await git(['config', '--get', 'source.remote'], cwd); } catch { /* optional */ }
  const name = remote || configured || (names.includes('source') || url ? 'source' : 'origin');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('invalid Source remote name');
  if (url) parseRemoteUrl(url);
  if (!names.includes(name)) {
    if (!url) throw new Error(`remote ${name} does not exist; add it with source sync --url <Source Git URL>`);
    await git(['remote', 'add', name, url], cwd);
  }
  const remoteUrl = await git(['remote', 'get-url', name], cwd);
  const parsed = parseRemoteUrl(remoteUrl);
  if (url && remoteUrl !== url) throw new Error(`remote ${name} already has a different URL; refusing to replace it`);
  // Send to this exact URL, not a separately configured pushurl/mirror refspec.
  return { name, url: remoteUrl, ...parsed };
}

export function authenticatedGit(credential, url, cwd, { retry = new ClientRetry(), runGit = git } = {}) {
  const cred = credential || process.env.SOURCE_CREDENTIAL;
  const flags = ['-c', 'http.followRedirects=false'];
  if (cred) flags.push('-c', `http.${url}.extraHeader=Authorization: Basic ${Buffer.from(`source:${cred}`).toString('base64')}`);
  return async (args) => {
    while (true) {
      try { return await runGit([...flags, ...args], cwd, { timeoutMs: retry.timeoutMs() }); }
      catch (error) {
        if (error.httpStatus === 429 && ['ls-remote', 'fetch', 'push'].includes(args[0])) {
          await retry.wait(`Git ${args[0]}`);
          continue;
        }
        // Do not leak command argv, credentials, or remote-controlled stderr.
        const failure = new Error(`Source Git ${args[0]} failed; check credentials, connectivity, and fast-forward history (no force or deletion is performed)`);
        failure.diagnostic = {
          operation: ['clone', 'ls-remote', 'fetch', 'push'].includes(args[0]) ? args[0] : 'git',
          kind: ['resource_exhausted', 'timeout', 'transport', 'git_exit'].includes(error.failureKind) ? error.failureKind : 'process',
          exitCode: Number.isInteger(error.code) ? error.code : null,
          curlCode: Number.isInteger(error.curlCode) && error.curlCode > 0 && error.curlCode < 100 ? error.curlCode : null,
          code: ['EAGAIN', 'ENOENT', 'ENOMEM', 'ENOBUFS', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(error.code) ? error.code : null,
          signal: ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(error.signal) ? error.signal : null,
          killed: error.killed === true,
          httpStatus: Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : null,
        };
        throw failure;
      }
    }
  };
}
