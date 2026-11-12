#!/usr/bin/env node
// This gate must execute live tests, never silently pass their DSN skips.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.SOURCE_TEST_DATABASE_URL) {
  console.error('test:integration requires SOURCE_TEST_DATABASE_URL pointing to a disposable PostgreSQL database');
  process.exitCode = 1;
} else {
  const files = [
    'tests/submission-recovery-live.test.js',
    'tests/verification-queue-live.test.js',
    'tests/verification-dispatch-live.test.js',
    'tests/integration-benchmark.test.js',
    'tests/workflow-comparison.test.js',
  ];
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'inherit'],
  });
  let tail = '';
  child.stdout.on('data', chunk => { process.stdout.write(chunk); tail = (tail + chunk.toString()).slice(-65536); });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('close', code => {
    const count = name => Number(tail.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
    // Update the floor only with a reviewed change to the suite inventory.
    const passed = code === 0 && count('tests') >= 25 && count('pass') === count('tests') && count('skipped') === 0 && count('fail') === 0 && count('cancelled') === 0;
    if (!passed) console.error('Live integration gate failed: require at least 25 executed passing tests and zero skips/failures/cancellations');
    process.exitCode = passed ? 0 : 1;
  });
}
