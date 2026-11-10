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
image, runtime, tool manifest, resource limits, user and export profile. Configure
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
candidate identity, export size and elapsed duration. The workspace is removed
before a result is returned. Cancellation, export errors and runtime exceptions
also release the attempt workspace; no passing receipt is returned for them.
The existing runner attempts named-container removal after cancellation/timeouts,
but that is not confirmed cleanup if the runtime is unreachable. Worker process
death and orphan-container/workspace reconciliation still require an operational
reaper before production use. Do not count local cleanup as proof of remote
container teardown.

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
candidate contents, absence of Git metadata, workspace writes, process version,
and workspace cleanup. Network/resource escape tests and complete staging
lifecycle validation are additional gates, not claims made by this smoke test.

Rollback consists of stopping verification workers and removing this executor
from the operator handler module. Retain existing candidate/receipt/dispatch
records and the generation-aware broker. No storage schema change is required.

## Workcell alternative

The optional [Workcell bridge](workcell-execution.md) reuses Workcell portable
lifecycle, evidence verification, cancellation and recovery contracts. It retains
recovery material when cleanup is unconfirmed; live execution and orphan recovery
remain validation gates. This does not change the OCI executor above.
