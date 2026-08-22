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

// Parse a CGI response (headers, blank line, body) into {status, headers, body}.
// `git http-backend` writes a `Status:` header plus normal headers, then a blank
// line, then the (possibly binary) body.
function parseCgiResponse(raw) {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  let headerEnd;
  let bodyStart;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    headerEnd = crlf;
    bodyStart = crlf + 4;
  } else if (lf >= 0) {
    headerEnd = lf;
    bodyStart = lf + 2;
  } else {
    headerEnd = raw.length;
    bodyStart = raw.length;
  }
  const headerText = raw.slice(0, headerEnd).toString('utf8');
  const body = raw.slice(bodyStart);
  const headers = {};
  let status = 200;
  for (const line of headerText.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'status') {
      const m = v.match(/^(\d+)/);
      if (m) status = parseInt(m[1], 10);
    } else {
      headers[k] = v;
    }
  }
  return { status, headers, body };
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
}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
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

    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let headerBuffer = Buffer.alloc(0);
    let streamed = false;
    let settled = false;
    let inputBytes = 0;

    const emitBody = (chunk) => {
      if (!chunk.length || stream.onBody?.(chunk) !== false) return;
      child.stdout.pause();
      stream.onDrain?.(() => child.stdout.resume());
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      stream?.onError?.(error);
      child.kill('SIGTERM');
      reject(error);
    };

    const emitHeadersAndBody = (chunk) => {
      const crlf = chunk.indexOf('\r\n\r\n');
      const lf = chunk.indexOf('\n\n');
      let bodyStart;
      if (crlf >= 0 && (lf < 0 || crlf <= lf)) bodyStart = crlf + 4;
      else if (lf >= 0) bodyStart = lf + 2;
      else return false;
      const parsed = parseCgiResponse(chunk);
      stream.onHeaders?.(parsed);
      streamed = true;
      if (chunk.length > bodyStart) emitBody(chunk.subarray(bodyStart));
      return true;
    };

    child.stdout.on('data', (c) => {
      outputBytes += c.length;
      if (outputBytes > maxOutputBytes) {
        fail(new Error('Git response exceeded configured output limit'));
        return;
      }
      if (!stream) {
        stdout.push(c);
        return;
      }
      if (!streamed) {
        headerBuffer = Buffer.concat([headerBuffer, c]);
        if (!emitHeadersAndBody(headerBuffer)) return;
        headerBuffer = Buffer.alloc(0);
        return;
      }
      emitBody(c);
    });
    child.stderr.on('data', (c) => stderr.push(c));
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const errorText = Buffer.concat(stderr).toString('utf8');
      if (stream) {
        if (!streamed && headerBuffer.length) {
          const parsed = parseCgiResponse(headerBuffer);
          stream.onHeaders?.(parsed);
          if (parsed.body.length) emitBody(parsed.body);
        }
        stream.onEnd?.({ exitCode: code, outputBytes, stderr: errorText });
        resolve({ status: streamed ? 200 : 502, headers: {}, body: null, streamed: true, stderr: errorText, exitCode: code, outputBytes });
        return;
      }
      const parsed = parseCgiResponse(Buffer.concat(stdout));
      parsed.stderr = errorText;
      parsed.exitCode = code;
      parsed.outputBytes = outputBytes;
      resolve(parsed);
    });
    if (input) {
      input.on('data', (chunk) => {
        inputBytes += chunk.length;
        if (inputBytes > maxInputBytes) {
          input.unpipe(child.stdin);
          input.destroy();
          fail(new Error('Git request body exceeded configured input limit'));
        }
      });
      input.pipe(child.stdin);
    } else {
      if (body) child.stdin.write(body);
      child.stdin.end();
    }
  });
}
