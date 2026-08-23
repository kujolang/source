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
- `GET /api/v1/orgs/{org}/projects/{project}/workflows` lists definitions
  (`read_workflows`).
- `POST /api/v1/orgs/{org}/projects/{project}/workflows/{id}/dispatch` submits
  an event (`dispatch_workflow`).

Dispatch is durable and multi-node safe. Each step becomes a Postgres queue job
with the workflow version, event ID, event input, and step number in its
payload. The event ID is the idempotency key: repeated webhook or agent
delivery returns the original job instead of creating duplicate work. Queue
depth, payload, attempts, leases, and worker concurrency remain bounded by the
same controls as direct jobs.

Execution is deliberately separated from dispatch. Operators register safe
handlers in `SourceWorker`; workflow content is untrusted data and never
becomes shell code automatically. A handler may invoke Kujo tools such as
Eval, ShipCheck, Concord, Fence, or CaseFile and submit their structured
artifacts as Source Evidence. This preserves the Kujo artifact boundary while
allowing hundreds or thousands of workers to process independent steps.

This is a workflow/action control plane, not a claim of complete GitHub Actions
runtime compatibility. Container isolation, runner provisioning, secrets
brokering, and hosted webhook signature adapters remain deployment-specific
work required before advertising drop-in `.github/workflows` compatibility.
