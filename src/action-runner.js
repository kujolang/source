// Explicit isolated execution seam for imported workflow jobs.
//
// Source never executes repository-provided workflow commands in its API or
// worker process. Operators must provide a container runtime and image. The
// default profile is network-less, read-only, capability-dropped, and bounded
// by CPU, memory, PIDs, output, and wall-clock limits.

import { spawn } from 'node:child_process';
import path from 'node:path';

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function safeImage(image) {
  if (typeof image !== 'string' || !image || image.length > 240 || /[\s\0]/.test(image) || image.startsWith('-')) throw new Error('isolated runner image is invalid');
  return image;
}

function safeWorkspace(root, workspace) {
  const rootPath = path.resolve(root || '');
  const workspacePath = path.resolve(workspace || '');
  const relative = path.relative(rootPath, workspacePath);
  if (!root || !workspace || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('workflow workspace must be inside the configured workspace root');
  return workspacePath;
}

function workflowScript(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 100) throw new Error('workflow job must contain 1-100 steps');
  const lines = ['set -eu'];
  for (const step of steps) {
    if (step?.uses) throw new Error('GitHub composite actions are not enabled in the isolated runner');
    if (typeof step?.run !== 'string' || !step.run.trim()) throw new Error('isolated runner requires run steps');
    if (step.run.length > 16 * 1024) throw new Error('workflow run step is too large');
    lines.push(step.run);
  }
  return `${lines.join('\n')}\n`;
}

function safeEnvironment(env) {
  return Object.fromEntries(Object.entries(env || {}).filter(([key, value]) => (
    /^[A-Z_][A-Z0-9_]{0,63}$/.test(key)
    && !/^(?:LD_|BASH_ENV$|ENV$|NODE_OPTIONS$|PYTHONPATH$|PERL5OPT$|RUBYOPT$|GIT_CONFIG_)/.test(key)
    && typeof value === 'string'
    && value.length <= 4096
  )));
}

export class IsolatedActionRunner {
  constructor({ runtime = 'podman', image, workspaceRoot, timeoutMs = 15 * 60_000, maxOutputBytes = 8 * 1024 * 1024, memory = '1g', cpus = 2, pidsLimit = 256, allowNetwork = false, user = '65532:65532' } = {}) {
    if (runtime !== 'podman' && runtime !== 'docker') throw new Error('isolated runner runtime must be podman or docker');
    this.runtime = runtime;
    this.image = safeImage(image);
    this.workspaceRoot = workspaceRoot;
    this.timeoutMs = boundedInteger(timeoutMs, 15 * 60_000, 1_000, 24 * 60 * 60_000);
    this.maxOutputBytes = boundedInteger(maxOutputBytes, 8 * 1024 * 1024, 1_024, 128 * 1024 * 1024);
    this.memory = safeImage(memory);
    this.cpus = boundedInteger(cpus, 2, 1, 64);
    this.pidsLimit = boundedInteger(pidsLimit, 256, 16, 10_000);
    this.allowNetwork = allowNetwork === true;
    this.user = safeImage(user);
  }

  buildArgs({ steps, envKeys = [] }, workspace) {
    const workspacePath = safeWorkspace(this.workspaceRoot, workspace);
    const args = ['run', '--rm', '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--pids-limit=${this.pidsLimit}`, `--memory=${this.memory}`, `--cpus=${this.cpus}`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--user', this.user];
    if (!this.allowNetwork) args.push('--network=none');
    args.push('--env', 'CI=true', '--env', 'GITHUB_ACTIONS=true', '--env', 'GITHUB_WORKSPACE=/workspace');
    for (const key of envKeys) args.push('--env', key);
    args.push('-v', `${workspacePath}:/workspace:rw`, '-w', '/workspace', this.image, '/bin/sh', '-lc', workflowScript(steps));
    return args;
  }

  async run({ steps }, { workspace, env = {} } = {}) {
    const safeEnv = safeEnvironment(env);
    const args = this.buildArgs({ steps, envKeys: Object.keys(safeEnv) }, workspace);
    const child = spawn(this.runtime, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        ...safeEnv,
      },
    });
    return new Promise((resolve, reject) => {
      let outputBytes = 0;
      const stdout = [];
      const stderr = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGKILL');
        settled = true;
        reject(new Error('isolated workflow timed out'));
      }, this.timeoutMs);
      timer.unref?.();
      const collect = (target, chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > this.maxOutputBytes && !settled) {
          settled = true;
          child.kill('SIGKILL');
          clearTimeout(timer);
          reject(new Error('isolated workflow output exceeded configured limit'));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', (chunk) => collect(stdout, chunk));
      child.stderr.on('data', (chunk) => collect(stderr, chunk));
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      });
    });
  }
}

export function createGitHubActionsHandler({ runner, workspaceForJob, secretProvider = async () => ({}) } = {}) {
  if (!runner || typeof runner.run !== 'function') throw new Error('runner is required');
  if (typeof workspaceForJob !== 'function') throw new Error('workspaceForJob is required');
  return async (payload, job) => {
    const parameters = payload?.parameters;
    if (!parameters) throw new Error('workflow job parameters are missing');
    const workspace = await workspaceForJob(payload, job);
    const env = await secretProvider(payload, job);
    return runner.run({ steps: parameters.steps }, { workspace, env });
  };
}
