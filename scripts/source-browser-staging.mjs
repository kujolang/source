// Operator-owned check baked into the pinned image, never loaded from a proposal.
// The application itself is loaded only from the exported candidate workspace.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const require = createRequire('/opt/lens/bridge/package.json');
const { capture } = require('/opt/lens/bridge/browser-bridge.js');
const { chromium } = require('playwright-core');
const { Source } = await import('/workspace/src/source.js');
const { startServer } = await import('/workspace/src/api.js');
const root = await mkdtemp(path.join(tmpdir(), 'source-browser-stage-'));
let server, browser;
const report = { version: 1, kind: 'source-browser-staging', status: 'running',
  scope: 'actual Source candidate, isolated local JSON store, Lens browser bridge plus operator assertions; not a full Lens CLI gate or remote provider deployment' };
try {
  const source = new Source(path.join(root, 'data'));
  const org = await source.createOrgAsync({ name: 'Browser staging', slug: 'browser-stage' });
  const password = randomBytes(24).toString('hex');
  const human = await source.createPrincipalAsync({ type: 'human', name: 'staging maintainer', password });
  await source.addOrgMemberAsync({ orgId: org.id, principalId: human.id, role: 'maintainer' });
  const project = await source.createProjectAsync({ orgId: org.id, name: 'Browser staging project', slug: 'staging', visibility: 'private' });
  server = await startServer(source, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200); await health.arrayBuffer();
  const privatePage = await fetch(`${base}/o/${org.id}/p/${project.id}`);
  assert.equal(privatePage.status, 401); await privatePage.arrayBuffer();
  const shots = path.join(root, 'screenshots'); await mkdir(shots);
  report.render = await capture({ url: `${base}/login`, viewports: ['desktop', 'mobile'], timeout: 30,
    browser: 'chromium', screenshotDir: shots, settleMs: 400, maxConcurrency: 1, readySelector: '#login-title' });
  assert.deepEqual(report.render.provider_errors, []);
  assert.equal(report.render.viewports.length, 2);
  report.screenshots = [];
  for (const view of report.render.viewports) {
    assert.equal(view.navigation_error, null);
    assert.equal(view.context_cleanup_failed, false);
    assert.equal(view.dom_summary.has_main, true);
    assert.match(view.dom_summary.visible_text_sample, /Sign in with a human principal/);
    assert.ok(view.dom_summary.document_width <= view.dom_summary.viewport_width + 1, 'no horizontal overflow');
    assert.ok(!view.console_messages.some(message => message.type === 'error'), 'no browser console errors');
    assert.equal(view.network_events.length, 0, 'no failed browser requests');
    assert.equal(view.evidence_limits.dropped_console_messages, 0);
    assert.equal(view.evidence_limits.dropped_network_events, 0);
    const bytes = await readFile(view.screenshot);
    assert.ok(bytes.length > 1000 && bytes.length <= 1024 * 1024);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    report.screenshots.push({ name: `${view.name}.png`, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') });
  }
  // Discover the rendered controls before interacting; never record form values.
  const inspected = JSON.parse((await exec(process.execPath, ['/opt/lens/bridge/inspect-bridge.js', '--url', `${base}/login`, '--timeout', '30'], { timeout: 45000, maxBuffer: 1024 * 1024 })).stdout);
  const inspectedText = JSON.stringify(inspected);
  for (const id of ['principal-id', 'password', 'org-id', 'project-id']) assert.ok(inspectedText.includes(`#${id}`), `missing inspected control ${id}`);
  browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', () => errors.push('pageerror'));
  await page.goto(`${base}/login`);
  await page.locator('#principal-id').fill(human.id);
  await page.locator('#password').fill(password);
  await page.locator('#org-id').fill(org.id);
  await page.locator('#project-id').fill(project.id);
  await Promise.all([page.waitForURL(`${base}/o/${org.id}/p/${project.id}`), page.locator('form[action="/login"] button[type="submit"]').click()]);
  assert.match(await page.locator('body').innerText(), /Browser staging project/);
  assert.deepEqual(errors, []);
  await context.close(); await browser.close(); browser = null;
  report.assertions = { endpointHealthy: true, privatePageDenied: true, desktopMobileRendered: true,
    screenshotsCaptured: true, noHorizontalOverflow: true, noFailedRenderRequests: true,
    selectorsInspected: true, authenticatedProjectVisible: true, browserClosed: true };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(root, { recursive: true, force: true });
  report.disposableApplicationRemoved = true;
  console.log(JSON.stringify(report));
}
