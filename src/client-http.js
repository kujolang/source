// One bounded JSON exchange for the submission client. Connection setup, headers
// and body share the caller's AbortSignal; no hidden shorter connect deadline,
// redirect following, automatic replay, or unbounded response buffering.
import http from 'node:http';
import https from 'node:https';

export function submitHttpRequest(value, { method = 'POST', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('expected HTTP(S) submission URL without embedded credentials');
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method, headers: { ...headers, 'accept-encoding': 'identity' }, signal, agent: false, maxHeaderSize: 16384 }, (response) => {
      const status = response.statusCode;
      if (status >= 300 && status < 400) {
        response.destroy(); reject(new Error('submission redirects are not allowed')); return;
      }
      const chunks = []; let size = 0;
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('submission response was truncated')));
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.destroy(); request.destroy(); reject(new Error('submission response exceeds 1 MiB')); return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status, ok: status >= 200 && status < 300,
        headers: { get: (name) => {
          const value = response.headers[String(name).toLowerCase()];
          return value == null ? null : Array.isArray(value) ? value.join(', ') : value;
        } },
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}
