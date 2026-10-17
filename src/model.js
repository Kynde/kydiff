// The merge model: input files, the segments the diff splits them into, and
// the user's decision for each differing segment ("hunk").
//
// A hunk's decision is one of
//   sel  = null        unresolved
//   sel  = [i, j, ...] take these sides' lines, in this order ([] = neither)
//   rows = [sel, ...]  a decision per row (overrides sel)
//
// A hunk's rows pair up similar lines across the sides: h.align[r] holds the
// line index (or -1) of each side on row r, and h.rowOf[side][k] the row of
// line k.
//   edit = [lines]     hand-edited result (overrides both)
//
// Everything is indexed by side. Two-way merges have sides left, right;
// three-way merges have ours, base, theirs, with the base in the middle.
// There, a hunk that only one side changed (or both changed the same way) is
// resolved automatically; the rest are conflicts.

import fs from 'node:fs';
import { diffLines, diff3, matchLines, wordDiff, normalizer, alignLines, alignLines3 } from './diff.js';

export function parseText(text) {
  let bom = false;
  if (text.charCodeAt(0) === 0xfeff) { bom = true; text = text.slice(1); }
  const lines = text.split('\n');
  const eofNewline = lines[lines.length - 1] === '';
  if (eofNewline) lines.pop();
  // Strip \r only if the file is consistently CRLF, so mixed endings stay visible.
  const crlf = lines.length > 0 && lines.every((l, i) => l.endsWith('\r') || (i === lines.length - 1 && !eofNewline));
  if (crlf) for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\r$/, '');
  return { lines, eol: crlf ? '\r\n' : '\n', bom, eofNewline };
}

export function loadFile(path, label) {
  const buf = path === '-' ? fs.readFileSync(0) : fs.readFileSync(path);
  if (buf.subarray(0, 8000).includes(0)) throw new Error(`${path}: binary file`);
  let mtime = null;
  try { if (path !== '-') mtime = fs.statSync(path).mtimeMs; } catch {}
  return { path, label: label || (path === '-' ? '(stdin)' : path), mtime, ...parseText(buf.toString('utf8')) };
}

export function serialize(file, lines) {
  let s = lines.join(file.eol);
  if (file.eofNewline && lines.length) s += file.eol;
  return (file.bom ? '﻿' : '') + s;
}

export class Merge {
  constructor(files, opts = {}) {
    if (files.length !== 2 && files.length !== 3) throw new Error('need 2 or 3 files');
    this.files = files;
    this.three = files.length === 3;
    this.base = this.three ? 1 : -1;
    this.outer = this.three ? [0, 2] : [0, 1];
    this.norm = normalizer(opts);
    this.segments = [];
    this.hunks = [];
    this.undoStack = [];
    this.redoStack = [];
    this.version = 0;
    this.wordCache = new Map();
    // Three-way: which lines each side kept from the base. Inside a conflict
    // only the lines a side actually changed are its operation.
    this.kept = null;
    if (this.three) {
      const [o, b, t] = files.map((f) => f.lines);
      const mo = matchLines(b, o, opts), mt = matchLines(b, t, opts);
      this.kept = [new Uint8Array(o.length), new Uint8Array(b.length), new Uint8Array(t.length)];
      mo.forEach((j, i) => { if (j >= 0) this.kept[0][j] = 1; });
      mt.forEach((j, i) => { if (j >= 0) this.kept[2][j] = 1; });
      for (let i = 0; i < b.length; i++) this.kept[1][i] = mo[i] >= 0 && mt[i] >= 0 ? 1 : 0;
      this.matches = [mo, mt];
    }
    const regions = this.three
      ? diff3(files[0].lines, files[1].lines, files[2].lines, opts, ...this.matches)
      : diffLines(files[0].lines, files[1].lines, opts).map((op) => ({ eq: op.eq, start: [op.a0, op.b0], lens: [op.a1 - op.a0, op.b1 - op.b0] }));
    for (const r of regions) {
      const seg = r.eq
        ? { type: 'eq', start: r.start, len: r.lens[0] }
        : { type: 'hunk', start: r.start, lens: r.lens, sel: null, rows: null, edit: null };
      seg.index = this.segments.length;
      this.segments.push(seg);
      if (seg.type === 'hunk') {
        seg.hunk = this.hunks.length;
        this.#align(seg);
        if (this.three) this.#autoResolve(seg);
        this.hunks.push(seg);
      }
    }
  }

  #align(h) {
    const ls = this.files.map((_, side) => this.lines(h, side));
    h.align = this.three ? alignLines3(...ls) : alignLines(...ls);
    h.height = h.align.length;
    h.rowOf = ls.map((l) => new Int32Array(l.length));
    h.align.forEach((row, r) => row.forEach((k, side) => { if (k >= 0) h.rowOf[side][k] = r; }));
  }

  // The lines of a side on rows [r0, r1).
  rowLines(h, side, [r0, r1]) {
    const out = [];
    for (let r = r0; r < r1; r++) if (h.align[r][side] >= 0) out.push(this.line(h, side, h.align[r][side]));
    return out;
  }

  // Three-way: take the side that changed when the other didn't, or either
  // when both made the same change. Not an undoable step; it's the start.
  #autoResolve(h) {
    const same = (x, y) => this.#sameLines(h, x, y);
    const [o, b, t] = [0, 1, 2];
    h.changed = [!same(o, b), false, !same(t, b)];
    if (!h.changed[o]) h.sel = [t];
    else if (!h.changed[t] || same(o, t)) h.sel = [o];
    h.conflict = !h.sel;
    h.auto = h.sel;
  }

  #sameLines(h, x, y) {
    if (h.lens[x] !== h.lens[y]) return false;
    for (let k = 0; k < h.lens[x]; k++) if (this.norm(this.line(h, x, k)) !== this.norm(this.line(h, y, k))) return false;
    return true;
  }

  get defaultEqSide() { return this.three ? 0 : 1; }
  get last() { return this.files.length - 1; }

  // Untouched automatic resolutions.
  isAuto(h) { return !!h.auto && h.sel === h.auto && !h.rows && !h.edit; }

  get sides() { return this.files.length; }

  lines(seg, side) {
    const n = seg.type === 'eq' ? seg.len : seg.lens[side];
    return this.files[side].lines.slice(seg.start[side], seg.start[side] + n);
  }

  line(h, side, k) { return this.files[side].lines[h.start[side] + k]; }

  // The decision that applies to row k of a hunk.
  rowSel(h, k) { return h.rows ? h.rows[k] : h.sel; }

  // How line k of a side fares: { state: 'open'|'take'|'drop'|'edit', order }
  // where order is 1, 2.. when several sides are taken, else 0.
  // 'same' is a line not taken whose text is in the result anyway (an equal
  // line of a taken side), or, three-way, a side line equal to the base: it
  // isn't lost, so it shouldn't look struck out.
  // An 'open' line is quiet when, three-way, it isn't part of any change:
  // a side line kept from the base, or a base line both sides kept.
  lineState(h, side, k) {
    if (h.edit) return { state: 'edit', order: 0 };
    const row = h.align[h.rowOf[side][k]];
    const s = this.rowSel(h, h.rowOf[side][k]);
    if (!s) return { state: 'open', order: 0, quiet: !!this.kept?.[side][h.start[side] + k] };
    if (s.includes(side)) return { state: 'take', order: s.length > 1 ? s.indexOf(side) + 1 : 0 };
    const text = this.norm(this.line(h, side, k));
    const eq = (o) => row[o] >= 0 && this.norm(this.line(h, o, row[o])) === text;
    if (s.some(eq) || (this.three && side !== this.base && eq(this.base))) return { state: 'same', order: 0 };
    return { state: 'drop', order: 0 };
  }

  // The result lines of a hunk tagged with their origin, { text, src, line }
  // with src a side index or 'edit'; unresolved rows produce
  // { open: [r0, r1) } placeholders. A hunk-level choice takes each side's
  // lines as a block; per-row choices go row by row.
  tagged(h) {
    if (h.edit) return h.edit.map((text) => ({ text, src: 'edit' }));
    const tag = (side, line) => ({ text: this.line(h, side, line), src: side, line });
    if (!h.rows) {
      if (!h.sel) return [{ open: [0, h.height] }];
      return h.sel.flatMap((side) => Array.from({ length: h.lens[side] }, (_, k) => tag(side, k)));
    }
    const out = [];
    for (let k = 0; k < h.height; k++) {
      const s = h.rows[k];
      if (s) for (const side of s) { if (h.align[k][side] >= 0) out.push(tag(side, h.align[k][side])); }
      else if (out.length && out[out.length - 1].open) out[out.length - 1].open[1] = k + 1;
      else out.push({ open: [k, k + 1] });
    }
    return out;
  }

  isResolved(h) { return !!(h.edit || (h.rows ? h.rows.every(Boolean) : h.sel)); }

  // The lines a hunk contributes to the result, or null if unresolved.
  resolved(h) { return this.isResolved(h) ? this.tagged(h).map((t) => t.text) : null; }

  // Like resolved(), but tagged with where each line came from, for display.
  resolvedTagged(h) { return this.isResolved(h) ? this.tagged(h) : null; }

  stats() {
    let unresolved = 0, edited = 0, auto = 0, conflicts = 0;
    for (const h of this.hunks) {
      if (h.edit) edited++;
      else if (!this.isResolved(h)) unresolved++;
      if (this.isAuto(h)) auto++;
      if (h.conflict) conflicts++;
    }
    return { total: this.hunks.length, unresolved, edited, auto, conflicts };
  }

  // Apply decisions as one undoable step: changes = [{ h, sel, rows, edit }].
  apply(changes) {
    const step = [];
    for (const { h, sel = null, rows = null, edit = null } of changes) {
      const after = { sel, rows, edit };
      if (sameDecision(h, after)) continue;
      step.push({ h, before: { sel: h.sel, rows: h.rows, edit: h.edit }, after });
      Object.assign(h, after);
    }
    if (!step.length) return false;
    this.undoStack.push(step);
    this.redoStack.length = 0;
    this.version++;
    return true;
  }

  // Decide a single row, splitting the hunk-level decision into rows; rows
  // that end up all alike fold back into a hunk-level decision.
  applyRow(h, k, sel) {
    const rows = h.rows ? [...h.rows] : Array.from({ length: h.height }, () => h.sel);
    rows[k] = sel;
    if (rows.every((r) => same(r, rows[0]))) return this.apply([{ h, sel: rows[0] }]);
    return this.apply([{ h, sel: null, rows }]);
  }

  undo() { return this.#replay(this.undoStack, this.redoStack, 'before'); }
  redo() { return this.#replay(this.redoStack, this.undoStack, 'after'); }

  #replay(from, to, which) {
    const step = from.pop();
    if (!step) return null;
    for (const c of step) Object.assign(c.h, c[which]);
    to.push(step);
    this.version++;
    return step;
  }

  // Intra-line highlight ranges for a hunk: ranges[side][k] for line k,
  // comparing the lines that share a row. Three-way, each side is compared
  // with the base, and the base shows what either side changed in it.
  words(h) {
    let w = this.wordCache.get(h);
    if (w) return w;
    w = this.files.map(() => []);
    const pair = (x, y, intoY) => {
      for (const row of h.align) {
        const i = row[x], j = row[y];
        if (i < 0 || j < 0) continue;
        const r = wordDiff(this.line(h, x, i), this.line(h, y, j));
        if (!r) continue;
        w[x][i] = r[0];
        w[y][j] = intoY && w[y][j] ? unionRanges(w[y][j], r[1]) : r[1];
      }
    };
    if (this.three) {
      if (h.changed[0]) pair(0, 1, true);
      if (h.changed[2]) pair(2, 1, true);
    } else pair(0, 1, false);
    this.wordCache.set(h, w);
    return w;
  }

  // Build the merged result.
  //   eqSide:     which side's text to use for equal segments (they can differ
  //               when whitespace is ignored)
  //   unresolved: a side index to fall back on, or 'markers'
  output({ eqSide = this.defaultEqSide, unresolved = 'markers' } = {}) {
    const out = [];
    const range = (h, side, rows) => this.rowLines(h, side, rows);
    const [l, r] = this.outer;
    for (const seg of this.segments) {
      if (seg.type === 'eq') { out.push(...this.lines(seg, eqSide)); continue; }
      for (const t of this.tagged(seg)) {
        if (!t.open) out.push(t.text);
        else if (unresolved === 'markers') {
          // diff3-style markers when there is a base.
          out.push(`<<<<<<< ${this.files[l].label}`, ...range(seg, l, t.open));
          if (this.three) out.push(`||||||| ${this.files[1].label}`, ...range(seg, 1, t.open));
          out.push('=======', ...range(seg, r, t.open), `>>>>>>> ${this.files[r].label}`);
        } else out.push(...range(seg, unresolved, t.open));
      }
    }
    return out;
  }
}

function unionRanges(a, b) {
  const all = [...a, ...b].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function same(x, y) {
  return x === y || (!!x && !!y && x.length === y.length && x.every((v, i) => same(v, y[i])));
}

function sameDecision(h, d) {
  return same(h.sel, d.sel) && same(h.rows, d.rows) && same(h.edit, d.edit);
}
