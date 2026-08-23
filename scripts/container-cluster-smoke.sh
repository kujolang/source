#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_TEST_DATABASE_URL:?set SOURCE_TEST_DATABASE_URL for host-side psql cleanup}"
: "${SOURCE_CONTAINER_DATABASE_URL:?set SOURCE_CONTAINER_DATABASE_URL to a DSN reachable from containers}"

image="${SOURCE_CONTAINER_IMAGE:-source:local-audit}"
schema="${SOURCE_TEST_SCHEMA:-source_container_smoke_$$}"
volume="${SOURCE_CONTAINER_GIT_VOLUME:-source-container-git-$$}"
node_a="source-container-a-$$"
node_b="source-container-b-$$"
port_a="${SOURCE_CONTAINER_PORT_A:-18810}"
port_b="${SOURCE_CONTAINER_PORT_B:-18811}"

if [[ ! "$schema" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "invalid SOURCE_TEST_SCHEMA" >&2
  exit 2
fi

cleanup() {
  docker rm --force "$node_a" "$node_b" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  psql "$SOURCE_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS \"$schema\" CASCADE" >/dev/null 2>&1 || true
}
finish() {
  local rc="$?"
  if [[ "$rc" -ne 0 ]]; then
    echo "container failover smoke failed; node logs:" >&2
    docker logs "$node_a" 2>&1 | tail -80 >&2 || true
    docker logs "$node_b" 2>&1 | tail -80 >&2 || true
  fi
  cleanup
  exit "$rc"
}
trap finish EXIT

docker volume create "$volume" >/dev/null
docker run --rm --user root -v "$volume":/var/lib/source/git "$image" \
  chown 1000:1000 /var/lib/source/git

docker run --rm --add-host=host.docker.internal:host-gateway \
  -e SOURCE_DATABASE_URL="$SOURCE_CONTAINER_DATABASE_URL" \
  -v "$volume":/var/lib/source/git \
  --tmpfs /var/lib/source/data:uid=1000,gid=1000 \
  "$image" node bin/source.js --store postgres --schema "$schema" init --name smoke

start_node() {
  local name="$1" port="$2"
  docker run --rm --detach --name "$name" \
    --add-host=host.docker.internal:host-gateway \
  -e SOURCE_DATABASE_URL="$SOURCE_CONTAINER_DATABASE_URL" \
  -v "$volume":/var/lib/source/git \
  --tmpfs /var/lib/source/data:uid=1000,gid=1000 \
  -p "$port":8787 "$image" \
    node bin/source.js --store postgres --schema "$schema" serve --host 0.0.0.0 --port 8787 \
      --writer-lease --writer-owner "$name" --writer-lease-ms 5000 >/dev/null
}

start_node "$node_a" "$port_a"
start_node "$node_b" "$port_b"

wait_ready() {
  local url="$1"
  for _ in {1..30}; do
    if [[ "$(curl -sS -o /dev/null -w '%{http_code}' "$url/readyz" || true)" == 200 ]]; then return 0; fi
    sleep 1
  done
  return 1
}

wait_ready "http://127.0.0.1:$port_a"
for _ in {1..10}; do
  if [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port_b/readyz" || true)" != 200 ]]; then break; fi
  sleep 1
done
if [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port_b/readyz" || true)" == 200 ]]; then
  echo "second writer unexpectedly became ready while the first lease was active" >&2
  exit 1
fi
curl -fsS "http://127.0.0.1:$port_a/.well-known/source" >/dev/null
docker stop "$node_a" >/dev/null
wait_ready "http://127.0.0.1:$port_b"
printf '{"ok":true,"nodes":2,"failover":"passed","writer_fencing":"passed","schema":"%s"}\n' "$schema"
