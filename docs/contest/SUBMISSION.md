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

The hybrid implementation keeps Source's application, Git staging, review and
evidence lifecycle in Node, with Postgres available for hosted state. A Cloudflare
Worker creates Artifacts repositories and issues short-lived operator credentials.
Only an accepted Source Change enters canonical promotion: the bridge verifies
ancestry, pushes with an expected remote tip, confirms the result and updates the
local cache. An interrupted push leaves Work open until a retry confirms it.

The local contract rehearsal executes real Source, Worker handlers and Git while
emulating the Artifacts binding and remote service. It proves local integration
and recovery behavior; it does not prove a deployed Cloudflare integration.
Workers Paid is active. The deployed Worker has passed actual repository creation,
Git push and independent clone with matching commit/content ([live evidence](CLOUDFLARE_LIVE.md)).
The combined three-client Source review and promotion flow also passes live,
including stale proposals, conflict resolution and injected lost-acknowledgement
recovery. Source itself runs locally with a JSON store; Workers and canonical Git
are live on Cloudflare. See [architecture and runbook](HYBRID.md).

The linked report pins the tested source commit and cloud Git result. Owner
review and manual submission remain pending.

## Why this approach

Git is the durable source record. Source adds the context needed to decide whether
a proposed commit should become canonical: the task, the producing session, its
evidence and a permitted review decision. That distinction matters when several
contributors work at once and when a passing result becomes stale after another
change lands. The demo preserves both the stale attempt and the reviewed revision,
so a reviewer can inspect how the final state was reached.

The project is an early implementation with repeatable local evidence, not a
production-certified hosted platform. The live Cloudflare lifecycle is verified.
Further work includes deployment-scale capacity,
independent security review and operational recovery drills.

## Repository and run instructions

Repository: https://github.com/kujolang/source (public; PR #2 merged).

Implementation branch: `main`. Reviewed implementation:
`2184ece2b3b72a7eec0f352d4be84b1f73717b42` (green hosted CI).

Run instructions: [RUNBOOK.md](RUNBOOK.md). The live report separately identifies
the capture commit and remote Git result.
The project uses MIT; third-party license notices accompany vendored assets.
No official GitHub release was present when checked on 2026-10-12.

## Video

The [5:54 live-cloud action film](video/README.md) includes Siren/v4 narration,
recorded Source UI interactions, real command output and verified Workers/Artifacts
promotion and recovery. The 1080p and smaller mobile copies are delivered locally;
checksums, provenance and verification are in video/delivery-v3.json. Owner review
and upload to the form remain pending. Required format: 5–10 minutes,
MP4/WebM/MOV, no more than 2 GiB. No credentials appear in the film.

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
