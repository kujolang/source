import test from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/concurrency.js';
import { RateLimiter } from '../src/ratelimit.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { GitRepo } from '../src/git.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  assert.equal(limiter.allow('a', { limit: 1, windowMs: 1 }), true);
  assert.equal(limiter.allow('b', { limit: 1, windowMs: 1 }), true);
  assert.equal(limiter.allow('c', { limit: 1, windowMs: 60_000 }), false);
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
