# Source 0.1.0

Source connects Git changes to their tasks, agent sessions, evidence and review decisions. This first public release includes the self-hosted server, browser UI, CLI, scoped Git/HTTP access, JSON/SQLite/PostgreSQL stores and the Cloudflare Workers/Artifacts bridge.

## Run the demo

Use Node.js 22, npm and Git:

```sh
git clone --branch v0.1.0 https://github.com/kujolang/source.git
cd source
npm ci
npm run demo:contest -- --trace
```

The local demo needs no Cloudflare account or model key. It runs three scripted contributors through real commits, approval denials, stale changes, conflict recovery and reviewed promotion. To browse its results, run `npm run demo:serve -- .contest-demo/run-XXXXXX` with the printed run directory. Open http://127.0.0.1:8787 and read that run's local `operator.json` for login details.

`npm run demo:hybrid` tests the Worker contract with an emulated Artifacts service. The separately recorded [live Cloudflare demo](contest/CLOUDFLARE_LIVE.md) uses deployed Workers and canonical Git on Artifacts while Source runs locally. Follow [HYBRID.md](contest/HYBRID.md) to configure your own live integration.

## Verification and limits

The release includes fixes for tenant and identity authorization, session traversal, Git option injection, PostgreSQL text/binary fidelity, migrations, retention, concurrent evidence relationships and resource cleanup. The reviewed implementation passed 245 default tests (eight environment-dependent skips), 19 live PostgreSQL checks, 5,000 successful HTTP requests, container builds and two-container failover. See the [audit](audits/repository-hardening.md) for exact evidence and CI links.

This is an experimental 0.x release, not a certified hosted platform. JSON is single-process. Exposed serving requires the documented PostgreSQL, shared Git storage, TLS and writer controls. Synchronous PostgreSQL maintenance is not transactionally atomic; worker timeout does not guarantee cancellation of arbitrary handlers. Operators upgrading existing deployments should review historical requester credentials and evidence fidelity. No deployment compromise is asserted.

Install through Git and npm. Source is not an npm registry publication or a Kennel-installable Kujo package. GitHub supplies source archives for this release. MIT license; third-party notices are retained.
