# Seven-minute recording plan

Status: script only. Final recording waits for mandatory live Workers/Artifacts
integration. A local rehearsal may use the first and middle sections but must
retain the scripted/local labels. Do not splice a mock cloud success into footage.

| Time | Screen / action | Narration intent |
| --- | --- | --- |
| 0:00–0:35 | Source title, clean project dashboard | Git preserves commits; Source connects intent, sessions, evidence and decisions. State what the demo will prove. |
| 0:35–1:15 | Three Work items, scoped capabilities, session/context view | Each client owns a bounded task. Identify the clients as scripted unless replaced by genuine agents. Explain that proposing does not grant approval. |
| 1:15–2:00 | Run `npm run demo:contest`, show report client times and proposals | Show three overlapping execution intervals, separate commits and successful submission. Show the three 403 approval denials. Do not equate a report with production capacity. |
| 2:00–3:10 | Original proposals and first accepted Change | Open executed test/evaluation artifacts and policy result. Show the scripted maintainer decision and canonical commit. Explain that review in this fixture is automated. |
| 3:10–4:20 | Original stale proposals and revised Changes | Show both stale rejections; distinguish independent rebase from the real same-line Git conflict. Show replacement Change, fresh evidence and final dark/20 settings with the docs preserved. |
| 4:20–5:30 | **Blocked: deployed Worker and real Artifacts repository** | Once deployed and verified, demonstrate authenticated creation, actual remote push/independent clone, then the integrated Source workflow. Show non-secret URLs and commit IDs. Explain precisely which runtime runs where. Do not record this section as complete yet. |
| 5:30–6:25 | Human UI evidence/review/repository views; MIT license and runbook | Show how a reviewer traces the result back to intent and evidence. Show how another person reproduces the exact commit from a public clone. |
| 6:25–7:00 | Honest status and roadmap | State validated scope, remaining production work and what makes the approach useful for collaboration. End on the public repository link. |

## Recording checks

- Freeze a reviewed commit and keep the video, runbook and evidence on that version.
- Rehearse once from a clean checkout; use disposable data and fresh credentials.
- Check UI visually at the intended recording resolution; HTTP smoke is insufficient.
- Keep the report and Git commit IDs readable; keep private credentials off screen.
- Replace this timing with actual recorded timings only after editing.
- Export MP4/WebM/MOV, verify duration 300–600 seconds, size <=2 GiB,
  intelligible audio and playback from beginning to end.
- Retain original evidence/footage. Upload the final video and submit manually.

## Narration draft

Read naturally and leave room for the screen actions above. This is approximately
seven minutes with demonstrations and pauses, not a measured final runtime.
The Cloudflare segment below is explicitly a **current-status rehearsal**; final
entry footage must replace it with verified live behavior before submission.

### 0:00–0:35 — Intent becomes reviewable work

“Git gives us a durable history of code. When several agents contribute at once,
we also need to know what each one was asked to do, what it checked, and who
allowed the result to become the shared version. Source connects those records.
In this demonstration, we will follow work from a task to a proposed commit,
inspect its evidence, and see what happens when another change lands first.”

### 0:35–1:15 — Bounded contributors

“This project has three tasks: enable a dark theme, improve the documentation,
and increase the page size. Three separate clients work on them concurrently.
These clients are scripted. They demonstrate the collaboration protocol; they
are not a demonstration of a language model deciding what to build.

“Each client receives a scoped Source capability. It can obtain its context,
create its proposal and supply evidence. That capability does not let it approve
its own work. The session records which task the contributor claimed and the
source state it started from.”

Pause on the task/session view. Keep credential values off screen.

### 1:15–2:00 — Actual concurrent proposals

“Here is the repeatable rehearsal. The three clients run in separate processes,
and these start and end times show that their work overlaps. Each client makes
real Git commits and submits a Change linked to its Work and Session.

“Each also attempts an approval that its credentials do not authorize. All three
requests are denied. That is an observable boundary in this fixture, not just a
button hidden in the interface. These timings demonstrate overlap on this machine;
they are not a production capacity benchmark.”

Pause on the report's execution intervals and approval-denial results.

### 2:00–3:10 — Evidence and a decision

“Now we can inspect the first proposal. Its evidence includes checks that actually
ran against the proposed source. The policy evaluation shows which requirements
have been met. Evidence, policy evaluation and approval are separate records.
A passing check does not give the contributor authority to accept its own Change.

“The rehearsal now acts as the maintainer and records an acceptance. This approval
is scripted so that another person can reproduce the flow. In normal use, the
human review interface lets a maintainer examine the work and make that decision.

“Acceptance makes the Change eligible for canonical promotion. Source still checks
the Git relationship before moving the shared branch. The proposed commit must
fit the current history. The resulting canonical commit is recorded alongside
the decision and evidence, so we can trace the outcome back to the original task.”

Show the actual evidence artifact and commit, not only a passing summary badge.

### 3:10–4:20 — Stale results and conflict recovery

“The remaining proposals were made against the earlier version. We retain them
so that the original attempt stays inspectable. A stale proposal cannot simply
replace the canonical tip.

“The documentation change can be rebased independently. The page-size change is
different: it edits the same settings line as the theme change. Git reports an
actual unmerged path. The scripted client resolves that conflict, produces a new
commit, runs fresh checks and submits a revised Change.

“The reviewed revision now preserves both intended settings: dark theme and a
page size of twenty. The documentation remains present too. We have a final code
state, but we also have the path that led to it: the stale attempt, the revision,
its new evidence and the later decision. Source makes that history available for
review instead of treating the last passing result as the whole story.”

### 4:20–5:30 — Hybrid boundary: current-status rehearsal

“The implemented hybrid path keeps Source's application and review lifecycle in
Node. A Cloudflare Worker is the operator endpoint for creating Artifacts
repositories and obtaining short-lived Git credentials. The accepted-change
bridge publishes to Artifacts with an expected remote tip, then confirms the
commit before updating the local cache and closing the Work.

“The local contract rehearsal shown here executes Source, the Worker handlers
and real Git. Its Artifacts binding and remote service are emulated. It proves
our local integration behavior, including recovery when a push succeeds but its
acknowledgement is lost. It does not prove that Cloudflare is deployed or working
for this account. That live verification remains deferred.

“The operator retains the Artifacts write credentials. Contributors use Source's
staging branches and scoped permissions. A direct push to the local canonical
branch is rejected; accepted changes use the controlled promotion path.”

**Final-entry replacement shot requirements:** show the deployed Worker, a real
Artifacts repository, accepted Source promotion, and an independent remote clone
with matching commit/content. Narrate the exact observed URLs, source commit and
results. Remove the emulation narration only when those shots are genuinely
recorded and the combined cloud collaboration flow has been verified. Do not
claim an automated approval is a human review or a local endpoint is Cloudflare.

### 5:30–6:25 — A reviewer can reproduce the result

“The human interface brings these records together. Starting from a Work item,
a reviewer can inspect its Changes, evidence and decisions, then open the
repository state that resulted. The goal is to make a multi-contributor outcome
understandable without reconstructing it from scattered terminal sessions.

“Source uses the MIT license, and the runbook describes the repeatable local
rehearsals and their limits. The final entry will identify one reviewed source
commit so that the code, evidence and video refer to the same version. Public
availability and an anonymous clean-clone run still need verification before
that entry is submitted.”

For the final recording, replace the last two sentences with the exact published
commit and demonstrated anonymous-clone result, only after verification.

### 6:25–7:00 — Honest next steps

“Source is an early implementation with repeatable local checks. Production use
needs more evidence: the actual deployment's capacity, independent security
review and operational recovery drills. Those are separate from this local demo.

“The useful result today is a reviewable collaboration flow around Git: bounded
contributors, explicit evidence, permitted decisions and canonical updates that
respect concurrent work. The repository and runbook show how to reproduce the
verified behavior and which steps still require live infrastructure.”
