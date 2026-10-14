# Source

[![Version](https://img.shields.io/badge/version-0.1.0-black)](package.json)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)
[![Kujo ecosystem](https://img.shields.io/badge/Kujo-ecosystem-white.svg)](https://kujolang.ai/ecosystem/source/)
[![Runtime](https://img.shields.io/badge/Node.js-22-black)](package.json)

Source connects Git changes to the work, agent sessions, checks and review decisions
that produced them. Contributors can propose changes and attach evidence. Only an
authorized review decision allows Source to promote a proposal into canonical Git.

Source is part of the Kujo ecosystem. Its server and CLI run on Node.js; adapters
read evidence from Kujo Eval, Spec and ShipCheck.

[Documentation](https://docs.kujolang.ai/tools/source/) ·
[Release](https://github.com/kujolang/source/releases/tag/v0.1.0) ·
[Public MCP catalog](https://mcp.kujolang.ai/mcp)

## What Source does

- Tracks a change from its task through review and promotion.
- Gives contributors scoped, expiring capabilities for API and Git access.
- Checks required evidence before accepting a proposal.
- Rejects stale proposals and preserves the record of revisions and conflicts.
- Provides a browser UI for work, evidence, decisions, repository files and history.
- Supports JSON and SQLite for local use, plus Postgres for shared deployments.
- Promotes accepted changes to Cloudflare Artifacts through a Worker-backed bridge.

```text
Project → Work → Session → Change → Evidence → Decision → Canonical Git
```

## Status

Source is an experimental, self-hosted platform. [Version 0.1.0](https://github.com/kujolang/source/releases/tag/v0.1.0)
is the first public release. It is suitable for local evaluation; it is not a
production-readiness certification.

The three-client demo exercises real Git commits, concurrent proposals, approval
denials, stale updates and conflict recovery. Clients and maintainer decisions are
scripted. The live Cloudflare profile also verifies accepted promotion, recovery
after a lost push acknowledgment, and an independent clone of the final repository.
Source and its review data run locally in that profile; Workers and canonical Git
run on Cloudflare.

CI covers the deterministic suite, PostgreSQL concurrency, container builds and
writer failover. See the [validation record](docs/contest/VALIDATION.md),
[live Cloudflare evidence](docs/contest/CLOUDFLARE_LIVE.md) and
[current roadmap](docs/contest/ROADMAP.md) for the scope and remaining work.
Deployment-scale capacity and independent security validation remain open.

## Quick start

Use **Node.js 22**, npm and Git. The local demo needs no Cloudflare account,
Postgres database, Kujo checkout or model-provider key.

```bash
git clone --branch v0.1.0 https://github.com/kujolang/source.git
cd source
npm ci
npm run demo:contest -- --trace
```

The command creates an isolated run under `.contest-demo/` and prints its report
path. To inspect that run in the browser, use the directory printed by the demo:

```bash
npm run demo:serve -- .contest-demo/run-XXXXXX
```

Open `http://127.0.0.1:8787`. Read the login IDs and password from that run's local
`operator.json`. Run directories and credentials are ignored by Git. Stop the
server with Ctrl-C. See the [runbook](docs/contest/RUNBOOK.md) for repeatable checks
and the reviewed implementation commit.

## Start your own local workspace

```bash
node bin/source.js demo --password '<your own password, at least 12 characters>'
node bin/source.js serve --host 127.0.0.1 --port 8787
```

The bootstrap command prints the login IDs. Sign in with the password you supplied
and enable project management controls to create and review work. Local state lives
in `.source/`. The CLI uses the same services as the API:

```bash
node bin/source.js help
```

The API lives under `/api/v1/` and requires a bearer capability. Git transport lives
under `/git/`: public repositories allow anonymous reads; private reads and all
pushes require a Git capability. See [API authorization](docs/source/19-capability-auth.md)
and [Git transport](docs/source/22-git-transport-auth.md).

## Cloudflare Workers and Artifacts

The hybrid design keeps Source's review service in Node.js. A Cloudflare Worker
creates Artifacts repositories and issues short-lived operator credentials. Source
pushes accepted changes, checks the remote result and updates its local Git cache.
Contributors do not receive the Worker secret or the Artifacts write token.

```bash
# Local contract rehearsal; emulates the Artifacts service.
npm run demo:hybrid

# Live profile; creates a new remote repository.
# Supply SOURCE_ARTIFACTS_WORKER_URL and SOURCE_BOOTSTRAP_SECRET securely first.
npm run demo:cloudflare
```

Follow the [Worker setup guide](cloudflare/artifacts-bootstrap/README.md) and
[hybrid integration guide](docs/contest/HYBRID.md) for deployment and credentials.
The live profile requires access to Workers and Artifacts.

## Development

```bash
npm run lint
npm run format:check
npm test
npm run test:cloudflare

# Optional: use a disposable PostgreSQL database.
SOURCE_TEST_DATABASE_URL='postgresql://USER@127.0.0.1:5432/TEST_DB' npm run test:postgres
```

Some integration tests skip when sibling Kujo repositories or a test database are
absent. Keep the tests and their fixtures: they verify permissions, Git behavior,
evidence ingestion and recovery. Generated state and reports belong in ignored
local directories, not in commits. Reviewed contest evidence is retained under
`docs/contest/` so others can check the published claims.

## Deployment

Use Postgres, shared durable Git storage, TLS and writer fencing for an exposed
service. JSON and SQLite are local backends. The Docker image runs as a non-root
user; serving nodes and workers can run separately.

- [Deployment, TLS and backups](docs/source/23-tls-deployment.md)
- [Resource limits, workers and recovery commands](docs/source/28-operations-reference.md)
- [Production validation still required](EXTERNAL-BLOCKERS.md)
- [Security policy](SECURITY.md)

## Documentation

- [Architecture](docs/source/03-system-architecture.md) and [domain model](docs/source/04-domain-object-model.md)
- [Work lifecycle](docs/source/05-work-lifecycle.md), [changes](docs/source/06-change-model.md) and [evidence](docs/source/07-evidence-model.md)
- [Kujo evidence adapters](docs/source/17-kujo-evidence-integration.md)
- [Contribute through Git with source submit](docs/source/18-source-submit.md)
- [Workflows and actions](docs/source/27-workflows-actions.md)
- [SiteKit UI assets](docs/SITEKIT.md)
- [Contest checklist](docs/contest/README.md) and [demo video record](docs/contest/video/README.md)

The [repository contract](.spec.yml) defines acceptance checks. Design documents
under [docs/source](docs/source/) also preserve earlier decisions and plans;
consult the current validation record before treating a planned feature as shipped.

## License

[MIT](LICENSE). Vendored assets retain their licenses in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
