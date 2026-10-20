import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { diffFiles, diffNames, loadDiffSide } from '../src/git.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kydiff-test-'));
  const sh = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
  sh('init', '-q');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'x\n');
  sh('add', '.');
  sh('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nB\n');
  sh('add', 'f.txt');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nB\nc\n');
  fs.rmSync(path.join(dir, 'old.txt'));
  return dir;
}

test('git diff: index against the working tree, and staged', () => {
  const cwd = process.cwd();
  const dir = repo();
  try {
    process.chdir(dir);
    const work = diffFiles([]);
    assert.deepEqual(work.map((f) => [f.path, f.status]), [['f.txt', 'M'], ['old.txt', 'D']]);
    assert.deepEqual(diffNames([], false), ['index', 'working tree']);
    const [l, r] = work[0].sides.map((s, i) => loadDiffSide(s, diffNames([], false)[i]));
    assert.deepEqual([l.lines, l.path, l.label], [['a', 'B'], '-', 'f.txt (index)']);
    assert.deepEqual([r.lines, r.path], [['a', 'B', 'c'], 'f.txt']);
    assert.deepEqual(loadDiffSide(work[1].sides[1], 'working tree').lines, []);

    const staged = diffFiles(['--cached']);
    assert.deepEqual(staged.map((f) => f.path), ['f.txt']);
    assert.deepEqual(staged[0].sides.map((s) => loadDiffSide(s, 'x').lines), [['a', 'b'], ['a', 'B']]);
    assert.deepEqual(diffNames(['--cached'], true), ['HEAD', 'index']);
    assert.deepEqual(diffNames(['HEAD~0..HEAD', '--', 'f.txt'], false), ['HEAD~0', 'HEAD']);
    assert.deepEqual(diffNames(['f.txt'], false), ['index', 'working tree']);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
