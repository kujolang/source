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
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function writeAtomicSync(file, data) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    if (error.code !== 'EEXIST') fs.rmSync(temporary, { force: true });
    throw error;
  }
}

async function writeAtomic(file, data) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    await fsp.writeFile(temporary, data, { flag: 'wx' });
    await fsp.rename(temporary, file);
  } catch (error) {
    if (error.code !== 'EEXIST') await fsp.rm(temporary, { force: true });
    throw error;
  }
}

export class Store {
  constructor(root) {
    this.root = root;
    this._asyncWriteTail = Promise.resolve();
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
    writeAtomicSync(p, JSON.stringify(obj, null, 2) + '\n');
  }

  // Async methods keep the compatibility backend usable by the async API
  // without blocking the event loop. The JSON backend remains single-process
  // and non-transactional; serializing async writes only prevents in-process
  // temp-file and counter races.
  async readJsonAsync(relPath) {
    try {
      return JSON.parse(await fsp.readFile(this._p(relPath), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async writeJsonAsync(relPath, obj) {
    return this._enqueueAsyncWrite(async () => {
      const p = this._p(relPath);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await writeAtomic(p, JSON.stringify(obj, null, 2) + '\n');
    });
  }

  listJson(dirRel, { cursor, limit, includeDirs = false } = {}) {
    const dir = this._p(dirRel);
    try {
      const out = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.json')) out.push(e.name.slice(0, -'.json'.length));
        else if (includeDirs && e.isDirectory()) out.push(e.name);
      }
      const unique = [...new Set(out)].sort().filter((name) => !cursor || name > cursor);
      if (Number.isInteger(limit) && limit > 0) unique.splice(Math.min(limit, 1001));
      return unique;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async listJsonAsync(dirRel, { cursor, limit, includeDirs = false } = {}) {
    const dir = this._p(dirRel);
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const out = entries
        .filter((e) => (e.isFile() && e.name.endsWith('.json')) || (includeDirs && e.isDirectory()))
        .map((e) => e.isFile() ? e.name.slice(0, -'.json'.length) : e.name);
      const unique = [...new Set(out)].sort().filter((name) => !cursor || name > cursor);
      if (Number.isInteger(limit) && limit > 0) unique.splice(Math.min(limit, 1_001));
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

  async getMetaAsync(key) {
    const meta = await this.readJsonAsync('meta.json') ?? {};
    return meta[key];
  }

  async setMetaAsync(key, value) {
    return this._enqueueAsyncWrite(async () => {
      const meta = await this.readJsonAsync('meta.json') ?? {};
      meta[key] = value;
      const p = this._p('meta.json');
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await writeAtomic(p, JSON.stringify(meta, null, 2) + '\n');
    });
  }

  async nextIdAsync(kind, prefix) {
    return this._enqueueAsyncWrite(async () => {
      const meta = await this.readJsonAsync('meta.json') ?? {};
      const key = `counter:${kind}`;
      const next = (meta[key] ?? 0) + 1;
      meta[key] = next;
      const p = this._p('meta.json');
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await writeAtomic(p, JSON.stringify(meta, null, 2) + '\n');
      return `${prefix}${next}`;
    });
  }

  // --- content-addressed artifacts --------------------------------------
  putArtifact(bytes) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const rel = path.join('artifacts', hash.slice(0, 2), hash);
    const p = this._p(rel);
    this._ensureDir(path.dirname(p));
    if (!fs.existsSync(p)) writeAtomicSync(p, bytes);
    return { hash, rel };
  }

  async putArtifactAsync(bytes) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const rel = path.join('artifacts', hash.slice(0, 2), hash);
    await this._enqueueAsyncWrite(async () => {
      const p = this._p(rel);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      try { await fsp.access(p); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        await writeAtomic(p, bytes);
      }
    });
    return { hash, rel };
  }

  getArtifact(hash) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return null;
    const rel = path.join('artifacts', hash.slice(0, 2), hash);
    try {
      return fs.readFileSync(this._p(rel));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async getArtifactAsync(hash) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return null;
    const rel = path.join('artifacts', hash.slice(0, 2), hash);
    try {
      return await fsp.readFile(this._p(rel));
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

  async auditAsync(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    return this._enqueueAsyncWrite(async () => {
      await fsp.mkdir(this.root, { recursive: true });
      await fsp.appendFile(this._p('audit.jsonl'), line + '\n', 'utf8');
    });
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

  async readAuditAsync() {
    try {
      const raw = await fsp.readFile(this._p('audit.jsonl'), 'utf8');
      return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async _enqueueAsyncWrite(operation) {
    const next = this._asyncWriteTail.then(operation, operation);
    this._asyncWriteTail = next.catch(() => {});
    return next;
  }

  // --- transactions -----------------------------------------------------
  // The JSON store has no cross-record transactions; this is a no-op wrapper
  // that keeps the interface uniform with SqliteStore. Documented limitation:
  // multi-record writes are not atomic on this backend.
  transaction(fn) {
    return fn();
  }

  transactionAsync(fn) {
    return fn();
  }
}
