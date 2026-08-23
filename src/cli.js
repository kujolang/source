// Source — CLI.
//
// A thin client over the application service. The CLI uses the same domain
// services as the API; no business logic lives only in the CLI.
//
// `source submit` is the exception: it is a *client* command that runs inside a
// contributor's working clone and talks to a remote Source instance over HTTP
// (see `submit.js`). All other commands operate on the local data root.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Source } from './source.js';

function dataRoot() {
  return process.env.SOURCE_DATA || '.source';
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function printText(lines) {
  process.stdout.write(lines.join('\n') + '\n');
}

export async function run(argv) {
  const args = [...argv];
  const leadingFlags = [];
  const globalValueFlags = new Set(['--store', '--database-url', '--schema']);
  while (globalValueFlags.has(args[0])) {
    leadingFlags.push(args.shift(), args.shift());
  }
  const [cmd, sub, ...rest] = args;

  // Flags may appear after the command (with or without a subcommand), so
  // search everything after `cmd`.
  const all = [...leadingFlags, sub, ...rest];
  const flag = (name) => {
    const i = all.indexOf(name);
    return i >= 0 ? all[i + 1] : undefined;
  };
  const hasFlag = (name) => all.includes(name);

  // Select the store backend: --store json|sqlite|postgres, or SOURCE_STORE.
  // SQLite requires Node >= 22.5 (node:sqlite); PostgreSQL requires a DSN.
  const backend = flag('--store') || process.env.SOURCE_STORE || 'json';
  if (cmd === 'serve' && (backend === 'json' || backend === 'sqlite') && !hasFlag('--allow-unsafe-local-store')) {
    const host = flag('--host');
    const loopback = !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!loopback) fail(`--store ${backend} is single-node only; use --store postgres for an exposed server or explicitly pass --allow-unsafe-local-store`);
  }
  let src;
  if (backend === 'sqlite') {
    const { SqliteStore } = await import('./sqlite-store.js');
    src = new Source(dataRoot(), { store: new SqliteStore(dataRoot()) });
  } else if (backend === 'postgres') {
    const { PostgresStore } = await import('./postgres-store.js');
    const dsn = flag('--database-url') || process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
    const schema = flag('--schema') || undefined;
    src = new Source(dataRoot(), { store: new PostgresStore({ dsn, schema }) });
  } else {
    src = new Source(dataRoot());
  }

  try {
    switch (cmd) {
      case 'init': {
        const instance = src.initInstance({ name: flag('--name') || 'source', hosted: hasFlag('--hosted') });
        print(instance);
        return;
      }
      case 'org': {
        if (sub === 'member' && rest[0] === 'add') {
          const membership = src.addOrgMember({
            orgId: flag('--org') || 'O1',
            principalId: flag('--principal'),
            role: flag('--role') || 'member',
          });
          print(membership);
          return;
        }
        if (sub === 'create') {
          const org = src.createOrg({ name: flag('--name') || 'default', slug: flag('--slug') || 'default' });
          print(org);
          return;
        }
        if (sub === 'list') {
          print(src.listOrgs());
          return;
        }
        if (sub === 'show') {
          print(src.getOrg(rest[0]));
          return;
        }
        break;
      }
      case 'project': {
        const orgId = flag('--org') || 'O1';
        if (sub === 'create') {
          const p = src.createProject({ orgId, slug: flag('--slug') || 'p', name: flag('--name') || 'p', description: flag('--description') || '' });
          print(p);
          return;
        }
        if (sub === 'list') {
          print(src.listProjects(orgId));
          return;
        }
        if (sub === 'show') {
          print(src.getProject(orgId, rest[0]));
          return;
        }
        break;
      }
      case 'repo': {
        const orgId = flag('--org') || 'O1';
        const projectId = flag('--project') || 'P1';
        if (sub === 'create') {
          const r = src.createRepository({ orgId, projectId, name: flag('--name') || 'main' });
          print(r);
          return;
        }
        break;
      }
      case 'work': {
        const orgId = flag('--org') || 'O1';
        const projectId = flag('--project') || 'P1';
        if (sub === 'create') {
          const w = src.createWork({
            orgId,
            projectId,
            intent: flag('--intent') || '',
            requester: flag('--requester') || 'U1',
            requirements: flag('--requirements') ? flag('--requirements').split(',') : [],
            acceptanceConditions: flag('--acceptance') ? flag('--acceptance').split(',') : [],
          });
          print(w);
          return;
        }
        if (sub === 'list') {
          print(src.listWork(orgId, projectId));
          return;
        }
        if (sub === 'show') {
          print(src.getWork(orgId, projectId, rest[0]));
          return;
        }
        if (sub === 'claim') {
          print(src.claimWork({ orgId, projectId, workId: rest[0], principalId: flag('--principal') || 'U1' }));
          return;
        }
        if (sub === 'assign') {
          print(src.assignWork({ orgId, projectId, workId: rest[0], principalId: flag('--principal') || 'U1' }));
          return;
        }
        break;
      }
      case 'session': {
        const orgId = flag('--org') || 'O1';
        const projectId = flag('--project') || 'P1';
        if (sub === 'start') {
          const s = src.startSession({ orgId, projectId, workId: flag('--work'), principalId: flag('--principal') || 'U1', baseCommit: flag('--base') || '' });
          print(s);
          return;
        }
        if (sub === 'complete') {
          print(src.completeSession({ orgId, projectId, sessionId: rest[0], result: flag('--result') || 'done' }));
          return;
        }
        break;
      }
      case 'change': {
        const orgId = flag('--org') || 'O1';
        const projectId = flag('--project') || 'P1';
        if (sub === 'submit') {
          const repoChanges = flag('--repo-changes') ? JSON.parse(flag('--repo-changes')) : null;
          const c = src.submitChange({
            orgId,
            projectId,
            workId: flag('--work'),
            sessionId: flag('--session'),
            baseCommit: flag('--base') || '',
            headCommit: flag('--head') || '',
            repositories: flag('--repos') ? flag('--repos').split(',') : [],
            repositoryChanges: repoChanges,
          });
          print(c);
          return;
        }
        if (sub === 'list') {
          print(src.listChanges(orgId, projectId));
          return;
        }
        if (sub === 'inspect') {
          const change = src.getChange(orgId, projectId, rest[0]);
          const evaluation = src.evaluateChange({ orgId, projectId, changeId: rest[0] });
          print({ change, interpretation: evaluation.interpretation });
          return;
        }
        if (sub === 'scan-secrets') {
          print({ findings: src.scanChangeSecrets({ orgId, projectId, changeId: flag('--change') || rest[0] }) });
          return;
        }
        break;
      }
      case 'evidence': {
        const orgId = flag('--org') || 'O1';
        const projectId = flag('--project') || 'P1';
        if (sub === 'add') {
          const e = src.addEvidence({
            orgId,
            projectId,
            changeId: flag('--change'),
            subject: flag('--subject') || '',
            claim: flag('--claim') || '',
            type: flag('--type') || 'test',
            producer: flag('--producer') || 'U1',
            artifact: flag('--artifact') || null,
            result: flag('--result') ? JSON.parse(flag('--result')) : null,
          });
          print(e);
          return;
        }
        if (sub === 'list') {
          print(src.listEvidence(orgId, projectId));
          return;
        }
        break;
      }
      case 'decision': {
        const orgId = flag('--org') || 'O1';
        const projectId = flag('--project') || 'P1';
        if (sub === 'accept' || sub === 'reject' || sub === 'request-revision') {
          const decision = sub === 'accept' ? 'accepted' : sub === 'reject' ? 'rejected' : 'revision_requested';
          const d = src.makeDecision({ orgId, projectId, changeId: flag('--change'), decision, decider: flag('--decider') || 'U1', reasoning: flag('--reasoning') || '' });
          print(d);
          return;
        }
        break;
      }
      case 'policy': {
        const orgId = flag('--org') || 'O1';
        const projectId = flag('--project') || 'P1';
        if (sub === 'show') {
          print(src.getPolicy(orgId, projectId));
          return;
        }
        break;
      }
      case 'cap': {
        if (sub === 'issue') {
          const cap = src.capabilities.issue({
            principalId: flag('--principal') || 'U1',
            scope: {
              org: flag('--org') || undefined,
              project: flag('--project') || undefined,
              work: flag('--work') || undefined,
            },
            allowed: flag('--allowed') ? flag('--allowed').split(',') : [],
            denied: flag('--denied') ? flag('--denied').split(',') : [],
            ttlMs: flag('--ttl') ? Number(flag('--ttl')) : 4 * 60 * 60 * 1000,
          });
          print(cap);
          return;
        }
        if (sub === 'revoke') {
          print({ revoked: src.capabilities.revoke(rest[0]) });
          return;
        }
        break;
      }
      case 'git-cap': {
        const orgId = flag('--org') || 'O1';
        const projectId = flag('--project') || 'P1';
        const cap = src.issueGitCapability({
          orgId,
          projectId,
          principalId: flag('--principal') || 'U1',
          push: !hasFlag('--read-only'),
        });
        print(cap);
        return;
      }
      case 'audit': {
        print(src.readAudit());
        return;
      }
      case 'serve': {
        // TLS: --tls-key/--tls-cert enable in-process HTTPS termination. Without
        // them the server is plain HTTP (terminate TLS at a reverse proxy).
        const tlsKey = flag('--tls-key');
        const tlsCert = flag('--tls-cert');
        let tls = null;
        if (tlsKey || tlsCert) {
          if (!tlsKey || !tlsCert) fail('--tls-key and --tls-cert must be provided together');
          tls = { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) };
        }
        const host = flag('--host');
        const numberFlag = (name, fallback) => {
          const value = Number(flag(name));
          return Number.isFinite(value) && value > 0 ? value : fallback;
        };
        import('./api.js')
          .then(({ startServer }) => startServer(src, {
            port: Number(flag('--port') || 8787),
            tls,
            host,
            trustProxy: hasFlag('--trust-proxy'),
            gitConcurrency: numberFlag('--git-concurrency', 32),
            gitQueue: numberFlag('--git-queue', 256),
            gitTenantConcurrency: numberFlag('--git-tenant-concurrency', 8),
            gitTenantQueue: numberFlag('--git-tenant-queue', 256),
            maxConnections: numberFlag('--max-connections', 10_000),
            maxGitBodyBytes: numberFlag('--max-git-body', 100_000_000),
            maxChunkedGitBodyBytes: numberFlag('--max-chunked-git-body', 16 * 1024 * 1024),
            maxGitResponseBytes: numberFlag('--max-git-response', 512 * 1024 * 1024),
            gitTimeoutMs: numberFlag('--git-timeout-ms', 120_000),
            maxJsonBodyBytes: numberFlag('--max-json-body', 1_000_000),
            maxWorkflowJobs: numberFlag('--max-workflow-jobs', 1_000),
            artifactConcurrency: numberFlag('--artifact-concurrency', 8),
            artifactQueue: numberFlag('--artifact-queue', 64),
            requestConcurrency: numberFlag('--request-concurrency', 2_048),
            requestQueue: numberFlag('--request-queue', 4_096),
            requireReplication: hasFlag('--require-replication'),
            replicationRole: flag('--replication-role') || 'primary',
            replicationMinStandbys: numberFlag('--min-replicas', 1),
            replicationMaxLagBytes: numberFlag('--max-replication-lag-bytes', 64 * 1024 * 1024),
          }))
          .then((server) => {
            const scheme = tls ? 'https' : 'http';
            const addr = server.address();
            const hostStr = host || 'localhost';
            process.stdout.write(`listening on ${scheme}://${hostStr}:${addr.port}\n`);
            let shuttingDown = false;
            const shutdown = async () => {
              if (shuttingDown) return;
              shuttingDown = true;
              server.beginDrain?.();
              server.closeIdleConnections?.();
              await new Promise((resolve) => {
                const timer = setTimeout(() => server.closeAllConnections?.(), 30_000);
                server.close(() => { clearTimeout(timer); resolve(); });
              });
              await src.store.closeAsync?.();
            };
            for (const signal of ['SIGTERM', 'SIGINT']) {
              process.once(signal, () => shutdown().finally(() => process.exit(0)));
            }
          })
          .catch((e) => fail(e.message));
        return;
      }
      case 'worker': {
        const handlerModule = flag('--handler-module');
        if (!handlerModule) fail('worker requires --handler-module <path>');
        if (backend !== 'postgres') fail('worker requires --store postgres for durable leases');
        const actionManifestPath = flag('--action-manifest');
        const actionKeyringPath = flag('--action-keyring');
        if (Boolean(actionManifestPath) !== Boolean(actionKeyringPath)) fail('worker action integration requires both --action-manifest and --action-keyring');
        const secretProviderModule = flag('--secret-provider-module');
        let actionRegistry = null;
        if (actionManifestPath) {
          const { loadActionKeyring, loadSignedActionRegistry } = await import('./action-runner.js');
          const keyring = await loadActionKeyring({ keyringPath: path.resolve(actionKeyringPath) });
          actionRegistry = await loadSignedActionRegistry({ manifestPath: path.resolve(actionManifestPath), keyring });
        }
        const secretBroker = secretProviderModule
          ? await (await import('./action-runner.js')).loadSecretLeaseBroker({ modulePath: path.resolve(secretProviderModule), leaseMs: Number(flag('--secret-lease-ms')) || 15 * 60_000 })
          : null;
        const loaded = await import(pathToFileURL(path.resolve(handlerModule)).href);
        const handlers = typeof loaded.createHandlers === 'function'
          ? await loaded.createHandlers({ actionRegistry, secretBroker })
          : loaded.handlers || loaded.default;
        if (!handlers || typeof handlers !== 'object') fail('handler module must export { handlers } or a default handler map');
        const { SourceWorker } = await import('./worker.js');
        const numberFlag = (name, fallback) => {
          const value = Number(flag(name));
          return Number.isFinite(value) && value > 0 ? value : fallback;
        };
        const worker = new SourceWorker({
          queue: src.jobs,
          handlers,
          workerId: flag('--worker-id') || `${process.pid}`,
          concurrency: numberFlag('--worker-concurrency', 8),
          leaseMs: numberFlag('--worker-lease-ms', 30_000),
          pollMs: numberFlag('--worker-poll-ms', 1_000),
          maxPollMs: numberFlag('--worker-max-poll-ms', 10_000),
          errorBackoffMs: numberFlag('--worker-error-backoff-ms', 1_000),
          retryDelayMs: numberFlag('--worker-retry-ms', 1_000),
          maxAttempts: numberFlag('--worker-max-attempts', 5),
          projectBurst: numberFlag('--worker-project-burst', 8),
          jitterRatio: numberFlag('--worker-jitter-ratio', 0.2),
          handlerTimeoutMs: numberFlag('--worker-handler-timeout-ms', 15 * 60_000),
          shutdownTimeoutMs: numberFlag('--worker-shutdown-timeout-ms', 30_000),
          onError: (error) => process.stderr.write(`worker ${flag('--worker-id') || process.pid}: ${error.message}\n`),
        });
        worker.start();
        process.stdout.write(`worker ${worker.workerId} started\n`);
        let shuttingDown = false;
        const shutdown = async () => {
          if (shuttingDown) return;
          shuttingDown = true;
          await worker.stop();
          await src.store.closeAsync?.();
        };
        for (const signal of ['SIGTERM', 'SIGINT']) {
          process.once(signal, () => shutdown().finally(() => process.exit(0)));
        }
        return;
      }
      case 'submit': {
        // Client command: run inside a working clone, talk to the remote Source
        // instance over HTTP. See src/submit.js.
        const { submitFromWorkingDir } = await import('./submit.js');
        const result = await submitFromWorkingDir({
          cwd: flag('--cwd') || process.cwd(),
          intent: flag('--intent') || '',
          baseUrl: flag('--url') || null,
          credential: flag('--credential') || null,
        });
        print(result);
        return;
      }
      case 'principal': {
        if (sub === 'create') {
          print(src.createPrincipal({ type: flag('--type') || 'human', name: flag('--name') || 'human', password: flag('--password') }));
          return;
        }
        break;
      }
      case 'help':
      case '--help':
      case undefined: {
        printText([
          'source — agent-first software-development platform',
          '',
          'Usage: source <command> <subcommand> [flags]',
          '',
          'Commands:',
          '  init --name <n> [--hosted]',
          '  org create|list|show [--name <n> --slug <s>]',
          '  org member add --org <o> --principal <id> [--role member|maintainer|admin]',
          '  project create|list|show --org <o> [--name --slug]',
          '  repo create --org <o> --project <p> --name <n>',
          '  principal create --type human|agent|service --name <n>',
          '  cap issue --principal <id> [--org <o>] [--project <p>] [--work <w>] [--allowed a,b] [--denied d,e] [--ttl <ms>]',
          '  cap revoke <id>',
          '  git-cap --org <o> --project <p> --principal <id> [--read-only]',
          '  work create|list|show|claim|assign --org <o> --project <p>',
          '  session start|complete --org <o> --project <p>',
          '  change submit|list|inspect|scan-secrets --org <o> --project <p>',
          '  evidence add|list --org <o> --project <p>',
          '  decision accept|reject|request-revision --org <o> --project <p>',
          '  policy show --org <o> --project <p>',
          '  audit',
          '  serve --port <n> [--host <addr>] [--store postgres] [--replication-role primary|standby --require-replication --min-replicas <n> --max-replication-lag-bytes <n>] [--trust-proxy] [--git-concurrency <n>] [--git-queue <n>] [--git-tenant-concurrency <n>] [--git-tenant-queue <n>] [--git-timeout-ms <n>] [--request-concurrency <n>] [--request-queue <n>] [--max-connections <n>] [--max-git-response <bytes>] [--max-workflow-jobs <n>] [--artifact-concurrency <n>] [--artifact-queue <n>]',
          '  worker --store postgres --handler-module <path> [--worker-id <id> --worker-concurrency <n> --worker-poll-ms <n> --worker-max-poll-ms <n> --worker-project-burst <n> --worker-jitter-ratio <0..1> --worker-handler-timeout-ms <n> --worker-shutdown-timeout-ms <n> --action-manifest <path> --action-keyring <path> --secret-provider-module <path> --secret-lease-ms <n>]',
          '  submit [--intent <s>] [--url <base>] [--credential <c>] [--cwd <dir>]',
          '',
          'Env: SOURCE_DATA (default .source), SOURCE_STORE (json|sqlite|postgres)',
          'Flags: --store json|sqlite|postgres (select the storage backend)',
          'Exposed servers require --store postgres unless --allow-unsafe-local-store is explicitly provided',
          'Postgres flags: --database-url <dsn>, --schema <schema>',
        ]);
        return;
      }
      default:
        fail(`unknown command: ${cmd}`);
    }
  } catch (e) {
    fail(e.message);
  }
}
