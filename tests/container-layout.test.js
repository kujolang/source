import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('Docker COPY layout includes runtime modules and serves UI assets', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'source-image-layout-'));
  try {
    // Reconstruct COPY inputs, not a Docker build. Dependencies come from npm ci.
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const copies = [...dockerfile.matchAll(/^COPY (.+)$/gm)];
    assert.ok(copies.length > 0);
    for (const [, instruction] of copies) {
      const words = instruction.trim().split(/\s+/);
      const destination = words.pop();
      for (const source of words) {
        const target = words.length > 1 ? path.join(destination, path.basename(source)) : destination;
        cpSync(path.join(root, source), path.join(directory, target), { recursive: true });
      }
    }
    symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    await execute(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { Source } from './src/source.js';
      import { startServer } from './src/api.js';
      const src = new Source('./data');
      src.initInstance({name:'image-layout-check'});
      const server = await startServer(src, {host:'127.0.0.1', port:0});
      try {
        for (const route of ['/healthz','/assets/source.css','/assets/sitekit/sitekit.css','/assets/sitekit/fonts/DepartureMono-Regular.woff2']) {
          const response = await fetch('http://127.0.0.1:' + server.address().port + route);
          assert.equal(response.status, 200, route);
          assert.ok((await response.arrayBuffer()).byteLength > 0, route);
        }
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `], { cwd: directory, timeout: 30_000 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
