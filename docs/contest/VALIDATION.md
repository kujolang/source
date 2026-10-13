# Validation record — 2026-10-12

Results are local unless explicitly labeled otherwise. The implementation was
prepared on `feat/cloudflare-artifacts-bootstrap`, starting from main
`006c6e7db612ef794775ebe372a6ff8e4a17cb53`.

| Check | Observed result |
| --- | --- |
| Root dependency install and `npm audit --omit=dev --audit-level=high` | Pass, zero reported vulnerabilities after js-yaml 4.3.2 update. |
| Node 22.23.3 default test suite | 205 tests: 202 pass, zero failures, three optional skips. |
| New Docker COPY-layout regression (Node 22.23.3) | One additional test passes; serving modules import and CSS/font routes return nonempty 200 responses from copied files. |
| Real Kujo sibling fixture checks (Node 22.23.3) | Both previously skipped fixture checks pass when supplied the local Spec repository and Eval artifact. |
| Cloudflare bootstrap unit tests | Four pass. These test binding behavior with a stub; they do not prove a deployed service. |
| Clean-clone `npm ci` and `npm run demo:contest` (Node 22.23.3) | Pass from commit `4d188fbce81ab67caf72a684eb8222e34bde5db5`; three clients overlap by 632 ms, all three approval attempts return 403, both stale proposals are rejected, one real conflict is recovered. |
| Local PostgreSQL 14.20, 5,000 lifecycle participants | Pass with HTTP concurrency 64; default 256 failed. See database result below. |
| Syntax lint and `git diff --check` | Pass. |
| GitHub Actions | Blocked before jobs start: billing/payment or spending-limit annotation. Local results are not remote CI success. |
| Real Docker build and two-container failover | Not run: Docker daemon unavailable. Copied-layout check is not a container build. |
| Browser visual QA | Not run: no controllable browser surface available. Authenticated UI routes and assets were checked over HTTP. |
| Workers + Artifacts live create/push/clone | Not run successfully: deploy returned Cloudflare 10403 requiring a paid plan; owner deferred setup. |

The three default skips were the real Spec dogfood fixture, real Eval artifact,
and opt-in live PostgreSQL test. The two fixture checks were exercised separately;
the database profile is reported separately rather than silently counted as a
passing default test.

The [shareable local demo report](evidence/local-demo.json) contains the exact
source commit, runtime, client commit IDs, intervals, recovery mapping, final Git
commit and audit event names. It contains no credentials or local filesystem
paths. The 632 ms overlap is evidence of concurrency, not a throughput benchmark.
The clean-clone run used a local clone; anonymous public GitHub reproduction still
requires repository publication.

## Database result

The 5,000-participant test passes with `SOURCE_LIVE_HTTP_CONCURRENCY=64`:
1 test passed, zero failures/skips, 143.0 seconds total on local PostgreSQL 14.20
and Node 22.23.3. The isolated test database was stopped after verification.

The default HTTP concurrency of 256 failed twice; after response-body consumption
was fixed, it reported `discovery request 178 failed: ETIMEDOUT`. The host's
`kern.ipc.somaxconn` is 128. This suggests a host backlog constraint but does not
prove the only cause. The default setting was not lowered in code or CI, and the
passing 64-concurrency profile does not certify the default gate. Re-run the
default gate and cold-connection load on the intended Linux deployment before
claiming capacity. No production behavior was changed to obtain the passing run.

## Concurrency scope

The old default test opened 1,000 cold connections simultaneously and timed out
on this host. The revised deterministic test first establishes and confirms
1,000 live server connections in bounded batches, then sends all requests and
checks responses and event-loop progress. It tests concurrent serving without
conflating it with the host's SYN backlog. It does not certify cold-connection
burst capacity; use the deployment load harness from a separate host for that.

## Publication limits

See [PUBLICATION_REVIEW.md](PUBLICATION_REVIEW.md). The limited history scan and
license cleanup do not substitute for the owner's private-content review.
This is a locally verified prototype preparation, not production certification
or a completed competition entry.
