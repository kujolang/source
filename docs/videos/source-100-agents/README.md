# Source 0.2.0 — 100 contributors, one shared file

A 56-second HyperFrames film built from a real-time local browser recording, narrated with ElevenLabs v4 Siren. The browser displays actual benchmark events and Git diffs. It is labeled as a test console, not presented as Source's product UI.

## What this run proves

100 independent scripted Node processes reached the same start barrier, cloned one repository, and changed separate sections of `shared.txt`. They submitted through real HTTP/Git using private capabilities and submission keys. Source assembled one candidate, rejected acceptance without verification, ran one PostgreSQL-backed verification job, and promoted exactly that commit. Every contributor head remains an ancestor. The checker found all 100 exact contributions and unchanged surrounding context. The final tree matches the sequential-merge baseline.

The successful run lasted 240.318 seconds, including the baseline and cleanup. This is a controlled local Git-content fixture, not 100 LLM sessions, same-line conflict resolution, application CI, or production capacity certification. The private-load profile explicitly allows 1000 pushes/submissions per minute per shared address.

The first recorded attempt failed during submission with ECONNRESET and two server ERR_HTTP_REQUEST_TIMEOUT observations. Its report and event log remain in `evidence/attempt-1`. The first recorder encoded a Retina 3840×2160 stream. The retry recorded at 960×540/10fps after reducing capture overhead; Source server deadlines and concurrency were unchanged. Capture overhead is a plausible contributor, not an isolated causal proof. The successful take is upscaled into the 1920×1080/30fps delivery.

## Evidence and edit

- `evidence/run.json`: successful run, checker/harness hashes, resource measurements and assertions.
- `evidence/events.jsonl`: real event times, contributor commits and Git diffs; no credentials.
- `evidence/recording.json`: recorder provenance. Its wall duration includes encoder drain; the source recording is 246.9 seconds.
- `evidence/edit-map.json`: exact source cut windows. The source screen recording has a small initial timestamp offset; cuts were checked against decoded footage, not event times alone.
- `evidence/narration.json` and alignment files: exact voice model, voice ID, generation-time tier, hashes and timing.
- `TRANSCRIPT.md`, `SPEC.md`, `STORYLINES.md`, `REVIEW.md`: editorial source and review.
- `assets/raw-run.mp4`, original WebM and `assets/attempt-1.webm`: local source recordings.
- `renders/source-0.2.0-100-agents-branded.mp4`: final local delivery.

The successful raw MP4, derived shot MP4s, master audio and editable source are committed. Original WebMs, voice stems and delivery exports remain local caches; see the media manifest for exact hashes. At the user’s request for a phone download, the branded 480p copy (854×480) is now attached to the v0.2.0 release: [download MP4](https://github.com/kujolang/source/releases/download/v0.2.0/source-0.2.0-100-agents-branded-480p.mp4). The 1080p master remains local.

## Reproduce

Use a disposable PostgreSQL database and the supported Node runtime. On this Mac, `/usr/bin/git` is the working Git HTTP client. The original run used the product at 022d303 plus the benchmark extension committed in 08b20ee; the report's harness SHA binds the exact harness.

```sh
PATH="/usr/bin:$PATH" SOURCE_TEST_DATABASE_URL='postgresql:///YOUR_DISPOSABLE_DATABASE?host=/tmp' \
  node scripts/benchmarks/integration.js --agents 100 --repos 1 --profile private-load \
  --same-file --keyed-submissions --progress --output /absolute/new-report.json
```

`record.mjs` documents the local Chrome/Puppeteer recording setup; adapt its executable/module paths and disposable database name. Never rerun into existing evidence or overwrite a successful take. It records actual events as they happen. Each agent edits its isolated clone; there is no shared working-tree race.

From this video directory, `python3 scripts/build.py` rebuilds the edit from local media. `scripts/voice.py` generates missing authorized takes only, refuses uncertain retries, and requires the successful report. `npx hyperframes check --json`, `snapshot --review`, `preview --background`, and `render --quality delivery --output renders/source-0.2.0-100-agents-branded.mp4` validate, preview and render. Audio was measured, not auditioned by the agent.

## Branding and timing interpretation

The current title cards use the exact Departure Mono regular font and SVG mark from kujolang.ai. Source assets and hashes are in `evidence/brand-assets.json`; branded render verification is in `evidence/brand-delivery.json`. Previous exports and their verification evidence remain available for provenance. Audio and real run footage are unchanged.

The measured start barrier through promotion and retention assertions took 156.602s. The 240.318s harness total also includes setup, a separate sequential-merge baseline and cleanup. Source ran one combined checker (0.466s execution) versus 100 checker invocations (43.880s execution) in that baseline: 99 checks avoided. Source assembly took 44.282s versus 16.610s for baseline merges, so checker savings alone must not be advertised as a whole-workflow speedup. The serial baseline reused already-created proposals; it did not repeat cloning, editing, authenticated submission and promotion one agent at a time. At the time of this recording, a full serial-agent comparison was unmeasured. A subsequent matched, unrecorded 100-contributor comparison passed at 696.281s serial versus 126.034s concurrent (5.52×); see [results and limits](../../validation/benchmarks/serial-comparison/README.md). This combines concurrency and batching and does not change the original video timing.

Independent task execution can reduce waiting when tasks can overlap, especially with expensive checks. Source additionally retains contributor identity/history, checks the combined result, and binds promotion to exact verified evidence. Conflicts, dependencies and resource contention limit parallel gains. The tiny scripted edits in this demonstration are chiefly evidence of concurrency and retention, not real coding productivity.
