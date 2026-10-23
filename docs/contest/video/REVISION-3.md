# Source in action — revision 3

This 353.958333-second cut retains five local action chapters and adds four
live-cloud chapters and a new conclusion. Siren eleven_v4 narration and aligned
captions are preserved. App recordings fill their 1536×865 stage.

## Evidence and limits

Cloud footage comes from clean implementation 10482dd7029406681a72dab067efd6f86c72e230,
repository source-hybrid-run-mbos1u-17e96e99. Independent clone confirmed cloud
commit 01ebfe8c6c5d550faa87fe67410c63974e42eade, dark theme, page size 20 and review
docs. See ../cloudflare-live-lifecycle.json and ../CLOUDFLARE_LIVE.md. Three scripted
client processes overlap, all self-approvals return 403, stale proposals are
rejected, revised proposals pass checks, and all three Work items close.
A deliberate exception after the real push tests lost-acknowledgment recovery:
retry confirms the remote and closes Work without a second push.

Terminal scenes replay actual stdout with reading pauses. UI footage consists of
frames captured during real browser clicks and scrolls, with edited pacing; it
is not continuous real-time recording. Cloud UI and stdout use the same run;
earlier local sections are separate examples. Source and JSON state are local;
Cloudflare hosts the Worker and canonical Git. Approval is scripted. This is
bounded prototype proof, not production certification or a live test of
simultaneous remote writers racing the Git lease.

A separate PostgreSQL job-claim race found in hosted CI is fixed at
2184ece2b3b72a7eec0f352d4be84b1f73717b42: recheck mutable eligibility on the lock
target. The old query fails the new regression (153 leases for 100 jobs). The fix
passes 12 race rounds and the local 5,000-request fleet gate. Hosted
[CI run 38449005437](https://github.com/kujolang/source/actions/runs/38449005437)
passes both jobs, including PostgreSQL and container failover. This is the
reviewed implementation checkpoint; later delivery docs do not alter behavior.
The live recording's capture commit remains separately pinned above.

## Production and verification

HyperFrames 0.8.152 composition checks pass: ten timeline samples, 27 contrast
checks, no lint, runtime, layout or motion findings. No motion assertion sidecars
were present. All 28 cloud layout snapshots were inspected. An attempted upgrade
to 0.8.153 timed out during baseline runtime checks, so the pin remains 0.8.152.

The native full render was deliberately canceled at frame 377/8495 after capture
ran at about 3 fps. Delivery uses streaming FFmpeg assembly: verified HyperFrames
layouts, actual browser clips, progressive stdout reveals, ASS captions and
mastered narration. The decorative progress bar is static in this delivery;
the editable project retains its animated bar. This is not represented as a
completed native HyperFrames render.

Final export QA caught and corrected shortened still-image chapters and a
cloud capture selection that omitted the evidence/decision views. Every chapter
now has its exact authored frame count; cloud UI cuts follow the voice alignment.
Exact export checks and checksums are in delivery-v3.json. No human listening
review is claimed. The owner should review pacing/pronunciation and submit
manually. No release, upload, subscription cancellation or cloud fixture deletion
was performed.
