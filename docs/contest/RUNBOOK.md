# Repeatable local contest rehearsal

Use Node.js 22 (validated with 22.23.3), npm and Git. No Kujo sibling checkout,
Cloudflare account, PostgreSQL, Docker or model-provider key is required for this
profile. This repository currently requires GitHub access; anonymous reproduction
must be rechecked after the owner publishes it.

```sh
git clone git@github.com:kujolang/source.git
cd source
git checkout feat/cloudflare-artifacts-bootstrap
npm ci
npm run lint
npm test
npm run test:cloudflare
npm run demo:contest
```

The demo forks three independent processes, each with a work-scoped API capability,
its own checkout, session, real commit and proposal. A ready barrier starts their
changes together, and the report asserts overlapping execution intervals. One
changes the theme, one documents review, and one changes page size on the same line
as the theme edit. Each agent's attempt to approve its proposal must return 403.

The scripted maintainer executes Node checks and `git diff --check`, records actual
outputs as evidence, evaluates policy and promotes the first proposal. Both stale
proposals must fail the Git canonical guard without changing main. The docs client
rebases cleanly; the page-size client hits an actual Git merge conflict. Recovery
preserves both settings, creates replacement Changes and fresh evidence, and
records accepted decisions. The final assertions check both settings and docs.

The demo also authenticates the human UI and checks project, work, change,
repository, CSS and font responses. These are HTTP checks, not visual/browser QA.

## Inspect and repeat

The command prints the new run directory and report path. For example:

```sh
npm run demo:serve -- .contest-demo/run-XXXXXX
```

Use the exact directory printed by your run. Open http://127.0.0.1:8787 and read
login IDs/password locally from that run's `operator.json`. The server binds only
to loopback. Stop it with Ctrl-C. Inspect the UI's original and revised Changes,
evidence, decisions and repository tree alongside `report.json`.

Every invocation makes a separate run; it does not reset any existing Source data.
To reset, stop its server and remove only that disposable run directory. `.source/`,
`.contest-demo/` and `.contest-results/` are ignored. Never publish operator.json,
capabilities, session cookies or the data directory. The report omits passwords
and capability values and may be shared after review.

## What this proves—and its limits

The real API, Git operations, evidence execution and recovery assertions are
exercised. Clients are deterministic scripts; approvals and conflict resolution
are scripted. They share the host filesystem and are not an adversarial execution
sandbox. Git clones/pushes in this profile use a local bare repository. The API
approval-denial check does not establish filesystem isolation. This is neither
an LLM-agent demonstration nor a Cloudflare integration demonstration.

## Other verification profiles

```sh
# Real disposable Postgres instance only; the test creates/drops its own schema.
SOURCE_TEST_DATABASE_URL='postgresql://USER@127.0.0.1:5432/TEST_DB' \
  SOURCE_LIVE_AGENTS=5000 npm run test:postgres

# Separately labeled local profile verified on this macOS host:
SOURCE_TEST_DATABASE_URL='postgresql://USER@127.0.0.1:5432/TEST_DB' \
  SOURCE_LIVE_AGENTS=5000 SOURCE_LIVE_HTTP_CONCURRENCY=64 npm run test:postgres

# Build when a working Docker daemon is available.
docker build --tag source:local-audit .
# See .github/workflows/ci.yml for the two-container failover environment.
```

The live Postgres test has 5,000 lifecycle participants but bounds HTTP fan-out
(default 256) and database connections. Do not call this 5,000 simultaneous network
connections. Optional sibling-repository integration tests skip when fixtures are
absent; the live database test skips without its DSN.

For cloud prerequisites and the real remote push/clone smoke procedure, see
[Workers/Artifacts bootstrap](../../cloudflare/artifacts-bootstrap/README.md).
Only run the cloud procedure after the owner enables the needed account access.
