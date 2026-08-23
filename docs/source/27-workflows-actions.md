# 27 — Durable Workflows and Actions

Source now provides the durable control-plane seam needed for GitHub-Actions-
style automation without coupling execution to the HTTP server. A workflow is
an immutable, project-scoped definition with a version, one or more event
triggers, and bounded queue steps:

```json
{
  "name": "push checks",
  "triggers": ["push"],
  "jobs": [
    { "kind": "kujo.eval", "payload": { "suite": "release" } }
  ]
}
```

Agents or trusted services use the capability-gated endpoints:

- `POST /api/v1/orgs/{org}/projects/{project}/workflows` creates a definition
  (`manage_workflows`).
- `POST /api/v1/orgs/{org}/projects/{project}/workflows/import-github` reads a
  committed `.github/workflows/*.yml`/`.yaml` file from a Source repository and
  translates its bounded trigger/job metadata (`manage_workflows`).
- `GET /api/v1/orgs/{org}/projects/{project}/workflows` lists definitions
  (`read_workflows`).
- `POST /api/v1/orgs/{org}/projects/{project}/workflows/{id}/dispatch` submits
  an event (`dispatch_workflow`).
- `POST /api/v1/orgs/{org}/projects/{project}/workflows/{id}/webhook` accepts a
  bounded HMAC-SHA256-signed delivery (`X-Hub-Signature-256` or
  `X-Source-Signature-256`) when `SOURCE_WEBHOOK_SECRET` is configured.

Dispatch is durable and multi-node safe. Each step becomes a Postgres queue job
with the workflow version, event ID, event input, and step number in its
payload. GitHub `needs` dependencies are validated as an acyclic graph and are
stored as durable job dependencies; a dependent job cannot be claimed until
every prerequisite completes. The event ID is the idempotency key: repeated
webhook or agent delivery returns the original job instead of creating duplicate
work. Queue depth, payload, attempts, leases, and worker concurrency remain
bounded by the same controls as direct jobs.

Execution is deliberately separated from dispatch. Operators register safe
handlers in `SourceWorker`; workflow content is untrusted data and never
becomes shell code automatically. A handler may invoke Kujo tools such as
Eval, ShipCheck, Concord, Fence, or CaseFile and submit their structured
artifacts as Source Evidence. This preserves the Kujo artifact boundary while
allowing hundreds or thousands of workers to process independent steps.

This is a workflow/action control plane, not a claim of complete GitHub Actions
runtime compatibility. YAML import preserves `run`, `uses`, permissions, and
environment as untrusted step data; it never executes them in Source. The
repository includes an explicit `IsolatedActionRunner` seam for operators that
provision Podman or Docker. It runs only bounded `run` steps in a
non-privileged, read-only, no-network-by-default container with CPU, memory,
PID, output, and wall-clock limits. Configure a separate workspace resolver and
secret provider through `createGitHubActionsHandler`; workflow YAML is never a
secret store. Operators may provide an explicit, bounded action resolver to map
pinned `uses` references to trusted run steps available in the runner image;
unresolved or unconfigured actions fail closed. The resolver is the operator's
compatibility boundary and must not fetch or execute remote action code
implicitly. `StaticActionRegistry` is provided for this deployment boundary;
its default policy accepts only 40-character commit-pinned references and
allowlists each action before resolving it. Mutable tags require an explicit
development-only opt-in. `StaticActionRegistry.fromSignedManifest` additionally
verifies an expiring Ed25519-signed manifest before accepting the catalog, so
action allowlists can be rotated without trusting the workflow repository.
`loadSignedActionRegistry({ manifestPath, keyring })` loads the bounded JSON
manifest from deployment storage and selects the signing key by `keyId`; keep
the retiring public key in the keyring until all manifests it signed expire,
then remove it as part of rotation.
Container
runtime provisioning, secrets brokering, and per-provider secret rotation
remain deployment-specific work required before advertising drop-in
`.github/workflows` compatibility. The
webhook endpoint itself is provider-neutral: it uses the delivery ID as the
idempotency key and maps `X-GitHub-Event` plus the JSON payload into the Source
workflow event contract.

`IsolatedActionRunner` also has its own bounded container admission budget (256
active and 512 queued by default), independent of workspace admission. This
prevents multiple worker handlers sharing one runner from overwhelming the
container host; tune `maxActive` and `queue` for the deployment.
Timeout and output-limit cleanup terminates the runtime process group as well
as the direct runtime process and explicitly removes the named runtime
container, preventing orphaned containers from consuming capacity after a
failed or hung action.
The handler sanitizes broker output to an allowlisted, bounded environment,
rejects runtime-injection variables such as `NODE_OPTIONS`, and redacts
brokered values from captured stdout/stderr before returning the result.
`SecretLeaseBroker` provides the production seam: each resolution requires an
explicit workload identity, is not cached, receives an expiry, and emits an
audit event containing references and metadata but never secret values. The
deployment resolver remains responsible for backing this seam with its rotating
secret system and revocation policy. Worker bootstrap can load that adapter with
`--secret-provider-module <path>`; the module must export
`resolveSecretLease`, `resolveIdentity`, `auditSecretLease`, and
`revokeSecretLease` (or equivalent names on its default export).
`--secret-lease-ms` bounds each lease. Completed action jobs revoke their lease
before the workspace is released; a provider that cannot revoke is rejected by
worker bootstrap.
Worker startup calls the provider health check and fails closed before claiming
jobs when it is unavailable or unhealthy.
For a standard HTTPS deployment, `createHttpSecretBroker` / `HttpSecretProvider`
POSTs identity and secret references to the provider over TLS, obtains a fresh
rotating bearer token per lease, rejects oversized or overlong responses, and
requires the provider to return an expiry no later than the requested lease.
against the operator's secret system.
