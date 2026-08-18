// Source — CLI.
//
// A thin client over the application service. The CLI uses the same domain
// services as the API; no business logic lives only in the CLI.
//
// `source submit` is the exception: it is a *client* command that runs inside a
// contributor's working clone and talks to a remote Source instance over HTTP
// (see `submit.js`). All other commands operate on the local data root.

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
  const [cmd, sub, ...rest] = argv;
  const src = new Source(dataRoot());

  // Flags may appear after the command (with or without a subcommand), so
  // search everything after `cmd`.
  const all = [sub, ...rest];
  const flag = (name) => {
    const i = all.indexOf(name);
    return i >= 0 ? all[i + 1] : undefined;
  };
  const hasFlag = (name) => all.includes(name);

  try {
    switch (cmd) {
      case 'init': {
        const instance = src.initInstance({ name: flag('--name') || 'source', hosted: hasFlag('--hosted') });
        print(instance);
        return;
      }
      case 'org': {
        if (sub === 'create') {
          const org = src.createOrg({ name: flag('--name') || 'default', slug: flag('--slug') || 'default' });
          print(org);
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
          const c = src.submitChange({
            orgId,
            projectId,
            workId: flag('--work'),
            sessionId: flag('--session'),
            baseCommit: flag('--base') || '',
            headCommit: flag('--head') || '',
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
      case 'audit': {
        print(src.readAudit());
        return;
      }
      case 'serve': {
        import('./api.js')
          .then(({ startServer }) => startServer(src, { port: Number(flag('--port') || 8787) }))
          .then((server) => process.stdout.write(`listening on http://localhost:${server.address().port}\n`))
          .catch((e) => fail(e.message));
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
        });
        print(result);
        return;
      }
      case 'principal': {
        if (sub === 'create') {
          print(src.createPrincipal({ type: flag('--type') || 'human', name: flag('--name') || 'human' }));
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
          '  org create --name <n> --slug <s>',
          '  project create|list|show --org <o> [--name --slug]',
          '  repo create --org <o> --project <p> --name <n>',
          '  principal create --type human|agent|service --name <n>',
          '  work create|list|show|claim|assign --org <o> --project <p>',
          '  session start|complete --org <o> --project <p>',
          '  change submit|list|inspect --org <o> --project <p>',
          '  evidence add|list --org <o> --project <p>',
          '  decision accept|reject|request-revision --org <o> --project <p>',
          '  policy show --org <o> --project <p>',
          '  audit',
          '  serve --port <n>',
          '  submit [--intent <s>] [--url <base>] [--cwd <dir>]',
          '',
          'Env: SOURCE_DATA (default .source)',
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
