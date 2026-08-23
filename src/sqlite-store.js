// Source — SQLite store (zero-dependency via node:sqlite).
//
// Same interface as the JSON store (store.js), but backed by a single SQLite
// database file. Provides ACID transactions across records — the JSON store's
// documented gap. Git bare repos remain on the filesystem (Git owns source);
// only Source's domain records, artifacts, and audit log move into SQLite.
//
// Requires Node >= 22.5 (node:sqlite). The JSON store remains the default for
// older runtimes; select this backend explicitly (see cli.js --store).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export class SqliteStore {
  constructor(root) {
    this.root = root;
    this._txDepth = 0;
    fs.mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'source.sqlite'));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS records (
        path TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        hash TEXT PRIMARY KEY,
        bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        line TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      );
    `);
  }

  // --- JSON records -------------------------------------------------------
  readJson(relPath) {
    const row = this.db.prepare('SELECT json FROM records WHERE path = ?').get(relPath);
    return row ? JSON.parse(row.json) : null;
  }

  writeJson(relPath, obj) {
    this.db
      .prepare('INSERT INTO records (path, json) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET json = excluded.json')
      .run(relPath, JSON.stringify(obj, null, 2));
  }

  // List the direct children (record ids, without ".json") of a logical
  // directory. Mirrors the JSON store's readdir of a directory.
  listJson(dirRel, { cursor, limit, includeDirs = false } = {}) {
    const prefix = dirRel.endsWith('/') ? dirRel : `${dirRel}/`;
    const rows = this.db.prepare('SELECT path FROM records WHERE path LIKE ?').all(`${prefix}%`);
    const names = rows
      .map((r) => {
        const rest = r.path.slice(prefix.length);
        if (rest.includes('/')) {
          if (!includeDirs) return null;
          return rest.split('/')[0];
        }
        return rest.endsWith('.json') ? rest.slice(0, -'.json'.length) : null;
      })
      .filter(Boolean);
    let out = [...new Set(names)].sort();
    if (cursor) {
      const start = out.indexOf(cursor);
      out = start >= 0 ? out.slice(start + 1) : out;
    }
    if (Number.isInteger(limit) && limit > 0) {
      out = out.slice(0, Math.min(limit, 1001));
    }
    return out;
  }

  // --- metadata counters --------------------------------------------------
  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // Atomic counter allocation for concurrent API writers.
  nextId(kind, prefix) {
    const key = `counter:${kind}`;
    const row = this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT)
      RETURNING value
    `).get(key);
    return `${prefix}${Number(row.value)}`;
  }

  allowRateLimit(key, limit, windowMs, now = Date.now(), cost = 1) {
    const safeCost = Math.min(1000, Math.max(1, Math.trunc(cost)));
    const row = this.db.prepare(`
      INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN ? >= rate_limits.reset_at THEN ? ELSE rate_limits.count + ? END,
        reset_at = CASE WHEN ? >= rate_limits.reset_at THEN ? ELSE rate_limits.reset_at END
      RETURNING count
    `).get(key, safeCost, now + windowMs, now, safeCost, safeCost, now, now + windowMs);
    return Number(row.count) <= limit;
  }

  // --- content-addressed artifacts ----------------------------------------
  putArtifact(bytes) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const rel = path.join('artifacts', hash.slice(0, 2), hash);
    this.db.prepare('INSERT OR IGNORE INTO artifacts (hash, bytes) VALUES (?, ?)').run(hash, bytes);
    return { hash, rel };
  }

  getArtifact(hash) {
    const row = this.db.prepare('SELECT bytes FROM artifacts WHERE hash = ?').get(hash);
    return row ? Buffer.from(row.bytes) : null;
  }

  // --- append-only audit log ----------------------------------------------
  audit(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    this.db.prepare('INSERT INTO audit (line) VALUES (?)').run(line);
  }

  readAudit() {
    return this.db
      .prepare('SELECT line FROM audit ORDER BY seq')
      .all()
      .map((r) => JSON.parse(r.line));
  }

  // --- transactions -------------------------------------------------------
  // Re-entrant: nested transaction() calls are no-ops (the outermost call owns
  // BEGIN/COMMIT). This lets composite operations compose transactional steps.
  transaction(fn) {
    if (this._txDepth > 0) {
      this._txDepth += 1;
      try {
        return fn();
      } finally {
        this._txDepth -= 1;
      }
    }
    this._txDepth = 1;
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this._txDepth = 0;
    }
  }
}
