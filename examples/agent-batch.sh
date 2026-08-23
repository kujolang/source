#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_URL:=http://127.0.0.1:8787}"
: "${SOURCE_ORG:=O1}"
: "${SOURCE_PROJECT:=P1}"
: "${SOURCE_CREDENTIAL:?set SOURCE_CREDENTIAL to an enqueue_job capability}"

curl --fail-with-body --silent --show-error \
  -X POST "$SOURCE_URL/api/v1/orgs/$SOURCE_ORG/projects/$SOURCE_PROJECT/jobs/batch" \
  -H "Authorization: Bearer $SOURCE_CREDENTIAL" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: agent-batch-example-1' \
  --data '{"jobs":[{"kind":"agent.task","payload":{"batch":1}},{"kind":"agent.task","payload":{"batch":2}}]}'
