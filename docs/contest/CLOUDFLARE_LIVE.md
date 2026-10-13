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

## Remaining scope

This proves the bootstrap transport, not Source's complete hosted lifecycle.
Accepted-change promotion, stale/concurrent updates and interrupted-operation
recovery still need live verification. Source remains a local Node application;
this deployment does not host its UI or Postgres. Record the genuine cloud segment
only after that lifecycle proof, then assemble the final 5–10 minute contest video.
No submission, official release, subscription cancellation or fixture deletion
was performed. Workers Paid continues until the owner cancels it.
