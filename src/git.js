// Source — Git integration.
//
// Git remains authoritative for source. Source invokes the `git` CLI for
// bare-repo storage, clone/fetch/push, ref inspection, and canonical-state
// updates. No packfile/network behavior is reimplemented.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function run(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
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

  // Enable anonymous push over smart HTTP. `git http-backend` disables
  // receive-pack for unauthenticated users by default; the MVP has no auth, so
  // this is set explicitly. Replaced by capability-gated auth in a later phase.
  enableReceivePack() {
    run(['config', 'http.receivepack', 'true'], { cwd: this.barePath });
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
