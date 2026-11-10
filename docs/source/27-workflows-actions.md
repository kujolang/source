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
The HTTP server accepts the same broker through `createServer({ secretBroker })`;
`/readyz` fails closed on provider health failure and `/metrics` publishes
lease, revocation, active-lease, and provider-health counters. `SourceWorker`
also exposes bounded claim/completion/failure/error counters through `metrics()`.
For a standard HTTPS deployment, `createHttpSecretBroker` / `HttpSecretProvider`
POSTs identity and secret references to the provider over TLS, obtains a fresh
rotating bearer token per lease, rejects oversized or overlong responses, and
requires the provider to return an expiry no later than the requested lease.
The timeout covers the response body as well as headers; the body limit is 1 MiB.
Redirects are rejected. Injected fetch implementations must return a standard
Response with a readable body. Workspace cleanup still runs if lease revocation fails.

## Queue priority, cancellation and lease fencing

Operator-side `JobQueue.enqueue` and `enqueueBatch` accept integer `priority`
from -100 to 100 (default 0). Higher numbers are claimed first among ready jobs;
dependency completion and the existing per-project burst allowance still apply.
This is strict priority without aging, so operators must avoid permanently
starving low-priority work. Public enqueue routes do not accept caller-selected
priority; the verification dispatcher must choose it from trusted policy.

`POST /api/v1/orgs/{org}/projects/{project}/jobs/{id}/cancel` requires the explicit,
project-wide `cancel_job` capability. Enqueue permission and work-scoped tokens
do not confer cancellation authority. The optional JSON `reason` is bounded to
1000 characters. Cancellation persists terminal `cancelled` state, reason and
timestamp, revokes the lease token and records a scoped audit event. Repeats
return the original cancellation; completed/failed jobs cannot be cancelled.
Dependent jobs fail rather than running without their prerequisite. Job listings
include priority and cancellation metadata; cancelled jobs leave active depth.

Complete, fail and heartbeat operations require the current, unexpired lease.
Workers abort on lease loss, heartbeat errors, or the local heartbeat deadline;
rejected completion is not counted as success. The isolated action handler passes
the abort signal to its container runner, which kills the runtime process and
attempts removal of its uniquely named container before releasing its slot.
Ephemeral workspaces are owned by job ID plus lease token. Cleanup from an old
attempt cannot delete a reclaimed attempt's workspace; duplicate acquisition of
one attempt is rejected, including while acquisition is pending.
Cancellation is cooperative for custom handlers: they must observe the signal
and fence persistent writes. It cannot undo side effects already performed or
prove provider teardown succeeded. Candidate evidence writes will also require
job-lease fencing in the verification dispatcher; queue cancellation alone does
not provide that integration.

The store adds priority/cancellation columns and upgrades the previous jobs
status constraint under existing schema initialization locking. Existing jobs
retain priority zero. Upgrade workers before enabling these operations. Rollback
requires draining workers and handling cancelled rows before restoring an old
status constraint; do not simply drop the new columns from a live queue.

Validation: `tests/verification-queue-live.test.js` uses real PostgreSQL stores for
priority, dependencies, cross-scope cancellation denial, stale leases and old
schema upgrade and racing cancellation/completion. Its HTTP test checks authorization and audit. Worker and runner
tests check cancellation propagation with controlled processes; they do not
establish live Docker/Podman cleanup. Durable candidate-aware scheduling, safe
reuse/coalescing, supersession and execution-cost accounting remain separate work.
## Candidate verification jobs

For a configured and planned integration candidate on PostgreSQL, dispatch with:

```bash
node bin/source.js --store postgres integration dispatch \
  --org O1 --project P1 --repo R1 --candidate <candidate-id> --principal U1
```

The HTTP equivalent is `POST
/api/v1/orgs/{org}/projects/{project}/repositories/{repo}/integration/{candidate}/dispatch`.
It requires `dispatch_verification` for that project. `enqueue_job` alone does not
authorize candidate dispatch. The body cannot set commands, producer identities,
priority, or execution environments. Configure those through the repository's
operator-managed verification policy.

The response reports `scheduled`, `coalesced`, or `reused` for each selected check,
with a reason and job or receipt ID. Use existing scoped job list/count and cancel
operations for visibility and cancellation. Completion results include execution
duration and receipt ID. Original check output remains in the evidence store.

Worker modules exporting `createHandlers` now receive `{ source, actionRegistry,
secretBroker }`. An operator module can import `createVerificationHandler` from
`src/verification-dispatcher.js` and return an `integration.verify` handler built
with `{ source, principalId, executor }`. The principal must be a trusted service
listed in each check policy. The executor must provide isolated exact-candidate
execution and cancellation; Source does not install a default host-shell runner.
Run the module with the existing PostgreSQL `worker --handler-module` command and
its concurrency/timeout/lease settings. See the verification planner architecture
for the executor interface and current limitations.

Rollback: stop dispatcher callers and drain/cancel `integration.verify` jobs
before reverting these code changes. Existing job storage requires no additional
schema migration for dispatch. Retain candidate dispatch ledgers and receipts:
deleting them discards rerun-generation enforcement. Do not operate older broker
code against candidates with active dispatch generations; older code does not
enforce the generation constraint. Restore a consistent pre-dispatch backup if a
full rollback is needed, following the existing Git/database recovery procedure.

## Retire or replace an integration candidate

```bash
# Terminally withdraw this candidate and cancel its pending/leased jobs.
node bin/source.js --store postgres integration retire \
  --org O1 --project P1 --repo R1 --candidate <old-id> --reason 'withdrawn'

# Atomically withdraw old work and schedule an already-planned replacement.
node bin/source.js --store postgres integration retire \
  --org O1 --project P1 --repo R1 --candidate <old-id> \
  --replacement <new-id> --reason 'updated proposal'
```

The HTTP endpoint is `POST
/api/v1/orgs/{org}/projects/{project}/repositories/{repo}/integration/{candidate}/retire`
with optional `reason` (1–1000 characters) and `replacementId`. It requires
`retire_integration`; specifying a replacement also requires
`dispatch_verification`. Neither `cancel_job` nor dispatch permission alone may
retire a candidate. The audit principal comes from the authenticated capability.

Retirement is terminal for that immutable candidate ID: status becomes
`cancelled` or `superseded`, and new dispatch, evidence, acceptance and promotion
are refused. It is not a pause/resume operation. Create a distinct candidate from
updated proposals or policy to continue. Historical receipts and approvals remain
inspectable but do not transfer to the replacement. Ordinary single-job
cancellation remains available when you only want to stop/retry one check.

The replacement must be a valid current candidate in the same repository and
project. Old-job cancellation, replacement admission and the retirement audit
commit together; validation or queue-admission failure rolls back all changes.
Repeated requests with the same replacement return the original result without
launching another generation. A different replacement for an already retired
candidate is refused. Landed Git receipts prevent retirement even if the database
promotion acknowledgment was lost. Promotion and retirement share the project
transaction lock, so retirement cannot undo a completed canonical Git update.

Runtime cancellation still depends on worker heartbeat/abort handling; late
evidence is rejected at the broker even if physical teardown is delayed. Never
delete retirement records during rollback or run an older broker that ignores
them against affected candidates. This change adds no database schema migration.

### Managed execution recovery

Managed action workspaces and candidate verification now publish host-owned
attempt journals before OCI launch. Operators can recover a dead local worker's
container with `node scripts/recover-executions.js /absolute/workspace-root`.
Recovery verifies host/PID namespace, dead owner, resource labels, image and
workspace binding; it never uses job ID or age alone to authorize deletion.
Live owners and uncertain state remain untouched. See
[the execution recovery contract](../architecture/candidate-execution.md) for
upgrade, environment identity, recovery states and remaining failure windows.

Container environment values are passed to the runtime client under inert random
aliases, then restored only inside the container shell. Workload `PATH`, `HOME`,
`DOCKER_HOST` and similar names cannot alter host runtime configuration. Values
remain out of argv, multiline values survive, and aliases are removed before
workflow commands. This is separate from output redaction and lease revocation.
