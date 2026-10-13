# Local browser QA — 2026-10-13

The in-app browser became available after the earlier HTTP-only checks. This
review uses the three-client rehearsal fixture with the current Source server,
locally on loopback. No live Cloudflare service was used.

## Fixed and verified

- Closed Work was counted as open because the dashboard filtered nonexistent
  completed/cancelled states. All three closed fixture items now yield zero open
  Work. The all-Changes metric is labeled "Recorded proposals".
- Grid minimum sizes, long hashes and navigation caused narrow-page overflow.
  Grid children can now shrink, navigation wraps, branch controls stack on narrow
  screens, and code/tables scroll within their own panels. The stylesheet URL
  changed to invalidate the prior one-hour cached asset.
- Repository sections used display:grid, overriding native hidden behavior.
  An explicit hidden rule now makes Contents and History mutually exclusive.

## Observations

The desktop dashboard renders the correct zero-open count and five recorded
proposals. At a 390 × 844 viewport, project, Change and repository pages have
375px client width and 375px scroll width (the scrollbar occupies 15px). The file
page measures 390/390px without a vertical scrollbar. Before the fix, the Change
page measured 375/478px and overflowed horizontally.

Contents shows Files while hiding Recent commits; History reverses visibility.
The branch selector switches main → agent-theme → main and updates the displayed
tip and file links. Canonical settings.json contains dark theme and pageSize 20;
the README renders its heading and evidence/review requirement. Work W1 displays
closed status and its Change link; the Actions empty state and forms load.
The browser captured no console errors. The temporary viewport was reset.

Node 22.23.3: the authenticated web UI integration test passes; syntax lint checks
76 JavaScript files; git diff --check passes. Earlier full-suite/PostgreSQL results
remain dated evidence in VALIDATION.md, not claims of a new full-suite run.

This is bounded local browser QA, not cross-browser certification, accessibility
certification, a real container run, or live cloud validation. Recording at the
final video resolution still requires a framing check.
