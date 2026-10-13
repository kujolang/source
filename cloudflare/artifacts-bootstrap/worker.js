// Operator-only integration proof, not Source's tenant authorization boundary.
const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

async function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const actual = request.headers.get('Authorization') || '';
  if (actual.length > 1024) return false;
  const digest = (value) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(actual), digest(`Bearer ${secret}`)]);
  const left = new Uint8Array(a), right = new Uint8Array(b);
  return left.reduce((difference, byte, i) => difference | (byte ^ right[i]), 0) === 0;
}

async function boundedJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid body');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) { await reader.cancel(); throw new Error('oversize'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/healthz' && request.method === 'GET') return json({ ok: true });
    if (!await authorized(request, env.SOURCE_BOOTSTRAP_SECRET)) return json({ error: 'unauthorized' }, 401);
    if (path !== '/repos') return json({ error: 'not found' }, 404);
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return json({ error: 'JSON required' }, 415);
    let body;
    try { body = await boundedJson(request); }
    catch { return json({ error: 'invalid JSON or body exceeds 1024 bytes' }, 400); }
    if (!body || typeof body.name !== 'string' || !/^source-smoke-[a-z0-9-]{1,48}$/.test(body.name)) {
      return json({ error: 'name must start with source-smoke- and contain only lowercase letters, digits or hyphens' }, 400);
    }
    try {
      const created = await env.ARTIFACTS.create(body.name, { setDefaultBranch: 'main' });
      return json({ name: created.name, remote: created.remote, token: created.token }, 201);
    } catch {
      // Do not leak upstream errors/tokens or retry uncertain creation.
      return json({ error: 'Artifacts creation failed; inspect repository state before retrying' }, 502);
    }
  }
};
