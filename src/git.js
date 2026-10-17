// Reading merge conflicts straight from git's index. During a conflicted
// merge, stage 1 holds the base version of a file, stage 2 ours and stage 3
// theirs.

import { execFileSync } from 'node:child_process';
import { parseText } from './model.js';

function git(args, input) {
  return execFileSync('git', args, { maxBuffer: 1 << 30, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
}

// Unmerged paths (relative to the current directory) and their stage blobs:
// [{ path, stages: { 1: sha, 2: sha, 3: sha } }]. A missing stage means the
// file didn't exist there (added on both sides, or deleted on one).
export function conflicts(paths = []) {
  let out;
  try {
    out = git(['ls-files', '-u', '-z', '--', ...paths]).toString('utf8');
  } catch (e) {
    throw new Error(e.stderr?.toString().trim() || 'not a git repository');
  }
  const byPath = new Map();
  for (const rec of out.split('\0')) {
    const m = /^\d+ ([0-9a-f]+) ([123])\t(.*)$/s.exec(rec);
    if (!m) continue;
    if (!byPath.has(m[3])) byPath.set(m[3], { path: m[3], stages: {} });
    byPath.get(m[3]).stages[m[2]] = m[1];
  }
  return [...byPath.values()];
}

// The three versions of a conflicted file, as model files.
export function loadConflict({ path, stages }) {
  const roles = [[2, 'ours'], [1, 'base'], [3, 'theirs']];
  return roles.map(([stage, role]) => {
    const sha = stages[stage];
    const text = sha ? git(['cat-file', 'blob', sha]) : Buffer.alloc(0);
    if (text.subarray(0, 8000).includes(0)) throw new Error(`${path}: binary file`);
    // path '-': these aren't files that can be saved over.
    return { path: '-', name: path, label: `${path} (${role}${sha ? '' : ', missing'})`, mtime: null, ...parseText(text.toString('utf8')) };
  });
}

export function stage(path) {
  git(['add', '--', path]);
}
