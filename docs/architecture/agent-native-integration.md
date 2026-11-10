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

## Scoped service access

`POST /api/v1/orgs/{org}/projects/{project}/repositories/{repo}/integration`
accepts `{ "changeIds": ["C1", "C2"] }` with a project-scoped
`plan_integration` capability. Work-only credentials cannot assemble unrelated
work. The service loads proposal heads from persisted Changes, reads the current
repository branch and operator policy, and persists an inspectable report with
scope and policy hash. It rejects multi-repository changes and Artifacts binding
until those coordination contracts are implemented. Project mutation uses the
existing async Postgres advisory-lock/transaction seam, with existing in-process
admission for local stores; Git command admission is shared with the HTTP server.

`GET` on the same path followed by `/{candidateId}` requires `read_context`.
Repeated planning yields the same candidate; audit records retain planning
outcomes including conflicts. Git smart HTTP rejects pushes to `refs/source/`
through Git's receive.hideRefs, preserving existing operator hooks. Candidate refs
are not a promotion API and must never be passed to the legacy canonical update
as a shortcut around verification.

Local operators can use the existing server data root with:

```sh
node bin/source.js integration plan --org O1 --project P1 --repo R1 --changes C1,C2
node bin/source.js integration show --org O1 --project P1 --repo R1 --candidate <id>
```

These commands manage the local server store like the existing administration
commands. Remote clients use the scoped HTTP interface. Opted-in repositories can now use the exact-candidate broker described in
`evidence-bound-promotion.md`; legacy repositories do not gain protection implicitly.

## Scope still required

The exact-candidate broker now provides explicit protection opt-in, service
receipts, maintainer acceptance, transactional Git promotion and lost-outcome
reconciliation. See `evidence-bound-promotion.md` for the offline configuration
requirement and tested boundary. Failed-batch splitting and conservative impact
selection are implemented below and in `verification-planner.md`. Isolated worker
execution, real PostgreSQL integration recovery, operator UI and complete mission
benchmarks remain outstanding. This is not production certification.

## Reproduce

`node --test tests/integration-planner.test.js` uses real Git subprocesses and
ten concurrent clones/commits/pushes. Planner tests cover: deterministic ten-agent
assembly with attribution, same-file compatibility/conflicts and binaries,
stacked dependencies/stale bases/cycles, and rename/delete plus shared dependency
risk. These are correctness fixtures, not production-capacity measurements.

`node --test tests/integration-api.test.js tests/git-http.test.js tests/artifacts.test.js`
checks project authorization, persisted proposal identity, repeat planning/readback,
canonical preservation and reserved-ref rejection alongside existing Artifacts
transport recovery. These fixtures test planning and transport; broker fixtures are documented in
`evidence-bound-promotion.md`. They do not establish a production gate.

## Increment validation — 2026-11-10

Planner (five tests), scoped API and CLI readback (one test), Git transport and
Artifacts regressions pass. Syntax lint checks 85 JavaScript files. The first
complete regression attempt hit host ENOSPC and is recorded as a failed run.
A subsequent isolated-per-file run of all 38 root test files passed 259 tests
with seven PostgreSQL-only skips; all six Worker tests also passed. Combined:
272 tests, 265 pass, seven skips, zero failures. The final CLI change was then
checked again through the API/CLI integration fixture (one pass).

To bound accumulated temporary fixture usage on a constrained host, run each
file with its own temporary directory and remove that directory after it exits:

```sh
for test_file in tests/*.test.js cloudflare/artifacts-bootstrap/worker.test.js; do
  source_test_tmp=$(mktemp -d) || exit 1
  TMPDIR="$source_test_tmp" node --test "$test_file"
  source_test_status=$?
  rm -rf "$source_test_tmp"
  [ "$source_test_status" -eq 0 ] || exit "$source_test_status"
done
```

The actual regression used the equivalent Python subprocess loop, collecting
all failures rather than stopping at the first. Test logs are local transient
files `/tmp/source-agent-native-isolated-regression.log` and
`/tmp/source-agent-native-worker.log`. No live Postgres, container, staging or
production claim follows from these results.

## Failed-batch splitting

`POST .../integration/{candidateId}/split` requires `plan_integration`, a recorded
failed required check, the unchanged candidate policy/proposals and unchanged
target base. The local CLI equivalent is `integration split` with normal scope
and candidate options. It deterministically halves the proposal order, includes
each half's full dependency closure, and persists new child candidates plus an
inspectable split report. Children inherit neither verification nor acceptance.
They require their own exact-candidate checks. If a half requires the entire
failed batch, the report explains the coupling instead of claiming isolation.
Single-proposal failures require agent revision. Repeated splitting is stable;
operators may recursively verify/split failing children. This is dependency-aware
fault isolation, not a claim to identify every semantic interaction automatically.

Isolated execution and durable dispatch still remain. Planner and broker tests cover dependency closure, child identity,
repeatability, failed-check admission and absence of inherited evidence.

## Ancestry discovery optimization

Before inferring dependencies, the planner asks Git `merge-base --independent`
for supplied heads that cannot be reached from another supplied head. Such a head
cannot be an ancestor dependency of a distinct proposal, so those impossible
pairwise queries are omitted. Other heads still use the original ancestry checks;
explicit dependencies and base/history validation are unchanged. Git defines this
reachability operation in its [merge-base documentation](https://git-scm.com/docs/git-merge-base).

Missing objects or failed discovery fall back to the original checks and their
per-proposal diagnostics. Timeout/output-bound failures still terminate planning.
The optimization does not assume disjoint files are independent, skip real merges,
change proposal order, or transfer evidence between candidate identities. In a
fully dependent chain, pairwise inference can still be quadratic. Tests compare
complete reports, including candidate identity, against the original all-pairs path.
