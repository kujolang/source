# Verification

Full render: HyperFrames 0.8.152, screenshot capture, hardware GPU, four-worker
streaming; all 8,371 frames rendered. The final H.264/AAC MP4 is 1920×1080,
24 fps, 348.791667 seconds. FFmpeg decoded the complete video/audio without
errors and found no >=0.5-second black intervals. Rendered contact sheet reviewed.
Composition checks passed: initial 24 timeline samples and 61 contrast checks;
master-audio update also passed. Motion sidecar assertions were not enabled.

Audio was mastered to a -16 LUFS / -1.5 dBTP target; decoded AAC measures
-16.11 LUFS and -1.23 dBTP (codec reconstruction), with no clipping. Captions
use provider timestamps; the original speech files and alignments are preserved.
The assistant could inspect frames and signal metrics but did not perform a
human listening audition. Review pronunciation and pacing before submission.

This is an explicitly labeled review cut. It contains no genuine deployed
Cloudflare footage because setup remains deferred. Replace the local-emulation
chapter with actual verified Workers/Artifacts evidence before contest entry.
