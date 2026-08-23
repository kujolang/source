#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const roots = ['bin', 'scripts', 'src', 'tests'];
const files = [];

function collect(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.isFile() && file.endsWith('.js')) files.push(file);
  }
}

for (const root of roots) collect(root);
for (const file of files.sort()) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
process.stdout.write(`lint: syntax checked ${files.length} JavaScript files\n`);
