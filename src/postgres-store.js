// Source — Postgres store with a normalized relational schema.
//
// The external store contract stays the same (`readJson`, `writeJson`, ...).
// Path-keyed records are kept in a `records` compatibility table, while
// `Work`, `Change`, `Evidence`, `Decision`, and `Principal` are also stored in
// normalized tables with foreign keys and join-ready junctions.
//
// Synchronous execution is preserved for the legacy store contract. Hot
// request-path operations also expose an async pooled `pg` seam so durable
// storage and throttling do not block the Node event loop.

import { createHash, randomBytes } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

const execFileAsync = promisify(execFile);

function escapeSqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Buffer.isBuffer(value)) {
    return `E'\\x${value.toString('hex')}'::bytea`;
  }
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function escapeSqlIdent(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe sql identifier: ${value}`);
  }
  return `"${String(value).replace(/"/g, '""')}"`;
}

function nowIso() {
  return new Date().toISOString();
}

function toJson(value) {
  return escapeSqlLiteral(JSON.stringify(value));
}

class PostgresStore {
  constructor({
    dsn = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL,
    schema = 'source',
    psql = 'psql',
    projectPrefix = 'source',
    connectionOptions = {},
    pool = null,
  } = {}) {
    if (!dsn) {
      throw new Error('Postgres DSN is required (SOURCE_DATABASE_URL, DATABASE_URL, or { dsn })');
    }

    this.dsn = dsn;
    this.schema = schema;
    this.psqlPath = psql;
    this.projectPrefix = projectPrefix;
    this.connectionOptions = connectionOptions;
    const poolOptions = { ...connectionOptions };
    delete poolOptions.env;
    delete poolOptions.noPassword;
    delete poolOptions.maxConnections;
    this.pool = pool || new pg.Pool({
      connectionString: dsn,
      ...poolOptions,
      max: connectionOptions.maxConnections || poolOptions.max || 32,
    });
    this._asyncTransaction = new AsyncLocalStorage();
    this._txDepth = 0;
    this._rateLimitOps = 0;

    this._initSchema();
  }

  _qualified(name) {
    return `${escapeSqlIdent(this.schema)}.${escapeSqlIdent(name)}`;
  }

  _run(sql) {
    const args = this._psqlArgs(sql);

    const result = execFileSync(this.psqlPath, args, {
      encoding: 'utf8',
      env: { ...process.env, ...(this.connectionOptions.env || {}) },
    });

    return String(result || '').replace(/\r/g, '').trim();
  }

  _psqlArgs(sql) {
    const args = [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=terse',
      '-q',
      '-d',
      this.dsn,
      '-c',
      String(sql).trim(),
    ];

    if (this.connectionOptions && this.connectionOptions.noPassword) {
      args.unshift('--no-password');
    }

    return args;
  }

  async _runAsync(sql) {
    const context = this._asyncTransaction.getStore();
    if (context?.client) {
      const result = await context.client.query(String(sql).trim());
      return this._formatAsyncRows(result.rows);
    }
    try {
      const result = await this.pool.query(String(sql).trim());
      return this._formatAsyncRows(result.rows);
    } catch (error) {
      // Preserve the legacy psql fallback for installations that have not
      // configured a reachable native Postgres client yet.
      if (error?.code !== 'ECONNREFUSED' && error?.code !== 'ENOTFOUND') throw error;
      const { stdout } = await execFileAsync(this.psqlPath, this._psqlArgs(sql), {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...(this.connectionOptions.env || {}) },
      });
      return String(stdout || '').replace(/\r/g, '').trim();
    }
  }

  _formatAsyncRows(rows) {
    if (!rows?.length) return '';
    return rows.map((row) => Object.values(row).map((value) => {
      if (value === null || value === undefined) return '';
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }).join('\t')).join('\n').trim();
  }

  _fetchJsonRows(sql) {
    const out = this._run(`SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)::text AS rows FROM (${sql}) AS r`);
    if (!out) return [];
    return JSON.parse(out);
  }

  async _fetchJsonRowsAsync(sql) {
    const out = await this._runAsync(`SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)::text AS rows FROM (${sql}) AS r`);
    if (!out) return [];
    return JSON.parse(out);
  }

  async _runJsonCommandAsync(sql) {
    const out = await this._runAsync(sql);
    return out ? JSON.parse(out) : [];
  }

  _fetchJsonRow(sql) {
    const out = this._run(`SELECT row_to_json(r)::text AS row FROM (${sql}) AS r LIMIT 1`);
    if (!out) return null;
    return JSON.parse(out);
  }

  _queryScalar(sql) {
    const out = this._run(sql);
    return out || null;
  }

  _initSchema() {
    this._run(`CREATE SCHEMA IF NOT EXISTS ${escapeSqlIdent(this.schema)}`);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('orgs')} (
        id TEXT PRIMARY KEY,
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('projects')} (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES ${this._qualified('orgs')}(id) ON DELETE CASCADE,
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('principals')} (
        id TEXT PRIMARY KEY,
        principal_type TEXT NOT NULL,
        name TEXT NOT NULL,
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('repositories')} (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES ${this._qualified('projects')}(id) ON DELETE CASCADE,
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('works')} (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES ${this._qualified('projects')}(id) ON DELETE CASCADE,
        requester_id TEXT NOT NULL REFERENCES ${this._qualified('principals')}(id),
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('sessions')} (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES ${this._qualified('works')}(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES ${this._qualified('principals')}(id),
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('changes')} (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES ${this._qualified('projects')}(id) ON DELETE CASCADE,
        work_id TEXT NOT NULL REFERENCES ${this._qualified('works')}(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES ${this._qualified('sessions')}(id),
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('evidence')} (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        producer_id TEXT NOT NULL REFERENCES ${this._qualified('principals')}(id),
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('decisions')} (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES ${this._qualified('projects')}(id) ON DELETE CASCADE,
        change_id TEXT NOT NULL,
        decider_id TEXT NOT NULL REFERENCES ${this._qualified('principals')}(id),
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('capabilities')} (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES ${this._qualified('principals')}(id),
        scope JSONB NOT NULL,
        allowed JSONB NOT NULL,
        denied JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        credential TEXT NOT NULL UNIQUE,
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('change_evidence')} (
        change_id TEXT NOT NULL REFERENCES ${this._qualified('changes')}(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES ${this._qualified('evidence')}(id) ON DELETE CASCADE,
        PRIMARY KEY (change_id, evidence_id)
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('change_decisions')} (
        change_id TEXT NOT NULL REFERENCES ${this._qualified('changes')}(id) ON DELETE CASCADE,
        decision_id TEXT NOT NULL REFERENCES ${this._qualified('decisions')}(id) ON DELETE CASCADE,
        PRIMARY KEY (change_id, decision_id)
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('work_sessions')} (
        work_id TEXT NOT NULL REFERENCES ${this._qualified('works')}(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES ${this._qualified('sessions')}(id) ON DELETE CASCADE,
        PRIMARY KEY (work_id, session_id)
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('work_decisions')} (
        work_id TEXT NOT NULL REFERENCES ${this._qualified('works')}(id) ON DELETE CASCADE,
        decision_id TEXT NOT NULL REFERENCES ${this._qualified('decisions')}(id) ON DELETE CASCADE,
        PRIMARY KEY (work_id, decision_id)
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('records')} (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        org_id TEXT,
        project_id TEXT,
        entity_id TEXT,
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('meta')} (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('artifacts')} (
        hash TEXT PRIMARY KEY,
        bytes BYTEA NOT NULL
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('human_sessions')} (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES ${this._qualified('principals')}(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('audit')} (
        seq BIGSERIAL PRIMARY KEY,
        line JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('rate_limits')} (
        key TEXT PRIMARY KEY,
        count BIGINT NOT NULL,
        reset_at BIGINT NOT NULL
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('jobs')} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL,
        org_id TEXT,
        project_id TEXT,
        work_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        leased_until TIMESTAMPTZ,
        worker_id TEXT,
        result JSONB,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    for (const column of ['org_id TEXT', 'project_id TEXT', 'work_id TEXT']) {
      this._run(`ALTER TABLE ${this._qualified('jobs')} ADD COLUMN IF NOT EXISTS ${column}`);
    }

    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_records_path`)} ON ${this._qualified('records')} (path)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_evidence_project`)} ON ${this._qualified('evidence')} (org_id, project_id)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_changes_work`)} ON ${this._qualified('changes')} (org_id, project_id, work_id)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_decisions_change`)} ON ${this._qualified('decisions')} (org_id, project_id, change_id)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_claim`)} ON ${this._qualified('jobs')} (status, available_at, created_at)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_scope`)} ON ${this._qualified('jobs')} (org_id, project_id, work_id, created_at)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_leased`)} ON ${this._qualified('jobs')} (leased_until, created_at) WHERE status = 'leased'`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_rate_limits_reset`)} ON ${this._qualified('rate_limits')} (reset_at)`);
  }

  _queryPathRow(relPath) {
    return this._fetchJsonRow(`SELECT json FROM ${this._qualified('records')} WHERE path = ${escapeSqlLiteral(relPath)}`)?.json ?? null;
  }

  async _queryPathRowAsync(relPath) {
    return (await this._fetchJsonRowsAsync(`SELECT json FROM ${this._qualified('records')} WHERE path = ${escapeSqlLiteral(relPath)}`))[0]?.json ?? null;
  }

  _deletePath(relPath) {
    this._run(`DELETE FROM ${this._qualified('records')} WHERE path = ${escapeSqlLiteral(relPath)}`);
  }

  _classifyRelPath(relPath) {
    const match = (pattern) => relPath.match(pattern);

    if (relPath === 'instance.json') {
      return { kind: 'instance', relPath };
    }
    if (relPath === 'meta.json') {
      return { kind: 'meta', relPath };
    }

    let m = match(/^orgs\/([^/]+)\/org\.json$/);
    if (m) return { kind: 'org', orgId: m[1], relPath };

    m = match(/^orgs\/([^/]+)\/projects\/([^/]+)\/project\.json$/);
    if (m) return { kind: 'project', orgId: m[1], projectId: m[2], relPath };

    m = match(/^orgs\/([^/]+)\/projects\/([^/]+)\/policy\.json$/);
    if (m) return { kind: 'policy', orgId: m[1], projectId: m[2], relPath };

    m = match(/^orgs\/([^/]+)\/projects\/([^/]+)\/repos\/([^/]+)\.json$/);
    if (m) return { kind: 'repository', orgId: m[1], projectId: m[2], id: m[3], relPath };

    m = match(/^orgs\/([^/]+)\/projects\/([^/]+)\/work\/([^/]+)\.json$/);
    if (m) return { kind: 'work', orgId: m[1], projectId: m[2], id: m[3], relPath };

    m = match(/^orgs\/([^/]+)\/projects\/([^/]+)\/sessions\/([^/]+)\.json$/);
    if (m) return { kind: 'session', orgId: m[1], projectId: m[2], id: m[3], relPath };

    m = match(/^orgs\/([^/]+)\/projects\/([^/]+)\/changes\/([^/]+)\.json$/);
    if (m) return { kind: 'change', orgId: m[1], projectId: m[2], id: m[3], relPath };

    m = match(/^orgs\/([^/]+)\/projects\/([^/]+)\/evidence\/([^/]+)\.json$/);
    if (m) return { kind: 'evidence', orgId: m[1], projectId: m[2], id: m[3], relPath };

    m = match(/^orgs\/([^/]+)\/projects\/([^/]+)\/decisions\/([^/]+)\.json$/);
    if (m) return { kind: 'decision', orgId: m[1], projectId: m[2], id: m[3], relPath };

    m = match(/^principals\/([^/]+)\.json$/);
    if (m) return { kind: 'principal', id: m[1], relPath };

    m = match(/^capabilities\/([^/]+)\.json$/);
    if (m) return { kind: 'capability', id: m[1], relPath };

    return { kind: 'unknown', relPath };
  }

  _upsertRecord(relPath, kind, orgId, projectId, id, obj) {
    const entityId = id || null;
    this._run(`INSERT INTO ${this._qualified('records')} (path, kind, org_id, project_id, entity_id, json)
      VALUES (${escapeSqlLiteral(relPath)}, ${escapeSqlLiteral(kind)}, ${escapeSqlLiteral(orgId)}, ${escapeSqlLiteral(projectId)}, ${escapeSqlLiteral(entityId)}, ${toJson(obj)})
      ON CONFLICT (path)
      DO UPDATE SET kind = EXCLUDED.kind, org_id = EXCLUDED.org_id, project_id = EXCLUDED.project_id, entity_id = EXCLUDED.entity_id, json = EXCLUDED.json`);
  }

  _syncOrg(entityId, obj) {
    this._run(`INSERT INTO ${this._qualified('orgs')} (id, json)
      VALUES (${escapeSqlLiteral(entityId)}, ${toJson(obj)})
      ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json`);
  }

  _syncProject(entityId, obj, orgId) {
    this._run(`INSERT INTO ${this._qualified('projects')} (id, org_id, json)
      VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(orgId)}, ${toJson(obj)})
      ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, json = EXCLUDED.json`);
  }

  _syncWork(entityId, obj, projectId, orgId) {
    this._run(`INSERT INTO ${this._qualified('works')} (id, org_id, project_id, requester_id, json)
      VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(orgId)}, ${escapeSqlLiteral(projectId)}, ${escapeSqlLiteral(obj.requester)}, ${toJson(obj)})
      ON CONFLICT (id)
      DO UPDATE SET org_id = EXCLUDED.org_id, project_id = EXCLUDED.project_id, requester_id = EXCLUDED.requester_id, json = EXCLUDED.json`);

    this._run(`DELETE FROM ${this._qualified('work_sessions')} WHERE work_id = ${escapeSqlLiteral(entityId)}`);
    for (const sessionId of Array.isArray(obj.sessions) ? obj.sessions : []) {
      this._run(`INSERT INTO ${this._qualified('work_sessions')} (work_id, session_id)
        VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(sessionId)})
        ON CONFLICT DO NOTHING`);
    }

    this._run(`DELETE FROM ${this._qualified('work_decisions')} WHERE work_id = ${escapeSqlLiteral(entityId)}`);
    for (const decisionId of Array.isArray(obj.decisions) ? obj.decisions : []) {
      this._run(`INSERT INTO ${this._qualified('work_decisions')} (work_id, decision_id)
        VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(decisionId)})
        ON CONFLICT DO NOTHING`);
    }
  }

  _syncSession(entityId, obj, projectId, orgId) {
    this._run(`INSERT INTO ${this._qualified('sessions')} (id, work_id, principal_id, json)
      VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(obj.workId)}, ${escapeSqlLiteral(obj.principal)}, ${toJson(obj)})
      ON CONFLICT (id)
      DO UPDATE SET work_id = EXCLUDED.work_id, principal_id = EXCLUDED.principal_id, json = EXCLUDED.json`);

    this._run(`INSERT INTO ${this._qualified('principals')} (id, principal_type, name, json)
      VALUES (${escapeSqlLiteral(obj.principal)}, 'human', ${escapeSqlLiteral(obj.principal)}, ${toJson({ id: obj.principal, name: 'agent session principal' })})
      ON CONFLICT (id) DO NOTHING`);

    this._run(`INSERT INTO ${this._qualified('projects')} (id, org_id, json)
      VALUES (${escapeSqlLiteral(projectId)}, ${escapeSqlLiteral(orgId)}, '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`);
  }

  _syncChange(entityId, obj, projectId, orgId) {
    this._run(`INSERT INTO ${this._qualified('changes')} (id, org_id, project_id, work_id, session_id, json)
      VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(orgId)}, ${escapeSqlLiteral(projectId)}, ${escapeSqlLiteral(obj.workId)}, ${escapeSqlLiteral(obj.sessionId)}, ${toJson(obj)})
      ON CONFLICT (id)
      DO UPDATE SET work_id = EXCLUDED.work_id, session_id = EXCLUDED.session_id, json = EXCLUDED.json`);

    this._run(`DELETE FROM ${this._qualified('change_evidence')} WHERE change_id = ${escapeSqlLiteral(entityId)}`);
    for (const evidenceId of Array.isArray(obj.evidence) ? obj.evidence : []) {
      this._run(`INSERT INTO ${this._qualified('change_evidence')} (change_id, evidence_id)
        VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(evidenceId)})
        ON CONFLICT DO NOTHING`);
    }

    this._run(`DELETE FROM ${this._qualified('change_decisions')} WHERE change_id = ${escapeSqlLiteral(entityId)}`);
    for (const decisionId of Array.isArray(obj.decisions) ? obj.decisions : []) {
      this._run(`INSERT INTO ${this._qualified('change_decisions')} (change_id, decision_id)
        VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(decisionId)})
        ON CONFLICT DO NOTHING`);
    }

    this._run(`INSERT INTO ${this._qualified('work_sessions')} (work_id, session_id)
      SELECT ${escapeSqlLiteral(obj.workId)}, ${escapeSqlLiteral(obj.sessionId)}
      WHERE ${escapeSqlLiteral(obj.sessionId)} IS NOT NULL
      ON CONFLICT DO NOTHING`);
  }

  _syncEvidence(entityId, obj, projectId, orgId) {
    this._run(`INSERT INTO ${this._qualified('evidence')} (id, org_id, project_id, producer_id, json)
      VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(orgId)}, ${escapeSqlLiteral(projectId)}, ${escapeSqlLiteral(obj.producer)}, ${toJson(obj)})
      ON CONFLICT (id)
      DO UPDATE SET producer_id = EXCLUDED.producer_id, json = EXCLUDED.json`);

    this._run(`INSERT INTO ${this._qualified('principals')} (id, principal_type, name, json)
      VALUES (${escapeSqlLiteral(obj.producer)}, 'human', ${escapeSqlLiteral(obj.producer)}, ${toJson({ id: obj.producer })})
      ON CONFLICT (id) DO NOTHING`);
  }

  _syncDecision(entityId, obj, projectId, orgId) {
    this._run(`INSERT INTO ${this._qualified('decisions')} (id, org_id, project_id, change_id, decider_id, json)
      VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(orgId)}, ${escapeSqlLiteral(projectId)}, ${escapeSqlLiteral(obj.changeId)}, ${escapeSqlLiteral(obj.decider)}, ${toJson(obj)})
      ON CONFLICT (id)
      DO UPDATE SET change_id = EXCLUDED.change_id, decider_id = EXCLUDED.decider_id, json = EXCLUDED.json`);

    this._run(`INSERT INTO ${this._qualified('change_decisions')} (change_id, decision_id)
      VALUES (${escapeSqlLiteral(obj.changeId)}, ${escapeSqlLiteral(entityId)})
      ON CONFLICT DO NOTHING`);

    const workDecision = this._fetchJsonRows(`
      SELECT work_id
      FROM ${this._qualified('changes')}
      WHERE id = ${escapeSqlLiteral(obj.changeId)}
        AND org_id = ${escapeSqlLiteral(orgId)}
        AND project_id = ${escapeSqlLiteral(projectId)}
    `);

    const row = workDecision[0];
    if (row?.work_id) {
      this._run(`INSERT INTO ${this._qualified('work_decisions')} (work_id, decision_id)
        VALUES (${escapeSqlLiteral(row.work_id)}, ${escapeSqlLiteral(entityId)})
        ON CONFLICT DO NOTHING`);
    }
  }

  _syncPrincipal(entityId, obj) {
    this._run(`INSERT INTO ${this._qualified('principals')} (id, principal_type, name, json)
      VALUES (${escapeSqlLiteral(entityId)}, ${escapeSqlLiteral(obj.type)}, ${escapeSqlLiteral(obj.name)}, ${toJson(obj)})
      ON CONFLICT (id)
      DO UPDATE SET principal_type = EXCLUDED.principal_type, name = EXCLUDED.name, json = EXCLUDED.json`);
  }

  _syncCapability(entityId, obj) {
    this._run(`INSERT INTO ${this._qualified('capabilities')} (id, principal_id, scope, allowed, denied, expires_at, credential, json)
      VALUES (
        ${escapeSqlLiteral(entityId)},
        ${escapeSqlLiteral(obj.principalId)},
        ${toJson(obj.scope)},
        ${toJson(obj.allowed)},
        ${toJson(obj.denied)},
        ${escapeSqlLiteral(obj.expiresAt)},
        ${escapeSqlLiteral(obj.credential)},
        ${toJson(obj)}
      )
      ON CONFLICT (id)
      DO UPDATE SET principal_id = EXCLUDED.principal_id, scope = EXCLUDED.scope, allowed = EXCLUDED.allowed,
        denied = EXCLUDED.denied, expires_at = EXCLUDED.expires_at, credential = EXCLUDED.credential, json = EXCLUDED.json`);

    this._run(`INSERT INTO ${this._qualified('principals')} (id, principal_type, name, json)
      VALUES (${escapeSqlLiteral(obj.principalId)}, 'human', 'capability principal', ${toJson({ id: obj.principalId })})
      ON CONFLICT (id) DO NOTHING`);
  }

  _syncPolicy(relPath, obj, projectId, orgId) {
    // Compatibility-only path; JSON-backed policies are already synchronized
    // via the containing project row.
    return;
  }

  readJson(relPath) {
    return this._queryPathRow(relPath);
  }

  readJsonAsync(relPath) {
    return this._queryPathRowAsync(relPath);
  }

  writeJson(relPath, obj) {
    const classified = this._classifyRelPath(relPath);

    this._upsertRecord(relPath, classified.kind, classified.orgId || null, classified.projectId || null, classified.id || null, obj);

    if (classified.kind === 'org') {
      this._syncOrg(classified.orgId, obj);
      return;
    }

    if (classified.kind === 'instance' || classified.kind === 'meta') {
      return;
    }

    if (classified.kind === 'project') {
      this._syncProject(classified.projectId, obj, classified.orgId);
      return;
    }

    if (classified.kind === 'policy') return;

    if (classified.kind === 'work') {
      this._syncWork(classified.id, obj, classified.projectId, classified.orgId);
      return;
    }

    if (classified.kind === 'session') {
      this._syncSession(classified.id, obj, classified.projectId, classified.orgId);
      return;
    }

    if (classified.kind === 'change') {
      this._syncChange(classified.id, obj, classified.projectId, classified.orgId);
      return;
    }

    if (classified.kind === 'evidence') {
      this._syncEvidence(classified.id, obj, classified.projectId, classified.orgId);
      return;
    }

    if (classified.kind === 'decision') {
      this._syncDecision(classified.id, obj, classified.projectId, classified.orgId);
      return;
    }

    if (classified.kind === 'principal') {
      this._syncPrincipal(classified.id, obj);
      return;
    }

    if (classified.kind === 'capability') {
      this._syncCapability(classified.id, obj);
      return;
    }

    if (classified.kind === 'policy') {
      return;
    }

    if (classified.kind === 'repository') {
      return;
    }

    if (classified.kind === 'unknown') {
      return;
    }

    this._syncPolicy(classified.projectId, obj, classified.projectId, classified.orgId);
  }

  async writeJsonAsync(relPath, obj) {
    const classified = this._classifyRelPath(relPath);
    await this._runAsync(`INSERT INTO ${this._qualified('records')} (path, kind, org_id, project_id, entity_id, json)
      VALUES (${escapeSqlLiteral(relPath)}, ${escapeSqlLiteral(classified.kind)}, ${escapeSqlLiteral(classified.orgId || null)}, ${escapeSqlLiteral(classified.projectId || null)}, ${escapeSqlLiteral(classified.id || null)}, ${toJson(obj)})
      ON CONFLICT (path) DO UPDATE SET kind = EXCLUDED.kind, org_id = EXCLUDED.org_id, project_id = EXCLUDED.project_id, entity_id = EXCLUDED.entity_id, json = EXCLUDED.json`);
    if (classified.kind === 'org') {
      await this._runAsync(`INSERT INTO ${this._qualified('orgs')} (id, json)
        VALUES (${escapeSqlLiteral(classified.orgId)}, ${toJson(obj)})
        ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json`);
    } else if (classified.kind === 'project') {
      await this._runAsync(`INSERT INTO ${this._qualified('projects')} (id, org_id, json)
        VALUES (${escapeSqlLiteral(classified.projectId)}, ${escapeSqlLiteral(classified.orgId)}, ${toJson(obj)})
        ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, json = EXCLUDED.json`);
    } else if (classified.kind === 'principal') {
      await this._runAsync(`INSERT INTO ${this._qualified('principals')} (id, principal_type, name, json)
        VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(obj.type)}, ${escapeSqlLiteral(obj.name)}, ${toJson(obj)})
        ON CONFLICT (id) DO UPDATE SET principal_type = EXCLUDED.principal_type, name = EXCLUDED.name, json = EXCLUDED.json`);
    } else if (classified.kind === 'work') {
      await this._runAsync(`INSERT INTO ${this._qualified('works')} (id, org_id, project_id, requester_id, json)
        VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(classified.orgId)}, ${escapeSqlLiteral(classified.projectId)}, ${escapeSqlLiteral(obj.requester)}, ${toJson(obj)})
        ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, project_id = EXCLUDED.project_id, requester_id = EXCLUDED.requester_id, json = EXCLUDED.json`);
      await this._runAsync(`DELETE FROM ${this._qualified('work_sessions')} WHERE work_id = ${escapeSqlLiteral(classified.id)}`);
      for (const sessionId of Array.isArray(obj.sessions) ? obj.sessions : []) {
        await this._runAsync(`INSERT INTO ${this._qualified('work_sessions')} (work_id, session_id)
          VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(sessionId)}) ON CONFLICT DO NOTHING`);
      }
      await this._runAsync(`DELETE FROM ${this._qualified('work_decisions')} WHERE work_id = ${escapeSqlLiteral(classified.id)}`);
      for (const decisionId of Array.isArray(obj.decisions) ? obj.decisions : []) {
        await this._runAsync(`INSERT INTO ${this._qualified('work_decisions')} (work_id, decision_id)
          VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(decisionId)}) ON CONFLICT DO NOTHING`);
      }
    } else if (classified.kind === 'session') {
      await this._runAsync(`INSERT INTO ${this._qualified('sessions')} (id, work_id, principal_id, json)
        VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(obj.workId)}, ${escapeSqlLiteral(obj.principal)}, ${toJson(obj)})
        ON CONFLICT (id) DO UPDATE SET work_id = EXCLUDED.work_id, principal_id = EXCLUDED.principal_id, json = EXCLUDED.json`);
      await this._runAsync(`INSERT INTO ${this._qualified('principals')} (id, principal_type, name, json)
        VALUES (${escapeSqlLiteral(obj.principal)}, 'agent', 'session principal', ${toJson({ id: obj.principal })})
        ON CONFLICT (id) DO NOTHING`);
      await this._runAsync(`INSERT INTO ${this._qualified('work_sessions')} (work_id, session_id)
        VALUES (${escapeSqlLiteral(obj.workId)}, ${escapeSqlLiteral(classified.id)}) ON CONFLICT DO NOTHING`);
    } else if (classified.kind === 'change') {
      await this._runAsync(`INSERT INTO ${this._qualified('changes')} (id, org_id, project_id, work_id, session_id, json)
        VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(classified.orgId)}, ${escapeSqlLiteral(classified.projectId)}, ${escapeSqlLiteral(obj.workId)}, ${escapeSqlLiteral(obj.sessionId)}, ${toJson(obj)})
        ON CONFLICT (id) DO UPDATE SET work_id = EXCLUDED.work_id, session_id = EXCLUDED.session_id, json = EXCLUDED.json`);
      await this._runAsync(`DELETE FROM ${this._qualified('change_evidence')} WHERE change_id = ${escapeSqlLiteral(classified.id)}`);
      for (const evidenceId of Array.isArray(obj.evidence) ? obj.evidence : []) {
        await this._runAsync(`INSERT INTO ${this._qualified('change_evidence')} (change_id, evidence_id)
          VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(evidenceId)}) ON CONFLICT DO NOTHING`);
      }
      await this._runAsync(`DELETE FROM ${this._qualified('change_decisions')} WHERE change_id = ${escapeSqlLiteral(classified.id)}`);
      for (const decisionId of Array.isArray(obj.decisions) ? obj.decisions : []) {
        await this._runAsync(`INSERT INTO ${this._qualified('change_decisions')} (change_id, decision_id)
          VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(decisionId)}) ON CONFLICT DO NOTHING`);
      }
      await this._runAsync(`INSERT INTO ${this._qualified('work_sessions')} (work_id, session_id)
        SELECT ${escapeSqlLiteral(obj.workId)}, ${escapeSqlLiteral(obj.sessionId)}
        WHERE ${escapeSqlLiteral(obj.sessionId)} IS NOT NULL
        ON CONFLICT DO NOTHING`);
    } else if (classified.kind === 'evidence') {
      await this._runAsync(`INSERT INTO ${this._qualified('evidence')} (id, org_id, project_id, producer_id, json)
        VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(classified.orgId)}, ${escapeSqlLiteral(classified.projectId)}, ${escapeSqlLiteral(obj.producer)}, ${toJson(obj)})
        ON CONFLICT (id) DO UPDATE SET producer_id = EXCLUDED.producer_id, json = EXCLUDED.json`);
      await this._runAsync(`INSERT INTO ${this._qualified('principals')} (id, principal_type, name, json)
        VALUES (${escapeSqlLiteral(obj.producer)}, 'service', 'evidence producer', ${toJson({ id: obj.producer })})
        ON CONFLICT (id) DO NOTHING`);
    } else if (classified.kind === 'decision') {
      await this._runAsync(`INSERT INTO ${this._qualified('decisions')} (id, org_id, project_id, change_id, decider_id, json)
        VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(classified.orgId)}, ${escapeSqlLiteral(classified.projectId)}, ${escapeSqlLiteral(obj.changeId)}, ${escapeSqlLiteral(obj.decider)}, ${toJson(obj)})
        ON CONFLICT (id) DO UPDATE SET change_id = EXCLUDED.change_id, decider_id = EXCLUDED.decider_id, json = EXCLUDED.json`);
      await this._runAsync(`INSERT INTO ${this._qualified('change_decisions')} (change_id, decision_id)
        VALUES (${escapeSqlLiteral(obj.changeId)}, ${escapeSqlLiteral(classified.id)}) ON CONFLICT DO NOTHING`);
      const rows = await this._runAsync(`SELECT work_id FROM ${this._qualified('changes')}
        WHERE id = ${escapeSqlLiteral(obj.changeId)}
          AND org_id = ${escapeSqlLiteral(classified.orgId)}
          AND project_id = ${escapeSqlLiteral(classified.projectId)}`);
      if (rows.rows?.[0]?.work_id) {
        await this._runAsync(`INSERT INTO ${this._qualified('work_decisions')} (work_id, decision_id)
          VALUES (${escapeSqlLiteral(rows.rows[0].work_id)}, ${escapeSqlLiteral(classified.id)}) ON CONFLICT DO NOTHING`);
      }
    } else if (classified.kind === 'capability') {
      await this._runAsync(`INSERT INTO ${this._qualified('capabilities')} (id, principal_id, scope, allowed, denied, expires_at, credential, json)
        VALUES (${escapeSqlLiteral(classified.id)}, ${escapeSqlLiteral(obj.principalId)}, ${toJson(obj.scope)}, ${toJson(obj.allowed)}, ${toJson(obj.denied)}, ${escapeSqlLiteral(obj.expiresAt)}, ${escapeSqlLiteral(obj.credential)}, ${toJson(obj)})
        ON CONFLICT (id) DO UPDATE SET principal_id = EXCLUDED.principal_id, scope = EXCLUDED.scope, allowed = EXCLUDED.allowed,
          denied = EXCLUDED.denied, expires_at = EXCLUDED.expires_at, credential = EXCLUDED.credential, json = EXCLUDED.json`);
      await this._runAsync(`INSERT INTO ${this._qualified('principals')} (id, principal_type, name, json)
        VALUES (${escapeSqlLiteral(obj.principalId)}, 'human', 'capability principal', ${toJson({ id: obj.principalId })})
        ON CONFLICT (id) DO NOTHING`);
    }
  }

  listJson(dirRel, { cursor, limit, includeDirs = false } = {}) {
    const normalized = dirRel.endsWith('/') ? dirRel.slice(0, -1) : dirRel;
    const prefix = `${normalized}/`;
    const where = `WHERE path LIKE ${escapeSqlLiteral(`${prefix}%`)}`;
    const limitClause = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${Math.min(limit, 1000)}` : '';

    const rows = this._fetchJsonRows(`
      SELECT path
      FROM ${this._qualified('records')}
      ${where}
      ORDER BY path
      ${limitClause}
    `);

    const names = rows
      .map((r) => r.path)
      .map((p) => {
        if (typeof p !== 'string' || !p.startsWith(`${normalized}/`)) return null;
        const rest = p.slice(normalized.length + 1);
        if (!rest) return null;
        if (rest.includes('/')) {
          if (!includeDirs) return null;
          return rest.split('/')[0];
        }
        if (!rest.endsWith('.json')) return null;
        return rest.slice(0, -'.json'.length);
      })
      .filter(Boolean)
      .sort();
    let out = [...new Set(names)];
    if (cursor) {
      const start = out.indexOf(cursor);
      out = start >= 0 ? out.slice(start + 1) : out;
    }
    if (Number.isInteger(limit) && limit > 0) {
      out = out.slice(0, Math.min(limit, 1001));
    }
    return out;
  }

  async listJsonAsync(dirRel, { cursor, limit, includeDirs = false } = {}) {
    const normalized = dirRel.endsWith('/') ? dirRel.slice(0, -1) : dirRel;
    const prefix = `${normalized}/`;
    const limitClause = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${Math.min(limit, 1000)}` : '';
    const restExpr = `substring(path from ${prefix.length + 1})`;
    const nameExpr = includeDirs
      ? `CASE WHEN position('/' in ${restExpr}) > 0 THEN split_part(${restExpr}, '/', 1)
             WHEN ${restExpr} LIKE '%.json' THEN left(${restExpr}, length(${restExpr}) - 5)
             ELSE NULL END`
      : `CASE WHEN position('/' in ${restExpr}) = 0 AND ${restExpr} LIKE '%.json'
             THEN left(${restExpr}, length(${restExpr}) - 5) ELSE NULL END`;
    const cursorClause = cursor ? `AND (${nameExpr}) > ${escapeSqlLiteral(cursor)}` : '';
    const rows = await this._fetchJsonRowsAsync(`
      SELECT DISTINCT ${nameExpr} AS name
      FROM ${this._qualified('records')}
      WHERE path LIKE ${escapeSqlLiteral(`${prefix}%`)}
        ${cursorClause}
        AND (${nameExpr}) IS NOT NULL
      ORDER BY name
      ${limitClause}
    `);
    return rows.map((row) => row.name).filter(Boolean);
  }

  getCapabilityByCredential(credential) {
    const row = this._fetchJsonRows(`
      SELECT json
      FROM ${this._qualified('capabilities')}
      WHERE credential = ${escapeSqlLiteral(credential)}
      LIMIT 1
    `);
    return row[0]?.json || null;
  }

  async getCapabilityByCredentialAsync(credential) {
    const rows = await this._fetchJsonRowsAsync(`
      SELECT json
      FROM ${this._qualified('capabilities')}
      WHERE credential = ${escapeSqlLiteral(credential)}
      LIMIT 1
    `);
    return rows[0]?.json || null;
  }

  getMeta(key) {
    const rows = this._fetchJsonRows(`SELECT value FROM ${this._qualified('meta')} WHERE key = ${escapeSqlLiteral(key)}`);
    return rows[0] ? rows[0].value : undefined;
  }

  setMeta(key, value) {
    this._run(`INSERT INTO ${this._qualified('meta')} (key, value)
      VALUES (${escapeSqlLiteral(key)}, ${toJson(value)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  }

  // Atomic counter allocation for concurrent API writers.
  nextId(kind, prefix) {
    const key = `counter:${kind}`;
    const value = this._run(`
      INSERT INTO ${this._qualified('meta')} (key, value)
      VALUES (${escapeSqlLiteral(key)}, '1'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = to_jsonb(((${this._qualified('meta')}.value)::text)::bigint + 1)
      RETURNING value
    `);
    return `${prefix}${Number(JSON.parse(value))}`;
  }

  async nextIdAsync(kind, prefix) {
    const key = `counter:${kind}`;
    const value = await this._runAsync(`
      INSERT INTO ${this._qualified('meta')} (key, value)
      VALUES (${escapeSqlLiteral(key)}, '1'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = to_jsonb(((${this._qualified('meta')}.value)::text)::bigint + 1)
      RETURNING value
    `);
    return `${prefix}${Number(JSON.parse(value))}`;
  }

  allowRateLimit(key, limit, windowMs, now = Date.now()) {
    this._cleanupRateLimits(now);
    const out = this._run(`
      INSERT INTO ${this._qualified('rate_limits')} (key, count, reset_at)
      VALUES (${escapeSqlLiteral(key)}, 1, ${escapeSqlLiteral(now + windowMs)})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN ${escapeSqlLiteral(now)} >= ${this._qualified('rate_limits')}.reset_at THEN 1 ELSE ${this._qualified('rate_limits')}.count + 1 END,
        reset_at = CASE WHEN ${escapeSqlLiteral(now)} >= ${this._qualified('rate_limits')}.reset_at THEN ${escapeSqlLiteral(now + windowMs)} ELSE ${this._qualified('rate_limits')}.reset_at END
      RETURNING count
    `);
    return Number(out) <= limit;
  }

  // Async counterpart for request-path throttles. This uses the pooled client
  // when available while preserving the same atomic SQL update.
  async allowRateLimitAsync(key, limit, windowMs, now = Date.now()) {
    await this._cleanupRateLimitsAsync(now);
    const out = await this._runAsync(`
      INSERT INTO ${this._qualified('rate_limits')} (key, count, reset_at)
      VALUES (${escapeSqlLiteral(key)}, 1, ${escapeSqlLiteral(now + windowMs)})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN ${escapeSqlLiteral(now)} >= ${this._qualified('rate_limits')}.reset_at THEN 1 ELSE ${this._qualified('rate_limits')}.count + 1 END,
        reset_at = CASE WHEN ${escapeSqlLiteral(now)} >= ${this._qualified('rate_limits')}.reset_at THEN ${escapeSqlLiteral(now + windowMs)} ELSE ${this._qualified('rate_limits')}.reset_at END
      RETURNING count
    `);
    return Number(out) <= limit;
  }

  _cleanupRateLimits(now) {
    this._rateLimitOps += 1;
    if (this._rateLimitOps % 1_000 !== 0) return;
    this._run(`DELETE FROM ${this._qualified('rate_limits')} WHERE key IN (
      SELECT key FROM ${this._qualified('rate_limits')} WHERE reset_at < ${escapeSqlLiteral(now)} LIMIT 1_000
    )`);
  }

  async _cleanupRateLimitsAsync(now) {
    this._rateLimitOps += 1;
    if (this._rateLimitOps % 1_000 !== 0) return;
    await this._runAsync(`DELETE FROM ${this._qualified('rate_limits')} WHERE key IN (
      SELECT key FROM ${this._qualified('rate_limits')} WHERE reset_at < ${escapeSqlLiteral(now)} LIMIT 1_000
    )`);
  }

  async enqueueJobAsync({ kind, payload = {}, availableAt = new Date(), orgId = null, projectId = null, workId = null }) {
    if (!kind || typeof kind !== 'string') throw new Error('job kind is required');
    const id = await this.nextIdAsync('job', 'J');
    const at = new Date(availableAt).toISOString();
    await this._runAsync(`INSERT INTO ${this._qualified('jobs')} (id, kind, payload, org_id, project_id, work_id, status, available_at)
      VALUES (${escapeSqlLiteral(id)}, ${escapeSqlLiteral(kind)}, ${toJson(payload)}, ${escapeSqlLiteral(orgId)}, ${escapeSqlLiteral(projectId)}, ${escapeSqlLiteral(workId)}, 'queued', ${escapeSqlLiteral(at)})`);
    return { id, kind, payload, orgId, projectId, workId, status: 'queued', attempts: 0, availableAt: at };
  }

  async listJobsAsync({ orgId, projectId, workId = null, cursor = null, limit = 100 }) {
    const safeLimit = Math.min(1000, Math.max(1, Math.trunc(limit)));
    const cursorClause = cursor ? `AND id > ${escapeSqlLiteral(cursor)}` : '';
    const workClause = workId ? `AND work_id = ${escapeSqlLiteral(workId)}` : '';
    return this._fetchJsonRowsAsync(`
      SELECT id, kind, payload, org_id, project_id, work_id, status, attempts,
             available_at, leased_until, worker_id, result, last_error, created_at, updated_at
      FROM ${this._qualified('jobs')}
      WHERE org_id = ${escapeSqlLiteral(orgId)} AND project_id = ${escapeSqlLiteral(projectId)}
        ${workClause} ${cursorClause}
      ORDER BY id
      LIMIT ${safeLimit}
    `);
  }

  async claimJobsAsync({ workerId, limit = 10, leaseMs = 30_000 }) {
    if (!workerId || typeof workerId !== 'string') throw new Error('workerId is required');
    const safeLimit = Math.min(1000, Math.max(1, Math.trunc(limit)));
    const safeLease = Math.min(86_400_000, Math.max(1, Math.trunc(leaseMs)));
    return this._runJsonCommandAsync(`
      WITH candidates AS (
        SELECT id
        FROM ${this._qualified('jobs')}
        WHERE (status = 'queued' AND available_at <= NOW())
           OR (status = 'leased' AND leased_until < NOW())
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${safeLimit}
      )
      , updated AS (
        UPDATE ${this._qualified('jobs')} j
        SET status = 'leased', attempts = j.attempts + 1, worker_id = ${escapeSqlLiteral(workerId)},
            leased_until = NOW() + (${safeLease} * INTERVAL '1 millisecond'), updated_at = NOW()
        FROM candidates
        WHERE j.id = candidates.id
        RETURNING j.id, j.kind, j.payload, j.status, j.attempts,
                  j.available_at, j.leased_until, j.worker_id
      )
      SELECT COALESCE(json_agg(row_to_json(updated)), '[]'::json)::text AS rows FROM updated
    `);
  }

  async completeJobAsync({ id, workerId, result = null }) {
    const rows = await this._runJsonCommandAsync(`
      WITH updated AS (
        UPDATE ${this._qualified('jobs')}
        SET status = 'completed', result = ${toJson(result)}, leased_until = NULL,
            worker_id = NULL, updated_at = NOW()
        WHERE id = ${escapeSqlLiteral(id)} AND status = 'leased' AND worker_id = ${escapeSqlLiteral(workerId)}
        RETURNING id
      ) SELECT COALESCE(json_agg(row_to_json(updated)), '[]'::json)::text AS rows FROM updated
    `);
    return Boolean(rows[0]);
  }

  async failJobAsync({ id, workerId, error, retryDelayMs = 1_000, maxAttempts = 5 }) {
    const delay = Math.min(86_400_000, Math.max(0, Math.trunc(retryDelayMs)));
    const attempts = Math.min(100, Math.max(1, Math.trunc(maxAttempts)));
    const rows = await this._runJsonCommandAsync(`
      WITH updated AS (
        UPDATE ${this._qualified('jobs')}
        SET status = CASE WHEN attempts >= ${attempts} THEN 'failed' ELSE 'queued' END,
            available_at = CASE WHEN attempts >= ${attempts} THEN available_at ELSE NOW() + (${delay} * INTERVAL '1 millisecond') END,
            leased_until = NULL, worker_id = NULL, last_error = ${escapeSqlLiteral(String(error || 'job failed'))}, updated_at = NOW()
        WHERE id = ${escapeSqlLiteral(id)} AND status = 'leased' AND worker_id = ${escapeSqlLiteral(workerId)}
        RETURNING id, status, attempts
      ) SELECT COALESCE(json_agg(row_to_json(updated)), '[]'::json)::text AS rows FROM updated
    `);
    return rows[0] || null;
  }

  async extendJobAsync({ id, workerId, leaseMs = 30_000 }) {
    const safeLease = Math.min(86_400_000, Math.max(1, Math.trunc(leaseMs)));
    const rows = await this._runJsonCommandAsync(`
      WITH updated AS (
        UPDATE ${this._qualified('jobs')}
        SET leased_until = NOW() + (${safeLease} * INTERVAL '1 millisecond'), updated_at = NOW()
        WHERE id = ${escapeSqlLiteral(id)} AND status = 'leased' AND worker_id = ${escapeSqlLiteral(workerId)}
        RETURNING id, leased_until
      ) SELECT COALESCE(json_agg(row_to_json(updated)), '[]'::json)::text AS rows FROM updated
    `);
    return rows[0] || null;
  }

  putArtifact(bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
    const hash = createHash('sha256').update(buffer).digest('hex');
    this._run(`INSERT INTO ${this._qualified('artifacts')} (hash, bytes)
      VALUES (${escapeSqlLiteral(hash)}, ${escapeSqlLiteral(buffer)})
      ON CONFLICT (hash) DO UPDATE SET bytes = EXCLUDED.bytes`);
    const rel = `artifacts/${hash.slice(0, 2)}/${hash}`;
    return { hash, rel };
  }

  async putArtifactAsync(bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
    const hash = createHash('sha256').update(buffer).digest('hex');
    await this._runAsync(`INSERT INTO ${this._qualified('artifacts')} (hash, bytes)
      VALUES (${escapeSqlLiteral(hash)}, ${escapeSqlLiteral(buffer)})
      ON CONFLICT (hash) DO UPDATE SET bytes = EXCLUDED.bytes`);
    return { hash, rel: `artifacts/${hash.slice(0, 2)}/${hash}` };
  }

  getArtifact(hash) {
    const row = this._fetchJsonRows(`SELECT encode(bytes, 'base64') AS bytes FROM ${this._qualified('artifacts')} WHERE hash = ${escapeSqlLiteral(hash)}`);
    if (!row[0]?.bytes) return null;
    return Buffer.from(row[0].bytes, 'base64');
  }

  async getArtifactAsync(hash) {
    const rows = await this._runAsync(`SELECT encode(bytes, 'base64') AS bytes FROM ${this._qualified('artifacts')} WHERE hash = ${escapeSqlLiteral(hash)}`);
    if (!rows[0]?.bytes) return null;
    return Buffer.from(rows[0].bytes, 'base64');
  }

  audit(entry) {
    const line = { at: nowIso(), ...entry };
    this._run(`INSERT INTO ${this._qualified('audit')} (line) VALUES (${toJson(line)})`);
  }

  async auditAsync(entry) {
    const line = { at: nowIso(), ...entry };
    await this._runAsync(`INSERT INTO ${this._qualified('audit')} (line) VALUES (${toJson(line)})`);
  }

  readAudit() {
    return this._fetchJsonRows(`SELECT line FROM ${this._qualified('audit')} ORDER BY seq ASC`).map((r) => r.line);
  }

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
    this._run('BEGIN');
    try {
      const result = fn();
      this._run('COMMIT');
      return result;
    } catch (err) {
      this._run('ROLLBACK');
      throw err;
    } finally {
      this._txDepth = 0;
    }
  }

  async transactionAsync(fn) {
    const existing = this._asyncTransaction.getStore();
    if (existing?.client) return fn();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this._asyncTransaction.run({ client }, fn);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async closeAsync() {
    await this.pool.end();
  }

  createHumanSessionRow(principalId, credential, ttlMs = 24 * 60 * 60 * 1000) {
    const id = randomBytes(24).toString('hex');
    const now = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const session = {
      id,
      principalId,
      credential,
      createdAt: now,
      expiresAt,
    };

    this._run(`INSERT INTO ${this._qualified('human_sessions')} (id, principal_id, expires_at, json)
      VALUES (${escapeSqlLiteral(id)}, ${escapeSqlLiteral(principalId)}, ${escapeSqlLiteral(expiresAt)}, ${toJson(session)})
      ON CONFLICT (id)
      DO UPDATE SET principal_id = EXCLUDED.principal_id, expires_at = EXCLUDED.expires_at, json = EXCLUDED.json`);

    return session;
  }

  async createHumanSessionRowAsync(principalId, credential, ttlMs = 24 * 60 * 60 * 1000) {
    const id = randomBytes(24).toString('hex');
    const now = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const session = { id, principalId, credential, createdAt: now, expiresAt };
    await this._runAsync(`INSERT INTO ${this._qualified('human_sessions')} (id, principal_id, expires_at, json)
      VALUES (${escapeSqlLiteral(id)}, ${escapeSqlLiteral(principalId)}, ${escapeSqlLiteral(expiresAt)}, ${toJson(session)})
      ON CONFLICT (id) DO UPDATE SET principal_id = EXCLUDED.principal_id, expires_at = EXCLUDED.expires_at, json = EXCLUDED.json`);
    return session;
  }

  readHumanSession(sessionId) {
    const row = this._fetchJsonRows(`SELECT json FROM ${this._qualified('human_sessions')} WHERE id = ${escapeSqlLiteral(sessionId)} LIMIT 1`);
    return row[0]?.json || null;
  }

  async readHumanSessionAsync(sessionId) {
    const rows = await this._runAsync(`SELECT json FROM ${this._qualified('human_sessions')} WHERE id = ${escapeSqlLiteral(sessionId)} LIMIT 1`);
    return rows[0]?.json || null;
  }

  deleteHumanSession(sessionId) {
    this._run(`DELETE FROM ${this._qualified('human_sessions')} WHERE id = ${escapeSqlLiteral(sessionId)}`);
  }

  async deleteHumanSessionAsync(sessionId) {
    await this._runAsync(`DELETE FROM ${this._qualified('human_sessions')} WHERE id = ${escapeSqlLiteral(sessionId)}`);
  }

  // Relationship queries (for reporting and authorization auditing).
  queryWorkGraph(orgId, projectId, workId) {
    const workRows = this._fetchJsonRows(`
      SELECT w.id, w.json AS work, p.id AS requester_id, p.principal_type AS requester_type, p.name AS requester_name
      FROM ${this._qualified('works')} w
      JOIN ${this._qualified('principals')} p ON p.id = w.requester_id
      WHERE w.org_id = ${escapeSqlLiteral(orgId)}
        AND w.project_id = ${escapeSqlLiteral(projectId)}
        AND w.id = ${escapeSqlLiteral(workId)}
    `);

    if (!workRows[0]) return null;

    const work = workRows[0].work;
    const changes = this._fetchJsonRows(`
      SELECT c.id, c.json AS change, c.session_id AS session_id, sp.id AS session_principal_id, sp.name AS session_principal_name
      FROM ${this._qualified('changes')} c
      LEFT JOIN ${this._qualified('sessions')} s ON s.id = c.session_id
      LEFT JOIN ${this._qualified('principals')} sp ON sp.id = s.principal_id
      WHERE c.org_id = ${escapeSqlLiteral(orgId)}
        AND c.project_id = ${escapeSqlLiteral(projectId)}
        AND c.work_id = ${escapeSqlLiteral(workId)}
      ORDER BY c.created_at
    `);

    const mappedChanges = changes.map((row) => {
      const evidence = this._fetchJsonRows(`
        SELECT e.id, e.json AS evidence, p.id AS producer_id, p.principal_type AS producer_type, p.name AS producer_name
        FROM ${this._qualified('change_evidence')} ce
        JOIN ${this._qualified('evidence')} e ON e.id = ce.evidence_id
        JOIN ${this._qualified('principals')} p ON p.id = e.producer_id
        WHERE ce.change_id = ${escapeSqlLiteral(row.id)}
        ORDER BY e.id
      `);

      const decisions = this._fetchJsonRows(`
        SELECT d.id, d.json AS decision, p.id AS decider_id, p.principal_type AS decider_type, p.name AS decider_name
        FROM ${this._qualified('change_decisions')} cd
        JOIN ${this._qualified('decisions')} d ON d.id = cd.decision_id
        JOIN ${this._qualified('principals')} p ON p.id = d.decider_id
        WHERE cd.change_id = ${escapeSqlLiteral(row.id)}
        ORDER BY d.id
      `);

      return {
        id: row.id,
        change: row.change,
        session: row.session_id
          ? {
              id: row.session_id,
              principal: { id: row.session_principal_id, name: row.session_principal_name },
            }
          : null,
        evidence,
        decisions,
      };
    });

    return {
      work,
      workId,
      requester: {
        id: workRows[0].requester_id,
        type: workRows[0].requester_type,
        name: workRows[0].requester_name,
      },
      changes: mappedChanges,
    };
  }

  queryChangesForPrincipal(orgId, projectId, principalId) {
    const decisions = this._fetchJsonRows(`
      SELECT d.id, d.change_id, d.json AS decision
      FROM ${this._qualified('decisions')} d
      WHERE d.org_id = ${escapeSqlLiteral(orgId)}
        AND d.project_id = ${escapeSqlLiteral(projectId)}
        AND d.decider_id = ${escapeSqlLiteral(principalId)}
      ORDER BY d.created_at
    `);

    const evidence = this._fetchJsonRows(`
      SELECT e.id, e.work_id, e.change_id, e.json AS evidence
      FROM (
        SELECT e.id, e.json AS e_json, ce.change_id, c.work_id
        FROM ${this._qualified('evidence')} e
        JOIN ${this._qualified('change_evidence')} ce ON ce.evidence_id = e.id
        JOIN ${this._qualified('changes')} c ON c.id = ce.change_id
        WHERE e.org_id = ${escapeSqlLiteral(orgId)}
          AND e.project_id = ${escapeSqlLiteral(projectId)}
          AND e.producer_id = ${escapeSqlLiteral(principalId)}
      ) AS e
      ORDER BY e.id
    `);

    return {
      principalId,
      evidence,
      decisions,
    };
  }

  migrateFromStore(legacyStore) {
    const counters = [
      'counter:org',
      'counter:work',
      'counter:session',
      'counter:change',
      'counter:evidence',
      'counter:decision',
      'counter:project',
      'counter:repository',
      'counter:principal',
      'counter:capability',
    ];

    for (const key of counters) {
      const value = legacyStore.getMeta(key);
      if (value !== undefined) {
        this.setMeta(key, value);
      }
    }

    const copy = (relPath) => {
      const data = legacyStore.readJson(relPath);
      if (data) {
        this.writeJson(relPath, data);
      }
    };

    copy('instance.json');
    copy('meta.json');

    for (const orgId of legacyStore.listJson('orgs')) {
      copy(`orgs/${orgId}/org.json`);
      const orgProjectPath = `orgs/${orgId}/projects`;
      for (const projectId of legacyStore.listJson(orgProjectPath)) {
        copy(`orgs/${orgId}/projects/${projectId}/project.json`);
        copy(`orgs/${orgId}/projects/${projectId}/policy.json`);

        for (const repoId of legacyStore.listJson(`orgs/${orgId}/projects/${projectId}/repos`)) {
          copy(`orgs/${orgId}/projects/${projectId}/repos/${repoId}.json`);
        }

        for (const workId of legacyStore.listJson(`orgs/${orgId}/projects/${projectId}/work`)) {
          copy(`orgs/${orgId}/projects/${projectId}/work/${workId}.json`);
        }

        for (const sessionId of legacyStore.listJson(`orgs/${orgId}/projects/${projectId}/sessions`)) {
          copy(`orgs/${orgId}/projects/${projectId}/sessions/${sessionId}.json`);
        }

        for (const changeId of legacyStore.listJson(`orgs/${orgId}/projects/${projectId}/changes`)) {
          copy(`orgs/${orgId}/projects/${projectId}/changes/${changeId}.json`);
        }

        for (const evidenceId of legacyStore.listJson(`orgs/${orgId}/projects/${projectId}/evidence`)) {
          const path = `orgs/${orgId}/projects/${projectId}/evidence/${evidenceId}.json`;
          const evidence = legacyStore.readJson(path);
          if (evidence) {
            copy(path);
            const hash = evidence.artifactRef?.hash;
            if (hash) {
              const bytes = legacyStore.getArtifact(hash);
              if (bytes) this.putArtifact(bytes);
            }
          }
        }

        for (const decisionId of legacyStore.listJson(`orgs/${orgId}/projects/${projectId}/decisions`)) {
          copy(`orgs/${orgId}/projects/${projectId}/decisions/${decisionId}.json`);
        }
      }
    }

    for (const principalId of legacyStore.listJson('principals')) {
      copy(`principals/${principalId}.json`);
    }

    for (const capId of legacyStore.listJson('capabilities')) {
      copy(`capabilities/${capId}.json`);
    }

    // Preserve legacy rows as an audit trail.
    legacyStore.readAudit().forEach((entry) => this.audit(entry));

    return {
      orgs: this._fetchJsonRows(`SELECT COUNT(*)::int AS count FROM ${this._qualified('orgs')}`)[0]?.count || 0,
      projects: this._fetchJsonRows(`SELECT COUNT(*)::int AS count FROM ${this._qualified('projects')}`)[0]?.count || 0,
      works: this._fetchJsonRows(`SELECT COUNT(*)::int AS count FROM ${this._qualified('works')}`)[0]?.count || 0,
      artifacts: this._fetchJsonRows(`SELECT COUNT(*)::int AS count FROM ${this._qualified('artifacts')}`)[0]?.count || 0,
    };
  }
}

export { PostgresStore };
