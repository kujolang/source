# Verification planner and identity

`src/verification.js` binds receipts to an exact candidate and the entire active
policy. A policy pins its version, security-policy version, 1–100 named/versioned
checks, command argument arrays, tool versions, environment, inputs, external
state, authorized producers, determinism and a bounded lifetime (up to seven
days). An empty policy fails closed. No similar-diff heuristic bypasses identity.

## Conservative applicability

Checks are mandatory by default. Only `optionalByImpact: true` checks in tiers 1
(targeted) and 3 (release) may be omitted. Tier 0 preflight and tier 2 combined
integration always run. Policies without explicit preflight and integration tiers
run every check. Existing policies retain their previous all-required behavior.

An operator may supply `impact: {version: "1", complete: true, coverage: [...],
dependencies: [{from, to}], sensitivePaths: [...], failurePaths: [...]}`. Paths are
literal prefixes, not globs; trailing slashes delimit directories. `from` depends
on `to`. The complete affected set includes both sides of renames and transitive
consumers. Cycles terminate. This is an operator assertion of dependency and
coverage completeness, not automatically inferred test coverage.

Missing/invalid inventories, unknown paths, incomplete models, absent check
applicability, and security/API/schema/dependency/generated/deployment paths
select conservatively. Sensitive or historically failing transitive consumers
also require the full suite. `impact.release: true` selects every check. Failure
paths are operator-trusted input; the service does not learn from untrusted logs.
A selected check reports why it runs; an omitted check reports its applicability
exclusion. The whole impact model participates in policy identity.

Example optional check: `{id: "ui", tier: 1, optionalByImpact: true,
paths: ["src/ui/"]}` plus all standard check identity and execution fields. Do not
mark a check optional merely to improve benchmark results.

## Tool artifact contracts

`src/integrations/control-tools.js` provides strict, source-inspected adapters.
A required check can set `adapter` to a gate-capable tool below. Passing receipts
must supply its original JSON output, satisfy the tool result contract, and still
satisfy independent trusted-service and exact-execution metadata checks. Workcell
also must identify the candidate commit inside its receipt. Failed executions
retain arbitrary original output, including crashes before JSON is produced.
Malformed or contradictory passing submissions are rejected before persistence.

| Tool | Inspected revision and contract | Classification |
| --- | --- | --- |
| ChangeBucket | `030eea6`, `src/analyze.kujo`, unversioned/v1 and v2 JSON | An explicitly checked, passing footprint budget |
| Fence | `d317304`, `src/reports.kujo`, schema 1 | Passed boundaries, no errors or skipped files |
| Concord | `f8812e7`, `src/reporter.kujo`, tool version 1.x | No reported artifact drift |
| Eval | `c1b263a`, `main.kujo` make_summary_payload | PASS summary, consistent counts, executed passes, no failures |
| ShipCheck | `7eedd9e`, `src/report.kujo`, tool version 1.x | Passing release gate and required error checks |
| Spec | `36da0d7`, `scripts/commands/maintenance.sh`, schema 1.0.0 | Context only; acceptance contract, not proof of satisfaction |
| RunLedger | `ab0ec5d`, `src/record.kujo` | Context only; run status is not test proof |
| CaseFile | `92e1d9b`, `casefile.kujo`, version 1.x | Context only; capture success is not captured-command success |
| Lens | `9104964`, `src/report.kujo`, schema string `1` | Configured checks only; visual/a11y disabled states remain explicit |
| Workcell | `189d7ab`, `src/receipts/receipt.kujo` and `v2.kujo` | v1/v2alpha1 completed, verified, terminal, untruncated lifecycle |

Source paths in this table are relative to each sibling tool repository. These
are compatibility observations at the listed revisions, not claims of future
version support. Context-only descriptors can use the existing `ingestEvidence`
application method with the original artifact; they cannot be configured as
passing broker checks. Existing legacy evidence adapters remain unchanged.

Adapters classify reports, not execution authenticity. A compromised authorized
producer can still lie. Artifact SHA-256 establishes integrity, not trustworthy
execution. Pin tool binaries/images and isolate the producer. The Workcell
adapter does not provision a container or establish that its security controls
satisfy a deployment policy. That execution integration remains required.

## Reuse and validation

Successful deterministic receipts may be reused only for an identical identity
while unexpired. Environment-dependent checks explicitly rerun when asked for
reuse. Latest matching execution governs; later failures block older passes and
failures win tied completion timestamps. Reasons include missing identity,
expiry, latest failure and required rerun. This evaluator is not yet a durable
execution cache or dispatcher.

Record/expiry times use service/operator clocks, so workers need monitored clock
synchronization. Original output is retained content-addressed and checked on
read. See `evidence-bound-promotion.md` for authorization and acceptance.

Run `node --test tests/impact-planner.test.js tests/control-tools.test.js
tests/verification.test.js tests/integration-broker.test.js`. Contract tests use
minimal source-grounded reports, not execution of all ten tools. A captured Lens
report from its hardening evaluation was also parsed successfully with disabled
visual comparison/accessibility preserved. Real end-to-end tool execution,
durable scheduling, supersession/cancellation and isolated staging remain open.
