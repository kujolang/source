# Source competition checklist

Updated 2026-10-13. Local preparation is usable; **the contest submission is not
ready** until the mandatory live Cloudflare integration and owner steps are done.
Workers/Artifacts account setup was deferred by the owner.

## Completed local preparation

- [x] Establish the repository baseline, license and release status: now public (2026-10-13),
  MIT, no official GitHub releases at review time.
- [x] Implement authenticated Workers/Artifacts bootstrap, local tests and real
  remote push/clone smoke command (live execution is still blocked).
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
  [submission draft](SUBMISSION.md) and [seven-minute script](VIDEO_SCRIPT.md).
- [x] Record actual verification and limits in [VALIDATION.md](VALIDATION.md).
- [x] Complete [PR 2 local review](PR_REVIEW.md), repair the fleet probe and
  client failure handling, and add regression coverage.

- [x] Review reachable publication history and remove internal run archives from
  the current tree; retain an explicit owner exposure decision for historical data.
- [x] Connect accepted Source changes to the [hybrid Artifacts bridge](HYBRID.md),
  including local contract tests for concurrent updates and uncertain-push recovery.
- [x] Prepare complete narration and architecture explanation for owner review.
- [x] Create a [3:13 local action cut](video/README.md) with ElevenLabs v4
  Siren narration, recorded UI actions, actual command output, and plain narration.
  The earlier 5:49 overview remains archived; the final contest cut still needs
  live cloud footage and a total duration of 5–10 minutes.

## Pending account, environment and owner gates

- [ ] Owner enables paid Workers/Artifacts; deploy and verify actual remote
  create/push/independent clone. Then verify the implemented Source/Artifacts hybrid lifecycle live.
- [ ] Re-run the collaboration flow against the actual cloud integration and
  preserve non-secret deployment/evidence/commit identifiers.
- [x] Publish the repository and obtain green remote checks, including the
  PostgreSQL fleet and container gates ([publication evidence](PUBLICATION_REVIEW.md)).
- [x] Verify the local 5,000-request database profile at default concurrency 256
  with an isolated client process and an explicitly bounded connection pool.
- [ ] Validate deployment cold-connect capacity from a separate host.
- [x] Run a real container build and two-container failover in GitHub Actions.
- [x] Complete local desktop and narrow-screen [browser QA](BROWSER_QA.md); fix
  repository tabs, open-work counts and page overflow.
- [x] Owner authorizes public exposure, publishes Source, merges PR #2 and
  verifies anonymous clone/install/both rehearsals at `996f9e4`.
- [ ] Freeze the final entry commit after live Cloudflare verification.
- [ ] Record/export/review the final 5–10 minute video using genuine cloud footage.
- [ ] Owner supplies contact/team/attendee details and confirms eligibility/terms.
- [ ] Owner submits manually and retains the confirmation.

An official tagged release is optional for the contest; the reviewed submission
commit is the required reproducibility reference. Do not create a release just
to imply maturity that the validation does not support.

Official [competition](https://www.cloudflare.com/git-competition/) and
[terms](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf)
control. Both Workers and Artifacts are mandatory. Deadline: October 14, 2026,
23:59 PDT (October 15, 02:59 Detroit).
