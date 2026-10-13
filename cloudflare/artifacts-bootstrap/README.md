# Source Workers and Artifacts bootstrap

This is the first hybrid integration proof: an authenticated Cloudflare Worker
creates an Artifacts repository, then a local Git client pushes a commit and
clones it into an independent directory. The smoke command checks both the
commit SHA and file content. Source's Node/Postgres application is unchanged.
This is an operator-only bootstrap, not the tenant-facing Source API or the
complete Work/Change/Evidence/Decision integration.

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
on first repository creation. The Worker accepts only `source-smoke-*` names,
requires the operator bearer secret, bounds request bodies to 1 KiB, and marks
credential responses `Cache-Control: no-store`. Upstream errors are redacted and
creation is not automatically retried because its outcome may be uncertain.
`GET /healthz` is process liveness only; it does not prove Artifacts access.

For local development, put the secret in ignored `.dev.vars` and run `npm run dev`.
A live proof must use the deployed service or an explicitly configured remote
Artifacts binding; a local emulator does not prove account access.

## Boundaries and next integration

Agents must not receive the operator bootstrap secret. The next increment should
map Source authorization and sessions to isolated Artifacts workspaces, enforce
canonical-writer authority, and reconcile approved changes. No repository
publication, contest submission, or production migration is part of this proof.

Before deleting retained smoke fixtures, inspect their names with
`npx wrangler artifacts repos list --help` and use the CLI's repository deletion
command only for the intended smoke repository. Rotate the bootstrap secret with
`wrangler secret put` if access needs to change.

References:
- https://developers.cloudflare.com/artifacts/get-started/workers/
- https://developers.cloudflare.com/artifacts/api/workers-binding/
- https://developers.cloudflare.com/artifacts/concepts/namespaces/
