# Source current roadmap

As of 2026-10-12. Earlier numbered architecture documents describe design intent
and historical milestones; this file records current contest readiness.

## Implemented locally

- Project → Work → Session → Change → Evidence → Decision → canonical Git lifecycle.
- Capability-scoped APIs; authenticated Git smart HTTP; organization isolation.
- Human management/review UI; work context, repository browser and evidence views.
- Deterministic policy checks and Kujo artifact adapters.
- JSON local storage, SQLite and pooled Postgres; durable workflow/worker primitives.
- Operational building blocks: readiness, metrics, writer fencing, backup and recovery tooling.
- Repeatable three-process contest rehearsal with real commits, executed evidence,
  rejected unauthorized approvals, independent rebase and actual merge conflict recovery.
- Authenticated Cloudflare bootstrap Worker and remote Git smoke command, tested locally.

## Required before contest entry

1. Enable paid Workers/Artifacts access (owner deferred this); deploy the bootstrap
   and pass real create/push/clone verification. Then connect the Source review and
   canonical Git flow to the Artifacts repository through the hybrid boundary.
2. Repeat the three-client flow against that integration and retain genuine cloud
   evidence. Demonstrate any claimed LLM-agent behavior with real agents; the current
   deterministic clients are explicitly scripted and are not an LLM demo.
3. Retain the existing MIT license, review publication/history, publish the repo
   and verify a clean anonymous clone can follow the runbook.
4. Restore GitHub Actions availability; run remote checks and container failover.
5. Record the final 5–10 minute video; fill owner/team details and submit manually.

## Beyond the contest

- Independent production security and operations validation, deployment-scale
  cold-connection/load testing and capacity sizing.
- Hosted identity, onboarding and operational service ownership if offering SaaS.
- Strong agent execution isolation and a production agent/provider runner.
- Product polish driven by real multi-user workflow use.

No release date or production-readiness claim is implied. A version field in
package.json is not evidence of an official published release.
