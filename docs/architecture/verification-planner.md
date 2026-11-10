# Verification planner and identity

The current implementation is the strict identity/receipt foundation in
`src/verification.js`, not the completed impact-aware planner.

Every configured check is mandatory. An empty policy fails closed. A policy pins
its version, security-policy version, 1–100 named/versioned check definitions,
command argument arrays, tool versions, environment, inputs, external-state
contracts, authorized producer IDs, determinism and a bounded lifetime (up to
seven days). All fields enter verification identity. No similar-diff heuristic or
source-tree equivalence bypasses exact-candidate binding.

Successful deterministic receipts may be reused only for an identical identity
while unexpired. Environment-dependent checks explicitly rerun when asked for
reuse. Latest matching execution governs; a later failure blocks an older pass.
Failures win ties at the same execution completion timestamp. Reasons are returned
per check, including absent matching identity, expiry, latest failure and required
rerun. This pure evaluator is not yet a durable execution cache or dispatcher.

Receipt creation validates exact execution metadata and trusted service principal;
original output is stored separately by the broker. Record and expiry times use
service/operator clocks, so deployed workers need monitored clock synchronization.
Authorization and service trust establish provenance; the SHA-256 digest alone
cannot establish trustworthy execution. See `evidence-bound-promotion.md`.

Still required: repository dependency/coverage impact models, conservative tier
selection with always-run requirements, real Kujo output adapters, trusted failure
history, durable deduplicated scheduling, supersession/cancellation, and execution
receipts produced by isolated workers. Until those exist, all declared checks run;
unknown impact cannot reduce required verification. Production, cache-efficiency
and isolated-staging claims remain unproven.
