// Read-only inventory. Values are never emitted, only object IDs, paths and categories.
import { execFileSync } from 'node:child_process';
import { scanSecrets } from '../../src/scan.js';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const objects = git('rev-list', '--objects', '--all').trim().split('\n');
const findings = [];
let blobs = 0;
for (const object of objects) {
  const space = object.indexOf(' ');
  if (space < 0) continue;
  const hash = object.slice(0, space), file = object.slice(space + 1);
  if (git('cat-file', '-t', hash).trim() !== 'blob') continue;
  blobs++;
  const content = git('cat-file', 'blob', hash);
  if (content.includes('\0')) continue;
  const categories = scanSecrets(content).map(({name, count}) => ({name, count}));
  for (const [name, pattern] of [
    ['personal_home_path', /\/(?:Users|home)\/[A-Za-z0-9._-]+/g],
    ['email_address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
    ['artifacts_token', new RegExp('art_' + 'v1_[A-Za-z0-9]{30,}', 'g')],
  ]) {
    const count = [...content.matchAll(pattern)].length;
    if (count) categories.push({ name, count });
  }
  if (categories.length) findings.push({ file, blob: hash, categories });
}
console.log(JSON.stringify({
  head: git('rev-parse','HEAD').trim(), commits: Number(git('rev-list','--all','--count')),
  uniqueBlobs: blobs, scope: 'all locally reachable Git refs; bounded pattern inventory, not a security certification',
  trackedInternalFiles: git('ls-files','.loop-engineering','.source').trim().split('\n').filter(Boolean),
  findings,
}, null, 2));
