# Source competition checklist

Updated 2026-10-13. The technical submission package is ready and the owner has
approved the final video. Required form details, eligibility/terms confirmation
and manual submission remain.
Workers Paid is active and the live bootstrap passes; the full three-client Source review, promotion and recovery flow also passes live.

## Completed local preparation

- [x] Establish the repository baseline, license and release status: now public (2026-10-13),
  MIT, no official GitHub releases at review time.
- [x] Implement authenticated Workers/Artifacts bootstrap, local tests and real
  remote push/clone smoke command; [live bootstrap passed](CLOUDFLARE_LIVE.md).
- [x] Apply js-yaml 4.3.2 dependency fix and check runtime dependency audit.
- [x] Build repeatable three-client fixture: separate processes, scoped API
  credentials, overlapping changes, executed evidence, denied agent approvals,
  independent rebase, real conflict, revised proposals and final canonical state.
- [x] Add HTTP checks for the authenticated UI and vendored CSS/font responses.
- [x] Fix missing container UI assets and add a copied-layout runtime check.
- [x] Clarify the established-connection concurrency test; retain real deployment
  cold-connection testing as a separate capacity gate.
- [x] Remove committed runtime state from the current tree; ignore private demo
  data; retain third-party license notices and correct the README's license claim.
- [x] Add Node 22 CI steps for the local demo and Cloudflare unit tests.
- [x] Prepare fresh-clone [runbook](RUNBOOK.md), [current roadmap](ROADMAP.md),
  [submission draft](SUBMISSION.md) and [current recorded narration](video/narration-v3.json).
- [x] Record actual verification and limits in [VALIDATION.md](VALIDATION.md).
- [x] Complete [PR 2 local review](PR_REVIEW.md), repair the fleet probe and
  client failure handling, and add regression coverage.

- [x] Review reachable publication history and remove internal run archives from
  the current tree; retain an explicit owner exposure decision for historical data.
- [x] Connect accepted Source changes to the [hybrid Artifacts bridge](HYBRID.md),
  including local contract tests for concurrent updates and uncertain-push recovery.
- [x] Prepare complete narration and architecture explanation for owner review.
- [x] Create the [5:54 live-cloud action film](video/README.md), mobile copy,
  separate Cloudflare segment, captions and editable project with Siren/v4 narration.

## Pending account, environment and owner gates

- [x] Owner enables paid Workers/Artifacts; deploy and verify actual remote
  create/push/independent clone ([evidence](CLOUDFLARE_LIVE.md)).
- [x] Verify the implemented Source/Artifacts review and promotion lifecycle live.
- [x] Re-run the collaboration flow against the actual cloud integration and
  preserve non-secret deployment/evidence/commit identifiers.
- [x] Publish the repository and obtain green remote checks, including the
  PostgreSQL fleet and container gates ([publication evidence](PUBLICATION_REVIEW.md)).
- [x] Verify the local 5,000-request database profile at default concurrency 256
  with an isolated client process and an explicitly bounded connection pool.
- [x] Run a real container build and two-container failover in GitHub Actions.
- [x] Complete local desktop and narrow-screen [browser QA](BROWSER_QA.md); fix
  repository tabs, open-work counts and page overflow.
- [x] Owner authorizes public exposure, publishes Source, merges PR #2 and
  verifies anonymous clone/install/both rehearsals at `996f9e4`.
- [x] Pin reviewed implementation `2184ece2b3b72a7eec0f352d4be84b1f73717b42`;
  live fixture provenance remains separately pinned in its report.
- [x] Record and export the final 5–10 minute video with genuine cloud footage.
- [x] Owner approves the final video (2026-10-13: “the video looks good”).
- [ ] Owner supplies contact/team/attendee details and confirms eligibility/terms.
- [ ] Owner submits manually and retains the confirmation.

Independent-host cold-connect capacity, broader security review and production
certification remain roadmap work, not stated contest entry requirements.

An official tagged release is optional for the contest; the reviewed submission
commit is the required reproducibility reference. Do not create a release just
to imply maturity that the validation does not support.

Official [competition](https://www.cloudflare.com/git-competition/) and
[terms](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf)
control. Both Workers and Artifacts are mandatory. Deadline: October 14, 2026,
23:59 PDT (October 15, 02:59 Detroit).
