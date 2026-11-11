# Matched 100-contributor workflow comparison

This experiment compares two complete Source operating patterns on the same local host, without a screen recorder. It does not edit the release video or resume the wider 250/1000 capacity campaign.

- Serial: one process clones current main, edits its section of shared.txt, submits through private HTTP/Git, then its one-proposal candidate is verified and promoted. The result is fetched before the next process starts. There are 100 verification jobs and 100 promotions.
- Concurrent batch: 100 processes start together, clone the common base and submit the same compatible edits. One candidate combines all 100 proposals, receives one verification job, and is promoted and fetched.

Both use the same benchmark revision and application code, host, Node/Git versions, private capabilities, submission keys, explicit 1000/minute push/submit profile, two PostgreSQL worker processes with concurrency two each, and fixed Git-content checker. Server HTTP timeouts are not extended. No LLM calls or repository code execute. Each serial contributor starts from the previous promoted commit; concurrent contributors share the original base. Growing clone history and repeated acceptance/promotion are consequently part of the serial pattern.

The primary workflow timer begins before the first contributor process is spawned and ends after the final verified promotion, contributor ancestry checks and authenticated fetch. It includes benchmark correctness assertions, including rejection of acceptance before verification. Common org/repo/principal/capability/worker preparation is reported separately. The full-harness timer additionally includes setup, an independent final content/ancestry audit, worker shutdown and cleanup. There is no extra sequential baseline inside either measured run.

The checker uses the candidate's recorded base commit to count prior completed sections, adds the submitted proposal count, and checks the entire candidate with the shared benchmark content checker. Final independent assertions require byte-exact expected shared.txt content, every contributor head in main's ancestry, 100 Work/Change records, completed-once jobs and identical final Git trees across modes.

Run order is serial then concurrent, each on a new temporary schema and Git fixture. This is one matched pair, not a statistical sample. The OS cache is not flushed and the host is not a dedicated production server. Report observed elapsed times, not universal speedups. Differences combine concurrency, batching and repeated integration/verification overhead; they do not isolate parallelism alone or predict AI coding productivity.

Reproduction (run sequentially, never at the same time):

```sh
PATH="/usr/bin:$PATH" SOURCE_TEST_DATABASE_URL='postgresql:///YOUR_DISPOSABLE_DB?host=/tmp' \
node scripts/benchmarks/workflow-comparison.js --mode serial --agents 100 --output /absolute/serial-new.json
PATH="/usr/bin:$PATH" SOURCE_TEST_DATABASE_URL='postgresql:///YOUR_DISPOSABLE_DB?host=/tmp' \
node scripts/benchmarks/workflow-comparison.js --mode concurrent --agents 100 --output /absolute/concurrent-new.json
```

The harness refuses to overwrite a report and cleans only its owned schema, processes and Git fixture. Preflight files are not capacity measurements. The comparison tests exercise both modes and assert serial batch non-overlap and identical final trees.
