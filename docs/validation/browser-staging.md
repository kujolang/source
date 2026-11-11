# Actual Source browser staging

On 2026-11-10 local time, `9648ffa` demonstrated a browser staging check inside
the actual private Source development lifecycle. This advances single-service
isolated staging; it is not multi-service deployment, remote-provider validation,
full Lens CLI certification, accessibility certification or production readiness.

## What ran

The operator image contains committed Source dependency manifests, the committed
Lens browser bridge at `91049646d70c11bf0c6071f39cf7dfac6b1ba70b`, its npm integrity
lock and the fixed operator check `/opt/source-browser-staging.mjs`. No proposed
Dockerfile or install lifecycle script runs during the build. The build has
network access; the resulting immutable image is:

`sha256:18c7ae155770d3d895ad79dc8b278d2019b80c07d1d84c551e5614bc5642feba`.

Its report records the base digest, complete image ID, source/bridge/checker hashes
and tool manifest: Node 26.13.0, Git 2.39.5, Debian 12.15, Playwright 1.61.1,
Lens bridge 1.1.1 and Chromium 149.0.7827.55. OS packages/browser installation
resolve during the build; this pins a result, not byte-identical future builds.

The existing executor exports exact Git objects and runs the trusted image check
with no external network, published ports, host credentials, Docker socket or
host dependencies. Existing non-root UID, read-only root, dropped capabilities,
no-new-privileges, CPU/memory/PID/time/output limits and ownership-journal cleanup
remain enforced. Chromium uses Playwright's launch defaults; the OCI boundary is
the isolation boundary, not a claim of an additional Chromium sandbox.

The check imports the actual candidate's Source/API modules, creates disposable
private JSON-backed application state and starts it on container loopback. It:

1. Checks `/healthz` and anonymous private-page rejection.
2. Uses the real Lens bridge to render `/login` at desktop 1440×900 and mobile
   390×844, collecting bounded DOM/console/network evidence and PNG screenshots.
3. Asserts the expected heading, main content, no page-wide horizontal overflow,
   no failed render requests or console errors, complete capture and context cleanup.
4. Uses Lens selector inspection before filling the rendered login form, signs in
   with a random disposable human password, and confirms the private project page.
5. Closes the browser/server and removes the application state. It reports
   screenshot bytes and hashes in the original execution artifact so workspace
   deletion cannot discard them.

The image-owned check cannot be replaced by changing the similarly named file in
the candidate. The candidate application remains untrusted code confined inside
OCI. The service producer attests execution; artifact hashes prove integrity,
not cryptographic execution authenticity. No real user credentials are supplied.

## Lifecycle and adversarial evidence

The real CLI imported Source at `debe983`, submitted `9648ffa`, and assembled
candidate `c5272e58fb50950a49735a7db788811062d99558`, tree
`9b4b86ce5fd6f7ba62cb9cb0e3e9d6440ba3b2ac`. A separate PostgreSQL CLI worker ran
all four required checks in OCI:

| Check | Result | Executor elapsed |
|---|---|---:|
| Preflight | Syntax checked 121 JS files in that candidate | 9,244 ms |
| Runtime | 43 passed; nested live-Docker case excluded | 4,770 ms |
| Git/API | 36 passed; PostgreSQL-only case skipped inside OCI | 19,815 ms |
| Browser staging | Desktop/mobile render and authenticated project | 6,691 ms |

The complete lifecycle and restore took 75.073 seconds. These are one fixture's
timings, not capacity or latency guarantees. Browser staging has
`deterministic: false`; redispatch requires new execution rather than evidence
reuse. This mode deliberately does not redispatch merely to demonstrate reuse.

All four exact-candidate receipts gated acceptance/promotion. A fresh
authenticated clone matched the promoted candidate. After quiescing the original
instance, backup/restore took the original path offline and a fresh process
verified relocated Git, policy/acceptance/outcome, four receipts and original
artifact hashes, completed jobs, private clone authorization and repeat promotion.
This includes the screenshot-bearing artifact. Successful disposable state and
backup payloads were removed.

The separate live regression in `200558d` imports actual Source objects and makes
a real Git proposal with a deliberately broken login heading. The same OCI
browser check fails. Genuine passing execution from the good candidate cannot
be recorded against the bad candidate; the bad candidate cannot be accepted or
promoted and canonical Git stays unchanged. The good candidate then lands.
The test also proves browser evidence is not reusable and workspaces are empty.
Its original failing output is retained in the regression report. The test passed
with no skips; syntax lint subsequently checked 123 JS/MJS files and whitespace
checks passed. This test uses a separate JSON-store broker fixture; the full
development lifecycle above uses PostgreSQL.

Evidence:

- [Image manifest](browser/source-browser-image.json)
- [Original lifecycle and restore report](browser/source-browser-lifecycle.json)
- [Actual UI regression, receipts and failing output](browser/source-browser-negative.json)
- [Desktop screenshot](browser/desktop.png) and [mobile screenshot](browser/mobile.png)

Both screenshots were visually inspected: login controls and text are readable;
mobile content continues below the viewport. The bridge reports a wide code
element inside the mobile code block, while the page width remains 390 pixels.
This check tests page-wide overflow, not the full Lens finding rules or pixel
baseline comparison. No claim is made that the full Lens CLI report would pass.

## Reproduction

Keep a trusted Lens checkout at the recorded commit in the sibling `lens/`
directory. Untracked sibling files are excluded from the image context.

```sh
node scripts/build-self-verification-image.js 9648ffa --browser > /absolute/browser-image.json
SOURCE_TEST_DATABASE_URL='<disposable PostgreSQL DSN>' \
  node scripts/real-project-lifecycle.js debe983 9648ffa \
  /absolute/browser-image.json /absolute/new-report.json --browser-staging --restore
SOURCE_TEST_BROWSER_IMAGE_REPORT=/absolute/browser-image.json \
  node --test tests/browser-staging-live.test.js
```

On this macOS host the build needs Docker's credential helper on PATH
(`/Applications/Docker.app/Contents/Resources/bin`), and the lifecycle uses
`PATH="/usr/bin:$PATH"` to select working Apple Git. Do not edit tested files
during a live run. Use disposable databases with create/drop permission for the
restore. Keep failed execution journals until explicit ownership-based recovery.

Still open: full Lens CLI/Kujo integration inside OCI, accessibility/visual
baselines, broader management/review journeys, multiple isolated services,
external/provider contracts and credentials, deployed failover/recovery/load,
Workcell host compatibility and the remaining migration gates.
