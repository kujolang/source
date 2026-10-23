# PR 2 local review — 2026-10-13

Reviewed changes from main `006c6e7` through the PR's initial head `870037c`,
including bootstrap code, demo scripts, tests, packaging, CI and readiness docs.
Cloudflare setup and deployment remain explicitly deferred.

## Fixed

- **Misleading/failing fleet HTTP probe:** the client and server competed on the
  same event loop. Sustained request failures also reproduced on a plain Node
  HTTP server. The fixture now launches the deployment probe asynchronously in
  a separate process, with a private connection pool capped at the requested
  concurrency. Default 256 concurrency and 5,000 requests pass locally without
  retries, ramp-up, host changes or reduced database limits.
- **Incorrect load accounting and incomplete responses:** non-2xx responses
  counted twice toward completed requests. Counts are now incremented once per
  request, and timeouts cover the complete response body. Interrupted responses
  settle instead of leaving a worker pending. CLI failures exit nonzero.
- **Rehearsal exit hang:** a client exiting with code zero, or a signal, before
  returning its result could clear its timeout while leaving the parent blocked.
  The new lifecycle monitor rejects premature exits, observes early failures,
  and rejects results sent before readiness. Tests use real child processes.
- **Concurrency-test wait:** server acceptance now has its own deadline, so a
  missed connection cannot leave the acceptance promise pending indefinitely.
- **Conflict proof:** the demo now checks the actual unmerged Git path before
  applying its scripted resolution, instead of accepting rebase-state presence
  alone as evidence of a conflict.

## Verification and limits

See [VALIDATION.md](VALIDATION.md) and the
[PostgreSQL result](evidence/postgres-local.json). The successful test isolates
load generation, not the database. It validates this local profile; independent
host-to-host deployment sizing and cold-connect capacity remain separate work.

The Cloudflare package audit reports no vulnerabilities, and its unit tests are
part of the default test run. No Cloudflare login, account change, deployment,
repository creation or remote smoke operation was attempted during this review.
At this earlier review, Docker and browser control were unavailable. The browser
gate was subsequently completed; see [browser QA](BROWSER_QA.md). Docker remains
unavailable.

## Hybrid follow-up review

The operator-side bridge now connects accepted Changes to the Worker and Artifacts
Git contract. Local and remote canonical updates use expected-tip checks; retry
reconciles a successful remote push whose acknowledgement was lost. The receive
hook rejects direct canonical pushes, stored binding metadata prevents local
fallback after a restore, and failed UI promotion returns HTTP 409 instead of a
success-looking redirect. Token-bearing upstream errors are redacted.

The publication follow-up removes tracked internal run archives at HEAD and
preserves the historical exposure decision for the owner. The submission draft,
architecture runbook and full narration distinguish local emulation from live
verification. See [VALIDATION.md](VALIDATION.md) for the 224-test suite, final HTTP
regressions, both rehearsals and the repeated default PostgreSQL profile.
Live Cloudflare, remote CI and container failover remain outside these local
results. The later [browser review](BROWSER_QA.md) closes the local visual gate.

Publication follow-up: PR #2 is merged. Remote CI and actual Docker failover now
pass after the pagination correction; see [publication evidence](PUBLICATION_REVIEW.md).
