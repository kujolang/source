#!/usr/bin/env node
// Source CLI entry point.

import { run } from '../src/cli.js';

run(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});
