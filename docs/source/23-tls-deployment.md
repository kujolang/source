# 23 — TLS + Deployment

Status: **Implemented.** The server can terminate TLS in-process (Node
`https`), and a documented self-host deployment path exists. The transport is
no longer plain-HTTP-only.

## What changed

Before this phase, `source serve` always bound a plain-HTTP server. TLS was a
documented-but-unimplemented deployment requirement (see `12-threat-model.md`
T4/T17 and `16-mvp-results.md`).

Now `createServer`/`startServer` accept a `tls: { key, cert }` option (PEM).
When present, the server is `https.createServer`; otherwise it is plain HTTP.
The CLI exposes this as `--tls-key`/`--tls-cert`, plus `--host` for explicit
binding.

## Two deployment modes

### 1. In-process TLS (simple self-host)

`source serve` terminates TLS itself. Suitable for a single-node self-host
where the operator manages a certificate directly.

```bash
source serve --host 0.0.0.0 --port 443 \
  --tls-key /etc/source/tls/privkey.pem \
  --tls-cert /etc/source/tls/fullchain.pem
```

The Git transport and the API are served over the same HTTPS listener; no
separate configuration is required.

### 2. Reverse-proxy TLS (recommended for production)

`source serve` stays plain HTTP on a loopback or internal address, and a
reverse proxy (nginx, Caddy, HAProxy) terminates TLS and forwards to it. This
is the recommended production shape because the proxy handles certificate
renewal, HTTP/2, and connection limits without Source reimplementing them.

```text
client ──TLS──► reverse proxy ──HTTP──► source serve --host 127.0.0.1 --port 8787
```

Example (Caddy, automatic Let's Encrypt):

```text
source.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

The server exposes `GET /healthz` for liveness and `GET /readyz` for
readiness. The CLI drains connections and closes the selected store on
`SIGTERM`/`SIGINT`, so orchestrators can remove an instance from service before
process termination.

Example (nginx, manual certificate):

```text
server {
    listen 443 ssl;
    server_name source.example.com;
    ssl_certificate     /etc/letsencrypt/live/source.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/source.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

## Container deployment

The repository includes a non-root, Node 20.19.5 production image for the Postgres-backed
server. It contains Git and the Postgres client required by the storage
bootstrap/fallback paths, keeps metadata and bare Git objects in separate
mounts, and exposes a container health check:

```bash
docker build -t source:local .
docker volume create source-git
docker run --rm --user root -v source-git:/var/lib/source/git \
  source:local chown 1000:1000 /var/lib/source/git
docker run --read-only --tmpfs /tmp --cap-drop=ALL \
  -p 8787:8787 \
  -e SOURCE_DATABASE_URL='postgresql://source:password@db/source' \
  -v source-data:/var/lib/source/data \
  -v source-git:/var/lib/source/git:rw \
  source:local
```

Use a private network, inject the DSN through the orchestrator's secret
facility, and place the Git volume on storage with documented snapshot and
restore semantics. Initialize shared-volume ownership for the image's numeric
runtime user (`1000`) before starting non-root nodes. The image is a serving
node; action workers remain separate
processes so container execution capacity can be scaled independently.

The repeatable two-node smoke gate is available as `npm run test:container`.
Set `SOURCE_TEST_DATABASE_URL` for host-side cleanup and
`SOURCE_CONTAINER_DATABASE_URL` to a Postgres DSN reachable from containers;
the script verifies both nodes, discovery, shared Git-volume permissions, and
survival after stopping one node.

## Certificate management

- **Let's Encrypt** (ACME) is the default recommendation for public domains;
  Caddy automates this, or `certbot` with nginx.
- **Self-signed** certificates are acceptable only for internal/development
  use; clients must then disable verification (`git -c http.sslVerify=false`),
  which is not a production posture.
- **Private CA** is appropriate for internal self-host deployments where the
  CA is distributed to clients.

Source does not implement ACME itself. Certificate issuance and renewal are
deployment concerns, not product concerns.

## Custom domains

Custom domains are a first-class commercial requirement (MEGA_PROMPT §6). The
deployment boundary already supports them: a hosted customer points
`source.customer.com` at managed Source infrastructure, and the reverse proxy
routes by `Host` header. Source itself is domain-agnostic — no Kujo domain is
hard-coded in the architecture. Domain ownership verification and per-tenant
TLS are deferred to the hosted product (see `12-threat-model.md` T22).

## Self-host deployment path

A minimal self-host:

1. **Install prerequisites** — Node.js ≥ 18 (≥ 22.5 for the SQLite store) and
   `git` on `PATH`.
2. **Initialize the instance** — `source init --name source.example.com`.
3. **Create the org and project** — `source org create …`, `source project
   create …`.
4. **Issue capabilities** — `source cap issue …` / `source git-cap …` for
   agents and contributors (out-of-band, operator-controlled).
5. **Serve** — either in-process TLS or behind a reverse proxy (above).
6. **Back up** — see "Data durability" below.

## Data durability

What is catastrophic to lose (MEGA_PROMPT §41), and the recovery requirement:

| Data | Location | Recovery requirement |
|---|---|---|
| Git objects | `<data>/orgs/*/projects/*/repos/*.git` | Backup the bare repos; Git objects are the canonical source history. |
| Work / Change / Decision records | `<data>/orgs/*/projects/*/{work,changes,decisions}` | Backup the JSON/SQLite store. |
| Identity + audit history | `<data>/principals`, `<data>/audit` | Backup; the audit log is append-only and must not be truncated. |
| Evidence metadata + artifacts | `<data>/orgs/*/projects/*/evidence`, `<data>/artifacts` | Backup; artifacts are content-addressed and immutable. |

The data root is `SOURCE_DATA` (default `.source`). Set `SOURCE_GIT_ROOT` when
Git objects live on a separate shared durable volume; every serving node must
mount the same Git root. A consistent backup of both roots captures
everything. Source includes an executable backup and verification workflow:

```bash
npm run backup -- --data-root "$SOURCE_DATA" --git-root "$SOURCE_GIT_ROOT" \
  --output /var/backups/source --database-url "$SOURCE_DATABASE_URL" --schema source
npm run backup:verify -- --backup /var/backups/source/source-backup-<timestamp>
```

The backup command runs `git fsck` on every bare repository, archives both
filesystem roots, uses `pg_dump` custom format for Postgres, writes SHA-256
checksums, and promotes the staging directory only after all artifacts finish.
Verification checks every checksum, lists every tar archive, and validates the
Postgres dump with `pg_restore --list`. Operators must schedule the command,
replicate completed backup directories off-host, and periodically perform a
restore drill into an isolated Postgres schema and filesystem root before
declaring recovery readiness.

## Security notes

- TLS resolves the "no TLS" remaining risk in `12-threat-model.md` T4
  (capability replay) and T17 (session hijacking) for deployments that enable
  it. Plain HTTP remains the default for local development only.
- TLS keys are read from disk by the operator and are never logged or stored
  in the Source data root.
- The capability credential is still carried as a Basic-auth password over
  the Git transport; TLS is what protects it in transit (see
  `22-git-transport-auth.md`).

## Tests

`tests/tls.test.js` covers:

- the server serves HTTPS when `tls` options are provided (discovery manifest
  over `https`);
- `git clone` works over HTTPS (smart-HTTP + TLS, self-signed cert with
  `http.sslVerify=false`);
- the server still serves plain HTTP without TLS options (reverse-proxy mode).

## Cross-references

- `12-threat-model.md` — T4 (capability replay), T17 (session hijacking), T22
  (custom-domain abuse).
- `22-git-transport-auth.md` — the Git transport that TLS now protects.
- `03-system-architecture.md` — deployment is a boundary, not a product
  feature.
- `16-mvp-results.md` — item 2 of the fresh next-phase list.
