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
- `renders/source-0.2.0-100-agents.mp4`: final local delivery.

The successful raw MP4, derived shot MP4s, master audio and editable source are committed. Original WebMs, voice stems and delivery exports remain local caches; see the media manifest for exact hashes. No video has been posted publicly or added to the GitHub release.

## Reproduce

Use a disposable PostgreSQL database and the supported Node runtime. On this Mac, `/usr/bin/git` is the working Git HTTP client. The original run used the product at 022d303 plus the benchmark extension committed in 08b20ee; the report's harness SHA binds the exact harness.

```sh
PATH="/usr/bin:$PATH" SOURCE_TEST_DATABASE_URL='postgresql:///YOUR_DISPOSABLE_DATABASE?host=/tmp' \
  node scripts/benchmarks/integration.js --agents 100 --repos 1 --profile private-load \
  --same-file --keyed-submissions --progress --output /absolute/new-report.json
```

`record.mjs` documents the local Chrome/Puppeteer recording setup; adapt its executable/module paths and disposable database name. Never rerun into existing evidence or overwrite a successful take. It records actual events as they happen. Each agent edits its isolated clone; there is no shared working-tree race.

From this video directory, `python3 scripts/build.py` rebuilds the edit from local media. `scripts/voice.py` generates missing authorized takes only, refuses uncertain retries, and requires the successful report. `npx hyperframes check --json`, `snapshot --review`, `preview --background`, and `render --quality delivery --output renders/source-0.2.0-100-agents.mp4` validate, preview and render. Audio was measured, not auditioned by the agent.
