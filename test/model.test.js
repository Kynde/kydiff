import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Merge, parseText, serialize } from '../src/model.js';
import { decode } from '../src/term.js';
import { Buffer } from '../src/editor.js';

const file = (text, label) => ({ path: label, label, mtime: null, ...parseText(text) });

function sample() {
  return new Merge([file('a\nb\nc\nd\n', 'L'), file('a\nB\nc\nd\ne\n', 'R')]);
}

test('segments and hunks', () => {
  const m = sample();
  assert.deepEqual(m.segments.map((s) => s.type), ['eq', 'hunk', 'eq', 'hunk']);
  assert.equal(m.hunks.length, 2);
  assert.deepEqual(m.hunks[1].lens, [0, 1]);
});

test('output follows selections, unresolved policy and order', () => {
  const m = sample();
  const [h1, h2] = m.hunks;
  assert.deepEqual(m.output({ unresolved: 0 }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(m.output({ unresolved: 1 }), ['a', 'B', 'c', 'd', 'e']);
  assert.deepEqual(m.output(), ['a', '<<<<<<< L', 'b', '=======', 'B', '>>>>>>> R', 'c', 'd', '<<<<<<< L', '=======', 'e', '>>>>>>> R']);
  m.apply([{ h: h1, sel: [1, 0] }, { h: h2, sel: [] }]);
  assert.deepEqual(m.output(), ['a', 'B', 'b', 'c', 'd']);
  m.apply([{ h: h1, sel: [0], edit: ['x', 'y'] }]);
  assert.deepEqual(m.output(), ['a', 'x', 'y', 'c', 'd']);
});

test('undo and redo restore whole steps', () => {
  const m = sample();
  const [h1, h2] = m.hunks;
  m.apply([{ h: h1, sel: [0] }, { h: h2, sel: [0] }]);
  m.apply([{ h: h1, sel: [1] }]);
  m.undo();
  assert.deepEqual([h1.sel, h2.sel], [[0], [0]]);
  m.undo();
  assert.deepEqual([h1.sel, h2.sel], [null, null]);
  m.redo();
  assert.deepEqual([h1.sel, h2.sel], [[0], [0]]);
  assert.equal(m.apply([{ h: h1, sel: [0] }]), false, 'no-op changes are not recorded');
});

test('line endings, BOM and final newline round-trip', () => {
  for (const text of ['a\r\nb\r\n', '﻿a\nb', 'a\nb\r\nc\n', '']) {
    const f = parseText(text);
    assert.equal(serialize(f, f.lines), text);
  }
  assert.deepEqual(parseText('a\nb\r\n').lines, ['a', 'b\r'], 'mixed endings stay visible');
});

test('key decoding', () => {
  assert.deepEqual(decode('j\x1b[A\x1b[1;5C\x1b[Z\r\x7f\x04'), ['j', 'up', 'C-right', 'S-tab', 'enter', 'backspace', 'C-d']);
  assert.deepEqual(decode('\x1b'), ['escape']);
  assert.deepEqual(decode('\x1bx'), ['M-x']);
  assert.deepEqual(decode('\x1b[<0;10;5M'), [{ type: 'mouse', action: 'down', button: 0, x: 9, y: 4, shift: false, ctrl: false }]);
  assert.equal(decode('\x1b[<65;1;1M')[0].action, 'wheeldown');
  const st = { paste: null };
  assert.deepEqual(decode('\x1b[200~one\ntw', st), []);
  assert.deepEqual(decode('o\x1b[201~q', st), [{ type: 'paste', text: 'one\ntwo' }, 'q']);
});

test('editor buffer', () => {
  const b = new Buffer(['hello', 'world']);
  b.end(); b.insert('!\nnew');
  assert.deepEqual(b.lines, ['hello!', 'new', 'world']);
  b.home(); b.backspace();
  assert.deepEqual(b.lines, ['hello!new', 'world']);
  b.vertical(1, 4); b.killEnd();
  assert.deepEqual(b.lines, ['hello!new', 'world']);
  b.home(); b.killEnd();
  assert.deepEqual(b.lines, ['hello!new', '']);
});

test('per-row decisions', () => {
  const m = new Merge([file('x\n1\n2\n3\ny\n', 'L'), file('x\nA\nB\ny\n', 'R')]);
  const [h] = m.hunks;
  assert.equal(h.height, 3);
  m.applyRow(h, 0, [1]);
  assert.equal(m.isResolved(h), false);
  assert.deepEqual(m.output({ unresolved: 0 }), ['x', 'A', '2', '3', 'y']);
  assert.deepEqual(m.output(), ['x', 'A', '<<<<<<< L', '2', '3', '=======', 'B', '>>>>>>> R', 'y']);
  m.applyRow(h, 1, [0, 1]);
  m.applyRow(h, 2, []);
  assert.deepEqual(m.resolved(h), ['A', '2', 'B']);
  m.applyRow(h, 1, [1]);
  m.applyRow(h, 2, [1]);
  assert.equal(h.rows, null, 'uniform rows fold back into a hunk decision');
  assert.deepEqual(h.sel, [1]);
  m.undo();
  assert.deepEqual(h.rows, [[1], [1], []]);
});

test('three-way: automatic resolution, conflicts and diff3 markers', () => {
  const m = new Merge([
    file('a\nB\nc\nX\ne\n', 'ours'),
    file('a\nb\nc\nd\ne\n', 'base'),
    file('a\nb\nc\nY\ne\nf\n', 'theirs'),
  ]);
  assert.ok(m.three);
  const [h1, h2, h3] = m.hunks;
  assert.deepEqual(h1.sel, [0], 'only ours changed b');
  assert.equal(h2.conflict, true, 'both changed d');
  assert.deepEqual(h3.sel, [2], 'only theirs added f');
  assert.deepEqual(m.stats(), { total: 3, unresolved: 1, edited: 0, auto: 2, conflicts: 1 });
  assert.deepEqual(m.output(), ['a', 'B', 'c', '<<<<<<< ours', 'X', '||||||| base', 'd', '=======', 'Y', '>>>>>>> theirs', 'e', 'f']);
  assert.equal(m.lineState(h1, 1, 0).state, 'drop');
  m.apply([{ h: h2, sel: [2, 0] }]);
  assert.deepEqual(m.resolved(h2), ['Y', 'X']);
  assert.equal(m.version, 1, 'automatic resolution is not an edit');
});

test('three-way: unchanged side shows as same, not dropped', () => {
  const m = new Merge([file('x\n', 'o'), file('x\n', 'b'), file('y\n', 't')]);
  const [h] = m.hunks;
  assert.deepEqual(h.sel, [2]);
  assert.equal(m.lineState(h, 0, 0).state, 'same');
  assert.equal(m.lineState(h, 1, 0).state, 'drop');
});

test('conflict markers', async () => {
  const { parseConflicts } = await import('../src/markers.js');
  const p = parseConflicts(['a', '<<<<<<< HEAD', 'X', '||||||| base', 'b', '=======', 'Y', '>>>>>>> feature', 'c',
    '<<<<<<< HEAD', 'P', '=======', 'Q', '>>>>>>> feature']);
  assert.deepEqual(p.ours, ['a', 'X', 'c', 'P']);
  assert.deepEqual(p.base, ['a', 'b', 'c']);
  assert.deepEqual(p.theirs, ['a', 'Y', 'c', 'Q']);
  assert.equal(p.conflicts, 2);
  assert.equal(p.withoutBase, 1);
  assert.deepEqual(p.labels, ['HEAD', 'base', 'feature']);
  assert.throws(() => parseConflicts(['<<<<<<< x', 'a']));
  // A rebuilt merge gives back one conflict per marker block.
  const files = [p.ours, p.base, p.theirs].map((l, i) => file(l.join('\n') + '\n', ['o', 'b', 't'][i]));
  assert.equal(new Merge(files).stats().conflicts, 2);
});
