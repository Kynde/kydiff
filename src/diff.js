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
  return ops.filter((o) => o.a1 > o.a0 || o.b1 > o.b0);
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
