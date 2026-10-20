// Reading merge conflicts straight from git's index. During a conflicted
// merge, stage 1 holds the base version of a file, stage 2 ours and stage 3
// theirs.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseText, loadFile } from './model.js';

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

export function inRepo() {
  try {
    git(['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export function stage(path) {
  git(['add', '--', path]);
}

const NULL_SHA = /^0+$/;

// The files a `git diff ARGS` would show, with what to load for each side:
// [{ path, status, sides: [{ sha, file, path }, { sha, file, path }] }].
// A side has a blob sha, or file when it is the working
// tree copy, or neither when the file doesn't exist on that side. Paths are
// relative to the current directory.
export function diffFiles(args = []) {
  let out, top;
  try {
    top = git(['rev-parse', '--show-toplevel']).toString('utf8').trim();
    out = git(['diff', '--raw', '-z', '--no-abbrev', '--no-color', '--no-ext-diff', ...args]).toString('utf8');
  } catch (e) {
    throw new Error(e.stderr?.toString().trim() || 'not a git repository');
  }
  const recs = out.split('\0');
  const files = [];
  for (let i = 0; i < recs.length; i++) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(recs[i]);
    if (!m) continue;
    const [, srcMode, dstMode, srcSha, dstSha, status] = m;
    const src = recs[++i];
    const dst = 'RC'.includes(status) ? recs[++i] : src;
    // Unmerged entries are for kydiff --git; gitlinks are submodules.
    if (status === 'U' || srcMode === '160000' || dstMode === '160000') continue;
    // Only the mode changed.
    if (srcSha === dstSha && !NULL_SHA.test(srcSha) && src === dst) continue;
    const rel = (p) => path.relative(process.cwd(), path.join(top, p)) || p;
    const side = (sha, mode, p) => {
      if (NULL_SHA.test(mode)) return { path: rel(p) };
      if (NULL_SHA.test(sha)) return { file: rel(p), path: rel(p) };
      return { sha, path: rel(p) };
    };
    files.push({ path: rel(dst), status, sides: [side(srcSha, srcMode, src), side(dstSha, dstMode, dst)] });
  }
  return files;
}

// What the two sides of `git diff ARGS` are, for labels: the revisions
// before "--" (A..B and A...B count as two), the rest being paths.
export function diffNames(args, cached) {
  const end = args.includes('--') ? args.indexOf('--') : args.length;
  const revs = [];
  for (const a of args.slice(0, end)) {
    if (a.startsWith('-')) continue;
    const range = /^(.*?)\.\.\.?(.*)$/.exec(a);
    if (range) { revs.push(range[1] || 'HEAD', range[2] || 'HEAD'); continue; }
    try {
      git(['rev-parse', '--verify', '--quiet', `${a}^{commit}`]);
      revs.push(a);
    } catch {
      // A path.
    }
  }
  if (revs.length >= 2) return revs.slice(0, 2);
  if (revs.length === 1) return [revs[0], cached ? 'index' : 'working tree'];
  return cached ? ['HEAD', 'index'] : ['index', 'working tree'];
}

// One side of a diffFiles entry as a model file. Only the working tree copy
// is a file that can be saved over.
export function loadDiffSide(side, name) {
  if (side.file) return loadFile(side.file, `${side.path} (working tree)`);
  const text = side.sha ? git(['cat-file', 'blob', side.sha]) : Buffer.alloc(0);
  if (text.subarray(0, 8000).includes(0)) throw new Error(`${side.path}: binary file`);
  const label = `${side.path} (${side.sha ? name : `not in ${name}`})`;
  return { path: '-', name: side.path, label, mtime: null, ...parseText(text.toString('utf8')) };
}
