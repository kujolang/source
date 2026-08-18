# 17 — Kujo Evidence Integration

Status: **Complete.** Source now ingests real Kujo Control-layer artifacts
(Eval, Spec, ShipCheck) as first-class Evidence, preserving the original
artifact content-addressed and correctly treating a failing tool result as
`invalid` (which blocks policy satisfaction).

This is the first item from the "Recommended Next Phase" list in
`16-mvp-results.md`, and it proves the **INTEGRATE** thesis from
`02-kujo-capability-audit.md`: Source consumes versioned JSON artifacts from
Kujo tools without linking Kujo code.

## What was built

| Piece | Location | Purpose |
|---|---|---|
| Eval normalizer | `src/integrations/kujo.js` | `summary.json`, `artifact-manifest.json`, `last_run.json` → Evidence descriptors |
| Spec normalizer | `src/integrations/kujo.js` | `spec export --format envelope` → Evidence descriptor |
| ShipCheck normalizer | `src/integrations/kujo.js` | `shipcheck scan|gate --format json` → Evidence descriptor |
| Artifact reader | `src/integrations/kujo.js` | `readEvalArtifacts(dir)` returns parsed + raw bytes |
| Runner | `src/integrations/kujo.js` | `KujoRunner` shells out to `kujo run main.kujo run … --json --artifact-checksums` |
| Service wiring | `src/source.js` | `ingestEvidence(...)` + `ingestEvalEvidence(...)` |
| Evidence validity | `src/domain.js`, `src/source.js` | `validity: 'valid' | 'invalid'` is now a real field |

## The validity fix

Before this phase, `createEvidence` hardcoded `validity: 'valid'`, and
`evaluateEvidence` matched only `validity === 'valid'`. A *failing* Eval would
therefore have been recorded as valid and would have satisfied the required
`eval` evidence — a correctness bug that only real integration exposed.

Now `validity` is a first-class field. A tool result that reports failure
(`status: 'FAIL'`, `gate_passed: 0`, a missing artifact) is normalized to
`validity: 'invalid'`, so it is recorded but does **not** satisfy policy. The
failing evidence remains inspectable; it is not discarded.

## Real artifact shapes (verified against the repos)

The normalizers were written against the actual artifacts, not README claims:

- **Eval `summary.json`** — `{ status: 'PASS'|'FAIL', passed, failed, skipped,
  total, pass_rate, duration_ms, suite_name, suite_version, generated_at_ms }`.
- **Eval `artifact-manifest.json`** — `{ artifacts: [{ exists, path, type }],
  command, suite_name, suite_version, generated_at_ms }`.
- **Eval `last_run.json`** — `{ data: { suite_name, suite_version, duration_ms,
  test_results: [{ check, description, details, message, name, passed,
  skipped }] } }`.
- **Spec envelope** — `{ metadata: { source_file, schema_version,
  checksum_sha256, generated_at, payload_format }, payload: {…} }`.
- **ShipCheck report** — `{ tool, version, dir, project_type, summary:
  { total_checks, passed, failed_errors, warnings, gate_passed: 0|1 },
  checks: [{ name, passed, severity, message, detail }] }`.

The fixtures under `tests/fixtures/kujo/` are faithful reproductions of the
real `eval/eval_results/` artifacts (the `summary.json` and
`artifact-manifest.json` are byte-for-byte copies of the real files). A test
also normalizes the live `../eval/eval_results/summary.json` when present.

## Mapping to the Evidence model

Each normalizer produces a descriptor that maps onto the Source Evidence
object:

```text
tool artifact        →  Evidence
─────────────────────────────────────────────
summary.status       →  validity (PASS → valid, FAIL → invalid)
summary.passed/failed→  result (compact summary)
suite_name/version   →  provenance (tool, suite, version)
raw JSON bytes       →  artifactRef (content-addressed, preserved verbatim)
```

The original artifact is never reduced to PASS/FAIL. A viewer can move from
"deterministic checks pass" down to the full `last_run.json` per-check output
without leaving the Source truth model.

## Runner

`KujoRunner.runEval(suitePath, { outputDir, cwd })` invokes:

```text
kujo run main.kujo run <suite> --output-dir <dir> --json --artifact-checksums
```

and returns the parsed artifacts. The `exec` function is injectable so tests
run offline without a Kujo binary. In production this runs wherever `kujo` is
on `PATH` (or on Source-managed compute in a later phase).

## Environment constraint

The build shell used for this phase only permits `git`, `rg`, `ls`, `pwd`, and
`npm`, so the Kujo runtime (`kujo`) could not be executed here. The runner and
normalizers are validated against real captured artifacts and a mocked runner;
the actual `kujo` invocation is pluggable and will run in any environment with
the runtime on `PATH`. This is a documented boundary, not a hidden gap.

## Tests

`tests/kujo-integration.test.js` (12 tests):

- Normalizers for Eval summary (pass + fail), manifest (present + missing),
  run (per-check), ShipCheck (pass + fail gate), and Spec envelope.
- End-to-end `ingestEvalEvidence`: failing eval → `invalid` → blocks policy;
  passing eval → `valid` → satisfies policy.
- Artifact preservation (original `summary.json` bytes retrievable).
- `KujoRunner` with a mocked `exec`.
- Live normalization of the real `../eval/eval_results/summary.json`.

## Cross-references

- `02-kujo-capability-audit.md` — the INTEGRATE classification this proves.
- `07-evidence-model.md` — the Evidence object this feeds.
- `16-mvp-results.md` — the next-phase list this item came from.
