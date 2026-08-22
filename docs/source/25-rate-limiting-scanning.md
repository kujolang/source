# 25 — Rate Limiting + Credential Scanning

Status: **Implemented.** The anonymous contribution path and Git push are now
rate-limited, and submitted Changes are scanned for credentials.

## Rate limiting

A fixed-window rate limiter (`src/ratelimit.js`) throttles the two
unauthenticated paths that could otherwise be abused for denial of service:

- **`source submit`** (`POST /api/v1/orgs/{org}/projects/{project}/submit`) —
  default 10 requests/minute per client address.
- **Git push** (`git-receive-pack`) — default 30 requests/minute per client
  address.

Limits and windows are configurable per route via `createServer(src, { rateLimit })`.
When the selected store implements durable rate limiting (SQLite or Postgres),
the counters are shared across server processes. The Postgres request path uses
an asynchronous `psql` update, while the legacy synchronous store contract
remains available to CLI and compatibility callers. The JSON store falls back
to a bounded in-memory limiter and is suitable only for a single process.
Exceeding the limit returns `429`. The limiter is keyed by client address and
is shared across serving processes when Postgres is selected. Expired Postgres
buckets are periodically pruned through an indexed expiry path so unique
clients cannot grow the table without bound. The JSON fallback remains
single-process only.

## Credential scanning

A deterministic scanner (`src/scan.js`) detects common high-entropy credential
patterns in text — cloud access keys, private key material, access tokens,
JWTs, and generic key-value credentials. It is pure pattern matching: no LLM,
no network.

Key properties:

- **Redacted findings.** A finding records only the pattern name and occurrence
  count, never the matched value, so scanning cannot itself leak a credential
  into evidence or the audit log.
- **Detective, not preventive.** A finding does not auto-block; it is recorded
  as a `security` Evidence with `validity: 'invalid'` so it is visible in the
  Change's evidence chain. The maintainer's Decision remains the gate.

Integration points:

- `Source.scanChangeSecrets({ orgId, projectId, changeId })` scans the diff of
  every repository in a Change and returns findings.
- `submitContribution` runs the scan automatically and, when findings exist,
  attaches a `security` Evidence (validity `invalid`) to the Change.
- `GET /api/v1/orgs/{org}/projects/{project}/changes/{changeId}/scan` exposes
  the scan over the machine interface.
- `source change scan-secrets --change <id>` exposes it over the CLI.

## Tests

`tests/ratelimit.test.js`:

- The limiter allows up to the limit then rejects, and resets after the window.
- The submit endpoint returns `429` on exceeding the limit.

`tests/scan.test.js`:

- The scanner detects common credential patterns and returns nothing for clean
  text.
- Findings are redacted (no credential value in the output).
- `scanChangeSecrets` finds a credential in a Change's diff.
- `submitContribution` records a `security` Evidence (validity `invalid`) when
  the diff contains a credential.

## Cross-references

- `12-threat-model.md` — T13 (credential leakage) and T23 (denial of service).
- `18-source-submit.md` — the contribution flow that is now rate-limited and
  scanned.
