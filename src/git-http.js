// Source — smart-HTTP Git transport.
//
// Serves Git repositories over HTTP using Git's own `git http-backend` CGI
// program. Source never reimplements the packfile/network protocol; it maps an
// HTTP request to a bare repository and delegates to Git. This is the seam that
// makes `git clone https://…` and `git push https://…` work for real
// contributors without requiring them to understand Source concepts.
//
// Responsibilities:
//   Git   — packfile/network protocol, ref advertisement, object transfer.
//   Source — URL → repository mapping, tenant isolation, (future) authN/authZ.

import { spawn } from 'node:child_process';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { sourceGitEnvironment } from './git.js';

const maxHeaderBytes = 32 * 1024;
function headerBoundary(raw) {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { end: crlf, body: crlf + 4 };
  if (lf >= 0) return { end: lf, body: lf + 2 };
  return null;
}

function parseCgiHeaders(raw) {
  const headers = new Map();
  let status = 200;
  for (const line of raw.toString('latin1').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error('Invalid Git CGI header');
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === 'status') {
      if (!/^[2-5][0-9]{2}(?: [^\r\n\0]*)?$/.test(value)) throw new Error('Invalid Git CGI status');
      status = Number(value.slice(0, 3));
    } else {
      validateHeaderName(name);
      validateHeaderValue(name, value);
      headers.set(name, value);
    }
  }
  return { status, headers: Object.fromEntries(headers) };
}

// Serve a single Git smart-HTTP request via `git http-backend`.
//
//   projectRoot — absolute path to the directory containing bare repos
//   pathInfo    — repo path + service, e.g. "/R1.git/info/refs"
//   queryString — raw query string (no leading "?"), e.g. "service=git-upload-pack"
//   method      — "GET" or "POST"
//   contentType — request Content-Type (for POST)
//   body        — request body Buffer (for POST)
//   input       — optional readable request stream; used for bounded streaming
//                 of packfiles without buffering the full upload in memory
//   remoteUser  — authenticated principal (empty for anonymous MVP)
//   remoteAddr  — client address (for reflog identification)
//   headers     — request headers (for Git-Protocol passthrough)
//
// Resolves to { status, headers, body, stderr, exitCode }. When `stream` is
// provided, CGI headers and body chunks are delivered incrementally through
// the callbacks, preserving backpressure and avoiding packfile-sized buffers.
export function gitHttpBackend({
  projectRoot,
  hooksPath = null,
  protectedRef = '',
  pathInfo,
  queryString = '',
  method = 'GET',
  contentType = '',
  body = null,
  remoteUser = '',
  remoteAddr = '',
  headers = {},
  stream = null,
  maxOutputBytes = 512 * 1024 * 1024,
  input = null,
  maxInputBytes = 100 * 1024 * 1024,
  contentLength = null,
  abortSignal = null,
  timeoutMs = 120_000,
  maxStderrBytes = 1024 * 1024,
  spawnProcess = spawn,
}) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('Git request was aborted'));
      return;
    }
    const env = {
      ...sourceGitEnvironment(),
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: queryString,
      REQUEST_METHOD: method,
      CONTENT_TYPE: contentType,
      CONTENT_LENGTH: String(contentLength ?? (body ? body.length : 0)),
      REMOTE_ADDR: remoteAddr,
    };
    if (remoteUser) env.REMOTE_USER = remoteUser;
    // Protocol v2 negotiation: the client sends `Git-Protocol: version=2`.
    // `git http-backend` copies HTTP_GIT_PROTOCOL into GIT_PROTOCOL.
    if (headers['git-protocol']) env.HTTP_GIT_PROTOCOL = headers['git-protocol'];

    const ownsProcessGroup = spawnProcess === spawn && process.platform !== 'win32';
    const child = spawnProcess('git', ['--no-replace-objects', ...(hooksPath ? ['-c', `core.hooksPath=${hooksPath}`] : []), '-c', 'receive.hideRefs=refs/source/', '-c', 'receive.hideRefs=refs/replace/', ...(protectedRef ? ['-c', `receive.hideRefs=${protectedRef}`] : []), 'http-backend'], {
      env, detached: ownsProcessGroup, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let onInputData;
    let headerBuffer = Buffer.alloc(0);
    let response = null;
    let settled = false;
    let inputBytes = 0;
    let timeout;

    const emitBody = (chunk) => {
      if (!chunk.length) return;
      if (!stream) {
        stdout.push(chunk);
        return;
      }
      if (stream.onBody?.(chunk) !== false) return;
      child.stdout.pause();
      stream.onDrain?.(() => { if (!settled) child.stdout.resume(); });
    };

    const fail = (error, terminate = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      if (terminate) {
        try {
          if (ownsProcessGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
      try { stream?.onError?.(error); }
      catch (callbackError) { error = new AggregateError([error, callbackError], error.message); }
      reject(error);
    };

    const onAbort = () => fail(new Error('Git request was aborted'));
    const cleanup = () => {
      abortSignal?.removeEventListener('abort', onAbort);
      if (input) {
        input.unpipe(child.stdin);
        if (onInputData) input.removeListener('data', onInputData);
        input.removeListener('error', fail);
      }
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => fail(new Error('Git request timed out')), Math.max(1, timeoutMs));
    timeout.unref?.();

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail(new Error('Git response exceeded configured output limit'));
        return;
      }
      try {
        if (response) {
          emitBody(chunk);
          return;
        }
        const combined = headerBuffer.length ? Buffer.concat([headerBuffer, chunk]) : chunk;
        const boundary = headerBoundary(combined.subarray(0, maxHeaderBytes + 4));
        if (!boundary) {
          if (combined.length >= maxHeaderBytes + 4) throw new Error('Git CGI headers exceeded configured output limit');
          headerBuffer = combined;
          return;
        }
        if (boundary.end > maxHeaderBytes) throw new Error('Git CGI headers exceeded configured output limit');
        response = parseCgiHeaders(combined.subarray(0, boundary.end));
        stream?.onHeaders?.(response);
        headerBuffer = Buffer.alloc(0);
        emitBody(combined.subarray(boundary.body));
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on('data', (c) => {
      if (settled) return;
      stderrBytes += c.length;
      if (stderrBytes > maxStderrBytes) return fail(new Error('Git stderr exceeded configured output limit'));
      stderr.push(c);
    });
    child.on('close', (code) => {
      if (settled) return;
      if (!response) {
        fail(new Error('Git CGI closed without complete response headers'), false);
        return;
      }
      try {
        const errorText = Buffer.concat(stderr).toString('utf8');
        stream?.onEnd?.({ exitCode: code, outputBytes, stderr: errorText });
        settled = true;
        clearTimeout(timeout);
        cleanup();
        resolve({
          ...response,
          body: stream ? null : Buffer.concat(stdout),
          ...(stream ? { streamed: true } : {}),
          stderr: errorText,
          exitCode: code,
          outputBytes,
        });
      } catch (error) {
        fail(error, false);
      }
    });
    if (input) {
      onInputData = (chunk) => {
        inputBytes += chunk.length;
        if (inputBytes > maxInputBytes) {
          input.unpipe(child.stdin);
          input.destroy();
          fail(new Error('Git request body exceeded configured input limit'));
        }
      };
      input.on('data', onInputData);
      input.on('error', fail);
      input.pipe(child.stdin);
    } else {
      if (body) child.stdin.write(body);
      child.stdin.end();
    }
  });
}
