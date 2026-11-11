// Operator-owned dependency image for Source's isolated real-project checks.
// Only committed manifests enter the build context; no checkout or credentials.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const browser = process.argv[3] === '--browser';
const base = browser ? 'node@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68'
  : 'node@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = async (...args) => (await exec('git', ['--no-replace-objects', ...args], { cwd: repository, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout;
if (process.argv.length > 4 || (process.argv[3] && !browser)) throw new Error('usage: node scripts/build-self-verification-image.js [commit] [--browser]');
const revision = (await git('rev-parse', '--verify', '--end-of-options', `${process.argv[2] || 'HEAD'}^{commit}`)).trim();
const context = await mkdtemp(path.join(tmpdir(), 'source-dependency-image-'));
try {
  const manifest = await git('show', `${revision}:package.json`);
  const lock = await git('show', `${revision}:package-lock.json`);
  let browserBuild = null;
  if (browser) {
    // Import only committed, operator-selected Lens bridge code and its lock.
    // Untracked sibling files, repository Dockerfiles and npm scripts stay out.
    const lensRepository = path.resolve(repository, '../lens');
    const lensGit = async (...args) => (await exec('git', ['--no-replace-objects', ...args], { cwd: lensRepository, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    const lensRevision = (await lensGit('rev-parse', 'HEAD')).trim();
    const names = (await lensGit('ls-tree', '-r', '--name-only', lensRevision, 'bridge')).trim().split('\n')
      .filter(name => /^bridge\/(?:[a-z-]+\.js|package(?:-lock)?\.json)$/.test(name));
    await mkdir(path.join(context, 'lens'));
    const files = {};
    for (const name of names) {
      const contents = await lensGit('show', `${lensRevision}:${name}`);
      files[name] = sha256(contents);
      await writeFile(path.join(context, 'lens', path.basename(name)), contents);
    }
    const checker = await git('show', `${revision}:scripts/source-browser-staging.mjs`);
    await writeFile(path.join(context, 'source-browser-staging.mjs'), checker);
    browserBuild = { lensRevision, files, checkerSha256: sha256(checker), contract: 'Lens browser bridge capture/inspect, not full Lens CLI' };
  }
  const dockerfile = `FROM ${base}
${browser ? 'RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*' : 'RUN apk add --no-cache git git-daemon'}
WORKDIR /opt/source-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mv node_modules /node_modules && npm cache clean --force
${browser ? `ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY lens/ /opt/lens/bridge/
WORKDIR /opt/lens/bridge
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && node node_modules/playwright-core/cli.js install --with-deps chromium --only-shell && rm -rf /var/lib/apt/lists/* && npm cache clean --force
COPY source-browser-staging.mjs /opt/source-browser-staging.mjs
` : ''}
WORKDIR /workspace
`;
  await Promise.all([
    writeFile(path.join(context, 'package.json'), manifest),
    writeFile(path.join(context, 'package-lock.json'), lock),
    writeFile(path.join(context, 'Dockerfile'), dockerfile),
  ]);
  // No repository-controlled Dockerfile, install lifecycle scripts, SSH mounts,
  // secret arguments or host directories are passed to the build.
  const iidfile = path.join(context, 'image-id');
  const build = await exec('docker', ['build', '--iidfile', iidfile, context], { timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
  process.stderr.write(build.stderr);
  const image = (await readFile(iidfile, 'utf8')).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Docker did not return a full immutable image ID');
  const probe = `const {execFileSync}=require('node:child_process'),fs=require('node:fs');
const gitPath=execFileSync('git',['--exec-path'],{encoding:'utf8'}).trim();
fs.accessSync(gitPath+'/git-http-backend',fs.constants.X_OK);
console.log(JSON.stringify({node:process.version,git:execFileSync('git',['--version'],{encoding:'utf8'}).trim(),gitHttpBackendSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(gitPath+'/git-http-backend')).digest('hex'),${browser ? "debian:fs.readFileSync('/etc/debian_version','utf8').trim(),playwright:require('/opt/lens/bridge/node_modules/playwright-core/package.json').version,lensBridge:require('/opt/lens/bridge/package.json').version,chromium:require('/opt/lens/bridge/node_modules/playwright-core/browsers.json').browsers.find(b=>b.name==='chromium-headless-shell').browserVersion," : "alpine:fs.readFileSync('/etc/alpine-release','utf8').trim(),"}pg:require('/node_modules/pg/package.json').version,yaml:require('/node_modules/js-yaml/package.json').version}));`;
  const { stdout } = await exec('docker', ['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65532:65532', '--memory=256m', '--cpus=1', '--pids-limit=64', '--entrypoint=node', image, '-e', probe], { timeout: 30000, maxBuffer: 65536 });
  console.log(JSON.stringify({ version: 1, revision, base, image, toolVersions: JSON.parse(stdout),
    packageSha256: sha256(manifest), lockSha256: sha256(lock), dockerfileSha256: sha256(dockerfile),
    buildNetwork: true, installScripts: false, runtimeProbeNetwork: 'none', ...(browserBuild ? { browserBuild } : {}),
    reproducibility: 'npm dependencies use committed integrity locks; OS packages and browser installation resolve at build time. The resulting image ID pins the complete local image, not a reproducible future build or registry distribution.' }, null, 2));
} finally {
  await rm(context, { recursive: true, force: true });
}
