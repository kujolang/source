# Submission draft — owner review required

This is preparation, not a submitted entry. Do not submit until every required
item in the checklist is complete. Never describe a planned integration as live.

## Project name

Source

## Vision / project description

Source makes software work inspectable around Git. A change is linked to the work
that requested it, the agent session that produced it, executable evidence, and an
explicit review decision before it becomes canonical. Agents receive bounded
capabilities, so proposing a change is separate from approving one.

The local demonstration runs three scripted clients concurrently. Independent
work and conflicting edits create real commits and proposals. It preserves stale
proposals, rejects stale canonical promotion, requests revisions, regenerates
evidence after rebase/conflict recovery, and retains the decision trail. A human
UI exposes work, Changes, evidence and the resulting repository state.

## Cloudflare usage — current truthful status

The proposed hybrid design places the edge/bootstrap API on Cloudflare Workers
and repository hosting on Cloudflare Artifacts; Node/Postgres retains Source's
application and review/evidence lifecycle. An authenticated repository-creation
Worker and a Git create/push/clone smoke command are implemented and locally
checked. Live deployment is currently blocked by the account's paid-plan
requirement. The integrated Source-to-Artifacts lifecycle has not been verified.

**Before entry:** replace this paragraph only with the exact deployed topology,
verified URLs and successful remote behavior. Until then this mandatory criterion
is unfinished and the project is not ready to submit.

## Repository and run instructions

Repository: https://github.com/kujolang/source (currently private).

Implementation branch: `feat/cloudflare-artifacts-bootstrap`.

Run instructions: [RUNBOOK.md](RUNBOOK.md). Pin the actual reviewed submission
commit before recording, and update these references after merge/publication.
The project uses MIT; third-party license notices accompany vendored assets.
No official GitHub release was present when checked on 2026-10-12.

## Video

Pending. Record 5–10 minutes, MP4/WebM/MOV, no more than 2 GiB. Use the
[recording script](VIDEO_SCRIPT.md), replacing blocked sections with genuine
completed behavior. Do not show tokens, account configuration or operator.json.

## Owner-supplied form details

- Team name: [owner to enter]
- Contact name and email: [owner to enter]
- Location and eligibility confirmations: [owner to review against official terms]
- First attendee details: [owner to enter]
- Optional second attendee: [owner to enter or leave blank]
- Final confirmations, consent and manual submission: [owner]

Official [competition page](https://www.cloudflare.com/git-competition/),
[terms](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf),
and [submission form](https://www.cloudflare.com/git-competition/submit/) govern.
Deadline: October 14, 2026 at 23:59 PDT (October 15 at 02:59 in Detroit).
Recheck the live form/terms before entry. The rules prohibit automated entries;
the owner must perform the final submission.
