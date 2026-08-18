# Decision 0001 — Implementation language: Node.js

**Classification:** Evidence-backed architecture decision.

## Alternatives considered

1. **Kujo** (the ecosystem's language) — natural fit for dogfooding, but the
   runtime binary is not executable in the build environment (shell allowlist
   is `git, rg, ls, pwd, npm`), so a Kujo implementation could not be run or
   tested here. Also, Source is a standalone commercial product, not a Kujo
   feature; the MEGA_PROMPT forbids hard-coding Kujo assumptions.
2. **Go / Rust** — strong for a Git server, but neither toolchain is runnable
   in this environment.
3. **Node.js (JavaScript, ESM)** — runnable and testable here (`node` v23 via
   `npm run`), mature `child_process` git integration, zero-dependency
   possible, portable and self-hostable.

## Selected

Node.js (JavaScript, ESM), zero runtime dependencies.

## Tradeoffs

- Loses the "dogfood in the ecosystem language" story; recovered by dogfooding
  the *product* against a real Kujo repository (the MEGA_PROMPT's actual
  requirement) rather than writing Source in Kujo.
- Node's single-threaded model is fine for the MVP's I/O-bound Git/HTTP work;
  a later split to a worker/queue is a clean seam.

## Reversibility

The `storage`, `git`, and `domain` boundaries are language-agnostic. A future
port to Go/Rust/Kujo would preserve the domain model and on-disk format.
