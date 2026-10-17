// The merge model: input files, the segments the diff splits them into, and
// the user's decision for each differing segment ("hunk").
//
// A hunk's decision is one of
//   sel  = null        unresolved
//   sel  = [i, j, ...] take these sides' lines, in this order ([] = neither)
//   rows = [sel, ...]  a decision per row, where row k pairs line k of each
//                      side the way the panes align them (overrides sel)
//   edit = [lines]     hand-edited result (overrides both)
//
// Everything is indexed by side so the same model can carry a third file.

import fs from 'node:fs';
import { diffLines, wordDiff } from './diff.js';

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
    if (files.length !== 2) throw new Error('only 2-way merges are supported so far');
    this.files = files;
    this.segments = [];
    this.hunks = [];
    this.undoStack = [];
    this.redoStack = [];
    this.version = 0;
    this.wordCache = new Map();
    const [a, b] = files;
    for (const op of diffLines(a.lines, b.lines, opts)) {
      const seg = op.eq
        ? { type: 'eq', start: [op.a0, op.b0], len: op.a1 - op.a0 }
        : { type: 'hunk', start: [op.a0, op.b0], lens: [op.a1 - op.a0, op.b1 - op.b0], sel: null, rows: null, edit: null };
      seg.index = this.segments.length;
      this.segments.push(seg);
      if (seg.type === 'hunk') {
        seg.hunk = this.hunks.length;
        seg.height = Math.max(...seg.lens);
        this.hunks.push(seg);
      }
    }
  }

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
  lineState(h, side, k) {
    if (h.edit) return { state: 'edit', order: 0 };
    const s = this.rowSel(h, k);
    if (!s) return { state: 'open', order: 0 };
    if (!s.includes(side)) return { state: 'drop', order: 0 };
    return { state: 'take', order: s.length > 1 ? s.indexOf(side) + 1 : 0 };
  }

  // The result lines of a hunk tagged with their origin, { text, src, line }
  // with src a side index or 'edit'; unresolved rows produce
  // { open: [k0, k1) } placeholders.
  tagged(h) {
    if (h.edit) return h.edit.map((text) => ({ text, src: 'edit' }));
    const take = (sides, k0, k1) => {
      const out = [];
      for (const side of sides) for (let k = k0; k < Math.min(k1, h.lens[side]); k++) out.push({ text: this.line(h, side, k), src: side, line: k });
      return out;
    };
    if (!h.rows) return h.sel ? take(h.sel, 0, h.height) : [{ open: [0, h.height] }];
    const out = [];
    for (let k = 0; k < h.height; k++) {
      const s = h.rows[k];
      if (s) out.push(...take(s, k, k + 1));
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
    let unresolved = 0, edited = 0;
    for (const h of this.hunks) {
      if (h.edit) edited++;
      else if (!this.isResolved(h)) unresolved++;
    }
    return { total: this.hunks.length, unresolved, edited };
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
  // pairing lines positionally the way side-by-side GitHub diffs do.
  words(h) {
    let w = this.wordCache.get(h);
    if (!w) {
      const a = this.lines(h, 0), b = this.lines(h, 1);
      w = [[], []];
      for (let k = 0; k < Math.min(a.length, b.length); k++) {
        const r = wordDiff(a[k], b[k]);
        if (r) { w[0][k] = r[0]; w[1][k] = r[1]; }
      }
      this.wordCache.set(h, w);
    }
    return w;
  }

  // Build the merged result.
  //   eqSide:     which side's text to use for equal segments (they can differ
  //               when whitespace is ignored)
  //   unresolved: a side index to fall back on, or 'markers'
  output({ eqSide = 1, unresolved = 'markers' } = {}) {
    const out = [];
    const range = (h, side, [k0, k1]) => this.lines(h, side).slice(k0, k1);
    for (const seg of this.segments) {
      if (seg.type === 'eq') { out.push(...this.lines(seg, eqSide)); continue; }
      for (const t of this.tagged(seg)) {
        if (!t.open) out.push(t.text);
        else if (unresolved === 'markers') {
          out.push(`<<<<<<< ${this.files[0].label}`, ...range(seg, 0, t.open),
            '=======', ...range(seg, 1, t.open), `>>>>>>> ${this.files[1].label}`);
        } else out.push(...range(seg, unresolved, t.open));
      }
    }
    return out;
  }
}

function same(x, y) {
  return x === y || (!!x && !!y && x.length === y.length && x.every((v, i) => same(v, y[i])));
}

function sameDecision(h, d) {
  return same(h.sel, d.sel) && same(h.rows, d.rows) && same(h.edit, d.edit);
}
