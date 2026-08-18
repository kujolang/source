// TLS + deployment tests.
//
// Proves the server can terminate TLS in-process (Node `https`) and that the
// Git smart-HTTP transport works over HTTPS. A self-signed certificate is
// generated with `openssl`; the git client is told to skip verification
// (`http.sslVerify=false`) because the certificate is not trusted.
//
// These tests also prove the plain-HTTP path is unchanged when no TLS options
// are provided (the reverse-proxy deployment mode).

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import https from 'node:https';
import { freshSource, seedRepo } from './helpers.js';
import { startServer } from '../src/api.js';

// Generate a self-signed certificate (key + cert PEM) in a temp dir.
// Returns { key, cert } as Buffers, ready for `https.createServer`.
function selfSignedCert() {
  const dir = mkdtempSync(path.join(tmpdir(), 'source-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve(stdout.trim());
    });
  });
}

// GET over HTTPS with certificate verification disabled (self-signed).
function httpsGet(port, pathname) {
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: pathname, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

test('server serves HTTPS when TLS options are provided', async () => {
  const { src } = freshSource();
  const tls = selfSignedCert();
  const server = await startServer(src, { port: 0, tls });
  const port = server.address().port;
  try {
    const res = await httpsGet(port, '/.well-known/source');
    assert.equal(res.status, 200);
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.api_version, '1');
    assert.ok(manifest.protocols.includes('git-smart-http'));
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('git clone works over HTTPS (smart-HTTP + TLS)', async () => {
  const { src, org, project, human } = freshSource();
  const { repo } = seedRepo(src, org.id, project.id);
  const cap = src.issueGitCapability({ orgId: org.id, projectId: project.id, principalId: human.id });
  const tls = selfSignedCert();
  const server = await startServer(src, { port: 0, tls });
  const port = server.address().port;
  try {
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'source-https-clone-'));
    const url = `https://source:${cap.credential}@127.0.0.1:${port}/git/${org.id}/${project.id}/${repo.id}.git`;
    await run(['-c', 'http.sslVerify=false', 'clone', url, cloneDir]);
    const readme = readFileSync(path.join(cloneDir, 'README.md'), 'utf8');
    assert.ok(readme.includes('change'));
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('server still serves plain HTTP without TLS options (reverse-proxy mode)', async () => {
  const { src } = freshSource();
  const server = await startServer(src, { port: 0 });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/source`);
    assert.equal(res.status, 200);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
