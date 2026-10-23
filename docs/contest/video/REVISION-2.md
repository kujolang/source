# Source in action — revision 2

Requested changes: fill the media stage, show Source being used, and edit the narration with orwell-writing. The six-chapter cut is 192.708333 seconds, with Siren eleven_v4 narration and captions.

The app viewport fills its stage edge to edge without a fixed-height contain box. Three actual browser recordings show creating/claiming/starting Work, evaluating and inspecting evidence, and browsing Git history/diff/final settings. They are sequences of captured browser frames taken during actual interactions. Long gaps are shortened; playback is slowed to narration. This is edited footage, not a continuous real-time recording. Original capture timestamps and frame ranges remain in assets/action-capture/*.json.

The two terminal scenes replay stdout from a successful fresh execution of `node scripts/contest/demo.js --trace`, preserving line order and wording while adding reading time. It is a separate local run from the browser footage; IDs can differ. Browser Work W4 is a separate UI example and is not claimed to have completed. The three-client rehearsal uses scripted clients and scripted maintainer approvals, with actual Git operations, permission denials, checks, stale-update rejection, and conflict recovery.

No Cloudflare deployment was performed. Live Workers/Artifacts verification remains deferred. The ending states this explicitly.

Rebuild: generate_voice_v2.py caches Siren/v4 takes by transcript hash. build_v2.py creates the editable six-chapter HyperFrames project and captions. master_v2.py assembles the narration at timeline offsets and normalizes delivery audio. Retain the original v1 archive as historical output.

Verification: 18 timeline samples, 23 contrast checks, no lint/runtime/layout/contrast findings. Six scene snapshots visually inspected, including 10 seconds. Audio has not received a human listening review.

Export note: HyperFrames composition checks passed. Its full renderer stopped at
the disk-space preflight as free storage fluctuated. Final delivery uses
export_streaming.py: verified HyperFrames layout captures, recorded browser
video overlaid at the same full-width stage bounds, progressive reveal of the
captured stdout, ASS captions, and the mastered narration. It streams FFmpeg
encodes without a large extracted-frame cache. The decorative timeline progress
bar is static in this delivery. No app UI content was synthesized or altered.

The Cloudflare demo node_modules directory was removed to recover 200 MB. It is
reinstallable with `npm ci --prefix cloudflare/artifacts-bootstrap`; tracked source,
lockfiles and prior deliverables were preserved. This is not a runtime dependency
change. Local recording server stopped and browser signed out.

Final export: 192.71 seconds; 1080p 5,244,152 bytes; 720p 2,456,613 bytes. Both full decode and nine exported-frame checks passed. Master audio measured -17.26 LUFS and -0.99 dBTP. Exact hashes are in delivery-v2.json. The final contest runtime remains open.
