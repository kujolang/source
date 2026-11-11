# 100-contributor serial versus concurrent workflow — 2026-11-11

One matched pair passed on the same local macOS host, with screen recording disabled. Implementation: `e1800a1f16082f71bb713cedb8f9b67bd4b37996`.

| Measurement | Serial | Concurrent batch |
|---|---:|---:|
| Complete workflow | 696.281s (11m 36s) | 126.034s (2m 6s) |
| Including setup, final audit and cleanup | 711.434s | 141.664s |
| Contributions | 100 | 100 |
| Verification jobs / promotions | 100 / 100 | 1 / 1 |
| Peak observed active HTTP sockets | 1 | 100 |

The primary workflow was **5.5245× faster**, using **81.8989% less elapsed time**, saving **570.246s (9m 30s)**. Including all harness overhead, the ratio was 5.0220×.

Both reports have matching code revision, harness hashes, host/configuration, byte-exact final contents and Git tree `062cca0a42a78f8f5f340eadccc0202eb7241e7a`. All 100 contributor commits remain ancestors of the promoted result. All 100 submissions per run finished; every verification job completed on its first attempt. No observed socket errors, timeouts or pending requests remained. Anonymous access was denied as expected. Six benchmark tests and JavaScript lint passed before measurement.

## What this supports

“In a local 100-contributor benchmark, Source completed a concurrent batch in 2m 6s versus 11m 36s running each complete workflow one at a time—about 5.5× faster. Both retained every contribution and produced identical final contents.”

These were scripted processes making small compatible edits to separate sections of the same file, not 100 LLM coding sessions or conflicting edits to the same lines. Serial waited for verification, promotion and fetch before starting the next contributor; concurrent combined all proposals into one verified promotion. The result measures concurrency **and batching**, not parallel execution alone. This is one pair, serial first, without cache flushing or a dedicated host; it does not establish repeatability or a universal speedup. This fresh unrecorded comparison is separate from the original recorded video run.

## Evidence and continuation

- [Serial raw report](serial-100-1.json)
- [Concurrent raw report](concurrent-100-1.json)
- [Derived comparison](comparison.json)
- [Methodology and reproduction](METHODOLOGY.md)

The disposable database was dropped after both processes exited and their owned schemas/fixtures were cleaned. No video was edited. The wider 250/1000 capacity campaign remains paused; further runs require user direction. Preflight evidence is only a small harness check.
