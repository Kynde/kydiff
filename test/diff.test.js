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
    for (let k = 1; k < ops.length; k++) assert.ok(!(ops[k].eq && ops[k - 1].eq));
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

test('diff3 regions', async () => {
  const { diff3 } = await import('../src/diff.js');
  const base = ['a', 'b', 'c', 'd', 'e'];
  const ours = ['a', 'B', 'c', 'd', 'e', 'f'];
  const theirs = ['a', 'b', 'c', 'D', 'e'];
  const r = diff3(ours, base, theirs);
  assert.deepEqual(r.map((x) => [x.eq, x.start, x.lens]), [
    [true, [0, 0, 0], [1, 1, 1]],
    [false, [1, 1, 1], [1, 1, 1]],
    [true, [2, 2, 2], [1, 1, 1]],
    [false, [3, 3, 3], [1, 1, 1]],
    [true, [4, 4, 4], [1, 1, 1]],
    [false, [5, 5, 5], [1, 0, 0]],
  ]);
});

test('diff3 covers all three files (random)', async () => {
  const { diff3 } = await import('../src/diff.js');
  let seed = 3;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const mutate = (xs) => xs.flatMap((x) => { const r = rnd(10); return r === 0 ? [] : r === 1 ? [x, 'n' + rnd(3)] : r === 2 ? ['m' + rnd(3)] : [x]; });
  for (let i = 0; i < 1000; i++) {
    const base = Array.from({ length: rnd(15) }, () => 'l' + rnd(5));
    const ours = mutate(base), theirs = mutate(base);
    const files = [ours, base, theirs];
    const pos = [0, 0, 0];
    for (const reg of diff3(ours, base, theirs)) {
      assert.deepEqual(reg.start, pos);
      if (reg.eq) for (let k = 0; k < reg.lens[0]; k++) assert.ok(ours[pos[0] + k] === base[pos[1] + k] && base[pos[1] + k] === theirs[pos[2] + k]);
      else assert.ok(reg.lens.some((n) => n > 0));
      reg.lens.forEach((n, s) => { pos[s] += n; });
    }
    assert.deepEqual(pos, files.map((f) => f.length));
  }
});

test('alignLines pairs similar lines', async () => {
  const { alignLines, alignLines3, similarity } = await import('../src/diff.js');
  assert.ok(similarity('function greet(name) {', "function greet(name, greeting = 'Hello') {") > 0.6);
  assert.ok(similarity('function greet(name) {', 'function mul(a, b) {') < 0.6);
  // An inserted line no longer shifts the pairing of the changed ones.
  const a = ['let x = compute(a);', 'return x + 1;'];
  const b = ['// new comment line', 'let x = compute(a, b);', 'return x + 2;'];
  assert.deepEqual(alignLines(a, b), [[-1, 0], [0, 1], [1, 2]]);
  // Dissimilar leftovers still share rows in order.
  assert.deepEqual(alignLines(['aaa', 'bbb'], ['xxx']), [[0, 0], [1, -1]]);
  assert.deepEqual(alignLines([], ['x', 'y']), [[-1, 0], [-1, 1]]);
  // Every line of both sides appears once, in order (random).
  let seed = 5;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const word = () => ['foo', 'bar', 'baz', '}', ''][rnd(5)] + (rnd(2) ? ' qux' : '');
  for (let t = 0; t < 500; t++) {
    const x = Array.from({ length: rnd(8) }, word), y = Array.from({ length: rnd(8) }, word), z = Array.from({ length: rnd(8) }, word);
    const rows = alignLines3(x, y, z);
    [x, y, z].forEach((s, side) => assert.deepEqual(rows.map((r) => r[side]).filter((v) => v >= 0), s.map((_, i) => i)));
    assert.ok(rows.every((r) => r.some((v) => v >= 0)));
  }
});

test('regroup pairs a changed block with its real counterpart', () => {
  const base = ['add() {', '}', '', 'function greet(name) {', "  log('Hello, ' + name);", '}', '', "export const V = '1.0.0';"];
  const theirs = ['add() {', '}', '', 'function mul(a, b) {', '  return a * b;', '}', '',
    "function greet(name, greeting = 'Hello') {", "  log(greeting + ', ' + name);", '}', '', "export const V = '1.0.1';"];
  const changes = (x, y) => diffLines(x, y).filter((o) => !o.eq).map((o) => [x.slice(o.a0, o.a1), y.slice(o.b0, o.b1)]);
  const fwd = changes(base, theirs);
  assert.deepEqual(fwd, [
    [[], ['function mul(a, b) {', '  return a * b;', '}', '']],
    [['function greet(name) {', "  log('Hello, ' + name);"], ["function greet(name, greeting = 'Hello') {", "  log(greeting + ', ' + name);"]],
    [["export const V = '1.0.0';"], ["export const V = '1.0.1';"]],
  ]);
  // Mirrored: the same pairing when deleting instead of inserting.
  assert.deepEqual(changes(theirs, base), fwd.map(([x, y]) => [y, x]));
});
