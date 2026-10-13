# Live Cloudflare bootstrap — October 13, 2026

Workers Paid is confirmed active. The smallest live flow now works:
Worker → Artifacts repository creation → Git push → independent clone → matching
commit and README content. This is actual Cloudflare, not the local emulator.

- Worker: https://source-artifacts-bootstrap.devio-digital.workers.dev
- Namespace: `source-bootstrap`
- Deployed version after secret installation: `b171c348-eac7-430b-9275-f51f3e0cf692`
- Source client fix: `6d76755`
- Machine-readable commits, repositories and checks: [cloudflare-live-smoke.json](cloudflare-live-smoke.json)
- Health returns 200; unauthenticated creation returns 401.
- Fresh short-lived credentials also pass Source's actual Artifacts bridge validation.
- Six Worker and nine integration tests pass; syntax checks pass for 76 JavaScript files.

## Compatibility fix and recovery

The first creation succeeded, but the client rejected the returned credential
because it assumed an `art_v1_` prefix. Current live credentials do not use that
prefix. Tokens are now treated as opaque, bounded, header-safe strings. Regression
coverage retains rejection of whitespace, control characters, non-ASCII values,
empty values and oversized credentials. Host and pinned-remote validation remain.

The existing repository was inspected, then reused through the token endpoint
and successfully pushed/cloned. A fresh end-to-end run also passes. Both fixtures
are retained for review; names and commit IDs are in the JSON report. The resume
path refuses repositories with existing branches, and credentials are absent from
Git configuration, command arguments and this evidence. The operator secret is
installed in the Worker and held in the operator's local secret manager.

## Full live Source lifecycle — verified

The three-client live run passed on clean Source commit `10482dd`.
The [lifecycle report](cloudflare-live-lifecycle.json) records the exact remote,
commits, decisions, UI checks and audit events. Three separate scripted processes
overlap by 1,290 ms. Each self-approval attempt returns HTTP 403. Source executes
tests and diff checks, records scripted maintainer decisions, and promotes to
live Artifacts. The seed cannot promote before acceptance; direct deletion of
the local canonical branch is rejected.

The live run deliberately throws after one successful remote push. Work remains
accepted. A retry confirms the remote and closes Work without a second push.
Stale proposals are rejected by the live bridge; documentation rebases cleanly,
while settings.json produces a real conflict. The revised proposal is checked,
accepted and promoted. An independent cloud clone matches commit
`01ebfe8c6c5d550faa87fe67410c63974e42eade`, dark theme, page size 20 and updated
documentation. All three client Work items close.

### Reproduce

Provide `SOURCE_ARTIFACTS_WORKER_URL` and `SOURCE_BOOTSTRAP_SECRET` privately, then:

```sh
npm ci
npm run demo:cloudflare
```

Each run creates a new review fixture and retains it in the cloud. Private local
state is under ignored `.contest-demo/run-*`; `live-creation.json` identifies the
remote even if a later step fails. Inspect that repository before retrying an
uncertain creation. The operator secret is excluded from forked client environments.
Clients stage Git locally and use Source's scoped HTTP API for lifecycle actions.
This does not measure public-internet contributor transport or hosted UI capacity.

## Remaining scope

The Source Node application and its JSON store run locally; this is not a hosted
UI/Postgres deployment. Contributors and maintainer decisions are scripted, not
LLM-generated or human-reviewed. The lost acknowledgement is injected after a real
push; it is not an observed Cloudflare outage. Concurrent remote-writer lease races
remain covered by local contract tests, not by this sequential promotion rehearsal.

Production load, independent security review, final owner video review and manual
contest submission remain separate gates. No submission, official release,
subscription cancellation or fixture deletion was performed. Workers Paid
continues until the owner cancels it.
