// Application state and input handling.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { render } from './view.js';
import { Buffer } from './editor.js';
import { keyText } from './term.js';
import { serialize } from './model.js';
import { highlighter } from './syntax.js';
import { ACTIONS, EDITOR_HELP, configPath } from './config.js';

const same = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));

export class App {
  constructor({ model, cfg, term, output = null }) {
    this.m = model;
    this.cfg = cfg;
    this.theme = cfg.themeColors;
    this.term = term;
    this.output = output;
    this.top = 0;
    this.cur = 0;
    this.lineOff = 0; // line cursor: display row within the current hunk
    this.hs = 0;
    this.showMerged = cfg.showMerged;
    this.fold = cfg.fold;
    this.expanded = new Set();
    this.editor = null;
    this.modal = null;
    this.msg = null;
    this.savedVersion = 0;
    this.saved = false;
    this.prevRows = null;
    this.drag = null;
    this.geom = null;
    this.syntaxOn = cfg.syntax;
    this.highlighters = model.files.map((f) => highlighter(f.label + ' ' + f.path));
    this.changed = model.files.map((_, side) => model.hunks.reduce((n, h) => n + h.lens[side], 0));
    this.buildRows();
    if (this.m.hunks.length) this.reveal(this.m.hunks[0]);
  }

  // Syntax coloring for a side's text: the full palette, or the quiet one
  // used for identical lines.
  syntax(side, dim = false) {
    if (!this.syntaxOn) return null;
    return { fn: this.highlighters[side], palette: dim ? this.theme.syntaxDim : this.theme.syntax };
  }

  changedCounts() { return this.changed; }

  get dirty() { return this.m.version !== this.savedVersion; }
  get bodyH() { return Math.max(1, this.term.rows - 2); }
  get hunk() { return this.m.hunks[this.cur] || null; }

  // ---- layout ---------------------------------------------------------

  // Rows are what the body shows, one per screen line: { si, off } for line
  // `off` of segment `si`, or a fold marker { si, off, fold, hidden }.
  buildRows() {
    const anchor = this.rows?.[this.top];
    const rows = [];
    const segs = this.m.segments;
    const ctx = this.cfg.foldContext;
    this.segRow = new Int32Array(segs.length + 1);
    for (const seg of segs) {
      this.segRow[seg.index] = rows.length;
      const si = seg.index;
      if (seg.type === 'eq') {
        const head = si === 0 ? 0 : ctx, tail = si === segs.length - 1 ? 0 : ctx;
        if (this.fold && !this.expanded.has(si) && seg.len > head + tail + 1) {
          for (let k = 0; k < head; k++) rows.push({ si, off: k });
          rows.push({ si, off: head, fold: true, hidden: seg.len - head - tail });
          for (let k = seg.len - tail; k < seg.len; k++) rows.push({ si, off: k });
        } else {
          for (let k = 0; k < seg.len; k++) rows.push({ si, off: k });
        }
      } else {
        const n = Math.max(1, this.contentHeight(seg), this.showMerged ? this.mergedHeight(seg) : 0);
        for (let k = 0; k < n; k++) rows.push({ si, off: k });
      }
    }
    this.segRow[segs.length] = rows.length;
    this.rows = rows;
    if (anchor) this.top = this.findRow(anchor.si, anchor.off);
    this.clampTop();
    if (this.hunk) this.lineOff = Math.max(0, Math.min(this.lineOff, this.contentHeight(this.hunk) - 1));
  }

  // How a hunk's rows map to lines:
  //   positional   row k shows line k of each side
  //   stacked      taking both: the first side's lines, then the second's,
  //                so the order reads top to bottom
  //   edited       positional originals, then a full-width band holding the
  //                edited text (also while editing)
  layout(h) {
    const P = h.height;
    if (this.editor?.h === h) return { kind: 'edited', P, band: this.editor.buf.lines.length };
    if (h.edit) return { kind: 'edited', P, band: Math.max(1, h.edit.length) };
    if (!h.rows && h.sel?.length === 2) return { kind: 'stacked', P, first: h.sel[0], second: h.sel[1] };
    return { kind: 'positional', P };
  }

  contentHeight(h) {
    const l = this.layout(h);
    if (l.kind === 'edited') return l.P + l.band;
    if (l.kind === 'stacked') return h.lens[l.first] + h.lens[l.second];
    return l.P;
  }

  // What display row `off` of a hunk shows: the line index per side (-1 for
  // none) and, for edited hunks, the line of the edit band (-1 for none).
  rowInfo(h, off) {
    const l = this.layout(h);
    const lines = h.lens.map(() => -1);
    let band = -1;
    if (l.kind === 'stacked') {
      const n1 = h.lens[l.first];
      if (off < n1) lines[l.first] = off;
      else if (off - n1 < h.lens[l.second]) lines[l.second] = off - n1;
    } else if (off < l.P) {
      h.lens.forEach((n, side) => { if (off < n) lines[side] = off; });
    } else if (l.kind === 'edited' && off - l.P < l.band) band = off - l.P;
    return { lines, band, layout: l };
  }

  mergedHeight(seg) {
    if (this.editor?.h === seg) return this.editor.buf.lines.length;
    return this.m.tagged(seg).length;
  }

  findRow(si, off) {
    let r = this.segRow[si];
    const end = this.segRow[si + 1];
    while (r + 1 < end && this.rows[r + 1].off <= off) r++;
    return r;
  }

  clampTop() {
    this.top = Math.max(0, Math.min(this.top, this.rows.length - this.bodyH));
  }

  hunkSpan(h) {
    const start = this.segRow[h.index];
    return [start, this.segRow[h.index + 1] - start];
  }

  // Scroll so the hunk is comfortably in view, leaving the view alone if it
  // already is so stepping through nearby hunks doesn't jitter.
  reveal(h) {
    const H = this.bodyH;
    const [start, n] = this.hunkSpan(h);
    const margin = Math.min(3, Math.floor(H / 6));
    if (start >= this.top + margin && start + n <= this.top + H - margin) return;
    let off = Math.floor(H / 3);
    if (n > H - off - margin) off = Math.max(margin, H - n - margin);
    this.top = start - Math.min(off, Math.floor(H / 3));
    this.clampTop();
  }

  scrollBy(n) {
    this.top += n;
    this.clampTop();
    this.syncCurToView();
  }

  // After free scrolling, keep the current hunk on screen so the choice keys
  // never act on something invisible.
  syncCurToView() {
    if (this.editor) return;
    const H = this.bodyH, top = this.top;
    const h = this.hunk;
    if (h) {
      const [s, n] = this.hunkSpan(h);
      if (s < top + H && s + n > top) return;
    }
    let fallback = -1;
    for (const x of this.m.hunks) {
      const [s, n] = this.hunkSpan(x);
      if (s >= top && s < top + H) { this.cur = x.hunk; this.lineOff = 0; return; }
      if (s < top && s + n > top) fallback = x.hunk;
      if (s >= top + H) break;
    }
    if (fallback >= 0) { this.cur = fallback; this.lineOff = 0; }
  }

  // ---- drawing --------------------------------------------------------

  draw() {
    const scr = render(this, this.term.cols, this.term.rows);
    const { out, rows } = scr.serialize(this.prevRows);
    this.prevRows = rows;
    this.term.write(out);
  }

  flash(text, warn = false) { this.msg = { text, warn }; }

  // ---- input ----------------------------------------------------------

  handle(ev) {
    if (typeof ev === 'object' && ev.type === 'mouse') return this.onMouse(ev);
    if (this.modal) return this.modalKey(ev);
    if (this.editor) return this.editorKey(ev);
    if (typeof ev === 'object') return; // stray paste
    this.msg = null;
    const action = this.cfg.keymap.get(ev);
    if (action && this.actions[action]) this.actions[action]();
  }

  actions = {
    nextLine: () => this.moveLine(1),
    prevLine: () => this.moveLine(-1),
    nextHunk: () => this.gotoHunk(this.cur + 1),
    prevHunk: () => this.gotoHunk(this.cur - 1),
    nextUnresolved: () => this.gotoUnresolved(1),
    prevUnresolved: () => this.gotoUnresolved(-1),
    scrollDown: () => this.scrollBy(1),
    scrollUp: () => this.scrollBy(-1),
    halfPageDown: () => this.scrollBy(Math.floor(this.bodyH / 2)),
    halfPageUp: () => this.scrollBy(-Math.floor(this.bodyH / 2)),
    pageDown: () => this.scrollBy(this.bodyH - 2),
    pageUp: () => this.scrollBy(-(this.bodyH - 2)),
    top: () => { this.top = 0; if (this.m.hunks.length) this.cur = 0; this.syncCurToView(); },
    bottom: () => { this.top = this.rows.length; this.clampTop(); if (this.m.hunks.length) this.cur = this.m.hunks.length - 1; this.syncCurToView(); },
    scrollRight: () => { this.hs += 8; },
    scrollLeft: () => { this.hs = Math.max(0, this.hs - 8); },
    scrollHome: () => { this.hs = 0; },
    selectLeft: () => this.choose([0]),
    selectRight: () => this.choose([1]),
    selectBoth: () => {
      const h = this.hunk;
      if (h) this.choose(!h.edit && !h.rows && same(h.sel, [0, 1]) ? [1, 0] : [0, 1]);
    },
    selectNeither: () => this.choose([]),
    unselect: () => this.choose(null),
    selectLineLeft: () => this.chooseLine([0]),
    selectLineRight: () => this.chooseLine([1]),
    selectLineBoth: () => this.chooseLine('both'),
    selectLineNeither: () => this.chooseLine([]),
    unselectLine: () => this.chooseLine(null),
    selectAllLeft: () => this.chooseAll([0]),
    selectAllRight: () => this.chooseAll([1]),
    edit: () => this.startEdit(),
    editExternal: () => this.editExternal(),
    undo: () => this.undoRedo('undo'),
    redo: () => this.undoRedo('redo'),
    toggleMerged: () => { this.showMerged = !this.showMerged; this.buildRows(); },
    toggleFold: () => { this.fold = !this.fold; this.expanded.clear(); this.buildRows(); if (this.hunk) this.reveal(this.hunk); },
    toggleSyntax: () => { this.syntaxOn = !this.syntaxOn; },
    help: () => this.showHelp(),
    redraw: () => { this.prevRows = null; },
    save: () => this.save(),
    quit: () => this.quit(),
    forceQuit: () => this.exit(),
  };

  gotoHunk(i) {
    const n = this.m.hunks.length;
    if (!n) return this.flash('no differences');
    if (i < 0 || i >= n) return this.flash(i < 0 ? 'at the first difference' : 'at the last difference');
    this.cur = i;
    this.lineOff = 0;
    this.reveal(this.hunk);
  }

  // Move the line cursor through differing lines, crossing into the
  // neighbouring hunk at either end.
  moveLine(dir) {
    const h = this.hunk;
    if (!h) return this.flash('no differences');
    const n = this.contentHeight(h);
    if (this.lineOff + dir >= 0 && this.lineOff + dir < n) this.lineOff += dir;
    else {
      const next = this.m.hunks[this.cur + dir];
      if (!next) return this.flash(dir > 0 ? 'at the last difference' : 'at the first difference');
      this.cur = next.hunk;
      this.lineOff = dir > 0 ? 0 : this.contentHeight(next) - 1;
      this.reveal(next);
    }
    this.showRow(this.segRow[this.hunk.index] + this.lineOff);
  }

  showRow(r) {
    if (r < this.top) this.top = r;
    if (r >= this.top + this.bodyH) this.top = r - this.bodyH + 1;
    this.clampTop();
  }

  gotoUnresolved(dir) {
    const hs = this.m.hunks, n = hs.length;
    for (let s = 1; s <= n; s++) {
      const i = (((this.cur + dir * s) % n) + n) % n;
      if (!this.m.isResolved(hs[i])) {
        if ((dir > 0 && i <= this.cur) || (dir < 0 && i >= this.cur)) this.flash('wrapped around');
        this.cur = i;
        this.lineOff = 0;
        return this.reveal(hs[i]);
      }
    }
    this.flash(n ? 'everything is resolved' : 'no differences');
  }

  choose(sel) {
    const h = this.hunk;
    if (!h) return;
    this.m.apply([{ h, sel }]);
    this.buildRows();
    if (this.cfg.autoAdvance && sel) {
      const next = this.m.hunks.find((x) => x.hunk > h.hunk && !this.m.isResolved(x));
      if (next) { this.cur = next.hunk; this.reveal(next); }
    }
  }

  // Decide only the row under the line cursor. sel 'both' takes both,
  // swapping their order if the row already takes both.
  chooseLine(sel, off = this.lineOff) {
    const h = this.hunk;
    if (!h) return;
    const info = this.rowInfo(h, off);
    if (info.band >= 0) return this.flash('that is the edited text; e edits it', true);
    const k = info.lines.find((x) => x >= 0);
    if (k === undefined) return;
    if (sel === 'both') sel = same(this.m.rowSel(h, k), [0, 1]) && !h.edit ? [1, 0] : [0, 1];
    this.m.applyRow(h, k, sel);
    this.buildRows();
    // Keep the cursor on the same line even if the layout changed.
    for (let r = 0; r < this.contentHeight(h); r++) if (this.rowInfo(h, r).lines.includes(k)) { this.lineOff = r; break; }
  }

  chooseAll(sel) {
    const changes = this.m.hunks.filter((h) => !this.m.isResolved(h)).map((h) => ({ h, sel }));
    if (!changes.length) return this.flash('nothing unresolved');
    this.m.apply(changes);
    this.buildRows();
    this.flash(`took ${sel[0] === 0 ? 'left' : 'right'} for ${changes.length} differences`);
  }

  undoRedo(which) {
    const step = this.m[which]();
    if (!step) return this.flash(`nothing to ${which}`);
    this.cur = step[0].h.hunk;
    this.buildRows();
    this.reveal(step[0].h);
    this.flash(`${which} (${step.length} difference${step.length > 1 ? 's' : ''})`);
  }

  // ---- in-place editing -------------------------------------------------

  startEdit(at = null) {
    const h = this.hunk;
    if (!h) return;
    const initial = this.editText(h);
    this.editor = { h, buf: new Buffer(initial), initial, hs: 0 };
    if (at) this.editor.buf.moveTo(at.line, at.col, this.cfg.tabWidth);
    this.buildRows();
    this.reveal(h);
    this.editorScroll();
  }

  endEdit(commit) {
    const { h, buf, initial } = this.editor;
    this.editor = null;
    if (commit) {
      const lines = buf.lines.length === 1 && buf.lines[0] === '' && !initial.length ? [] : buf.lines;
      if (!same(lines, initial)) this.m.apply([{ h, sel: h.sel, rows: h.rows, edit: lines }]);
    }
    this.buildRows();
    this.reveal(h);
  }

  editorKey(k) {
    const ed = this.editor, b = ed.buf, tw = this.cfg.tabWidth;
    if (typeof k === 'object') { if (k.type === 'paste') b.insert(k.text); }
    else switch (k) {
      case 'escape': return this.endEdit(true);
      case 'C-c': return this.endEdit(false);
      case 'left': b.left(); break;
      case 'right': b.right(); break;
      case 'up': b.vertical(-1, tw); break;
      case 'down': b.vertical(1, tw); break;
      case 'pageup': b.vertical(-10, tw); break;
      case 'pagedown': b.vertical(10, tw); break;
      case 'C-left': case 'M-b': b.wordLeft(); break;
      case 'C-right': case 'M-f': b.wordRight(); break;
      case 'home': case 'C-a': b.home(); break;
      case 'end': case 'C-e': b.end(); break;
      case 'C-k': b.killEnd(); break;
      case 'C-u': b.killStart(); break;
      case 'C-l': b.set(this.m.lines(ed.h, 0)); break;
      case 'C-r': b.set(this.m.lines(ed.h, 1)); break;
      case 'enter': b.insert('\n'); break;
      case 'backspace': b.backspace(); break;
      case 'delete': case 'C-d': b.del(); break;
      default: {
        const s = keyText(k);
        if (s !== null) b.insert(s);
      }
    }
    this.buildRows();
    this.editorScroll();
  }

  // Keep the editing cursor visible, vertically and horizontally.
  editorScroll() {
    const ed = this.editor;
    this.lineOff = ed.h.height + ed.buf.y;
    this.showRow(this.segRow[ed.h.index] + this.lineOff);
    const tw = this.bandWidth();
    const col = ed.buf.cursorColumn(this.cfg.tabWidth);
    if (col < ed.hs) ed.hs = Math.max(0, col - 8);
    if (col >= ed.hs + tw) ed.hs = col - tw + 8;
  }

  // What editing starts from: the current result, with undecided rows
  // filled in as left then right.
  editText(h) {
    return this.m.tagged(h).flatMap((e) => e.open
      ? [0, 1].flatMap((side) => this.m.lines(h, side).slice(e.open[0], e.open[1]))
      : [e.text]);
  }

  // Text width of the full-width edit band.
  bandWidth() {
    const g = this.geom;
    if (!g) return 40;
    const last = g.panes[this.m.sides - 1];
    return last.x + last.w - g.panes[0].textX;
  }

  editExternal() {
    const h = this.hunk;
    if (!h) return;
    const initial = this.editText(h);
    const ext = path.extname(this.m.files[1].path) || '.txt';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdiff-'));
    const file = path.join(dir, `hunk-${h.hunk + 1}${ext}`);
    fs.writeFileSync(file, initial.length ? initial.join('\n') + '\n' : '');
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    this.term.stop();
    const fd = this.term.fd;
    const res = spawnSync(`${editor} "$KDIFF_FILE"`, { shell: true, stdio: [fd, fd === 0 ? 1 : fd, 2], env: { ...process.env, KDIFF_FILE: file } });
    this.term.start();
    this.prevRows = null;
    try {
      if (res.status !== 0) return this.flash(`${editor} exited with status ${res.status}; nothing changed`, true);
      let text = fs.readFileSync(file, 'utf8');
      if (text.endsWith('\n')) text = text.slice(0, -1);
      const lines = text === '' ? [] : text.split('\n');
      if (!same(lines, initial)) this.m.apply([{ h, sel: h.sel, rows: h.rows, edit: lines }]);
      this.buildRows();
      this.reveal(h);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- mouse ----------------------------------------------------------

  onMouse(ev) {
    const g = this.geom;
    if (!g || this.modal) return;
    if (ev.action === 'wheelup' || ev.action === 'wheeldown') {
      this.top += ev.action === 'wheelup' ? -3 : 3;
      this.clampTop();
      this.syncCurToView();
      return;
    }
    if (ev.action === 'up') { this.drag = null; return; }
    const inBody = ev.y >= g.bodyY && ev.y < g.bodyY + g.bodyH;
    if (ev.x >= g.ovX && inBody && ev.button === 0) {
      // Click or drag on the overview jumps there, centered.
      if (ev.action === 'down') this.drag = 'overview';
      if (this.drag !== 'overview') return;
      const r = Math.floor(((ev.y - g.bodyY + 0.5) * this.rows.length) / g.bodyH);
      this.top = r - Math.floor(this.bodyH / 2);
      this.clampTop();
      this.syncCurToView();
      return;
    }
    if (ev.action !== 'down' || !inBody || ev.button === 1) return;
    const ri = this.top + ev.y - g.bodyY;
    const row = this.rows[ri];
    const pane = g.panes.find((p) => ev.x >= p.x && ev.x < p.x + p.w);
    if (!row || !pane) return;
    const seg = this.m.segments[row.si];
    const info = seg.type === 'hunk' ? this.rowInfo(seg, row.off) : null;
    const inBand = info && info.band >= 0 && pane.kind === 'side';
    if (this.editor) {
      if (seg === this.editor.h && (inBand || pane.kind === 'merged')) {
        const line = inBand ? info.band : row.off;
        const col = ev.x - (inBand ? g.panes[0].textX : pane.textX) + this.editor.hs;
        this.editor.buf.moveTo(line, col, this.cfg.tabWidth);
        this.editorScroll();
      } else this.endEdit(true);
      return;
    }
    if (row.fold) {
      this.expanded.add(row.si);
      this.buildRows();
      return;
    }
    if (seg.type !== 'hunk') return;
    this.cur = seg.hunk;
    this.lineOff = Math.min(row.off, this.contentHeight(seg) - 1);
    this.msg = null;
    if (inBand) {
      this.startEdit({ line: info.band, col: ev.x - g.panes[0].textX + this.hs });
    } else if (pane.kind === 'merged') {
      this.startEdit({ line: row.off, col: ev.x - pane.textX });
    } else if (ev.button === 2 || ev.ctrl) {
      // Right (or ctrl) click takes the side for that line only.
      this.chooseLine([pane.side], this.lineOff);
    } else {
      // Clicking a side takes it; clicking the taken side again undoes that.
      this.choose(!seg.edit && !seg.rows && same(seg.sel, [pane.side]) ? null : [pane.side]);
    }
  }

  // ---- modals ---------------------------------------------------------

  modalKey(k) {
    const md = this.modal;
    if (md.input) {
      const b = md.input;
      if (typeof k === 'object') { if (k.type === 'paste') b.insert(k.text); return; }
      switch (k) {
        case 'escape': case 'C-c': this.modal = null; return;
        case 'enter': this.modal = null; return md.submit(b.line);
        case 'left': return b.left();
        case 'right': return b.right();
        case 'home': case 'C-a': return b.home();
        case 'end': case 'C-e': return b.end();
        case 'backspace': return b.backspace();
        case 'delete': case 'C-d': return b.del();
        case 'C-u': return b.killStart();
        case 'C-k': return b.killEnd();
        default: { const s = keyText(k); if (s !== null && s !== '\t') b.insert(s); }
      }
      return;
    }
    if (typeof k === 'object') return;
    const scrollKeys = { down: 1, j: 1, up: -1, k: -1, pagedown: md.pageH, space: md.pageH, pageup: -md.pageH };
    if (md.scrollable && k in scrollKeys) { md.scroll += scrollKeys[k]; return; }
    const fn = md.keys?.[k];
    if (fn) { this.modal = null; return fn(); }
    if (k === 'escape' || k === 'C-c' || (md.scrollable && (k === 'q' || k === '?'))) this.modal = null;
  }

  choice(title, intro, options) {
    const lines = intro.map((s) => [[s, 'modalDim']]);
    if (intro.length) lines.push([['']]);
    const keys = {};
    for (const [key, label, fn, detail] of options) {
      keys[key] = fn;
      lines.push([[`  ${key}  `, 'modalKey'], [label], ...(detail ? [[`  ${detail}`, 'modalDim']] : [])]);
    }
    lines.push([['']], [['  Esc  ', 'modalKey'], ['cancel', 'modalDim']]);
    this.modal = { title, lines, keys };
  }

  showHelp() {
    const pretty = { up: '\u2191', down: '\u2193', left: '\u2190', right: '\u2192', 'S-left': 'S-\u2190', 'S-right': 'S-\u2192',
      pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End', enter: 'Enter', backspace: 'Bksp', tab: 'Tab',
      'S-tab': 'S-Tab', space: 'Space', escape: 'Esc', f1: 'F1' };
    const fmt = (keys) => keys.map((k) => pretty[k] || k).join(' ');
    const allKeys = ACTIONS.flatMap(([, a]) => a.map(([n]) => fmt(this.cfg.bindings[n])));
    const kw = Math.min(20, Math.max(...allKeys.map((s) => s.length)) + 2);
    const section = (title, items) => [[[title, 'modalTitle']], ...items.map(([k, d]) => [[`  ${k.padEnd(kw)}`, 'modalKey'], [d]]), [['']]];
    const groups = Object.fromEntries(ACTIONS.map(([g, actions]) => [g, section(g, actions.map(([n, , d]) => [fmt(this.cfg.bindings[n]), d]))]));
    const editing = section('While editing', EDITOR_HELP);
    const mouse = section('Mouse', [['click a side', 'take it (click again to undo)'], ['right-click a side', 'take it for that line only'], ['click edited text', 'edit it'], ['click overview', 'jump; drag to scroll'], ['click a fold', 'unfold it']]);
    const left = [...groups.Move, ...groups.View, ...groups.File];
    const right = [...groups.Choose, ...groups['Choose one line'], ...editing, ...mouse];
    const width = (col) => Math.max(...col.map((l) => l.reduce((a, [s]) => a + s.length, 0)));
    let lines;
    const lw = width(left) + 4;
    if (lw + width(right) + 10 <= this.term.cols) {
      // Side by side when there is room for it.
      lines = [];
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = left[i] || [['']];
        const pad = lw - l.reduce((a, [s]) => a + s.length, 0);
        lines.push([...l, [' '.repeat(pad)], ...(right[i] || [])]);
      }
    } else lines = [...left, ...right];
    lines.push([[`Keys and colors can be changed in ${configPath()}`, 'modalDim']]);
    this.modal = { title: 'kdiff help', lines, scrollable: true, scroll: 0 };
  }

  // ---- saving and quitting -----------------------------------------------

  save(then = null) {
    const [a, b] = this.m.files;
    const opts = [];
    if (this.output) opts.push(['o', `output  ${this.output}`, () => this.saveTo(this.output, null, then)]);
    if (a.path !== '-') opts.push(['l', `left    ${a.path}`, () => this.saveTo(a.path, 0, then)]);
    if (b.path !== '-') opts.push(['r', `right   ${b.path}`, () => this.saveTo(b.path, 1, then)]);
    opts.push(['a', 'save as…', () => this.promptPath(then)]);
    const { unresolved } = this.m.stats();
    const intro = unresolved
      ? [`${unresolved} difference${unresolved > 1 ? 's are' : ' is'} unresolved. Saving over the left or`, 'right file keeps that file\'s version of them.']
      : [];
    this.choice('Save the merged result to', intro, opts);
  }

  promptPath(then) {
    const b = new Buffer([this.output || this.m.files[1].path], { multiline: false });
    b.end();
    this.modal = {
      title: 'Save as', lines: [[['Path to write the merged result to:', 'modalDim']]], input: b,
      submit: (p) => p.trim() ? this.saveTo(p.trim(), null, then) : this.flash('not saved', true),
    };
  }

  // side: the input file being overwritten (its version wins for unresolved
  // hunks and its formatting is kept), or null for any other path.
  saveTo(file, side, then) {
    const { unresolved } = this.m.stats();
    if (side === null && unresolved) {
      const go = (policy) => () => this.write(file, policy, 1, then);
      return this.choice(`${unresolved} unresolved difference${unresolved > 1 ? 's' : ''}`, ['How should they be written?'], [
        ['m', 'with conflict markers', go('markers'), '<<<<<<< / ======= / >>>>>>>'],
        ['l', 'take left', go(0)],
        ['r', 'take right', go(1)],
      ]);
    }
    this.write(file, side ?? 1, side ?? 1, then);
  }

  write(file, unresolved, fmtSide, then, force = false) {
    const loaded = this.m.files.find((f) => f.path !== '-' && path.resolve(f.path) === path.resolve(file));
    if (loaded && loaded.mtime !== null && !force) {
      let mtime = null;
      try { mtime = fs.statSync(file).mtimeMs; } catch {}
      if (mtime !== null && mtime !== loaded.mtime) {
        return this.choice('File changed on disk', [`${file} was modified after kdiff read it.`], [
          ['y', 'overwrite it anyway', () => this.write(file, unresolved, fmtSide, then, true)],
        ]);
      }
    }
    const lines = this.m.output({ eqSide: fmtSide, unresolved });
    try {
      fs.writeFileSync(file, serialize(this.m.files[fmtSide], lines));
    } catch (e) {
      return this.flash(`could not save: ${e.message}`, true);
    }
    if (loaded) try { loaded.mtime = fs.statSync(file).mtimeMs; } catch {}
    this.savedVersion = this.m.version;
    this.saved = true;
    this.flash(`wrote ${lines.length} lines to ${file}`);
    if (then) then();
  }

  quit() {
    if (!this.dirty) return this.exit();
    this.choice('Unsaved changes', ['The merge has changes that are not saved.'], [
      ['s', 'save, then quit', () => this.save(() => this.exit())],
      ['y', 'quit without saving', () => this.exit()],
    ]);
  }

  exit() {
    this.term.stop();
    // Signal "not merged" to callers like git mergetool when an output file
    // was requested but never written.
    process.exit(this.output && !this.saved ? 1 : 0);
  }
}
