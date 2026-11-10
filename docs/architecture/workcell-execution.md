# Workcell candidate verification

`src/workcell-executor.js` connects the existing verification dispatcher to
Workcell's portable lifecycle. Source does not implement another provider API or
run contributed commands on the host. Contract inspected at Workcell revision
`189d7ab6e975301a0e5100b65e8ad3fe4a584573` (1.3.0):
`src/execution/portable_coordinator.kujo`, `portable_oci.kujo`,
`src/receipts/v2.kujo`, `src/cli/cli.kujo` and `docs/runtime-lifecycle.md`.

This bridge is opt-in. It has real-Git contract tests and actual Workcell
validation/inspection evidence. A live Docker attempt now records an integrity-verified
failure receipt, but workload execution is blocked by the daemon lacking AppArmor. It is not a production isolation claim.

## Configure

Copy `examples/verification/workcell-definition.json` and
`workcell-profiles.json` to an operator-owned configuration directory. Replace
the all-zero image digest with a real, tested image digest. The placeholder is
not a runnable image. Install the tools needed for endpoint/browser checks in
that image. Use an absolute, deployment-controlled Workcell launcher and Kujo
binary. Keep definition/profile/adapter configuration outside contributed Git.

```js
import { readFile } from 'node:fs/promises';
import { WorkcellExecutor } from '/srv/source/src/workcell-executor.js';
import { createVerificationHandler } from '/srv/source/src/verification-dispatcher.js';
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const executor = new WorkcellExecutor({
  root: '/srv/source-workcell-attempts',
  executable: '/opt/workcell/bin/workcell',
  kujo: '/opt/kujo/bin/kujo',
  workcellRevision: '189d7ab6e975301a0e5100b65e8ad3fe4a584573',
  definition: await json('/etc/source/workcell-definition.json'),
  profiles: await json('/etc/source/workcell-profiles.json'),
  profile: 'docker',
  toolVersions: { workcell: '1.3.0', node: 'YOUR_EXACT_IMAGE_NODE_VERSION' },
  maxActive: 4,
  queue: 32,
});
export function createHandlers({ source }) {
  return { 'integration.verify': createVerificationHandler({
    source, principalId: process.env.SOURCE_VERIFY_PRINCIPAL, executor,
  }) };
}
```

Put `executor.environment` and the identical `toolVersions` in the repository's
operator verification policy. The check command is an argument array; it replaces
the template's workload command. Use `adapter: "workcell"` for the existing
Workcell evidence gate. Environment identity includes the template, entire host
profile document, selected profile, optional adapter manifest, Workcell revision
and tool manifest. Configuration mutation after construction is rejected.
Revision/tool version values are operator attestations, not independent binary
signature checks. Deploy the declared code and image immutably.

The bridge deliberately requires network `none`, no ambient environment allowlist,
no secret references, and empty check `inputs`/`externalState`. It passes only PATH,
Git isolation settings, the explicit KUJO binary and an attempt-owned TMPDIR to
Workcell. TMPDIR confines Workcell output and scratch paths to that private attempt;
it does not inherit the worker's ambient temporary-directory value. Provider profiles
that require credentials cannot currently use this bridge. External adapters can
be supplied explicitly through `manifest`, but need separate compatibility and
live-provider validation. There is no provider fallback.

## Exact source and evidence

The regular-file Git exporter validates the candidate digest, commit/tree and
blob hashes, rejects symlinks/submodules/path aliases, and excludes uncommitted
files. The bridge creates a new repository, fetches the candidate objects without
shared alternates, populates its index and HEAD without checkout/filter execution,
and requires a clean Git status. Only the candidate commit is shallow-fetched. No canonical Git metadata or remote
credentials are copied. The worker must run as a non-root POSIX user. Workcell receives this exact clean repository.

A caller context binds candidate ID, verification identity and the job's lease
attempt. Source resolves the profile through Workcell inspect before execution
and requires the receipt to match its profile fingerprint and adapter/provider
identities. After execution, Source invokes `workcell verify` and requires an
integrity-verified v2 receipt with the exact source commit, clean-source flag,
command and caller context. Passing evidence also requires successful CLI/summary
outcomes, the existing complete Workcell lifecycle gate and zero remaining owned
resources. A valid failed workload becomes failed Source evidence. Missing,
substituted or unverifiable receipts throw and cannot produce passing evidence.
The dispatcher independently rechecks the live job lease before recording it.

The original receipt and original stdout/stderr become one Source immutable output
artifact. Workcell's full run directory, including declared artifacts, integrity
manifest and recovery journal, remains in the operator attempt root. Execution
metadata records that directory and run ID. Exported binary artifacts are not yet
copied into Source's artifact service; preserve/back up the Workcell run directories
when those artifacts are required. Artifact hashes prove integrity, not execution
authenticity or provider security.

## Endpoint and browser checks

An offline staging check can run a repository test driver that starts the
candidate service inside its Workcell environment, exercises loopback endpoints,
runs an installed headless browser when applicable, captures declared screenshots
and reports, and stops the service. The image must contain all dependencies;
network `none` prevents external downloads and service access. Configure Workcell
artifact declarations and verification commands in the operator template.

This supports an isolated single-environment test command, not a provisioned
multi-service cloud deployment. Live endpoint/browser fixtures, multi-service
staging, externally bound inputs, and remote credential delivery remain required
follow-up work. Production deployment is not exposed by this bridge.

## Cancellation, preservation and recovery

Cancellation writes Workcell's documented `--cancel-file`; it does not immediately
kill the coordinator while it is cleaning resources. An outer watchdog allows the
configured workload timeout plus two minutes for setup/cleanup. A hung or killed
coordinator cannot yield successful evidence. Its attempt directory remains for
inspection and Workcell recovery. The slot is released on every outcome.

Only a verified cleanup result with zero remaining resources permits removal of
the prepared source. Preserved filesystem outcomes retain the source repository
because Workcell worktrees may refer to it. Run evidence is always retained.
Failures before verified cleanup retain source and control files too. The thrown
error identifies the attempt directory. Repeated failures can consume disk;
operators must monitor the attempt root and apply a reviewed retention policy.
There is no automatic age-based deletion or Source reaper in this increment.

For remote journals, use Workcell's `recover` command with the recorded journal
and the same approved provider configuration. For OCI resources use Workcell's
ownership-scoped inventory/clean path. Inspect the exact run ownership and stop
its worker before recovery; never infer ownership from a directory's age. Keep
failed evidence and verify cleanup before removing recovery material. Consult
Workcell's recovery documentation for the installed version. Worker SIGKILL,
orphan cleanup and runtime-unavailable recovery need live validation.

Rollback: stop the affected verification workers, remove this executor from the
operator module, and retain attempt/evidence/dispatch records. No database schema
migration is required. Existing evidence remains subject to policy identity,
expiry and generation checks.


## Reproduce live validation

```bash
SOURCE_TEST_CONTAINER_IMAGE='node@sha256:<tested-digest>' \
SOURCE_TEST_CONTAINER_NODE_VERSION='<exact-version>' \
SOURCE_TEST_WORKCELL_EXECUTABLE='/opt/workcell/bin/workcell' \
SOURCE_TEST_KUJO='/opt/kujo/bin/kujo' \
SOURCE_TEST_WORKCELL_REVISION='<40-hex-revision>' \
node scripts/workcell-candidate-smoke.js
```

The command emits the original receipt/captured logs and execution identity,
retains the test-owned root for inspection/recovery, and exits nonzero unless the
workload passes with verified integrity and cleanup. It never substitutes a host
command. Remove the printed owned root only after checking the retained cleanup
and recovery state. The checked-in Docker profile requires Workcell's existing
host security controls; no flag disables them.

On 2026-11-10 Docker Desktop 29.6.2 reached Workcell but failed before execution:
`Docker daemon does not report AppArmor; rootful Docker requires both seccomp and
AppArmor profiles`. The receipt is verified and cannot authorize promotion.
See [raw failed report](../validation/container/workcell-smoke-blocked.json).
Use a compatible approved runtime host to complete this gate. The separate OCI
executor's passing smoke does not establish Workcell compatibility.
