// Line and word diffing.
//
// Core is Myers' O(ND) algorithm in its linear-space form (middle snake +
// divide and conquer), operating on integer id arrays. Results are expressed
// as "ops": contiguous runs covering both sequences,
//   { eq: true|false, a0, a1, b0, b1 }

export function diffSeq(A, B) {
  const matches = []; // [ai, bi, len] in order
  const emit = (ai, bi, len) => {
    const last = matches[matches.length - 1];
    if (last && last[0] + last[2] === ai && last[1] + last[2] === bi) last[2] += len;
    else matches.push([ai, bi, len]);
  };

  // Shared work arrays, sized for the worst case.
  const maxD = Math.ceil((A.length + B.length) / 2) + 2;
  const Vf = new Int32Array(2 * maxD + 3);
  const Vb = new Int32Array(2 * maxD + 3);

  function middleSnake(a0, a1, b0, b1) {
    const N = a1 - a0, M = b1 - b0, delta = N - M, odd = (delta & 1) !== 0;
    const max = Math.ceil((N + M) / 2), off = max + 1;
    Vf[off + 1] = 0;
    Vb[off + 1] = 0;
    for (let d = 0; d <= max; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && Vf[off + k - 1] < Vf[off + k + 1])) ? Vf[off + k + 1] : Vf[off + k - 1] + 1;
        let y = x - k;
        const x0 = x, y0 = y;
        while (x < N && y < M && A[a0 + x] === B[b0 + y]) { x++; y++; }
        Vf[off + k] = x;
        if (odd) {
          const kb = delta - k;
          if (kb >= -(d - 1) && kb <= d - 1 && x + Vb[off + kb] >= N) {
            return [a0 + x0, b0 + y0, a0 + x, b0 + y];
          }
        }
      }
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && Vb[off + k - 1] < Vb[off + k + 1])) ? Vb[off + k + 1] : Vb[off + k - 1] + 1;
        let y = x - k;
        const x0 = x, y0 = y;
        while (x < N && y < M && A[a1 - 1 - x] === B[b1 - 1 - y]) { x++; y++; }
        Vb[off + k] = x;
        if (!odd) {
          const kf = delta - k;
          if (kf >= -d && kf <= d && x + Vf[off + kf] >= N) {
            return [a0 + N - x, b0 + M - y, a0 + N - x0, b0 + M - y0];
          }
        }
      }
    }
    throw new Error('diff: middle snake not found');
  }

  function rec(a0, a1, b0, b1) {
    let p = 0;
    while (a0 + p < a1 && b0 + p < b1 && A[a0 + p] === B[b0 + p]) p++;
    if (p) emit(a0, b0, p);
    a0 += p; b0 += p;
    let s = 0;
    while (a1 - s > a0 && b1 - s > b0 && A[a1 - 1 - s] === B[b1 - 1 - s]) s++;
    a1 -= s; b1 -= s;
    if (a0 < a1 && b0 < b1) {
      const [x, y, u, v] = middleSnake(a0, a1, b0, b1);
      rec(a0, x, b0, y);
      if (u > x) emit(x, y, u - x);
      rec(u, a1, v, b1);
    }
    if (s) emit(a1, b1, s);
  }

  rec(0, A.length, 0, B.length);

  const ops = [];
  let i = 0, j = 0;
  for (const [ai, bi, len] of matches) {
    if (ai > i || bi > j) ops.push({ eq: false, a0: i, a1: ai, b0: j, b1: bi });
    ops.push({ eq: true, a0: ai, a1: ai + len, b0: bi, b1: bi + len });
    i = ai + len; j = bi + len;
  }
  if (i < A.length || j < B.length) ops.push({ eq: false, a0: i, a1: A.length, b0: j, b1: B.length });
  return ops;
}

export function normalizer(opts = {}) {
  if (opts.ignoreAllSpace) return (s) => s.replace(/\s+/g, '');
  if (opts.ignoreSpaceChange) return (s) => s.replace(/\s+/g, ' ').trim();
  return (s) => s;
}

// Diff two arrays of strings. Returns ops, with pure insertions/deletions
// slid to more natural positions (see slide()).
export function diffLines(a, b, opts = {}) {
  const norm = normalizer(opts);
  const ids = new Map();
  const intern = (s) => {
    const k = norm(s);
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    return id;
  };
  const A = Int32Array.from(a, intern);
  const B = Int32Array.from(b, intern);
  const ops = diffSeq(A, B);
  slide(ops, A, B, a, b);
  return regroup(ops.filter((o) => o.a1 > o.a0 || o.b1 > o.b0), A, B, a, b);
}

// Myers picks one of several equally short diffs, and sometimes pairs a
// changed line with the wrong replacement, e.g. when one side adds a
// function right before a function it also changed:
//
//   [change D -> I][equal E][change K -> J+E+R]   (K and/or R may be empty)
//   is the same as
//   [insert I+E][change D -> J][equal E][change K -> R]
//
// Choose whichever pairs the changed lines with more similar ones. Also
//
//   [change D -> I+E+J][equal E]  is the same as  [insert I+E][change D -> J][equal E]
//
// which is preferred when D pairs with J alone just as well. The
// mirrored cases (deleting instead of inserting, or the order reversed) are
// handled by swapping the sides and/or reversing the sequences.
function regroup(ops, A, B, a, b) {
  const swap = (os) => os.map((o) => ({ eq: o.eq, a0: o.b0, a1: o.b1, b0: o.a0, b1: o.a1 }));
  const rev = (os, n, m) => os.map((o) => ({ eq: o.eq, a0: n - o.a1, a1: n - o.a0, b0: m - o.b1, b1: m - o.b0 })).reverse();
  const variants = [
    [(os) => os, (os) => os, A, B, a, b],
    [swap, swap, B, A, b, a],
  ];
  for (let pass = 0; pass < 2; pass++) {
    for (const [to, from, X, Y, x, y] of variants) {
      let os = to(ops);
      if (pass) os = rev(os, X.length, Y.length);
      const [Xs, Ys, xs, ys] = pass ? [[...X].reverse(), [...Y].reverse(), [...x].reverse(), [...y].reverse()] : [X, Y, x, y];
      os = regroupForward(os, Xs, Ys, xs, ys);
      if (pass) os = rev(os, X.length, Y.length);
      ops = from(os);
    }
  }
  return ops;
}

function regroupForward(ops, A, B, a, b) {
  for (let n = 0; n + 1 < ops.length; n++) {
    const [c, e] = [ops[n], ops[n + 1]];
    if (c.eq || !e.eq || c.a0 === c.a1 || tooBig(c)) continue;
    const L = e.a1 - e.a0;
    const D = a.slice(c.a0, c.a1);
    const whole = blockSimilarity(D, b.slice(c.b0, c.b1));
    if (!whole) continue;
    let best = -1;
    for (let p = c.b1 - L - 1; p >= c.b0; p--) {
      let match = true;
      for (let k = 0; k < L && match; k++) match = B[p + k] === B[e.b0 + k];
      if (match && blockSimilarity(D, b.slice(p + L, c.b1)) >= whole - 0.01) { best = p; break; }
    }
    if (best < 0) continue;
    ops.splice(n, 1,
      { eq: false, a0: c.a0, a1: c.a0, b0: c.b0, b1: best + L },
      { eq: false, a0: c.a0, a1: c.a1, b0: best + L, b1: c.b1 });
  }
  for (let n = 0; n + 2 < ops.length; n++) {
    const [c, e, j] = [ops[n], ops[n + 1], ops[n + 2]];
    if (c.eq || !e.eq || j.eq || c.a0 === c.a1 || c.b0 === c.b1 || tooBig(c) || tooBig(j)) continue;
    const L = e.a1 - e.a0;
    const D = a.slice(c.a0, c.a1), I = b.slice(c.b0, c.b1), K = a.slice(j.a0, j.a1);
    const current = blockSimilarity(D, I) + blockSimilarity(K, b.slice(j.b0, j.b1));
    let best = -1, bestScore = current + 0.01;
    // Where E appears again in the new side of the next change.
    for (let p = j.b0 + 1; p + L <= j.b1; p++) {
      let match = true;
      for (let k = 0; k < L && match; k++) match = B[p + k] === B[e.b0 + k];
      if (!match) continue;
      const score = blockSimilarity(D, b.slice(j.b0, p)) + blockSimilarity(K, b.slice(p + L, j.b1));
      if (score > bestScore) { best = p; bestScore = score; }
    }
    if (best < 0) continue;
    const out = [
      { eq: false, a0: c.a0, a1: c.a0, b0: c.b0, b1: e.b1 },
      { eq: false, a0: c.a0, a1: c.a1, b0: j.b0, b1: best },
      { eq: true, a0: e.a0, a1: e.a1, b0: best, b1: best + L },
      { eq: false, a0: j.a0, a1: j.a1, b0: best + L, b1: j.b1 },
    ].filter((o) => o.a1 > o.a0 || o.b1 > o.b0);
    ops.splice(n, 3, ...out);
  }
  // Merge equal runs the rewrite may have left side by side. Adjacent
  // changes stay apart: they are separate decisions.
  const out = [];
  for (const o of ops) {
    const last = out[out.length - 1];
    if (last?.eq && o.eq) { last.a1 = o.a1; last.b1 = o.b1; } else out.push({ ...o });
  }
  return out;
}

// Regrouping compares blocks pairwise; leave huge rewrites as they are.
const tooBig = (o) => (o.a1 - o.a0) * (o.b1 - o.b0) > 20000;

function blockSimilarity(x, y) {
  let score = 0;
  for (const [i, j] of alignLines(x, y)) if (i >= 0 && j >= 0) score += similarity(x[i], y[j]);
  return score;
}

// A pure insertion (or deletion) that is surrounded by lines equal to its own
// edges can be shifted up or down without changing the diff's meaning, e.g.
// an added function whose closing "}" could pair with the previous one's.
// Pick the lowest position that ends the block on a blank line, else the
// lowest position overall (like GNU diff); that tends to read best for code.
function slide(ops, A, B, a, b) {
  // Make sure every change op has an equal op on both sides (possibly empty).
  if (!ops.length) return;
  if (!ops[0].eq) ops.unshift({ eq: true, a0: 0, a1: 0, b0: 0, b1: 0 });
  if (!ops[ops.length - 1].eq) ops.push({ eq: true, a0: A.length, a1: A.length, b0: B.length, b1: B.length });
  for (let n = 1; n < ops.length - 1; n++) {
    const op = ops[n];
    if (op.eq) continue;
    const insert = op.a0 === op.a1;
    if (!insert && op.b0 !== op.b1) continue;
    const S = insert ? B : A, text = insert ? b : a;
    const s = insert ? op.b0 : op.a0, e = insert ? op.b1 : op.a1;
    const prev = ops[n - 1], next = ops[n + 1];
    // An equal run may give up all its lines only at the file edge;
    // otherwise two change blocks would collide.
    const minPrev = prev.a0 === 0 && prev.b0 === 0 ? 0 : 1;
    const minNext = next.a1 === A.length && next.b1 === B.length ? 0 : 1;
    let up = 0, down = 0;
    while (prev.a1 - prev.a0 - up > minPrev && S[s - up - 1] === S[e - up - 1]) up++;
    while (next.a1 - next.a0 - down > minNext && S[s + down] === S[e + down]) down++;
    if (!up && !down) continue;
    let best = down;
    for (let d = down; d >= -up; d--) {
      if (text[e + d - 1].trim() === '') { best = d; break; }
    }
    if (best === 0) continue;
    op.a0 += best; op.a1 += best; op.b0 += best; op.b1 += best;
    prev.a1 += best; prev.b1 += best;
    next.a0 += best; next.b0 += best;
  }
}

// Word-level diff of two lines, for intra-line highlighting.
// Returns [rangesA, rangesB] where ranges are [[start, end], ...] in string
// offsets, or null when the lines are too different to be worth marking.
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

export function wordDiff(a, b) {
  if (a === b) return [[], []];
  const ids = new Map();
  const tok = (s) => {
    const offs = [], seq = [];
    for (const m of s.matchAll(TOKEN)) {
      offs.push(m.index);
      let id = ids.get(m[0]);
      if (id === undefined) { id = ids.size; ids.set(m[0], id); }
      seq.push(id);
    }
    offs.push(s.length);
    return { offs, seq: Int32Array.from(seq) };
  };
  const ta = tok(a), tb = tok(b);
  const ops = diffSeq(ta.seq, tb.seq);
  const ra = [], rb = [];
  let same = 0;
  for (const op of ops) {
    if (op.eq) {
      same += a.slice(ta.offs[op.a0], ta.offs[op.a1]).replace(/\s+/g, '').length;
      continue;
    }
    if (op.a1 > op.a0) addRange(ra, a, ta.offs[op.a0], ta.offs[op.a1]);
    if (op.b1 > op.b0) addRange(rb, b, tb.offs[op.b0], tb.offs[op.b1]);
  }
  const shorter = Math.min(a.replace(/\s+/g, '').length, b.replace(/\s+/g, '').length);
  if (shorter > 0 && same / shorter < 0.3) return null;
  return [ra, rb];
}

// Append [s, e), merging with the previous range when only whitespace
// separates them so highlights read as phrases rather than confetti.
function addRange(ranges, str, s, e) {
  const last = ranges[ranges.length - 1];
  if (last && /^\s*$/.test(str.slice(last[1], s))) last[1] = e;
  else ranges.push([s, e]);
}

// Three-way alignment in the manner of diff3: diff the base against each
// side and split everything into regions that are either unchanged in all
// three or a "chunk" where at least one side differs from the base.
// Returns [{ eq, start: [o, b, t], lens: [no, nb, nt] }] for ours, base,
// theirs.
// For each line of base, the index of the line it matches in side, or -1.
export function matchLines(base, side, opts = {}) {
  const m = new Int32Array(base.length).fill(-1);
  for (const op of diffLines(base, side, opts)) {
    if (op.eq) for (let k = 0; k < op.a1 - op.a0; k++) m[op.a0 + k] = op.b0 + k;
  }
  return m;
}

export function diff3(ours, base, theirs, opts = {}, mo = matchLines(base, ours, opts), mt = matchLines(base, theirs, opts)) {
  const out = [];
  let o = 0, b = 0, t = 0;
  while (b < base.length || o < ours.length || t < theirs.length) {
    // Stable: the base line sits at the current position in both sides.
    let n = 0;
    while (b + n < base.length && mo[b + n] === o + n && mt[b + n] === t + n) n++;
    if (n) {
      out.push({ eq: true, start: [o, b, t], lens: [n, n, n] });
      o += n; b += n; t += n;
      continue;
    }
    // Unstable: runs to the next base line that both sides kept.
    let e = b;
    while (e < base.length && (mo[e] < 0 || mt[e] < 0)) e++;
    const oe = e < base.length ? mo[e] : ours.length;
    const te = e < base.length ? mt[e] : theirs.length;
    out.push({ eq: false, start: [o, b, t], lens: [oe - o, e - b, te - t] });
    o = oe; b = e; t = te;
  }
  return out;
}

// How alike two lines are, 0..1: overlap of their words weighted by length,
// so renaming one identifier in a line keeps it recognisably the same line.
// Lines without words (braces, blank) only match themselves.
const WORD = /[\p{L}\p{N}_]+/gu;

function wordBag(s) {
  const bag = new Map();
  let total = 0;
  for (const w of s.match(WORD) || []) { bag.set(w, (bag.get(w) || 0) + 1); total += w.length; }
  return { bag, total, bare: s.trim() };
}

function bagSimilarity(x, y) {
  if (!x.total || !y.total) return x.bare === y.bare && !x.total && !y.total ? 1 : 0;
  let common = 0;
  const [small, big] = x.bag.size < y.bag.size ? [x, y] : [y, x];
  for (const [w, n] of small.bag) {
    const m = big.bag.get(w);
    if (m) common += Math.min(n, m) * w.length;
  }
  return (2 * common) / (x.total + y.total);
}

export function similarity(a, b) {
  return a === b ? 1 : bagSimilarity(wordBag(a), wordBag(b));
}

// Pair up the lines of a changed block so that similar lines face each
// other: an optimal monotonic matching of pairs at least `threshold` alike.
// Lines left over between matches share rows in order, like a side-by-side
// diff of replaced lines. Returns rows [[i or -1, j or -1], ...] covering
// both. Very large blocks are paired by position.
export function alignLines(a, b, { threshold = 0.6, maxCells = 250000 } = {}) {
  const n = a.length, m = b.length;
  const pairs = [];
  if (n && m && n * m <= maxCells) {
    const ba = a.map(wordBag), bb = b.map(wordBag);
    const W = m + 1;
    const S = new Float64Array((n + 1) * W);
    const sim = new Float64Array(n * m);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const s = a[i - 1] === b[j - 1] ? 1 : bagSimilarity(ba[i - 1], bb[j - 1]);
        sim[(i - 1) * m + j - 1] = s;
        let best = Math.max(S[(i - 1) * W + j], S[i * W + j - 1]);
        if (s >= threshold) best = Math.max(best, S[(i - 1) * W + j - 1] + s);
        S[i * W + j] = best;
      }
    }
    for (let i = n, j = m; i > 0 && j > 0;) {
      const s = sim[(i - 1) * m + j - 1];
      if (s >= threshold && S[i * W + j] === S[(i - 1) * W + j - 1] + s) { pairs.push([i - 1, j - 1]); i--; j--; }
      else if (S[i * W + j] === S[(i - 1) * W + j]) i--;
      else j--;
    }
    pairs.reverse();
  }
  const rows = [];
  let pi = 0, pj = 0;
  for (const [i, j] of [...pairs, [n, m]]) {
    for (let k = 0; k < Math.max(i - pi, j - pj); k++) rows.push([pi + k < i ? pi + k : -1, pj + k < j ? pj + k : -1]);
    if (i < n || j < m) rows.push([i, j]);
    pi = i + 1; pj = j + 1;
  }
  return rows;
}

// Three-way rows for a block: each side aligned to the base, joined on the
// base lines. Side lines without a base counterpart go before the next base
// line, ours and theirs sharing rows in order. Rows are [o, b, t].
export function alignLines3(ours, base, theirs, opts) {
  const split = (rows) => {
    const of = new Int32Array(base.length).fill(-1);
    const before = Array.from({ length: base.length + 1 }, () => []);
    let pending = [];
    for (const [x, b] of rows) {
      if (b >= 0) { of[b] = x; before[b] = pending; pending = []; } else pending.push(x);
    }
    before[base.length] = pending;
    return { of, before };
  };
  const o = split(alignLines(ours, base, opts)), t = split(alignLines(theirs, base, opts));
  const rows = [];
  for (let i = 0; i <= base.length; i++) {
    const eo = o.before[i], et = t.before[i];
    for (let k = 0; k < Math.max(eo.length, et.length); k++) rows.push([eo[k] ?? -1, -1, et[k] ?? -1]);
    if (i < base.length) rows.push([o.of[i], i, t.of[i]]);
  }
  return rows;
}
