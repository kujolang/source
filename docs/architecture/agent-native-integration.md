# Agent-native integration

## Increment 1: deterministic candidate assembly

Invariant: assembly creates a retained proposal commit and never changes a
canonical branch. Git merge success does not establish semantic safety.

`IntegrationPlanner` in `src/integration-planner.js` consumes a current base and
bounded proposal snapshots `{id, baseCommit, headCommit, dependsOn}`. It verifies
commit objects and ancestry, rejects stale bases, infers stacked dependencies,
and orders ready proposals deterministically. Missing/cyclic/rejected dependencies
block dependent proposals. Real `git merge-tree --write-tree` performs merges,
including rename/delete and binary conflicts. Compatible same-file edits remain
eligible. Merge commits retain every contributing head as ancestry and record
proposal IDs, bases, heads and dependencies in deterministic commit messages.

The result contains an immutable candidate identity/tree/head plus separate
rejection, conflict and risk reports. `refs/source/candidates/<id>` retains the
objects across interruptions and garbage collection. Repeating identical input
reconstructs the same candidate. Assembly is bounded to 100 proposals by default
(up to 1000 explicitly), 30-second Git commands and 8 MiB command output.

Operator-configured exclusive path prefixes conservatively separate shared
migration/generated domains. Dependency path groups flag different-file semantic
coupling. Every candidate requires preflight and combined integration verification;
these flags are requirements, not passing evidence. File overlap alone never
establishes compatibility or safety.

## Scope still required

This primitive is not yet an exposed/authorized integration service or a merge
broker. Source Change eligibility wiring, verification-failure splitting, durable
promotion receipts, protected refs, policy-bound evidence and workflow execution
remain subsequent increments. Transport must protect internal refs before this
primitive can be exposed to untrusted contributors. Existing legacy promotion is
not made safe by merely constructing a candidate.

## Reproduce

`node --test tests/integration-planner.test.js` uses real Git subprocesses and
ten concurrent clones/commits/pushes. Four tests pass: deterministic ten-agent
assembly with attribution, same-file compatibility/conflicts and binaries,
stacked dependencies/stale bases/cycles, and rename/delete plus shared dependency
risk. These are correctness fixtures, not production-capacity measurements.
