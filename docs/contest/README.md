# Source competition checklist

Updated 2026-10-12. Local preparation is usable; **the contest submission is not
ready** until the mandatory live Cloudflare integration and owner steps are done.
Workers/Artifacts account setup was deferred by the owner.

## Completed local preparation

- [x] Establish the repository baseline, license and release status: private,
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

## Pending account, environment and owner gates

- [ ] Owner enables paid Workers/Artifacts; deploy and verify actual remote
  create/push/independent clone. Then finish the Source/Artifacts hybrid lifecycle.
- [ ] Re-run the collaboration flow against the actual cloud integration and
  preserve non-secret deployment/evidence/commit identifiers.
- [ ] Restore GitHub Actions billing/spending availability and get remote checks
  green; the workflow changes alone do not restore the account.
- [ ] Verify the default 256-request database burst and deployment cold-connect
  capacity; local 5,000-participant validation passed only at HTTP concurrency 64.
- [ ] Run a real container build and two-container failover with a Docker daemon.
- [ ] Complete visual browser QA (browser control was unavailable here).
- [ ] Owner reviews public exposure, chooses the final entry commit, publishes
  the repository, and verifies anonymous clone/run. Do not publish runtime data.
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
