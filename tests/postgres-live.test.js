import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresStore } from '../src/postgres-store.js';
import { Source } from '../src/source.js';
import { startServer } from '../src/api.js';

const dsn = process.env.SOURCE_TEST_DATABASE_URL;

test('Postgres async lifecycle and HTTP burst remain correct under 1000 agents', { skip: !dsn }, async () => {
  const schema = `source_test_${Date.now()}_${process.pid}`;
  let store;
  let server;
  try {
    store = new PostgresStore({ dsn, schema, connectionOptions: { maxConnections: 16 } });
    const src = new Source(mkdtempSync(path.join(tmpdir(), 'source-pg-live-')), { store });
    await store.writeJsonAsync('instance.json', { id: 'instance', name: 'postgres-live', apiVersion: '1' });
    const org = await src.createOrgAsync({ name: 'load-org', slug: 'load-org' });
    const project = await src.createProjectAsync({ orgId: org.id, name: 'load-project', slug: 'load-project' });
    const principal = await src.createPrincipalAsync({ type: 'agent', name: 'load-agent' });
    const works = await Promise.all(Array.from({ length: 1_000 }, (_, i) => src.createWorkAsync({
      orgId: org.id,
      projectId: project.id,
      intent: `agent-${i}`,
      requester: principal.id,
    })));
    assert.equal(works.length, 1_000);
    assert.equal((await src.listWorkAsync(org.id, project.id, { limit: 1_001 })).length, 1_000);

    server = await startServer(src, { port: 0, maxConnections: 2_000 });
    const url = `http://127.0.0.1:${server.address().port}/.well-known/source`;
    const responses = await Promise.all(Array.from({ length: 1_000 }, () => fetch(url)));
    assert.ok(responses.every((response) => response.status === 200));
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    await store?.closeAsync().catch(() => {});
    execFileSync('psql', ['-d', dsn, '-v', 'ON_ERROR_STOP=1', '-c', `DROP SCHEMA IF EXISTS "${schema}" CASCADE`], { stdio: 'ignore' });
  }
});
