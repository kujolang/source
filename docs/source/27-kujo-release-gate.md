# Kujo release gate

Source remains a Node.js service because its HTTP, Git, Postgres, and container
runtime boundaries are implemented with the platform libraries they require.
Kujo is used for deterministic evaluation, evidence normalization, workflow
translation, and environment/tooling checks rather than being forced into the
request-serving hot path.

Run the repository's Kujo-backed gate from this checkout with:

```sh
kujo run ../eval/main.kujo run eval.json \
  --output-dir .eval_results --json --artifact-checksums
```

The gate records the normal Node suite, concurrency suite, CLI contract,
whitespace cleanliness, production dependency audit, and Kujo Doctor result as
machine-readable artifacts.
When a Postgres test deployment is available, run the opt-in live gate
separately:

```sh
SOURCE_TEST_DATABASE_URL='postgresql://...' npm run test:postgres
```

The live gate is intentionally not silently replaced by a local mock: external
database, shared Git storage, failover, and deployment load remain deployment
evidence rather than repository-only claims.
