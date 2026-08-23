# Security policy

## Supported versions

Security fixes are applied to the latest version on `main`. Older revisions
are not guaranteed to receive fixes; operators should upgrade before exposing
Source beyond a trusted network boundary.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue. Send a private
report to `security@kujolang.ai` with:

- the affected commit or release;
- the deployment mode and relevant configuration (without credentials);
- reproduction steps or a minimal proof of concept; and
- the expected and observed security impact.

Please allow seven days for an acknowledgement. We will coordinate severity,
remediation, and disclosure timing with the reporter. Do not include bearer
credentials, private repositories, secret values, or production personal data
in a report.

## Deployment security boundary

Production deployments must use TLS, Postgres, capability-scoped credentials,
an isolated action runtime, an external rotating secret provider, and the
writer-lease/replication readiness controls documented in
`docs/source/23-tls-deployment.md`. The JSON and SQLite stores are for local or
single-node use only.
