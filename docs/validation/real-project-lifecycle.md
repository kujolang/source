# Source's own repository lifecycle

On 2026-11-10 (local time), a disposable private Source instance imported actual
Source history at `85e80d7`, accepted the local-image/dependency-builder change at
`d930346`, verified the assembled candidate in OCI containers, and promoted it.
This advances the real-project normal-lifecycle requirement. It is not a primary
remote cutover, production deployment or complete migration certification.

[Raw report](real-project-lifecycle.json) records the exact source revision,
harness hash, policy, environment, jobs, original test outputs, receipts and
authorization results. The candidate was
`3bd8db8407d57ef3b50115f3e2e93a363c321112`, tree
`196f70d40603c9805b43c8fdf9566e1d35b43ff2`. Each check exported 276 committed files
(2,651,877 bytes), with no working-tree files or Git metadata.

## Demonstrated path

- Actual `source sync` CLI imported history through authenticated HTTP, preserving
  GitHub `origin` and the existing upstream in an owned clone.
- Actual `source submit` CLI created Work/Session/Change/Evidence records using
  the contributor capability and real feature commits.
- Scoped HTTP APIs planned, dispatched, evaluated, accepted and promoted the
  candidate. Anonymous private Git access, direct protected-branch push,
  contributor promotion and acceptance before verification were rejected.
- A separately launched `source worker` CLI used PostgreSQL leases and the OCI
  executor. Three jobs completed once. Repeated dispatch coalesced all three,
  and later dispatch reused exact evidence.
- The scripted maintainer accepted the evidence; promotion and its idempotent
  repetition returned landed. A fresh authenticated clone matched the candidate
  commit/tree and retained proposal ancestry. Execution workspaces were empty,
  the worker exited zero, and the successful fixture was removed.

| Required check | Result | Executor elapsed time |
|---|---|---:|
| Preflight | Syntax checked 118 JavaScript files | 6,832 ms |
| Runtime components | 43 passed, 0 failed, 1 excluded nested live-container test | 3,860 ms |
| Integration broker/API, submit and sync | 23 passed, 0 failed, 0 skipped | 53,067 ms |

The nested container test needs a Docker socket, which verification does not
receive. It passed separately on the host with the full local image ID. The
[six live lifecycle checks](container/local-image-smoke.json) also passed,
including runtime isolation, cancellation, timeout, output bounds and retained
workspace recovery after an injected cleanup outage. These fixture checks are
separate from the actual-project suite. No check was removed after failure to
obtain the passing result. The private lifecycle took 78.947 seconds including
setup/cleanup; this is not a load benchmark or a comparison with GitHub CI.

## Reproduction

Use a non-root POSIX worker, Docker, Node, Git with smart HTTP support and a
disposable PostgreSQL database. The source checkout and GitHub are never pushed
or changed by the harness.

```sh
node scripts/build-self-verification-image.js d930346 > /absolute/image.json
SOURCE_TEST_DATABASE_URL='<disposable database DSN>' \
  node scripts/real-project-lifecycle.js \
  85e80d7 d930346 /absolute/image.json /absolute/unique-report.json
```

The builder's current manifest fingerprints the HTTP backend executable; the
recorded lifecycle used an earlier package-description field. The immutable
image ID is unchanged, but the tool manifest/environment identity changes.
Reproduction creates a new policy/candidate and fresh receipts; do not relabel
recorded receipts. [Current dependency-image build](container/source-dependency-image.json)
contains the base digest, npm lock hash, Dockerfile hash and observed tools.

The build needs network and installs Git plus Alpine's `git-daemon` package,
which supplies `git-http-backend`; npm lifecycle scripts are disabled. Runtime
checks use no external network, a non-root user, read-only root filesystem,
dropped capabilities and bounded memory/CPU/PIDs. Installing the package starts
no daemon. See [Alpine package contents](https://pkgs.alpinelinux.org/contents?arch=armhf&branch=v3.24&name=git-daemon&repo=main).

## Failures exposed and resolved for this run

The initial image had Git client commands but no HTTP backend. Runtime checks
passed, while 10 of 23 API/Git tests failed with HTTP 502; the queue recorded a
failed receipt and promotion was never attempted. The builder now installs and
checks the backend. This was an image dependency problem, not a waived test.

The host's `/usr/local/bin/git` 2.42.0 installation sent only four bytes in a
chunked import request and failed with an unexpected disconnect. With the same
Source code and limits, installed `/usr/bin/git` 2.50.1 (Apple Git-155) imported
successfully. The passing invocation prefixed PATH with `/usr/bin`; no persistent
Git settings or buffer limits changed. This isolates an installation-dependent
failure, not a proven defect in every Git 2.42 build. On this machine use
`PATH="/usr/bin:$PATH"` before the lifecycle or large sync command. Git documents
that pushes exceeding `http.postBuffer` use
[chunked transfer](https://git-scm.com/docs/git-config#Documentation/git-config.txt-httppostBuffer);
raising that buffer is not a general fix.

Failed harness runs now retain their private PostgreSQL schema and owned root,
including receipts/artifacts, for explicit inspection and recovery. The result
names both. Stop and verify workers/containers before removing retained state.

## Remaining gates

This demonstrates one real Source proposal through its normal development path,
with a scripted maintainer and targeted component suites. Independent human
review, multi-proposal real-project concurrency, required deployment/provider
integrations, browser staging, queue-integrated crash/restart, coordinated
backup/restore, production failover, SSH/general branch/tag protection and full
project migration remain unverified. The load and production gates remain open.
