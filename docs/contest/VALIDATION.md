# Validation record — updated 2026-10-13

Results are local unless explicitly labeled otherwise. The implementation was
prepared on `feat/cloudflare-artifacts-bootstrap`, starting from main
`006c6e7db612ef794775ebe372a6ff8e4a17cb53`.

| Check | Observed result |
| --- | --- |
| Root dependency install and `npm audit --omit=dev --audit-level=high` | Pass, zero reported vulnerabilities after js-yaml 4.3.2 update. |
| Node 22.23.3 default test suite | 214 tests: 211 pass, zero failures, three optional skips (2026-10-13). |
| New Docker COPY-layout regression (Node 22.23.3) | Pass in the default suite; serving modules import and CSS/font routes return nonempty 200 responses from copied files. |
| Real Kujo sibling fixture checks (Node 22.23.3) | Both passed on 2026-10-12 with local Spec/Eval inputs; these unchanged optional fixtures were not rerun in the 2026-10-13 pass. |
| Cloudflare bootstrap unit tests | Four pass. These test binding behavior with a stub; they do not prove a deployed service. |
| Clean-clone `npm ci` and `npm run demo:contest` (Node 22.23.3) | Pass from commit `4d188fbce81ab67caf72a684eb8222e34bde5db5`; three clients overlap by 632 ms, all three approval attempts return 403, both stale proposals are rejected, one real conflict is recovered. |
| Reviewed demo on Node 22.23.3 (2026-10-13) | Pass after lifecycle fixes; three clients overlap 712 ms and the actual conflict is recovered. |
| Local PostgreSQL 14.20, 5,000 lifecycle participants | Pass at unchanged default concurrency 256, using an isolated client and bounded sockets. See database result below. |
| Syntax lint and `git diff --check` | Pass; 71 JavaScript files syntax checked. |
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

On 2026-10-13, the 5,000-participant test passes at the unchanged default HTTP
concurrency of 256: 5,000 completed requests, 5,000 HTTP 200 responses, zero errors,
peak 256 active client requests, max 256 pooled sockets, no retries. Whole test:
160.6 seconds, local PostgreSQL 14.20 and Node 22.23.3. See the
[recorded result](evidence/postgres-local.json). The temporary database was stopped.

The previous same-process fetch loop failed again before the fix, at request 228
with ETIMEDOUT. Sustained 5,000-request probes reproduced timeouts on a plain Node
HTTP server with no Source or PostgreSQL code. Bounding sockets alone did not
remove the failure. Moving the same bounded probe to a separate client process
passed against that plain server (256 accepted sockets) and then against Source.
The fixture had mixed load generation and serving on one event loop. The new
fixture uses the shared deployment load script asynchronously in a child process;
it neither lowers concurrency nor changes host, database or server settings.

The load helper also consumes full responses, bounds whole-request duration,
handles interrupted response bodies, and counts non-2xx completions once. Tests
check actual overlapping server requests, socket reuse, failure counts and CLI
exit behavior. The previous backlog-only explanation was a hypothesis, not an
established root cause. This local success does not certify deployment capacity.

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
