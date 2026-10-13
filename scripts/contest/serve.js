import { existsSync } from 'node:fs';
import path from 'node:path';
import { Source } from '../../src/source.js';
import { startServer } from '../../src/api.js';

const run = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !existsSync(path.join(run, 'operator.json'))) {
  throw new Error('Usage: npm run demo:serve -- .contest-demo/run-XXXXXX');
}
const server = await startServer(new Source(path.join(run, 'data')), { host: '127.0.0.1', port: 8787 });
console.log('Local rehearsal: http://127.0.0.1:8787');
console.log(`Read login IDs and the generated password locally from ${path.join(run, 'operator.json')}. Do not share that file.`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.closeAllConnections?.();
  server.close();
});
