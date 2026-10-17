import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSeq, diffLines, wordDiff } from '../src/diff.js';

function lcsLen(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

function check(a, b, ops) {
  let i = 0, j = 0, same = 0;
  for (const op of ops) {
    assert.equal(op.a0, i); assert.equal(op.b0, j);
    if (op.eq) {
      assert.equal(op.a1 - op.a0, op.b1 - op.b0);
      for (let k = 0; k < op.a1 - op.a0; k++) assert.equal(a[op.a0 + k], b[op.b0 + k]);
      same += op.a1 - op.a0;
    }
    i = op.a1; j = op.b1;
  }
  assert.equal(i, a.length); assert.equal(j, b.length);
  return same;
}

test('myers finds a minimal diff (random)', () => {
  let seed = 1;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let t = 0; t < 2000; t++) {
    const a = Array.from({ length: rnd(25) }, () => rnd(4));
    const b = Array.from({ length: rnd(25) }, () => rnd(4));
    const ops = diffSeq(Int32Array.from(a), Int32Array.from(b));
    assert.equal(check(a, b, ops), lcsLen(a, b), `a=${a} b=${b}`);
  }
});

test('diffLines produces valid ops after sliding (random)', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const words = ['', '}', '{', 'x', 'y'];
  for (let t = 0; t < 2000; t++) {
    const a = Array.from({ length: rnd(20) }, () => words[rnd(words.length)]);
    const b = Array.from({ length: rnd(20) }, () => words[rnd(words.length)]);
    const ops = diffLines(a, b);
    assert.equal(check(a, b, ops), lcsLen(a, b));
    for (let k = 1; k < ops.length; k++) assert.notEqual(ops[k].eq, ops[k - 1].eq);
  }
});

test('inserted function is shown as a whole block', () => {
  const a = ['f1 {', '}', '', 'f3 {', '}'];
  const b = ['f1 {', '}', '', 'f2 {', '}', '', 'f3 {', '}'];
  const ops = diffLines(a, b);
  const ins = ops.find((o) => !o.eq);
  assert.deepEqual(b.slice(ins.b0, ins.b1), ['f2 {', '}', '']);
});

test('ignore whitespace', () => {
  const ops = diffLines(['a  b', 'c'], ['a b', 'c'], { ignoreSpaceChange: true });
  assert.equal(ops.length, 1);
  assert.ok(ops[0].eq);
});

test('wordDiff marks changed words', () => {
  const [ra, rb] = wordDiff('const x = foo(1);', 'const x = bar(1);');
  assert.deepEqual(ra, [[10, 13]]);
  assert.deepEqual(rb, [[10, 13]]);
  assert.equal(wordDiff('completely different', 'nothing alike here'), null);
});
