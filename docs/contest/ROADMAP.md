# Source current roadmap

As of 2026-10-13. Earlier numbered architecture documents describe design intent
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
- Authenticated Cloudflare Worker, remote Git smoke command and accepted-change
  hybrid bridge; local contract rehearsal covers remote races and retry recovery.

## Required before contest entry

1. Paid access, bootstrap and full three-client live review/promotion now pass
   ([evidence](CLOUDFLARE_LIVE.md)). Preserve the report with the entry commit.
2. Keep scripted-client and simulated-review labels. No LLM-agent behavior is claimed.
3. Review the completed [5:54 live-cloud film](video/README.md), fill owner/team
   details and submit manually. Implementation checkpoint: `2184ece`.

Publication, anonymous clone/rehearsals and PR #2 merge are complete. CI and real
container failover pass at `2184ece`; see [publication evidence](PUBLICATION_REVIEW.md).

## Beyond the contest

- Independent production security and operations validation, deployment-scale
  cold-connection/load testing and capacity sizing.
- Hosted identity, onboarding and operational service ownership if offering SaaS.
- Strong agent execution isolation and a production agent/provider runner.
- Product polish driven by real multi-user workflow use.

No release date or production-readiness claim is implied. A version field in
package.json is not evidence of an official published release.
