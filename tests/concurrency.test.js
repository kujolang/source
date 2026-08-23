import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedSemaphore, Semaphore } from '../src/concurrency.js';
import { RateLimiter } from '../src/ratelimit.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { GitRepo } from '../src/git.js';
import { startServer } from '../src/api.js';
import { gitHttpBackend } from '../src/git-http.js';
import { PostgresStore } from '../src/postgres-store.js';
import { freshSource } from './helpers.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

test('Semaphore bounds active work and rejects beyond the queue budget', async () => {
  const semaphore = new Semaphore({ capacity: 1, queue: 1 });
  const first = await semaphore.acquire();
  const second = semaphore.acquire();
  const rejected = await semaphore.acquire();
  assert.equal(rejected, null);
  first();
  const releaseSecond = await second;
  assert.equal(typeof releaseSecond, 'function');
  releaseSecond();
});

test('KeyedSemaphore isolates tenants and removes idle buckets', async () => {
  const slots = new KeyedSemaphore({ capacity: 1, queue: 0, maxKeys: 2 });
  const first = await slots.acquire('project-a');
  assert.ok(first);
  assert.equal(await slots.acquire('project-a'), null);
  const other = await slots.acquire('project-b');
  assert.ok(other);
  assert.equal(await slots.acquire('project-c'), null);
  first();
  other();
  assert.equal(slots.buckets.size, 0);
  const recycled = await slots.acquire('project-c');
  assert.ok(recycled);
  recycled();
});

test('RateLimiter evicts expired keys and caps memory growth', () => {
  const limiter = new RateLimiter({ maxKeys: 2 });
  assert.equal(limiter.allow('a', { limit: 1, windowMs: 60_000 }), true);
  assert.equal(limiter.allow('b', { limit: 1, windowMs: 60_000 }), true);
  assert.equal(limiter.allow('c', { limit: 1, windowMs: 60_000 }), false);
});

test('RateLimiter async path delegates to an async durable store', async () => {
  let syncCalls = 0;
  const limiter = new RateLimiter({
    store: {
      allowRateLimit() {
        syncCalls += 1;
        throw new Error('sync store path used');
      },
      async allowRateLimitAsync() {
        await new Promise((resolve) => setImmediate(resolve));
        return true;
      },
    },
  });
  assert.equal(await limiter.allowAsync('agent:async', { limit: 1, windowMs: 1000 }), true);
  assert.equal(syncCalls, 0);
});

test('Postgres async transactions keep all statements on one pooled client', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql).trim());
      return { rows: sql.includes('SELECT 1') ? [{ value: 1 }] : [] };
    },
    release() { calls.push('RELEASE'); },
  };
  const store = Object.create(PostgresStore.prototype);
  store.pool = { connect: async () => client };
  store._asyncTransaction = new (await import('node:async_hooks')).AsyncLocalStorage();
  const value = await store.transactionAsync(() => store._runAsync('SELECT 1'));
  assert.equal(value, '1');
  assert.deepEqual(calls, ['BEGIN', 'SELECT 1', 'COMMIT', 'RELEASE']);
});

test('async change submission does not fall back to synchronous reads for missing sessions', async () => {
  const { src, org, project, agent } = freshSource();
  const work = await src.createWorkAsync({ orgId: org.id, projectId: project.id, intent: 'async change', requester: agent.id });
  await src.claimWorkAsync({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  await src.startSessionAsync({ orgId: org.id, projectId: project.id, workId: work.id, principalId: agent.id });
  const readJson = src.store.readJson.bind(src.store);
  src.store.readJsonAsync = async (rel) => readJson(rel);
  src.store.nextIdAsync = async () => 'C1';
  src.store.readJson = () => { throw new Error('sync store path used'); };
  const change = await src.submitChangeAsync({
    orgId: org.id,
    projectId: project.id,
    workId: work.id,
    sessionId: 'S-missing',
    baseCommit: 'base',
    headCommit: 'head',
  });
  assert.equal(change.sessionId, 'S-missing');
});

test('Postgres canonical promotion lock uses the project row', async () => {
  const calls = [];
  const store = Object.create(PostgresStore.prototype);
  store._qualified = (name) => `"source"."${name}"`;
  store._runAsync = async (sql) => { calls.push(sql); return ''; };
  await store.lockProjectAsync('O1', 'P1');
  assert.match(calls[0], /WHERE org_id = 'O1' AND id = 'P1'/);
  assert.match(calls[0], /FOR UPDATE/);
});

test('Postgres synchronous canonical promotion exposes the same project lock primitive', () => {
  const calls = [];
  const store = Object.create(PostgresStore.prototype);
  store._qualified = (name) => `"source"."${name}"`;
  store._run = (sql) => { calls.push(sql); return ''; };
  store.lockProject('O1', 'P1');
  assert.match(calls[0], /WHERE org_id = 'O1' AND id = 'P1'/);
  assert.match(calls[0], /FOR UPDATE/);
});

test('Postgres async transactions roll back relational record fan-out on failure', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql).trim());
      if (String(sql).includes('FAIL')) throw new Error('forced failure');
      return { rows: [] };
    },
    release() { calls.push('RELEASE'); },
  };
  const store = Object.create(PostgresStore.prototype);
  store.pool = { connect: async () => client };
  store._asyncTransaction = new (await import('node:async_hooks')).AsyncLocalStorage();
  await assert.rejects(() => store.transactionAsync(async () => {
    await store._runAsync('INSERT INTO records VALUES (1)');
    await store._runAsync('FAIL');
  }), /forced failure/);
  assert.deepEqual(calls, ['BEGIN', 'INSERT INTO records VALUES (1)', 'FAIL', 'ROLLBACK', 'RELEASE']);
});

test('Postgres admission queue rejects excess work instead of buffering it unboundedly', async () => {
  let releaseQuery;
  const queryBlocked = new Promise((resolve) => { releaseQuery = resolve; });
  const store = Object.create(PostgresStore.prototype);
  store.dbAdmission = new Semaphore({ capacity: 1, queue: 0 });
  store.dbAdmissionRejected = 0;
  store._asyncTransaction = new (await import('node:async_hooks')).AsyncLocalStorage();
  store.pool = { query: async () => { await queryBlocked; return { rows: [] }; } };
  const first = store._runAsync('SELECT 1');
  for (let attempt = 0; attempt < 20 && store.dbAdmission.active !== 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(store.dbAdmission.active, 1);
  await assert.rejects(() => store._runAsync('SELECT 2'), /admission queue exhausted/);
  assert.equal(store.dbAdmissionRejected, 1);
  releaseQuery();
  await first;
});

test('Postgres worker claims bound expired-attempt cleanup', async () => {
  const store = Object.create(PostgresStore.prototype);
  let query = '';
  store._qualified = (name) => `"source"."${name}"`;
  store._runJsonCommandAsync = async (sql) => { query = sql; return []; };
  const jobs = await store.claimJobsAsync({ workerId: 'bounded-worker', limit: 10 });
  assert.deepEqual(jobs, []);
  assert.match(query, /FROM "source"\."jobs"[\s\S]*LIMIT 1000/);
  assert.match(query, /UPDATE "source"\."jobs" AS j/);
  assert.match(query, /FOR UPDATE SKIP LOCKED/);
  assert.match(query, /row_number\(\) OVER/);
  assert.match(query, /PARTITION BY org_id, project_id/);
  assert.match(query, /project_rank <= 8/);
});

test('Postgres workflow records use one bounded bulk read', async () => {
  const store = Object.create(PostgresStore.prototype);
  let query = '';
  store._qualified = (name) => `"source"."${name}"`;
  store._fetchJsonRowsAsync = async (sql) => { query = sql; return [{ path: 'workflows/W1.json', json: { id: 'W1' } }]; };
  const rows = await store.readJsonManyAsync(['workflows/W1.json', 'workflows/W1.json']);
  assert.deepEqual(rows, [{ path: 'workflows/W1.json', json: { id: 'W1' } }]);
  assert.match(query, /path IN \('workflows\/W1\.json'\)/);
  await assert.rejects(() => store.readJsonManyAsync(Array.from({ length: 1_002 }, (_, index) => `W${index}`)), /0-1001/);
});

test('decision reads use one bounded bulk read', async () => {
  const { src, org, project } = freshSource();
  let paths;
  src.store.readJsonManyAsync = async (requested) => {
    paths = requested;
    return requested.map((path) => ({ path, json: { id: path.split('/').at(-1).replace('.json', '') } }));
  };
  const rows = await src.getDecisionManyAsync(org.id, project.id, ['D1', 'D1', 'D2']);
  assert.deepEqual(rows.map((row) => row.id), ['D1', 'D2']);
  assert.equal(paths.length, 2);
  await assert.rejects(() => src.getDecisionManyAsync(org.id, project.id, Array.from({ length: 1_001 }, (_, index) => `D${index}`)), /bounded read/);
});

test('Postgres repository resolution uses a tenant-scoped indexed query', async () => {
  const store = Object.create(PostgresStore.prototype);
  let query = '';
  store._qualified = (name) => `"source"."${name}"`;
  store._fetchJsonRowsAsync = async (sql) => { query = sql; return [{ json: { id: 'R1', name: 'main' } }]; };
  assert.deepEqual(await store.findRepositoryAsync('O1', 'P1', 'main'), { id: 'R1', name: 'main' });
  assert.match(query, /kind = 'repository'/);
  assert.match(query, /org_id = 'O1'/);
  assert.match(query, /project_id = 'P1'/);
  assert.match(query, /json->>'name'/);
});

test('Postgres record directory listings have a prefix-search index', () => {
  const source = readFileSync(new URL('../src/postgres-store.js', import.meta.url), 'utf8');
  assert.match(source, /records_path_pattern/);
  assert.match(source, /path text_pattern_ops/);
});

test('Postgres list pagination fetches a bounded lookahead row at the maximum page size', async () => {
  const store = Object.create(PostgresStore.prototype);
  let query = '';
  store._qualified = (name) => `"source"."${name}"`;
  store._fetchJsonRowsAsync = async (sql) => { query = sql; return []; };
  await store.listJsonAsync('orgs', { limit: 1_001 });
  assert.match(query, /LIMIT 1001/);
  await store.listJobsAsync({ orgId: 'O1', projectId: 'P1', limit: 1_001 });
  assert.match(query, /LIMIT 1001/);
});

test('Postgres fair worker claims have a tenant/status/time index', () => {
  const source = readFileSync(new URL('../src/postgres-store.js', import.meta.url), 'utf8');
  assert.match(source, /jobs_fair/);
  assert.match(source, /org_id, project_id, status, available_at, leased_until, created_at, id/);
});

test('SQLite counter allocation returns unique monotonic IDs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'source-counter-'));
  const store = new SqliteStore(root);
  const ids = Array.from({ length: 100 }, () => store.nextId('work', 'W'));
  assert.equal(new Set(ids).size, 100);
  assert.equal(ids.at(-1), 'W100');
});

test('SQLite rate limits are durable and shared through the store', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'source-rate-limit-'));
  const store = new SqliteStore(root);
  assert.equal(store.allowRateLimit('agent:1', 2, 60_000, 1000), true);
  assert.equal(store.allowRateLimit('agent:1', 2, 60_000, 1001), true);
  assert.equal(store.allowRateLimit('agent:1', 2, 60_000, 1002), false);
  assert.equal(store.allowRateLimit('agent:1', 2, 60_000, 61_001), true);
});

test('async Git operations yield to the event loop under concurrent work', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'source-async-git-'));
  const bare = path.join(root, 'repo.git');
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
  const repo = new GitRepo(bare);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  await Promise.all(Array.from({ length: 24 }, () => repo.hasCommitAsync('deadbeef')));
  clearInterval(timer);
  assert.ok(ticks > 0, `event loop did not run while Git work was in flight: ${ticks}`);
});

test('SQLite counters and rate limits survive concurrent processes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'source-multiprocess-'));
  const storeModule = path.resolve('src/sqlite-store.js');
  const worker = `
    import { SqliteStore } from ${JSON.stringify(storeModule)};
    const store = new SqliteStore(process.argv[1]);
    const ids = Array.from({ length: 40 }, () => store.nextId('process', 'X'));
    const allowed = Array.from({ length: 40 }, () => store.allowRateLimit('shared', 1000, 60000));
    process.stdout.write(JSON.stringify({ ids, allowed }));
  `;
  const results = await Promise.all(Array.from({ length: 4 }, () => execFileAsync(process.execPath, ['--input-type=module', '-e', worker, root], { maxBuffer: 2 * 1024 * 1024 })));
  const ids = results.flatMap(({ stdout }) => JSON.parse(stdout).ids);
  assert.equal(ids.length, 160);
  assert.equal(new Set(ids).size, 160);
  assert.equal(Math.max(...ids.map((id) => Number(id.slice(1)))), 160);
});

test('smart-HTTP Git remains responsive under concurrent requests', async () => {
  const { src, org, project } = freshSource();
  project.visibility = 'public';
  src.store.writeJson(`orgs/${org.id}/projects/${project.id}/project.json`, project);
  const repo = src.createRepository({ orgId: org.id, projectId: project.id, name: 'public', visibility: 'public' });
  const server = await startServer(src, { port: 0, gitConcurrency: 4, gitQueue: 64 });
  const base = `http://127.0.0.1:${server.address().port}/git/${org.id}/${project.id}/${repo.id}.git/info/refs?service=git-upload-pack`;
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    const responses = await Promise.all(Array.from({ length: 48 }, () => fetch(base)));
    assert.ok(responses.every((response) => response.status === 200), [...new Set(responses.map((response) => response.status))].join(','));
    assert.ok(ticks > 0, 'HTTP Git requests starved the event loop');
  } finally {
    clearInterval(timer);
    server.closeAllConnections?.();
    server.close();
  }
});

test('HTTP discovery withstands a thousand concurrent agent connections', async () => {
  const { src } = freshSource();
  const server = await startServer(src, { port: 0, maxConnections: 2_000 });
  const url = `http://127.0.0.1:${server.address().port}/.well-known/source`;
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    const responses = await Promise.all(Array.from({ length: 1_000 }, () => fetch(url)));
    assert.ok(responses.every((response) => response.status === 200));
    assert.ok(ticks > 0, 'event loop did not progress during the thousand-agent burst');
  } finally {
    clearInterval(timer);
    server.closeAllConnections?.();
    server.close();
  }
});

test('HTTP request admission rejects excess in-flight work with retryable backpressure', async () => {
  const { src } = freshSource();
  src.store.checkHealthAsync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { ok: true };
  };
  const server = await startServer(src, { port: 0, requestConcurrency: 2, requestQueue: 0 });
  const url = `http://127.0.0.1:${server.address().port}/readyz`;
  try {
    const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(url)));
    assert.ok(responses.some((response) => response.status === 503));
    assert.ok(responses.some((response) => response.status === 200));
    assert.match(await (await fetch(`http://127.0.0.1:${server.address().port}/metrics`)).text(), /source_request_admission_rejected_total [1-9]/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('health and readiness endpoints expose process and storage state', async () => {
  const { src } = freshSource();
  const server = await startServer(src, { port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    const metricResponse = await fetch(`${base}/metrics`);
    assert.equal(metricResponse.status, 200);
    assert.match(await metricResponse.text(), /source_requests_total/);
    src.store.poolStats = () => ({ total: 8, idle: 3, waiting: 2, fallbackActive: 1, admissionActive: 4, admissionWaiting: 5, admissionRejected: 6 });
    const poolMetricResponse = await fetch(`${base}/metrics`);
    const poolMetrics = await poolMetricResponse.text();
    assert.match(poolMetrics, /source_postgres_pool_connections 8/);
    assert.match(poolMetrics, /source_postgres_pool_waiting 2/);
    assert.match(poolMetrics, /source_postgres_admission_active 4/);
    assert.match(poolMetrics, /source_postgres_admission_waiting 5/);
    assert.match(poolMetrics, /source_postgres_admission_rejected_total 6/);
    assert.match(poolMetrics, /source_git_admission_rejected_total 0/);
    assert.match(poolMetrics, /source_git_tenant_buckets 0/);
    assert.match(poolMetrics, /source_canonical_admission_active 0/);
    src.store.checkHealthAsync = async () => { throw new Error('database unavailable'); };
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    delete src.store.checkHealthAsync;
    server.beginDrain();
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/.well-known/source`)).status, 503);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('Git-backed scan requests honor the shared concurrency budget', async () => {
  const { src, org, project } = freshSource();
  const cap = src.capabilities.issue({
    principalId: 'U1',
    scope: { org: org.id, project: project.id, work: 'W1' },
    allowed: ['read_context'],
  });
  src.getChangeAsync = async () => ({ workId: 'W1' });
  let scanStarted;
  const scanStartedPromise = new Promise((resolve) => { scanStarted = resolve; });
  src.scanChangeSecretsAsync = async () => {
    scanStarted();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return [];
  };
  const server = await startServer(src, { port: 0, gitConcurrency: 1, gitQueue: 0 });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/orgs/${org.id}/projects/${project.id}/changes/C1/scan`;
  try {
    const first = fetch(url, { headers: { Authorization: `Bearer ${cap.credential}` } });
    await scanStartedPromise;
    const second = await fetch(url, { headers: { Authorization: `Bearer ${cap.credential}` } });
    assert.equal(second.status, 503);
    assert.equal((await first).status, 200);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('Git CGI output is bounded when a caller configures a response cap', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'source-git-output-cap-'));
  const repo = path.join(root, 'repo.git');
  execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
  await assert.rejects(
    gitHttpBackend({
      projectRoot: root,
      pathInfo: '/repo.git/info/refs',
      maxOutputBytes: 1,
    }),
    /output limit/,
  );
});
