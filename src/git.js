// Source — Git integration.
//
// Git remains authoritative for source. Source invokes the `git` CLI for
// bare-repo storage, clone/fetch/push, ref inspection, and canonical-state
// updates. No packfile/network behavior is reimplemented.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

function run(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

const execFileAsync = promisify(execFile);

async function runAsync(args, opts = {}) {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  return String(stdout || '').trim();
}

export class GitRepo {
  constructor(barePath) {
    this.barePath = barePath;
  }

  // Initialize a bare repository (synchronous).
  init(defaultBranch = 'main') {
    fs.mkdirSync(this.barePath, { recursive: true });
    run(['init', '--bare', '--initial-branch', defaultBranch, this.barePath]);
    return this;
  }

  // Resolve a ref to a commit hash (empty string if unborn).
  revParse(ref) {
    try {
      return run(['rev-parse', ref], { cwd: this.barePath });
    } catch {
      return '';
    }
  }

  defaultBranch() {
    try {
      return run(['symbolic-ref', '--short', 'HEAD'], { cwd: this.barePath });
    } catch {
      return 'main';
    }
  }

  // List refs (branches) as {name, hash}.
  listBranches() {
    const out = run(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], {
      cwd: this.barePath,
    });
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [name, hash] = line.split(' ');
      return { name, hash };
    });
  }

  // Does `ancestor` exist and is it an ancestor of `descendant`?
  isAncestor(ancestor, descendant) {
    try {
      run(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: this.barePath });
      return true;
    } catch {
      return false;
    }
  }

  // Fast-forward the default branch to `head` only if `base` is an ancestor of
  // the current default branch tip (TOCTOU guard). Returns {ok, reason}.
  fastForward(base, head, branch) {
    const tip = this.revParse(branch);
    if (!tip) {
      // Unborn branch: create it at head.
      run(['update-ref', `refs/heads/${branch}`, head], { cwd: this.barePath });
      return { ok: true, reason: 'created' };
    }
    if (!this.isAncestor(base, tip)) {
      return { ok: false, reason: 'non-fast-forward: base is not an ancestor of current tip' };
    }
    if (!this.isAncestor(tip, head)) {
      return { ok: false, reason: 'head does not descend from current tip' };
    }
    run(['update-ref', `refs/heads/${branch}`, head], { cwd: this.barePath });
    return { ok: true, reason: 'fast-forwarded' };
  }

  // Does a commit exist in this repo?
  hasCommit(hash) {
    try {
      run(['cat-file', '-e', `${hash}^{commit}`], { cwd: this.barePath });
      return true;
    } catch {
      return false;
    }
  }

  // Diff stat between two commits (or empty tree).
  diffStat(base, head) {
    const args = ['diff', '--stat', '--no-renames'];
    if (base) args.push(base, head);
    else args.push(head);
    try {
      return run(args, { cwd: this.barePath });
    } catch {
      return '';
    }
  }

  // Full diff (patch) between two commits (or empty tree).
  diff(base, head) {
    const args = ['diff', '--no-renames'];
    if (base) args.push(base, head);
    else args.push(head);
    try {
      return run(args, { cwd: this.barePath });
    } catch {
      return '';
    }
  }

  // List changed files between base and head.
  changedFiles(base, head) {
    const args = ['diff', '--name-status', '--no-renames'];
    if (base) args.push(base, head);
    else args.push(head);
    try {
      const out = run(args, { cwd: this.barePath });
      return out ? out.split('\n') : [];
    } catch {
      return [];
    }
  }

  // Async counterparts are used by HTTP-facing service paths so Git work does
  // not block the Node event loop. Synchronous methods remain for the CLI and
  // compatibility with the pure application-service tests.
  async revParseAsync(ref) {
    try { return await runAsync(['rev-parse', ref], { cwd: this.barePath }); } catch { return ''; }
  }

  async listBranchesAsync() {
    try {
      const out = await runAsync(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], { cwd: this.barePath });
      if (!out) return [];
      return out.split('\n').map((line) => {
        const [name, hash] = line.split(' ');
        return { name, hash };
      });
    } catch {
      return [];
    }
  }

  async defaultBranchAsync() {
    try { return await runAsync(['symbolic-ref', '--short', 'HEAD'], { cwd: this.barePath }); } catch { return 'main'; }
  }

  async hasCommitAsync(hash) {
    try { await runAsync(['cat-file', '-e', `${hash}^{commit}`], { cwd: this.barePath }); return true; } catch { return false; }
  }

  async showFileAsync(ref, filePath) {
    if (typeof ref !== 'string' || !/^[A-Za-z0-9._/@-]{1,200}$/.test(ref)) throw new Error('invalid Git ref');
    if (typeof filePath !== 'string' || filePath.includes('..') || filePath.startsWith('/') || filePath.includes(':')) throw new Error('invalid repository file path');
    return runAsync(['show', `${ref}:${filePath}`], { cwd: this.barePath });
  }

  async listCommitsAsync(ref = 'HEAD', limit = 50) {
    if (typeof ref !== 'string' || !/^[A-Za-z0-9._/@-]{1,200}$/.test(ref)) throw new Error('invalid Git ref');
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)));
    try {
      const out = await runAsync(['log', `-${safeLimit}`, '--date=iso-strict', '--format=%H%x09%an%x09%ad%x09%s', ref], { cwd: this.barePath });
      return out ? out.split('\n').map((line) => {
        const [hash, author, date, ...subject] = line.split('\t');
        return { hash, author, date, subject: subject.join('\t') };
      }) : [];
    } catch {
      return [];
    }
  }

  async listTreeAsync(ref = 'HEAD', directory = '') {
    if (typeof ref !== 'string' || !/^[A-Za-z0-9._/@-]{1,200}$/.test(ref)) throw new Error('invalid Git ref');
    if (typeof directory !== 'string' || directory.includes('..') || directory.startsWith('/') || directory.includes(':')) throw new Error('invalid repository path');
    const treeRef = directory ? `${ref}:${directory.replace(/\/$/, '')}` : ref;
    try {
      const out = await runAsync(['ls-tree', '-z', treeRef], { cwd: this.barePath });
      return out ? out.split('\0').filter(Boolean).map((entry) => {
        const tab = entry.indexOf('\t');
        const [mode, type, hash] = entry.slice(0, tab).split(' ');
        return { mode, type, hash, name: entry.slice(tab + 1) };
      }) : [];
    } catch {
      return [];
    }
  }

  async commitDiffAsync(hash) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{7,64}$/i.test(hash)) throw new Error('invalid commit');
    try { return await runAsync(['show', '--format=fuller', '--stat', '--patch', hash], { cwd: this.barePath }); } catch { return ''; }
  }

  async isAncestorAsync(ancestor, descendant) {
    try { await runAsync(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: this.barePath }); return true; } catch { return false; }
  }

  async fastForwardAsync(base, head, branch) {
    const tip = await this.revParseAsync(branch);
    if (!tip) {
      await runAsync(['update-ref', `refs/heads/${branch}`, head], { cwd: this.barePath });
      return { ok: true, reason: 'created' };
    }
    if (!(await this.isAncestorAsync(base, tip))) return { ok: false, reason: 'non-fast-forward: base is not an ancestor of current tip' };
    if (!(await this.isAncestorAsync(tip, head))) return { ok: false, reason: 'head does not descend from current tip' };
    await runAsync(['update-ref', `refs/heads/${branch}`, head], { cwd: this.barePath });
    return { ok: true, reason: 'fast-forwarded' };
  }

  async diffAsync(base, head) {
    const args = ['diff', '--no-renames'];
    if (base) args.push(base, head); else args.push(head);
    try { return await runAsync(args, { cwd: this.barePath }); } catch { return ''; }
  }

  async changedFilesAsync(base, head) {
    const args = ['diff', '--name-status', '--no-renames'];
    if (base) args.push(base, head); else args.push(head);
    try {
      const out = await runAsync(args, { cwd: this.barePath });
      return out ? out.split('\n') : [];
    } catch { return []; }
  }
}

// Clone a bare repo into a working directory (for the dogfood/contribution flow).
export function clone(barePath, workDir) {
  run(['clone', barePath, workDir]);
  return workDir;
}

// Run an arbitrary git command in a working directory (read-only helpers).
export function gitIn(cwd, args) {
  return run(args, { cwd });
}
