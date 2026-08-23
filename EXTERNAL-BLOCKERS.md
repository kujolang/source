# External blockers to production certification

This file records work that cannot be completed or proven from the local
repository alone. It is intentionally separate from implementation TODOs.

## Status

Source's local implementation gates are passing, including the 5,000-agent
Postgres profile, Docker writer failover, full Node test suite, dependency
audit, Kujo Eval, Concord, Fence, and ShipCheck. The items below remain open
because they require external infrastructure, credentials, or organizational
evidence.

## Open blockers

### 1. Hosted CI execution

- **Status:** not verified from this environment.
- **Required evidence:** a successful GitHub-hosted run of `.github/workflows/ci.yml`
  proving the deterministic suite, 5,000-agent Postgres gate, and two-container
  writer-failover gate on the actual runner image.
- **Owner/action:** push or manually dispatch the workflow in GitHub and retain
  the run URL and artifacts.

### 2. Independent security assessment

- **Status:** local dependency audit passes; the configured Codex Security scan
  could not pass its host preflight and produced no report.
- **Required evidence:** a completed repository security scan from Codex
  Security or an equivalent enterprise scanner, followed by triage of every
  finding.
- **Owner/action:** run the scanner in a host with the required preflight
  capability and attach the signed/exported report.

### 3. Multi-region resilience certification

- **Status:** single-control-plane writer fencing, replication checks, backup
  verification, and local failover drills exist; multi-region behavior is not
  certified.
- **Required evidence:** a documented regional/database failure drill covering
  promotion, replication lag, recovery point objective, recovery time objective,
  stale-writer fencing, and data-integrity verification.
- **Owner/action:** execute the drill against the intended production topology
  and record measured RPO/RTO against the service objectives.

### 4. Independent capacity certification

- **Status:** 5,000-agent behavior is verified against local PostgreSQL; this is
  not a production capacity claim.
- **Required evidence:** a representative deployment benchmark covering agent
  concurrency, Git traffic, workflow fan-out, worker throughput, database
  saturation, queue pressure, latency percentiles, and failure recovery.
- **Owner/action:** run the load plan in the target infrastructure and publish
  the capacity envelope and scaling thresholds.

### 5. Compliance and operational evidence

- **Status:** repository security/deployment guidance exists; organizational
  control evidence is not present.
- **Required evidence:** backup-retention proof, restore records, secret/key
  rotation records, access reviews, incident-response runbooks and exercises,
  alert-routing proof, audit-log retention, and any required SOC 2/ISO or
  equivalent control mapping.
- **Owner/action:** complete the organization's production-readiness and
  compliance checklist using the deployed service and retain the evidence.

## Release rule

These items are release-certification blockers, not reasons to hide or disable
the local UI. A deployment may be used for local development and controlled
staging while they remain open, but it should not be represented as fully
production-certified until the evidence above exists.
