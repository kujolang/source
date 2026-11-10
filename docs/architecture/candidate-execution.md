# Exact-candidate container execution

`CandidateContainerExecutor` implements the verification worker's executor
interface using the existing `IsolatedActionRunner` and
`EphemeralWorkspaceManager`. It is optional operator configuration; the API does
not execute repository commands and there is no fallback to a host shell.

The exporter validates the candidate snapshot and commit/tree relationship,
enumerates regular files from Git, reads their raw blob bytes in a bounded batch,
verifies blob content hashes, and writes a fresh attempt-owned workspace. It does
not use checkout filters, hooks, Git archive attributes, a working checkout, or
untracked files. The workspace contains no Git metadata or credential helpers.
Case/Unicode aliases, unsafe paths, symlinks and submodules are rejected. Export
is limited to 10,000 files and 256 MiB, with bounded Git command time/output.

The operator must supply an image pinned by SHA-256 digest and a tool-version
manifest for that image. The executor's `environment` value hashes the normalized
image, runtime, tool manifest, resource limits, user, export and cleanup profile. Configure
the check with exactly that environment and tool manifest before planning the
candidate. Changing the profile requires policy update, replanning and fresh
verification. The manifest is an operator attestation about the pinned image;
Source does not independently discover every executable's version.

Commands are argument arrays quoted for the container shell. The existing runner
enforces no network, read-only container root, dropped capabilities, no privilege
escalation, bounded memory/CPU/PIDs/output/time, and a writable disposable workspace.
The worker must run as a non-root POSIX user. The container uses that numeric UID
and GID, and the runtime's UID mapping must permit access to owner-only exported
files. Rootless/remapped runtime compatibility needs live validation; access
failure must not be worked around by making the workspace public or running the
container as root. Dependencies must already be available in the pinned image or
the candidate. External services, nonempty `inputs`/`externalState`, networked
staging, symlink/submodule materialization and secret injection are not supported
by this initial executor.

Example operator worker module (paths and values are deployment-owned):

```js
import { CandidateContainerExecutor } from '/srv/source/src/candidate-executor.js';
import { createVerificationHandler } from '/srv/source/src/verification-dispatcher.js';

const executor = new CandidateContainerExecutor({
  workspaceRoot: '/srv/source-verification-workspaces',
  runtime: 'docker',
  image: process.env.SOURCE_VERIFY_IMAGE, // immutable image@sha256:... reference
  toolVersions: { node: process.env.SOURCE_VERIFY_NODE_VERSION },
  maxActive: 8,
});

export function createHandlers({ source }) {
  return {
    'integration.verify': createVerificationHandler({
      source,
      principalId: process.env.SOURCE_VERIFY_PRINCIPAL,
      executor,
    }),
  };
}
```

Obtain `executor.environment` from the same configuration when authoring the
operator verification policy. Each check's command must run successfully inside
that image against `/workspace`. Start the module with the existing PostgreSQL
worker CLI and dispatch through `integration dispatch` or the scoped API.

Successful or failed command results preserve stdout, stderr, exit status,
candidate identity, export size and elapsed duration. The runner confirms named
container removal before returning a result, including when the runtime command
exited successfully. A failed removal is followed by a bounded successful runtime
inventory check; an unreachable daemon is never treated as proof of absence.
The workspace is removed only after confirmed teardown (or a pre-launch/export
failure). Returned candidate execution metadata records `cleanupConfirmed: true`.
The profile now includes `cleanup: confirmed-removal-v1`, changing the environment
hash: update operator policy from the executor's new environment, then replan and
reverify. Do not edit old receipts to match the new environment.

If cleanup cannot be confirmed, no passing result is returned. The exact workspace
is retained and a mode-0600 `.source-action-<attempt>.cleanup.json` record is written
in the configured workspace root, outside the container's sole bind mount. It
contains the container name, runtime, image, workspace and timestamp, never command
output or injected secrets. The worker error also identifies the container and
workspace, and whether writing the record succeeded. The runner stops admitting
new workloads, including queued admissions; another runner instance using that
root refuses work while a cleanup record exists. Already-running attempts retain
their independent cleanup lifecycle. If storage prevents writing a record, the
current runner still blocks, but restart protection requires operator intervention
using the job error; do not restart around that failure.

Operator recovery is explicit: stop/drain workers using the affected root, restore
runtime access, inspect the recorded exact container and confirm its workspace
mount, then remove that container and verify absence through a successful runtime
inventory. Only then remove the recorded workspace and its cleanup record. Restart
workers and retry/re-dispatch through the existing lease-fenced job path. Preserve
records until every affected container is accounted for; never sweep containers by
prefix or delete a workspace while its container might still run. Rollback also
requires resolving retained cleanup records before restarting an older binary.

This is confirmed cleanup with durable recovery on observed runtime failures.
Worker SIGKILL before cleanup can still leave an unrecorded container/workspace;
that separate crash-orphan reaper and deployment recovery proof remain required.

## Validation

Unit/integration fixtures use real Git objects and controlled runtime process
events. They verify exact binary bytes, executable bits, exclusion of working
changes and untracked files, ignored archive attributes, size limits, symlink and
path-alias rejection, corrupt-blob rejection, shell argument quoting, profile
matching, cancellation before allocation and workspace release on failure.
These fixtures do not establish container isolation.

Run an explicit live smoke check after starting a supported runtime and preparing
a digest-pinned image containing Node:

```bash
SOURCE_TEST_CONTAINER_RUNTIME=docker \
SOURCE_TEST_CONTAINER_IMAGE='your-image@sha256:<64-hex-digest>' \
SOURCE_TEST_CONTAINER_NODE_VERSION='v26.12.1' \
node scripts/candidate-container-smoke.js
```

Use the actual image's exact Node version. This command fails if configuration or
the runtime is unavailable; it never substitutes host execution. It validates
candidate contents and a loopback HTTP endpoint, absence of untracked host files,
Git metadata and an ambient canary variable, non-root execution, dropped effective
capabilities, no-new-privileges, read-only root and loopback-only interfaces. A live
runtime inspection checks the configured memory/CPU/PID limits and sole workspace
bind mount. Failed commands, cancellation after startup, timeout and output overflow
must leave no named containers or workspaces. Runtime inventory failure fails the
check; absence is never inferred from a failed inspection. This is not a container
escape audit, browser test or worker-SIGKILL orphan recovery proof.

The original Docker Desktop run on 2026-11-10 passed all five cases. Raw profile/results and
limitations: [candidate smoke](../validation/container/candidate-smoke.json).
Docker server 29.6.2, image Node v26.13.0, digest recorded in that report. This
supersedes the previous unavailable-daemon status for the local OCI executor;
other runtime/UID mappings and production isolation remain unverified.

Rollback consists of stopping verification workers and removing this executor
from the operator handler module. Retain existing candidate/receipt/dispatch
records and the generation-aware broker. No storage schema change is required.

## Workcell alternative

The optional [Workcell bridge](workcell-execution.md) reuses Workcell portable
lifecycle, evidence verification, cancellation and recovery contracts. It retains
recovery material when cleanup is unconfirmed; live execution and orphan recovery
remain validation gates. This does not change the OCI executor above.

The cleanup-confirmation follow-up adds a sixth live case: after real container
startup, a fault-injected unavailable cleanup boundary leaves the container
running. The script verifies retained candidate bytes, durable recovery metadata,
and blocked current/restarted runners; restores real cleanup, confirms removal,
and only then removes the workspace and marker. See
[cleanup confirmation results](../validation/container/cleanup-confirmation.json).
This injects the cleanup failure without stopping the shared Docker daemon; it is
not a daemon restart or worker-SIGKILL recovery test.
