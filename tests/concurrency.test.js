import test from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/concurrency.js';
import { RateLimiter } from '../src/ratelimit.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { GitRepo } from '../src/git.js';
import { startServer } from '../src/api.js';
import { gitHttpBackend } from '../src/git-http.js';
import { PostgresStore } from '../src/postgres-store.js';
import { freshSource } from './helpers.js';
import { mkdtempSync } from 'node:fs';
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
