// Source — JSON-file store with atomic writes.
//
// Domain records are plain JSON on disk. Writes are atomic (temp + rename).
// Artifacts are content-addressed by SHA-256. The audit log is append-only.
//
// Synchronous fs is used deliberately: the MVP is a single-process modular
// monolith whose Git operations are already synchronous (execFileSync), so a
// synchronous store keeps the whole service simple and race-free per record.
//
// This is the default backend. `sqlite-store.js` provides the same interface
// with ACID transactions; see `docs/source/20-sqlite-store.md`.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class Store {
  constructor(root) {
    this.root = root;
  }

  _p(...segments) {
    return path.join(this.root, ...segments);
  }

  _ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // --- JSON records -----------------------------------------------------
  readJson(relPath) {
    const p = this._p(relPath);
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  writeJson(relPath, obj) {
    const p = this._p(relPath);
    this._ensureDir(path.dirname(p));
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
  }

  listJson(dirRel, { cursor, limit, includeDirs = false } = {}) {
    const dir = this._p(dirRel);
    try {
      const out = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.json')) out.push(e.name.slice(0, -'.json'.length));
        else if (includeDirs && e.isDirectory()) out.push(e.name);
      }
      const unique = [...new Set(out)].sort();
      if (cursor) {
        const start = unique.indexOf(cursor);
        unique.splice(0, start >= 0 ? start + 1 : 0);
      }
      if (Number.isInteger(limit) && limit > 0) unique.splice(Math.min(limit, 1001));
      return unique;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  // --- metadata counters ------------------------------------------------
  getMeta(key) {
    const meta = this.readJson('meta.json') ?? {};
    return meta[key];
  }

  setMeta(key, value) {
    const meta = this.readJson('meta.json') ?? {};
    meta[key] = value;
    this.writeJson('meta.json', meta);
  }

  // --- content-addressed artifacts --------------------------------------
  putArtifact(bytes) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const rel = path.join('artifacts', hash.slice(0, 2), hash);
    const p = this._p(rel);
    this._ensureDir(path.dirname(p));
    if (!fs.existsSync(p)) fs.writeFileSync(p, bytes);
    return { hash, rel };
  }

  getArtifact(hash) {
    const rel = path.join('artifacts', hash.slice(0, 2), hash);
    try {
      return fs.readFileSync(this._p(rel));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  // --- append-only audit log --------------------------------------------
  audit(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    this._ensureDir(this.root);
    fs.appendFileSync(this._p('audit.jsonl'), line + '\n', 'utf8');
  }

  readAudit() {
    try {
      const raw = fs.readFileSync(this._p('audit.jsonl'), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  // --- transactions -----------------------------------------------------
  // The JSON store has no cross-record transactions; this is a no-op wrapper
  // that keeps the interface uniform with SqliteStore. Documented limitation:
  // multi-record writes are not atomic on this backend.
  transaction(fn) {
    return fn();
  }
}
