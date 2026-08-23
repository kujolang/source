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
import { Semaphore } from './concurrency.js';

const execFileAsync = promisify(execFile);
const MAX_BULK_RECORD_READS = 1_001;

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

function normalizeJobDependencies(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('job dependencies must contain 0-100 references');
  return [...new Set(value.map((dependency) => {
    if (typeof dependency !== 'string' || !dependency || dependency.length > 240) throw new Error('job dependency reference is invalid');
    return dependency;
  }))];
}

function assertDependencyAcyclic(jobs) {
  const edges = new Map(jobs.map((job) => [job.dedupeKey, job.dependsOn.filter((dependency) => jobs.some((candidate) => candidate.dedupeKey === dependency))]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visiting.has(key)) throw new Error('job dependencies contain a cycle');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of edges.get(key) || []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of edges.keys()) visit(key);
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
    this.hashCapabilities = true;
    this.connectionOptions = connectionOptions;
    const poolOptions = { ...connectionOptions };
    delete poolOptions.env;
    delete poolOptions.noPassword;
    delete poolOptions.maxConnections;
    delete poolOptions.fallbackConcurrency;
    delete poolOptions.fallbackTimeoutMs;
    const maxConnections = connectionOptions.maxConnections || poolOptions.max || 32;
    const maxDbQueue = Math.min(100_000, Math.max(0, Math.trunc(connectionOptions.maxDbQueue ?? maxConnections * 8)));
    this.pool = pool || new pg.Pool({
      connectionString: dsn,
      ...poolOptions,
      max: maxConnections,
      connectionTimeoutMillis: poolOptions.connectionTimeoutMillis ?? 10_000,
      idleTimeoutMillis: poolOptions.idleTimeoutMillis ?? 30_000,
      query_timeout: poolOptions.query_timeout ?? 30_000,
    });
    this.lastPoolError = null;
    this.dbAdmission = new Semaphore({ capacity: maxConnections, queue: maxDbQueue });
    this.dbAdmissionRejected = 0;
    this.fallbackConcurrency = Math.min(32, Math.max(1, Math.trunc(connectionOptions.fallbackConcurrency ?? 4)));
    this.fallbackTimeoutMs = Math.min(60_000, Math.max(1_000, Math.trunc(connectionOptions.fallbackTimeoutMs ?? 10_000)));
    this._fallbackActive = 0;
    this.jobRetentionMs = Math.min(365 * 24 * 60 * 60 * 1_000, Math.max(60_000, Math.trunc(connectionOptions.jobRetentionMs ?? 7 * 24 * 60 * 60 * 1_000)));
    this._jobMaintenanceOps = 0;
    this.pool.on?.('error', (error) => { this.lastPoolError = error; });
    this._asyncTransaction = new AsyncLocalStorage();
    this._txDepth = 0;
    this._rateLimitOps = 0;
    this._jobWakeupChannel = `source_jobs_${createHash('sha256').update(String(schema)).digest('hex').slice(0, 24)}`;
    this._jobListenerClient = null;
    this._jobListenerPromise = null;
    this._jobWaiters = new Set();

    // Schema creation is intentionally serialized across serving nodes. The
    // legacy psql bootstrap uses one short-lived session per statement, so the
    // advisory transaction lock is applied by _run while initialization is in
    // progress rather than held by a separate session.
    this._schemaInitializing = true;
    try {
      this._initSchema();
    } finally {
      this._schemaInitializing = false;
    }
  }

  _qualified(name) {
    return `${escapeSqlIdent(this.schema)}.${escapeSqlIdent(name)}`;
  }

  _run(sql) {
    const args = this._psqlArgs(sql);

    const statement = this._schemaInitializing
      ? `SELECT pg_advisory_xact_lock(hashtext(${escapeSqlLiteral(`source-schema:${this.schema}`)}));\n${String(sql).trim()}`
      : String(sql).trim();
    args[args.length - 1] = statement;

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
    const release = await this._acquireDbSlot();
    try {
      const result = await this.pool.query(String(sql).trim());
      this.lastPoolError = null;
      return this._formatAsyncRows(result.rows);
    } catch (error) {
      // Preserve the legacy psql fallback for installations that have not
      // configured a reachable native Postgres client yet.
      if (error?.code !== 'ECONNREFUSED' && error?.code !== 'ENOTFOUND') throw error;
        if (this._fallbackActive >= this.fallbackConcurrency) {
          throw new Error('Postgres fallback process budget exhausted');
        }
        this._fallbackActive += 1;
        try {
          const { stdout } = await execFileAsync(this.psqlPath, this._psqlArgs(sql), {
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
            timeout: this.fallbackTimeoutMs,
            killSignal: 'SIGTERM',
            env: { ...process.env, ...(this.connectionOptions.env || {}) },
          });
          return String(stdout || '').replace(/\r/g, '').trim();
        } finally {
          this._fallbackActive -= 1;
      }
    } finally {
      release();
    }
  }

  async _acquireDbSlot() {
    if (!this.dbAdmission) return () => {};
    const release = await this.dbAdmission.acquire();
    if (release) return release;
    this.dbAdmissionRejected += 1;
    const error = new Error('Postgres query admission queue exhausted');
    error.code = 'DB_ADMISSION_EXHAUSTED';
    throw error;
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

  async _notifyJobsAsync() {
    try {
      await this._runAsync(`SELECT pg_notify(${escapeSqlLiteral(this._jobWakeupChannel)}, '')`);
    } catch (error) {
      // Notifications are an optimization. Polling remains the correctness
      // fallback when LISTEN/NOTIFY is unavailable or temporarily unhealthy.
      this.lastPoolError = error;
    }
  }

  async _ensureJobListenerAsync() {
    if (this._jobListenerClient) return true;
    if (this._jobListenerPromise) return this._jobListenerPromise;
    this._jobListenerPromise = (async () => {
      const listenerOptions = { connectionString: this.dsn, ...this.connectionOptions };
      delete listenerOptions.env;
      delete listenerOptions.noPassword;
      delete listenerOptions.maxConnections;
      delete listenerOptions.fallbackConcurrency;
      delete listenerOptions.fallbackTimeoutMs;
      const client = new pg.Client(listenerOptions);
      try {
        await client.connect();
        await client.query(`LISTEN ${escapeSqlIdent(this._jobWakeupChannel)}`);
      } catch (error) {
        await client.end().catch(() => {});
        throw error;
      }
      const reset = () => {
        if (this._jobListenerClient !== client) return;
        this._jobListenerClient = null;
        for (const waiter of this._jobWaiters) waiter(false);
        this._jobWaiters.clear();
      };
      client.on('notification', () => {
        for (const waiter of this._jobWaiters) waiter(true);
        this._jobWaiters.clear();
      });
      client.on('error', reset);
      this._jobListenerClient = client;
      return true;
    })().finally(() => { this._jobListenerPromise = null; });
    return this._jobListenerPromise;
  }

  async waitForWorkAsync({ timeoutMs = 10_000 } = {}) {
    const timeout = Math.min(300_000, Math.max(1, Math.trunc(timeoutMs)));
    try {
      await this._ensureJobListenerAsync();
    } catch {
      return false;
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (woken) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._jobWaiters.delete(finish);
        resolve(woken);
      };
      const timer = setTimeout(() => finish(false), timeout);
      timer.unref?.();
      this._jobWaiters.add(finish);
    });
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
      CREATE TABLE IF NOT EXISTS ${this._qualified('replication_events')} (
        seq BIGSERIAL PRIMARY KEY,
        operation TEXT NOT NULL CHECK (operation IN ('upsert')),
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        org_id TEXT,
        project_id TEXT,
        entity_id TEXT,
        previous_hash TEXT,
        current_hash TEXT,
        json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this._run(`
      CREATE TABLE IF NOT EXISTS ${this._qualified('writer_leases')} (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        fencing_token BIGINT NOT NULL,
        lease_until TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    this._run(`ALTER TABLE ${this._qualified('replication_events')} ADD COLUMN IF NOT EXISTS previous_hash TEXT`);
    this._run(`ALTER TABLE ${this._qualified('replication_events')} ADD COLUMN IF NOT EXISTS current_hash TEXT`);

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
        max_attempts INTEGER NOT NULL DEFAULT 5,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        leased_until TIMESTAMPTZ,
        worker_id TEXT,
        lease_token TEXT,
        depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
        dedupe_key TEXT UNIQUE,
        result JSONB,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    for (const column of ['org_id TEXT', 'project_id TEXT', 'work_id TEXT', 'max_attempts INTEGER NOT NULL DEFAULT 5', 'lease_token TEXT', 'depends_on JSONB NOT NULL DEFAULT \'[]\'::jsonb', 'dedupe_key TEXT']) {
      this._run(`ALTER TABLE ${this._qualified('jobs')} ADD COLUMN IF NOT EXISTS ${column}`);
    }

    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_records_path`)} ON ${this._qualified('records')} (path)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_records_path_pattern`)} ON ${this._qualified('records')} (path text_pattern_ops)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_records_repository`)} ON ${this._qualified('records')} (kind, org_id, project_id, entity_id)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_records_repository_name`)} ON ${this._qualified('records')} (org_id, project_id, (json->>'name')) WHERE kind = 'repository'`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_evidence_project`)} ON ${this._qualified('evidence')} (org_id, project_id)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_changes_work`)} ON ${this._qualified('changes')} (org_id, project_id, work_id)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_decisions_change`)} ON ${this._qualified('decisions')} (org_id, project_id, change_id)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_claim`)} ON ${this._qualified('jobs')} (status, available_at, created_at)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_ready`)} ON ${this._qualified('jobs')} (available_at, created_at, id) WHERE status = 'queued'`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_expired`)} ON ${this._qualified('jobs')} (leased_until, created_at, id) WHERE status = 'leased'`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_scope`)} ON ${this._qualified('jobs')} (org_id, project_id, work_id, created_at)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_fair`)} ON ${this._qualified('jobs')} (org_id, project_id, status, available_at, leased_until, created_at, id)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_active_scope`)} ON ${this._qualified('jobs')} (org_id, project_id, status, created_at) WHERE status IN ('queued', 'leased')`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_leased`)} ON ${this._qualified('jobs')} (leased_until, created_at) WHERE status = 'leased'`);
    this._run(`CREATE UNIQUE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_jobs_dedupe`)} ON ${this._qualified('jobs')} (dedupe_key) WHERE dedupe_key IS NOT NULL`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_rate_limits_reset`)} ON ${this._qualified('rate_limits')} (reset_at)`);
    this._run(`CREATE INDEX IF NOT EXISTS ${escapeSqlIdent(`${this.projectPrefix}_replication_events_seq`)} ON ${this._qualified('replication_events')} (seq)`);
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

  async readJsonManyAsync(relPaths) {
    if (!Array.isArray(relPaths) || relPaths.length > MAX_BULK_RECORD_READS) throw new Error(`bulk record read must contain 0-${MAX_BULK_RECORD_READS} paths`);
    const paths = [...new Set(relPaths.map((relPath) => {
      if (typeof relPath !== 'string' || !relPath || relPath.length > 1_000) throw new Error('record path is invalid');
      return relPath;
    }))];
    if (!paths.length) return [];
    return this._fetchJsonRowsAsync(`
      SELECT path, json
      FROM ${this._qualified('records')}
      WHERE path IN (${paths.map(escapeSqlLiteral).join(',')})
      ORDER BY path
    `);
  }

  async findRepositoryAsync(orgId, projectId, repoRef) {
    if (typeof repoRef !== 'string' || !repoRef || repoRef.length > 240) throw new Error('repository reference is invalid');
    const rows = await this._fetchJsonRowsAsync(`
      SELECT json
      FROM ${this._qualified('records')}
      WHERE kind = 'repository'
        AND org_id = ${escapeSqlLiteral(orgId)}
        AND project_id = ${escapeSqlLiteral(projectId)}
        AND (entity_id = ${escapeSqlLiteral(repoRef)} OR json->>'name' = ${escapeSqlLiteral(repoRef)})
      LIMIT 1
    `);
    return rows[0]?.json || null;
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
    return this.transactionAsync(() => this._writeJsonAsync(relPath, obj));
  }

  // Domain mutations commonly update a primary record plus one or more
  // projections. Keep the whole fan-out on one pooled client and transaction
  // so bursty agent traffic does not pay one checkout/commit per record.
  async writeJsonManyAsync(entries) {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_BULK_RECORD_READS) {
      throw new Error(`bulk record write must contain 1-${MAX_BULK_RECORD_READS} entries`);
    }
    for (const entry of entries) {
      if (!entry || typeof entry.relPath !== 'string' || !entry.relPath || entry.relPath.length > 1_000) {
        throw new Error('record path is invalid');
      }
    }
    return this.transactionAsync(async () => {
      for (const { relPath, obj } of entries) await this._writeJsonAsync(relPath, obj);
    });
  }

  async _writeJsonAsync(relPath, obj, { emitReplicationEvent = true } = {}) {
    const classified = this._classifyRelPath(relPath);
    if (emitReplicationEvent) {
      await this._runAsync(`INSERT INTO ${this._qualified('replication_events')} (operation, path, kind, org_id, project_id, entity_id, previous_hash, current_hash, json)
        SELECT 'upsert', ${escapeSqlLiteral(relPath)}, ${escapeSqlLiteral(classified.kind)}, ${escapeSqlLiteral(classified.orgId || null)},
          ${escapeSqlLiteral(classified.projectId || null)}, ${escapeSqlLiteral(classified.id || null)}, md5(json::text), md5(${toJson(obj)}::jsonb::text), ${toJson(obj)}::jsonb
        FROM ${this._qualified('records')} WHERE path = ${escapeSqlLiteral(relPath)}
        UNION ALL
        SELECT 'upsert', ${escapeSqlLiteral(relPath)}, ${escapeSqlLiteral(classified.kind)}, ${escapeSqlLiteral(classified.orgId || null)},
          ${escapeSqlLiteral(classified.projectId || null)}, ${escapeSqlLiteral(classified.id || null)}, NULL, md5(${toJson(obj)}::jsonb::text), ${toJson(obj)}::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM ${this._qualified('records')} WHERE path = ${escapeSqlLiteral(relPath)})`);
    }
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

  // Ordered, transactional CDC seam for a deployment's native replication or
  // consensus consumer. The event is committed with the compatibility record
  // and normalized projections, so a cursor never observes a partial write.
  async listReplicationEventsAsync({ afterSeq = 0, limit = 1_000 } = {}) {
    const cursor = Math.max(0, Math.trunc(Number(afterSeq) || 0));
    const pageSize = Math.min(1_000, Math.max(1, Math.trunc(Number(limit) || 1)));
    const rows = await this._fetchJsonRowsAsync(`
      SELECT seq, operation, path, kind, org_id AS "orgId", project_id AS "projectId", entity_id AS "entityId", previous_hash AS "previousHash", current_hash AS "currentHash", json, created_at AS "createdAt"
      FROM ${this._qualified('replication_events')}
      WHERE seq > ${cursor}
      ORDER BY seq
      LIMIT ${pageSize + 1}
    `);
    const events = rows.slice(0, pageSize);
    return {
      events,
      nextCursor: events.length ? Number(events.at(-1).seq) : cursor,
      hasMore: rows.length > pageSize,
    };
  }

  async applyReplicationEventsAsync({ sourceId, events } = {}) {
    if (typeof sourceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(sourceId)) throw new Error('replication source id is invalid');
    if (!Array.isArray(events) || events.length > 1_000) throw new Error('replication event batch must contain 0-1000 events');
    return this.transactionAsync(async () => {
      const key = `replication:cursor:${sourceId}`;
      const currentRows = await this._fetchJsonRowsAsync(`SELECT value FROM ${this._qualified('meta')} WHERE key = ${escapeSqlLiteral(key)}`);
      let cursor = Number(currentRows[0]?.value || 0);
      const paths = [...new Set(events.filter((event) => Number(event?.seq) > cursor).map((event) => event?.path).filter((path) => typeof path === 'string'))];
      const currentRecords = paths.length
        ? await this._fetchJsonRowsAsync(`SELECT path, md5(json::text) AS hash FROM ${this._qualified('records')} WHERE path IN (${paths.map(escapeSqlLiteral).join(',')})`)
        : [];
      const currentHashes = new Map(currentRecords.map((row) => [row.path, row.hash]));
      let applied = 0;
      for (const event of events) {
        const sequence = Number(event?.seq);
        if (!Number.isSafeInteger(sequence) || sequence <= cursor) continue;
        if (sequence !== cursor + 1) {
          const error = new Error(`replication event gap: expected ${cursor + 1}, received ${sequence}`);
          error.code = 'REPLICATION_GAP';
          throw error;
        }
        if (event.operation !== 'upsert' || typeof event.path !== 'string' || !event.path || event.json === undefined) {
          throw new Error('replication event is invalid');
        }
        if (event.previousHash !== undefined && (currentHashes.get(event.path) || null) !== event.previousHash) {
          const error = new Error(`replication conflict at ${event.path}`);
          error.code = 'REPLICATION_CONFLICT';
          error.path = event.path;
          throw error;
        }
        await this._writeJsonAsync(event.path, event.json, { emitReplicationEvent: false });
        currentHashes.set(event.path, event.currentHash || 'updated');
        cursor = sequence;
        applied += 1;
      }
      await this._runAsync(`INSERT INTO ${this._qualified('meta')} (key, value)
        VALUES (${escapeSqlLiteral(key)}, ${toJson(cursor)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
      return { sourceId, applied, cursor };
    });
  }

  listJson(dirRel, { cursor, limit, includeDirs = false } = {}) {
    const normalized = dirRel.endsWith('/') ? dirRel.slice(0, -1) : dirRel;
    const prefix = `${normalized}/`;
    const where = `WHERE path LIKE ${escapeSqlLiteral(`${prefix}%`)}`;
    const limitClause = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${Math.min(limit, MAX_BULK_RECORD_READS)}` : '';

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
    const limitClause = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${Math.min(limit, MAX_BULK_RECORD_READS)}` : '';
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

  async lockProjectAsync(orgId, projectId) {
    await this._runAsync(`SELECT id FROM ${this._qualified('projects')}
      WHERE org_id = ${escapeSqlLiteral(orgId)} AND id = ${escapeSqlLiteral(projectId)}
      FOR UPDATE`);
  }

  lockProject(orgId, projectId) {
    this._run(`SELECT id FROM ${this._qualified('projects')}
      WHERE org_id = ${escapeSqlLiteral(orgId)} AND id = ${escapeSqlLiteral(projectId)}
      FOR UPDATE`);
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

  async nextIdsAsync(kind, prefix, count) {
    const safeCount = Math.min(1000, Math.max(1, Math.trunc(count)));
    const key = `counter:${kind}`;
    const value = await this._runAsync(`
      INSERT INTO ${this._qualified('meta')} (key, value)
      VALUES (${escapeSqlLiteral(key)}, to_jsonb(${safeCount}::bigint))
      ON CONFLICT (key) DO UPDATE SET value = to_jsonb(((${this._qualified('meta')}.value)::text)::bigint + ${safeCount})
      RETURNING value
    `);
    const end = Number(JSON.parse(value));
    return Array.from({ length: safeCount }, (_, index) => `${prefix}${end - safeCount + index + 1}`);
  }

  allowRateLimit(key, limit, windowMs, now = Date.now(), cost = 1) {
    const safeCost = Math.min(1000, Math.max(1, Math.trunc(cost)));
    this._cleanupRateLimits(now);
    const out = this._run(`
      INSERT INTO ${this._qualified('rate_limits')} (key, count, reset_at)
      VALUES (${escapeSqlLiteral(key)}, ${safeCost}, ${escapeSqlLiteral(now + windowMs)})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN ${escapeSqlLiteral(now)} >= ${this._qualified('rate_limits')}.reset_at THEN ${safeCost} ELSE ${this._qualified('rate_limits')}.count + ${safeCost} END,
        reset_at = CASE WHEN ${escapeSqlLiteral(now)} >= ${this._qualified('rate_limits')}.reset_at THEN ${escapeSqlLiteral(now + windowMs)} ELSE ${this._qualified('rate_limits')}.reset_at END
      RETURNING count
    `);
    return Number(out) <= limit;
  }

  // Async counterpart for request-path throttles. This uses the pooled client
  // when available while preserving the same atomic SQL update.
  async allowRateLimitAsync(key, limit, windowMs, now = Date.now(), cost = 1) {
    const safeCost = Math.min(1000, Math.max(1, Math.trunc(cost)));
    await this._cleanupRateLimitsAsync(now);
    const out = await this._runAsync(`
      INSERT INTO ${this._qualified('rate_limits')} (key, count, reset_at)
      VALUES (${escapeSqlLiteral(key)}, ${safeCost}, ${escapeSqlLiteral(now + windowMs)})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN ${escapeSqlLiteral(now)} >= ${this._qualified('rate_limits')}.reset_at THEN ${safeCost} ELSE ${this._qualified('rate_limits')}.count + ${safeCost} END,
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

  async enqueueJobAsync({ kind, payload = {}, availableAt = new Date(), orgId = null, projectId = null, workId = null, maxAttempts = 5, maxQueueDepth = null, dedupeKey = null, dependsOn = [] }) {
    if (!kind || typeof kind !== 'string') throw new Error('job kind is required');
    const safeAttempts = Math.min(100, Math.max(1, Math.trunc(maxAttempts)));
    const id = await this.nextIdAsync('job', 'J');
    const at = new Date(availableAt).toISOString();
    const safeDepth = maxQueueDepth == null ? null : Math.min(10_000_000, Math.max(1, Math.trunc(maxQueueDepth)));
    const safeDedupeKey = dedupeKey == null ? null : String(dedupeKey).slice(0, 240);
    const safeDependsOn = normalizeJobDependencies(dependsOn);
    const validateDependencies = async () => {
      if (!safeDependsOn.length) return;
      const rows = await this._fetchJsonRowsAsync(`SELECT id, dedupe_key AS key FROM ${this._qualified('jobs')}
        WHERE id IN (${safeDependsOn.map(escapeSqlLiteral).join(',')})
           OR dedupe_key IN (${safeDependsOn.map(escapeSqlLiteral).join(',')})`);
      const known = new Set(rows.flatMap((row) => [row.id, row.key]).filter(Boolean));
      if (safeDependsOn.some((dependency) => !known.has(dependency))) throw new Error('job dependency does not exist');
    };
    const insert = () => this._runAsync(`INSERT INTO ${this._qualified('jobs')} (id, kind, payload, org_id, project_id, work_id, status, available_at, max_attempts, dedupe_key, depends_on)
      VALUES (${escapeSqlLiteral(id)}, ${escapeSqlLiteral(kind)}, ${toJson(payload)}, ${escapeSqlLiteral(orgId)}, ${escapeSqlLiteral(projectId)}, ${escapeSqlLiteral(workId)}, 'queued', ${escapeSqlLiteral(at)}, ${safeAttempts}, ${escapeSqlLiteral(safeDedupeKey)}, ${toJson(safeDependsOn)})
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id`);
    let inserted;
    if (safeDepth != null && orgId && projectId) {
      // Lock the project in an explicit transaction. A single SQL statement
      // can retain a pre-wait snapshot while another request holds the row
      // lock, which would make a count-then-insert quota race under burst load.
      inserted = await this.transactionAsync(async () => {
        await this._runAsync(`SELECT id FROM ${this._qualified('projects')} WHERE id = ${escapeSqlLiteral(projectId)} FOR UPDATE`);
        await validateDependencies();
        if (safeDedupeKey) {
          const existing = await this._runAsync(`SELECT id FROM ${this._qualified('jobs')} WHERE dedupe_key = ${escapeSqlLiteral(safeDedupeKey)} LIMIT 1`);
          if (existing) return `dedupe:${existing}`;
        }
        const current = await this._runAsync(`SELECT COUNT(*) FROM ${this._qualified('jobs')}
          WHERE org_id = ${escapeSqlLiteral(orgId)} AND project_id = ${escapeSqlLiteral(projectId)}
            AND status IN ('queued', 'leased')`);
        if (Number(current || 0) >= safeDepth) return '';
        const result = await insert();
        await this._notifyJobsAsync();
        return result;
      });
    } else {
      inserted = await this.transactionAsync(async () => {
        await validateDependencies();
        const result = await insert();
        await this._notifyJobsAsync();
        return result;
      });
    }
    if (typeof inserted === 'string' && inserted.startsWith('dedupe:')) {
      return { id: inserted.slice('dedupe:'.length), kind, payload, orgId, projectId, workId, status: 'deduplicated', attempts: 0, maxAttempts: safeAttempts, availableAt: at, dedupeKey: safeDedupeKey, dependsOn: safeDependsOn };
    }
    if (!inserted && safeDedupeKey) {
      const existing = await this._runAsync(`SELECT id FROM ${this._qualified('jobs')} WHERE dedupe_key = ${escapeSqlLiteral(safeDedupeKey)} LIMIT 1`);
      if (existing) {
        return { id: existing, kind, payload, orgId, projectId, workId, status: 'deduplicated', attempts: 0, maxAttempts: safeAttempts, availableAt: at, dedupeKey: safeDedupeKey, dependsOn: safeDependsOn };
      }
    }
    if (safeDepth != null && orgId && projectId && !inserted) {
      throw new Error('job queue depth exceeded');
    }
    this._jobMaintenanceOps += 1;
    if (this._jobMaintenanceOps % 1_000 === 0) await this.pruneJobsAsync({ limit: 1_000 });
    return { id, kind, payload, orgId, projectId, workId, status: 'queued', attempts: 0, maxAttempts: safeAttempts, availableAt: at, dedupeKey: safeDedupeKey, dependsOn: safeDependsOn };
  }

  async enqueueJobsAsync({ jobs, maxQueueDepth = null } = {}) {
    if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 100) throw new Error('job batch must contain 1-100 jobs');
    const normalized = jobs.map((job) => {
      if (!job || typeof job.kind !== 'string' || !job.kind) throw new Error('job kind is required');
      const availableAt = new Date(job.availableAt || Date.now()).toISOString();
      const dedupeKey = job.dedupeKey == null ? null : String(job.dedupeKey).slice(0, 240);
      return {
        ...job,
        payload: job.payload ?? {},
        availableAt,
        dedupeKey,
        dependsOn: normalizeJobDependencies(job.dependsOn),
        maxAttempts: Math.min(100, Math.max(1, Math.trunc(job.maxAttempts ?? 5))),
      };
    });
    const scopes = new Set(normalized.map((job) => `${job.orgId || ''}\u0000${job.projectId || ''}`));
    if (scopes.size > 1) throw new Error('job batch must use one organization and project scope');
    const orgId = normalized[0].orgId || null;
    const projectId = normalized[0].projectId || null;
    const batchDedupeKeys = new Set(normalized.map((job) => job.dedupeKey).filter(Boolean));
    assertDependencyAcyclic(normalized.filter((job) => job.dedupeKey));
    const safeDepth = maxQueueDepth == null ? null : Math.min(10_000_000, Math.max(1, Math.trunc(maxQueueDepth)));
    return this.transactionAsync(async () => {
      if (safeDepth != null && orgId && projectId) {
        await this._runAsync(`SELECT id FROM ${this._qualified('projects')} WHERE id = ${escapeSqlLiteral(projectId)} FOR UPDATE`);
      }
      const dedupeKeys = normalized.map((job) => job.dedupeKey).filter(Boolean);
      const existing = dedupeKeys.length
        ? await this._fetchJsonRowsAsync(`SELECT dedupe_key AS key, id FROM ${this._qualified('jobs')} WHERE dedupe_key IN (${dedupeKeys.map(escapeSqlLiteral).join(',')})`)
        : [];
      const existingKeys = new Set(existing.map((row) => row.key));
      const dependencyKeys = [...new Set(normalized.flatMap((job) => job.dependsOn))];
      const externalDependencies = dependencyKeys.filter((dependency) => !batchDedupeKeys.has(dependency));
      if (externalDependencies.length) {
        const dependencyRows = await this._fetchJsonRowsAsync(`SELECT id, dedupe_key AS key FROM ${this._qualified('jobs')}
          WHERE id IN (${externalDependencies.map(escapeSqlLiteral).join(',')})
             OR dedupe_key IN (${externalDependencies.map(escapeSqlLiteral).join(',')})`);
        const knownDependencies = new Set(dependencyRows.flatMap((row) => [row.id, row.key]).filter(Boolean));
        if (externalDependencies.some((dependency) => !knownDependencies.has(dependency))) throw new Error('job dependency does not exist');
      }
      const newKeys = new Set();
      const newCount = normalized.filter((job) => {
        if (!job.dedupeKey) return true;
        if (existingKeys.has(job.dedupeKey) || newKeys.has(job.dedupeKey)) return false;
        newKeys.add(job.dedupeKey);
        return true;
      }).length;
      if (safeDepth != null && orgId && projectId) {
        const current = await this._runAsync(`SELECT COUNT(*) FROM ${this._qualified('jobs')}
          WHERE org_id = ${escapeSqlLiteral(orgId)} AND project_id = ${escapeSqlLiteral(projectId)}
            AND status IN ('queued', 'leased')`);
        if (Number(current || 0) + newCount > safeDepth) throw new Error('job queue depth exceeded');
      }
      const ids = await this.nextIdsAsync('job', 'J', normalized.length);
      const values = normalized.map((job, index) => `(${escapeSqlLiteral(ids[index])}, ${escapeSqlLiteral(job.kind)}, ${toJson(job.payload)}, ${escapeSqlLiteral(job.orgId || null)}, ${escapeSqlLiteral(job.projectId || null)}, ${escapeSqlLiteral(job.workId || null)}, 'queued', ${escapeSqlLiteral(job.availableAt)}, ${job.maxAttempts}, ${escapeSqlLiteral(job.dedupeKey)}, ${toJson(job.dependsOn)})`).join(',');
      const inserted = await this._runJsonCommandAsync(`WITH inserted AS (
        INSERT INTO ${this._qualified('jobs')} (id, kind, payload, org_id, project_id, work_id, status, available_at, max_attempts, dedupe_key, depends_on)
          VALUES ${values}
          ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
          RETURNING id, dedupe_key AS key
      ) SELECT COALESCE(json_agg(row_to_json(inserted)), '[]'::json)::text AS rows FROM inserted`);
      await this._notifyJobsAsync();
      const insertedIds = new Set(inserted.map((row) => row.id));
      const insertedByKey = new Map(inserted.filter((row) => row.key).map((row) => [row.key, row.id]));
      const resolved = dedupeKeys.length
        ? await this._fetchJsonRowsAsync(`SELECT dedupe_key AS key, id FROM ${this._qualified('jobs')} WHERE dedupe_key IN (${dedupeKeys.map(escapeSqlLiteral).join(',')})`)
        : [];
      const resolvedByKey = new Map(resolved.map((row) => [row.key, row.id]));
      return normalized.map((job, index) => {
        const id = insertedIds.has(ids[index]) ? ids[index] : resolvedByKey.get(job.dedupeKey) || existing.find((row) => row.key === job.dedupeKey)?.id || insertedByKey.get(job.dedupeKey);
        return { id, kind: job.kind, payload: job.payload, orgId: job.orgId || null, projectId: job.projectId || null, workId: job.workId || null, status: insertedIds.has(ids[index]) ? 'queued' : 'deduplicated', attempts: 0, maxAttempts: job.maxAttempts, availableAt: job.availableAt, dedupeKey: job.dedupeKey, dependsOn: job.dependsOn };
      });
    });
  }

  async pruneJobsAsync({ limit = 1_000 } = {}) {
    const safeLimit = Math.min(10_000, Math.max(1, Math.trunc(limit)));
    await this._runAsync(`DELETE FROM ${this._qualified('jobs')}
      WHERE id IN (
        SELECT id FROM ${this._qualified('jobs')}
        WHERE status IN ('completed', 'failed')
          AND updated_at < NOW() - (${this.jobRetentionMs} * INTERVAL '1 millisecond')
        ORDER BY updated_at
        LIMIT ${safeLimit}
      )`);
  }

  async listJobsAsync({ orgId, projectId, workId = null, cursor = null, limit = 100 }) {
    const safeLimit = Math.min(MAX_BULK_RECORD_READS, Math.max(1, Math.trunc(limit)));
    const cursorClause = cursor ? `AND id > ${escapeSqlLiteral(cursor)}` : '';
    const workClause = workId ? `AND work_id = ${escapeSqlLiteral(workId)}` : '';
    return this._fetchJsonRowsAsync(`
      SELECT id, kind, payload, org_id, project_id, work_id, status, attempts, max_attempts, depends_on AS "dependsOn",
             dedupe_key AS "dedupeKey", available_at, leased_until, worker_id, result, last_error, created_at, updated_at
      FROM ${this._qualified('jobs')}
      WHERE org_id = ${escapeSqlLiteral(orgId)} AND project_id = ${escapeSqlLiteral(projectId)}
        ${workClause} ${cursorClause}
      ORDER BY id
      LIMIT ${safeLimit}
    `);
  }

  async countJobsAsync({ orgId, projectId }) {
    const out = await this._runAsync(`SELECT COUNT(*) FROM ${this._qualified('jobs')}
      WHERE org_id = ${escapeSqlLiteral(orgId)} AND project_id = ${escapeSqlLiteral(projectId)}
        AND status IN ('queued', 'leased')`);
    return Number(out || 0);
  }

  async claimJobsAsync({ workerId, limit = 10, leaseMs = 30_000, maxAttempts = null, projectBurst = 8 }) {
    if (!workerId || typeof workerId !== 'string') throw new Error('workerId is required');
    const safeLimit = Math.min(1000, Math.max(1, Math.trunc(limit)));
    const safeLease = Math.min(86_400_000, Math.max(1, Math.trunc(leaseMs)));
    const safeAttempts = maxAttempts == null ? null : Math.min(100, Math.max(1, Math.trunc(maxAttempts)));
    const safeProjectBurst = Math.min(1_000, Math.max(1, Math.trunc(projectBurst)));
    const attemptAssignment = safeAttempts == null ? 'j.max_attempts' : String(safeAttempts);
    const leaseToken = randomBytes(24).toString('hex');
    return this._runJsonCommandAsync(`
      WITH expired AS (
        SELECT id
        FROM ${this._qualified('jobs')}
        WHERE status = 'leased' AND leased_until < NOW() AND attempts >= max_attempts
        ORDER BY leased_until, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1000
      ), exhausted AS (
        UPDATE ${this._qualified('jobs')} AS j
        SET status = 'failed', leased_until = NULL, worker_id = NULL, lease_token = NULL,
            last_error = 'maximum attempts exceeded', updated_at = NOW()
        FROM expired
        WHERE j.id = expired.id
        RETURNING j.id
      ), blocked AS (
        UPDATE ${this._qualified('jobs')} AS j
        SET status = 'failed', leased_until = NULL, worker_id = NULL, lease_token = NULL,
            last_error = 'dependency failed', updated_at = NOW()
        WHERE j.status = 'queued'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(j.depends_on, '[]'::jsonb)) AS dependency(reference)
            JOIN ${this._qualified('jobs')} AS dependency_job
              ON dependency_job.id = dependency.reference OR dependency_job.dedupe_key = dependency.reference
            WHERE dependency_job.id IS NULL OR dependency_job.status = 'failed'
          )
        RETURNING j.id
      ), ranked AS (
        SELECT id, row_number() OVER (
          PARTITION BY org_id, project_id ORDER BY created_at, id
        ) AS project_rank
        FROM ${this._qualified('jobs')} AS j
        WHERE ((status = 'queued' AND available_at <= NOW())
           OR (status = 'leased' AND leased_until < NOW() AND attempts < max_attempts))
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(j.depends_on, '[]'::jsonb)) AS dependency(reference)
            LEFT JOIN ${this._qualified('jobs')} AS dependency_job
              ON dependency_job.id = dependency.reference OR dependency_job.dedupe_key = dependency.reference
            WHERE dependency_job.id IS NULL OR dependency_job.status <> 'completed'
          )
      ), scope_count AS (
        SELECT COUNT(*) AS scopes FROM ranked WHERE project_rank = 1
      ), candidates AS (
        SELECT j.id
        FROM ${this._qualified('jobs')} j
        JOIN ranked r ON r.id = j.id
        CROSS JOIN scope_count s
        WHERE r.project_rank <= ${safeProjectBurst} OR s.scopes <= 1
        ORDER BY j.created_at, j.id
        FOR UPDATE OF j SKIP LOCKED
        LIMIT ${safeLimit}
      )
      , updated AS (
        UPDATE ${this._qualified('jobs')} j
        SET status = 'leased', attempts = j.attempts + 1,
            max_attempts = CASE WHEN j.attempts = 0 THEN ${attemptAssignment} ELSE j.max_attempts END,
            worker_id = ${escapeSqlLiteral(workerId)}, lease_token = ${escapeSqlLiteral(leaseToken)},
            leased_until = NOW() + (${safeLease} * INTERVAL '1 millisecond'), updated_at = NOW()
        FROM candidates
        WHERE j.id = candidates.id
        RETURNING j.id, j.kind, j.payload, j.org_id AS "orgId", j.project_id AS "projectId", j.work_id AS "workId", j.status, j.attempts,
                  j.available_at AS "availableAt", j.leased_until AS "leasedUntil",
                  j.worker_id AS "workerId", j.lease_token AS "leaseToken", j.max_attempts AS "maxAttempts", j.depends_on AS "dependsOn"
      )
      SELECT COALESCE(json_agg(row_to_json(updated)), '[]'::json)::text AS rows FROM updated
    `);
  }

  async completeJobAsync({ id, workerId, leaseToken, result = null }) {
    if (!leaseToken) throw new Error('leaseToken is required');
    const rows = await this._runJsonCommandAsync(`
      WITH updated AS (
        UPDATE ${this._qualified('jobs')}
        SET status = 'completed', result = ${toJson(result)}, leased_until = NULL,
            worker_id = NULL, lease_token = NULL, updated_at = NOW()
        WHERE id = ${escapeSqlLiteral(id)} AND status = 'leased' AND worker_id = ${escapeSqlLiteral(workerId)} AND lease_token = ${escapeSqlLiteral(leaseToken)}
        RETURNING id
      ) SELECT COALESCE(json_agg(row_to_json(updated)), '[]'::json)::text AS rows FROM updated
    `);
    return Boolean(rows[0]);
  }

  async failJobAsync({ id, workerId, leaseToken, error, retryDelayMs = 1_000, maxAttempts = 5 }) {
    if (!leaseToken) throw new Error('leaseToken is required');
    const delay = Math.min(86_400_000, Math.max(0, Math.trunc(retryDelayMs)));
    const attempts = Math.min(100, Math.max(1, Math.trunc(maxAttempts)));
    const rows = await this._runJsonCommandAsync(`
      WITH updated AS (
        UPDATE ${this._qualified('jobs')}
        SET status = CASE WHEN attempts >= max_attempts OR attempts >= ${attempts} THEN 'failed' ELSE 'queued' END,
            available_at = CASE WHEN attempts >= max_attempts OR attempts >= ${attempts} THEN available_at ELSE NOW() + (${delay} * INTERVAL '1 millisecond') END,
            leased_until = NULL, worker_id = NULL, lease_token = NULL,
            last_error = ${escapeSqlLiteral(String(error || 'job failed'))}, updated_at = NOW()
        WHERE id = ${escapeSqlLiteral(id)} AND status = 'leased' AND worker_id = ${escapeSqlLiteral(workerId)} AND lease_token = ${escapeSqlLiteral(leaseToken)}
        RETURNING id, status, attempts
      ) SELECT COALESCE(json_agg(row_to_json(updated)), '[]'::json)::text AS rows FROM updated
    `);
    return rows[0] || null;
  }

  async extendJobAsync({ id, workerId, leaseToken, leaseMs = 30_000 }) {
    if (!leaseToken) throw new Error('leaseToken is required');
    const safeLease = Math.min(86_400_000, Math.max(1, Math.trunc(leaseMs)));
    const rows = await this._runJsonCommandAsync(`
      WITH updated AS (
        UPDATE ${this._qualified('jobs')}
        SET leased_until = NOW() + (${safeLease} * INTERVAL '1 millisecond'), updated_at = NOW()
        WHERE id = ${escapeSqlLiteral(id)} AND status = 'leased' AND worker_id = ${escapeSqlLiteral(workerId)} AND lease_token = ${escapeSqlLiteral(leaseToken)}
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
    const release = await this._acquireDbSlot();
    const client = await this.pool.connect().catch((error) => {
      release();
      throw error;
    });
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
      release();
    }
  }

  async closeAsync() {
    for (const waiter of this._jobWaiters) waiter(false);
    this._jobWaiters.clear();
    if (this._jobListenerClient) {
      const client = this._jobListenerClient;
      this._jobListenerClient = null;
      await client.query('UNLISTEN *').catch(() => {});
      await client.end().catch(() => {});
    }
    await this.pool.end();
  }

  async checkHealthAsync() {
    await this._runAsync('SELECT 1');
    return true;
  }

  async acquireWriterLeaseAsync({ name = 'primary', owner, leaseMs = 30_000 } = {}) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(name)) throw new Error('writer lease name is invalid');
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_.:-]{1,240}$/.test(owner)) throw new Error('writer lease owner is invalid');
    const safeLease = Math.min(86_400_000, Math.max(1_000, Math.trunc(leaseMs)));
    const rows = await this._fetchJsonRowsAsync(`
      INSERT INTO ${this._qualified('writer_leases')} (name, owner, fencing_token, lease_until)
      VALUES (${escapeSqlLiteral(name)}, ${escapeSqlLiteral(owner)}, 1, NOW() + (${safeLease} * INTERVAL '1 millisecond'))
      ON CONFLICT (name) DO UPDATE SET
        owner = EXCLUDED.owner,
        fencing_token = ${this._qualified('writer_leases')}.fencing_token + 1,
        lease_until = EXCLUDED.lease_until,
        updated_at = NOW()
      WHERE ${this._qualified('writer_leases')}.lease_until < NOW()
         OR ${this._qualified('writer_leases')}.owner = EXCLUDED.owner
      RETURNING name, owner, fencing_token AS "fencingToken", lease_until AS "leaseUntil"
    `);
    if (!rows[0]) {
      const error = new Error('writer lease is held by another owner');
      error.code = 'WRITER_LEASE_HELD';
      throw error;
    }
    return rows[0];
  }

  async renewWriterLeaseAsync({ name = 'primary', owner, fencingToken, leaseMs = 30_000 } = {}) {
    if (!owner || !Number.isSafeInteger(Number(fencingToken))) throw new Error('writer lease renewal identity is invalid');
    const safeLease = Math.min(86_400_000, Math.max(1_000, Math.trunc(leaseMs)));
    const rows = await this._fetchJsonRowsAsync(`
      UPDATE ${this._qualified('writer_leases')}
      SET lease_until = NOW() + (${safeLease} * INTERVAL '1 millisecond'), updated_at = NOW()
      WHERE name = ${escapeSqlLiteral(name)} AND owner = ${escapeSqlLiteral(owner)}
        AND fencing_token = ${Number(fencingToken)} AND lease_until >= NOW()
      RETURNING name, owner, fencing_token AS "fencingToken", lease_until AS "leaseUntil"
    `);
    return rows[0] || null;
  }

  async assertWriterLeaseAsync({ name = 'primary', owner, fencingToken } = {}) {
    if (!owner || !Number.isSafeInteger(Number(fencingToken))) throw new Error('writer lease assertion identity is invalid');
    const rows = await this._fetchJsonRowsAsync(`
      SELECT name, owner, fencing_token AS "fencingToken", lease_until AS "leaseUntil"
      FROM ${this._qualified('writer_leases')}
      WHERE name = ${escapeSqlLiteral(name)} AND owner = ${escapeSqlLiteral(owner)}
        AND fencing_token = ${Number(fencingToken)} AND lease_until >= NOW()
      LIMIT 1
    `);
    if (!rows[0]) {
      const error = new Error('writer lease is not valid');
      error.code = 'WRITER_LEASE_LOST';
      throw error;
    }
    return rows[0];
  }

  async releaseWriterLeaseAsync({ name = 'primary', owner, fencingToken } = {}) {
    if (!owner || !Number.isSafeInteger(Number(fencingToken))) throw new Error('writer lease release identity is invalid');
    const rows = await this._fetchJsonRowsAsync(`
      DELETE FROM ${this._qualified('writer_leases')}
      WHERE name = ${escapeSqlLiteral(name)} AND owner = ${escapeSqlLiteral(owner)} AND fencing_token = ${Number(fencingToken)}
      RETURNING name
    `);
    return Boolean(rows[0]);
  }

  async checkReplicationAsync({ role = 'primary', minStandbys = 1, maxLagBytes = 64 * 1024 * 1024 } = {}) {
    if (role !== 'primary' && role !== 'standby') throw new Error('replication role must be primary or standby');
    const observed = role === 'primary'
      ? (await this._fetchJsonRowsAsync(`
        SELECT json_build_object(
          'inRecovery', pg_is_in_recovery(),
          'standbys', COALESCE((SELECT json_agg(json_build_object(
            'state', state,
            'syncState', sync_state,
            'replayLagBytes', COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)
          )) FROM pg_stat_replication), '[]'::json)
        ) AS status`))[0]?.status
      : (await this._fetchJsonRowsAsync(`
        SELECT json_build_object(
          'inRecovery', pg_is_in_recovery(),
          'receiverStatus', COALESCE((SELECT status FROM pg_stat_wal_receiver LIMIT 1), 'disconnected'),
          'receiveLagBytes', COALESCE(pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()), 0)
        ) AS status`))[0]?.status;
    const failures = [];
    if (role === 'primary') {
      if (observed?.inRecovery) failures.push('database is in recovery, expected primary');
      const standbys = Array.isArray(observed?.standbys) ? observed.standbys : [];
      const streaming = standbys.filter((replica) => replica.state === 'streaming');
      if (streaming.length < minStandbys) failures.push(`only ${streaming.length} streaming standby(s), expected at least ${minStandbys}`);
      if (streaming.some((replica) => Number(replica.replayLagBytes) > maxLagBytes)) failures.push('standby replay lag exceeds configured bound');
    } else {
      if (!observed?.inRecovery) failures.push('database is not in recovery, expected standby');
      if (observed?.receiverStatus !== 'streaming') failures.push(`WAL receiver status is ${observed?.receiverStatus || 'unknown'}, expected streaming`);
      if (Number(observed?.receiveLagBytes) > maxLagBytes) failures.push('standby receive lag exceeds configured bound');
    }
    if (failures.length) {
      const error = new Error(failures.join('; '));
      error.code = 'REPLICATION_NOT_READY';
      error.failures = failures;
      error.observed = observed;
      throw error;
    }
    return { role, observed };
  }

  poolStats() {
    return {
      total: Number(this.pool.totalCount || 0),
      idle: Number(this.pool.idleCount || 0),
      waiting: Number(this.pool.waitingCount || 0),
      fallbackActive: this._fallbackActive,
      admissionCapacity: this.dbAdmission?.capacity || 0,
      admissionActive: this.dbAdmission?.active || 0,
      admissionWaiting: this.dbAdmission?.waiters?.length || 0,
      admissionRejected: this.dbAdmissionRejected || 0,
    };
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
