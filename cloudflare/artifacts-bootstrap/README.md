# Source Workers and Artifacts bootstrap

This is the first hybrid integration proof: an authenticated Cloudflare Worker
creates an Artifacts repository, then a local Git client pushes a commit and
clones it into an independent directory. The smoke command checks both the
commit SHA and file content. Source's Node/Postgres review lifecycle now connects to this Worker through
the operator-side [hybrid bridge](../../docs/contest/HYBRID.md). Local contract
tests cover accepted promotion and recovery. The [live bootstrap](../../docs/contest/CLOUDFLARE_LIVE.md)
passed on October 13; the full review lifecycle remains unverified live.

## Run

Use Node 22 or later, Git, and a Cloudflare account with Workers and Artifacts
access. From this directory:

```sh
npm ci
npx wrangler whoami
npm test
npx wrangler deploy --dry-run
```

Create a random secret of at least 32 characters in your secret manager. Install
it using the hidden prompt (do not commit it):

```sh
npx wrangler secret put SOURCE_BOOTSTRAP_SECRET
npm run deploy
```

Set `SOURCE_BOOTSTRAP_URL` to the resulting HTTPS Worker URL and provide
`SOURCE_BOOTSTRAP_SECRET` through your shell/secret manager without pasting it
into command history. Then run:

```sh
npm run smoke
```

The command prints only the repository name, credential-free remote, verified
commit, and completed checks. It removes temporary local workspaces and retains
the remote smoke repository for review. Do not enable Git tracing around this
command. Repository credentials are passed to Git through its process environment,
never written to Git config or included in command arguments.

The Worker uses the `source-bootstrap` namespace. Artifacts creates a namespace
on first repository creation. The Worker accepts only `source-smoke-*` and `source-hybrid-*` names,
requires the operator bearer secret, bounds request bodies to 1 KiB, and marks
credential responses `Cache-Control: no-store`. Upstream errors are redacted and
creation is not automatically retried because its outcome may be uncertain.
`GET /healthz` is process liveness only; it does not prove Artifacts access.

For local development, put the secret in ignored `.dev.vars` and run `npm run dev`.
A live proof must use the deployed service or an explicitly configured remote
Artifacts binding; a local emulator does not prove account access.

## Operator boundary

Agents must not receive the operator secret or Artifacts write tokens.
`POST /repos/:name/token` obtains a disposable repository capability, reads its
metadata and mints a five-minute write token. The bridge pins the remote URL,
uses an expected-tip Git push and reconciles uncertain outcomes. Source enforces
review and protects the local canonical branch. See [HYBRID.md](../../docs/contest/HYBRID.md)
for binding commands, recovery and the local proof. The initial implementation did not deploy or upgrade the account. The owner
subsequently enabled Workers Paid, and the bootstrap is now deployed.

Before deleting retained smoke fixtures, inspect their names with
`npx wrangler artifacts repos list --help` and use the CLI's repository deletion
command only for the intended smoke repository. Rotate the bootstrap secret with
`wrangler secret put` if access needs to change.

References:
- https://developers.cloudflare.com/artifacts/get-started/workers/
- https://developers.cloudflare.com/artifacts/api/workers-binding/
- https://developers.cloudflare.com/artifacts/concepts/namespaces/

## Verified status on October 12 2026

- Wrangler 4.149.0 authenticated to the configured account and reported
  Workers and Artifacts write scopes.
- All four Worker unit tests passed, JavaScript syntax checks passed, and
  `wrangler deploy --dry-run` successfully bundled the Artifacts binding.
- Namespace listing returned access denied (10004). The live deployment then
  returned the actionable blocker: **Artifacts requires a paid Workers plan**
  (10403). No successful Worker deployment or live Git push/clone is claimed.
- The account owner must enable the appropriate plan in Cloudflare billing.
  Then rerun `wrangler whoami`, confirm Artifacts namespace access, install the
  bootstrap secret, deploy, and run the smoke command above. Account upgrades
  were not performed by this change.

## Live proof on October 13 2026

The paid-plan blocker above is resolved. See [deployment evidence](../../docs/contest/CLOUDFLARE_LIVE.md)
and the credential-free JSON report. All six Worker and nine integration tests pass.

If creation succeeded but the smoke client stopped before pushing, inspect the
namespace first. Set `SOURCE_SMOKE_REPOSITORY` to that exact repository to obtain
a fresh token and resume without creating a duplicate. Resume refuses repositories
with existing branch refs. Never retry creation merely because its result was uncertain.

Artifacts tokens are opaque strings. Source checks nonempty printable ASCII and
a 4096-character bound; it does not assume an undocumented token prefix. Tokens
remain restricted to the validated and pinned Artifacts remote.
