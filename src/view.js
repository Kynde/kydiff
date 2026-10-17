// Rendering: draws the application state into a Screen. Pure apart from
// recording the geometry it used, which mouse handling needs.

import { Screen, style, mix, cpWidth, strWidth, fit } from './screen.js';

const HATCH = '╱'; // ╱
const SEP = '│', SEP_HUNK = '┃'; // │ ┃
const BAR = '▌'; // ▌
const EDIT_MARK = '✎'; // ✎
const PILL_L = '▐', PILL_R = '▌'; // ▐ ▌ give badges rounded-looking ends

export function geometry(app, W, H) {
  const m = app.m;
  const panes = [];
  const nPanes = m.sides + (app.showMerged ? 1 : 0);
  const ovW = m.sides;
  const avail = W - ovW - (nPanes - 1);
  const base = Math.floor(avail / nPanes);
  const numW = Math.max(2, String(Math.max(...m.files.map((f) => f.lines.length))).length);
  let x = 0;
  for (let p = 0; p < nPanes; p++) {
    const w = p === nPanes - 1 ? avail - base * (nPanes - 1) : base;
    const merged = p >= m.sides;
    // [mark][space][line number][space][text]; the merged pane has no numbers.
    const gut = merged ? 0 : numW;
    const textX = merged ? x + 2 : x + gut + 3;
    panes.push({ kind: merged ? 'merged' : 'side', side: merged ? -1 : p, x, w, numW: gut, markX: x, numX: x + 1, textX, textW: Math.max(0, x + w - textX) });
    x += w + 1;
  }
  return { W, H, bodyY: 1, bodyH: Math.max(1, H - 2), panes, ovX: W - ovW, ovW };
}

export function render(app, W, H) {
  const scr = new Screen(W, H);
  const t = app.theme;
  if (W < 40 || H < 6) {
    scr.text(0, 0, 'kdiff: terminal too small', style({ fg: t.warn }));
    return scr;
  }
  const g = geometry(app, W, H);
  app.geom = g;
  drawHeader(app, scr, g);
  drawBody(app, scr, g);
  drawOverview(app, scr, g);
  drawStatus(app, scr, g);
  if (app.modal) drawModal(app, scr, app.modal);
  return scr;
}

// A solid badge: ▐text▌ on the bar background. Returns columns used.
function pill(scr, x, y, text, color, t, maxW = scr.w - x) {
  if (maxW < 3) return 0;
  const edge = style({ fg: color, bg: t.bar.bg });
  scr.put(x, y, PILL_L, edge);
  const w = scr.text(x + 1, y, text, style({ fg: t.pillText, bg: color, bold: true }), maxW - 2);
  scr.put(x + 1 + w, y, PILL_R, edge);
  return w + 2;
}

function drawHeader(app, scr, g) {
  const t = app.theme, bar = style(t.bar);
  scr.fill(0, 0, g.W, 1, ' ', bar);
  const changed = app.changedCounts();
  for (const p of g.panes) {
    const room = p.w - 1;
    let x = p.x + 1;
    if (p.kind === 'merged') {
      x += pill(scr, x, 0, app.editor ? `${EDIT_MARK} editing` : 'merged', t.edit, t, room);
      if (app.output) scr.text(x + 1, 0, `→ ${app.output}`, bar, p.x + p.w - x - 2);
      continue;
    }
    const f = app.m.files[p.side], sc = app.sideColors[p.side];
    const role = app.m.three ? `${app.sideName(p.side)} \u00b7 ` : '';
    const saved = app.overwritten.has(p.side) ? 'saved over \u00b7 ' : '';
    const info = `${role}${saved}${f.lines.length} lines${f.eol === '\r\n' ? ' CRLF' : ''}${f.eofNewline || !f.lines.length ? '' : ' no-EOL'}`;
    const count = changed[p.side] ? `${sc.sign}${changed[p.side]}` : '';
    const tail = strWidth(info) + (count ? count.length + 2 : 0) + 2;
    let label = f.label;
    const maxLabel = Math.max(8, room - tail - 2);
    if (strWidth(label) > maxLabel) label = '…' + [...label].slice(-(maxLabel - 1)).join('');
    x += pill(scr, x, 0, label, sc.mark, t, room);
    const end = p.x + p.w - 1;
    if (end - x > tail) {
      let rx = end - tail + 1;
      if (count) { rx += scr.text(rx, 0, count, style({ fg: sc.mark, bg: t.bar.bg, bold: true })); rx += 2; }
      scr.text(rx, 0, info, bar);
    }
  }
}

function sepStyle(app, seg) {
  const t = app.theme;
  if (seg.type === 'eq') return t.sep;
  if (seg.edit || app.editor?.h === seg) return t.sepEdited;
  if (app.m.isAuto(seg)) return t.sepAuto;
  return app.m.isResolved(seg) ? t.sepResolved : t.sepUnresolved;
}

function drawBody(app, scr, g) {
  const t = app.theme;
  for (let y = 0; y < g.bodyH; y++) {
    const row = app.rows[app.top + y];
    const sy = g.bodyY + y;
    if (!row) continue;
    const seg = app.m.segments[row.si];
    if (row.fold) {
      const fs = style(t.fold);
      scr.fill(0, sy, g.ovX, 1, ' ', fs);
      const label = `⋯ ${row.hidden} identical lines ⋯`;
      for (const p of g.panes) scr.text(p.x + Math.max(0, Math.floor((p.w - strWidth(label)) / 2)), sy, label, fs, p.w);
      continue;
    }
    const info = seg.type === 'hunk' ? app.rowInfo(seg, row.off) : null;
    const band = info && info.band >= 0;
    if (band) drawBand(app, scr, g, sy, row, seg, info.band);
    for (const p of g.panes) {
      if (p.kind === 'side') { if (!band) drawSideCell(app, scr, p, sy, row, seg, info); }
      else drawMergedCell(app, scr, p, sy, row, seg);
    }
    const ss = style(sepStyle(app, seg));
    for (let i = band ? app.m.sides - 1 : 0; i < g.panes.length - 1; i++) scr.put(g.panes[i].x + g.panes[i].w, sy, seg.type === 'eq' ? SEP : SEP_HUNK, ss);
  }
}

function drawLineNo(scr, p, sy, n, st) {
  if (!p.numW) return;
  const s = ' ' + (n ? String(n).padStart(p.numW) : ' '.repeat(p.numW)) + ' ';
  scr.text(p.numX, sy, s, style(st));
}

function drawSideCell(app, scr, p, sy, row, seg, info) {
  const t = app.theme, m = app.m, side = p.side;
  const file = m.files[side], sc = app.sideColors[side];
  if (seg.type === 'eq') {
    const idx = seg.start[side] + row.off;
    drawLineNo(scr, p, sy, idx + 1, t.lineNo);
    drawText(app, scr, p.textX, sy, p.textW, file.lines[idx], t.eq, null, null, { syn: app.syntax(side, true) });
    return;
  }
  const k = info.lines[side];
  const cur = seg.hunk === app.cur;
  const numSt = cur && row.off === app.lineOff && !app.editor && k >= 0 ? t.cursor : cur ? t.current : { fg: sc.num };
  drawLineNo(scr, p, sy, k >= 0 ? seg.start[side] + k + 1 : 0, numSt);
  if (k < 0) {
    scr.fill(p.textX, sy, p.textW, 1, HATCH, style({ fg: sc.filler }));
    // Taking an empty side (dropping the other side's lines) still shows.
    if (info.layout.kind === 'positional' && row.off < seg.height) {
      const s = m.rowSel(seg, row.off);
      if (s?.length === 1 && s[0] === side) scr.put(p.markX, sy, BAR, style({ fg: sc.mark }));
    }
    return;
  }
  let { state, order, quiet } = m.lineState(seg, side, k);
  // While editing, show the originals in full color for reference.
  if (state === 'edit' && app.editor?.h === seg) state = 'open';
  let base, word = null, mark = ' ', markSt = null, syn = null;
  if (state === 'edit' || state === 'same' || quiet) {
    base = t.eq; syn = app.syntax(side, true);
  } else if (state === 'open') {
    base = sc.line; word = sc.word; syn = app.syntax(side);
  } else if (state === 'take') {
    base = sc.chosen; word = sc.chosenWord; syn = app.syntax(side);
    // Taking both: number badges show the order the sides go in.
    if (order) { mark = String(order); markSt = { fg: t.pillText, bg: sc.mark, bold: true }; }
    else { mark = BAR; markSt = { fg: sc.mark }; }
  } else {
    base = t.rejected;
  }
  const ranges = word ? m.words(seg)[side][k] : null;
  scr.put(p.markX, sy, mark, style(markSt || {}));
  drawText(app, scr, p.textX, sy, p.textW, file.lines[seg.start[side] + k], base, word && mix(base, word), ranges, { syn });
}

// The edited text of a hunk spans the side panes, below the originals.
function drawBand(app, scr, g, sy, row, seg, b) {
  const t = app.theme;
  const first = g.panes[0], last = g.panes[app.m.sides - 1];
  const ed = app.editor?.h === seg ? app.editor : null;
  const st = ed ? t.editing : t.edited;
  const x1 = last.x + last.w;
  scr.fill(first.x, sy, x1 - first.x, 1, ' ', style(st));
  scr.put(first.markX, sy, EDIT_MARK, style(mix(st, { fg: t.edit, bold: true })));
  const cur = seg.hunk === app.cur && row.off === app.lineOff && !ed;
  if (cur) drawLineNo(scr, first, sy, 0, t.cursor);
  const lines = ed ? ed.buf.lines : seg.edit;
  const w = x1 - first.textX;
  if (!lines.length) {
    scr.text(first.textX, sy, '(empty \u2014 these lines are removed)', style(mix(st, { italic: true })), w);
    return;
  }
  drawText(app, scr, first.textX, sy, w, lines[b], st, null, null, { hs: ed ? ed.hs : app.hs, syn: app.syntax(1) });
  if (ed && b === ed.buf.y) scr.cursor = [first.textX + ed.buf.cursorColumn(app.cfg.tabWidth) - ed.hs, sy];
}

function drawMergedCell(app, scr, p, sy, row, seg) {
  const t = app.theme, m = app.m;
  if (seg.type === 'eq') {
    const es = m.defaultEqSide;
    drawText(app, scr, p.textX, sy, p.textW, m.files[es].lines[seg.start[es] + row.off], t.eq, null, null, { syn: app.syntax(es, true) });
    return;
  }
  const k = row.off;
  const ed = app.editor?.h === seg ? app.editor : null;
  const entries = ed ? ed.buf.lines.map((text) => ({ text, src: 'edit' })) : m.tagged(seg);
  if (k >= entries.length) {
    if (entries.length === 1 && entries[0].open) scr.fill(p.x, sy, p.w, 1, HATCH, style(mix(t.unresolved, { italic: false })));
    else scr.fill(p.textX, sy, p.textW, 1, HATCH, style({ fg: t.sep.fg }));
    if (k === 0) scr.text(p.textX, sy, ' (nothing) ', style(t.eq), p.textW);
    return;
  }
  const e = entries[k];
  if (e.open) {
    const us = style(t.unresolved);
    scr.fill(p.x, sy, p.w, 1, ' ', us);
    scr.text(p.textX, sy, 'unresolved', us, p.textW);
    return;
  }
  if (e.src === 'edit') {
    const st = ed ? t.editing : t.edited;
    scr.put(p.markX, sy, EDIT_MARK, style(mix(st, { fg: t.edit })));
    drawText(app, scr, p.textX, sy, p.textW, e.text, st, null, null, { syn: app.syntax(1) });
    return;
  }
  const sc = app.sideColors[e.src];
  scr.put(p.markX, sy, BAR, style({ fg: sc.mark }));
  const ranges = m.words(seg)[e.src][e.line];
  drawText(app, scr, p.textX, sy, p.textW, e.text, sc.chosen, mix(sc.chosen, sc.chosenWord), ranges, { syn: app.syntax(e.src) });
}

// Draw a line of source text: tabs expanded, control characters made
// visible, horizontally scrolled, syntax colored, with highlighted ranges.
//   syn: { fn: line -> [[s, e, kind]], palette } or null
function drawText(app, scr, x, y, width, str, stObj, hlObj, ranges, { hs = app.hs, syn = null } = {}) {
  const tw = app.cfg.tabWidth;
  const plain = style(stObj), plainHl = hlObj ? style(hlObj) : plain;
  const ctrl = style(mix(stObj, app.theme.ctrl));
  const toks = syn ? syn.fn(str) : null;
  const found = app.search ? [...str.matchAll(app.search.re)].filter((m) => m[0]).map((m) => [m.index, m.index + m[0].length]) : [];
  const matchSt = style(app.theme.match);
  let fi = 0;
  scr.fill(x, y, width, 1, ' ', style(mix(stObj, { strike: false })));
  let col = 0, ri = 0, ti = 0, lastX = -1;
  for (let i = 0; i < str.length;) {
    const cp = str.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    while (ranges && ri < ranges.length && ranges[ri][1] <= i) ri++;
    const inHl = ranges && ri < ranges.length && ranges[ri][0] <= i;
    let cst = inHl ? plainHl : plain;
    if (toks) {
      while (ti < toks.length && toks[ti][1] <= i) ti++;
      if (ti < toks.length && toks[ti][0] <= i) cst = style(mix(inHl ? hlObj : stObj, syn.palette[toks[ti][2]]));
    }
    while (fi < found.length && found[fi][1] <= i) fi++;
    if (fi < found.length && found[fi][0] <= i) cst = matchSt;
    let ch = String.fromCodePoint(cp), w = cpWidth(cp), cs = cst;
    if (cp === 9) {
      const n = tw - (col % tw);
      for (let s = 0; s < n; s++, col++) if (col >= hs && col < hs + width) scr.put(x + col - hs, y, ' ', cst);
      i += len;
      continue;
    }
    if (cp < 32 || cp === 127) { ch = cp === 13 ? '␍' : cp === 127 ? '␡' : String.fromCodePoint(0x2400 + cp); w = 1; cs = ctrl; }
    if (w === 0) { if (lastX >= 0) scr.combine(lastX, y, ch); i += len; continue; }
    if (col >= hs && col + w <= hs + width) { scr.put(x + col - hs, y, ch, cs, w); lastX = x + col - hs; }
    else if (col < hs + width && col + w > hs) for (let s = Math.max(col, hs); s < Math.min(col + w, hs + width); s++) scr.put(x + s - hs, y, ' ', cst);
    col += w;
    i += len;
  }
  const more = style(mix(stObj, { strike: false }, app.theme.more));
  if (col > hs + width && width > 0) scr.put(x + width - 1, y, '›', more);
  if (hs > 0 && col > 0 && width > 0) scr.put(x, y, '‹', more);
}

// The overview: one column per side, two sub-rows per cell using half
// blocks, scaled so the whole file fits the height of the body.
function drawOverview(app, scr, g) {
  const t = app.theme, ov = t.ov, m = app.m;
  const N = app.rows.length, S = g.bodyH * 2;
  const viewEnd = app.top + g.bodyH;
  for (let side = 0; side < m.sides; side++) {
    const colors = new Array(S);
    for (let s = 0; s < S; s++) {
      const r0 = Math.floor((s * N) / S);
      const r1 = Math.max(r0 + 1, Math.floor(((s + 1) * N) / S));
      let best = -1, color = ov.eq;
      for (let r = r0; r < r1 && r < N; r++) {
        const row = app.rows[r];
        const seg = m.segments[row.si];
        let p, c;
        if (seg.type === 'eq') { p = 0; c = r >= app.top && r < viewEnd ? ov.eqView : ov.eq; }
        else {
          const info = app.rowInfo(seg, row.off);
          const k = info.lines[side];
          const st = k >= 0 ? m.lineState(seg, side, k).state : null;
          if (seg.hunk === app.cur) { p = 5; c = ov.current; }
          else if (info.band >= 0 || st === 'edit') { p = 3; c = ov.edited; }
          else if (st === 'open') { p = 4; c = app.sideColors[side].ov; }
          else if (m.isAuto(seg)) { p = 2; c = st === 'take' ? ov.auto : ov.rejected; }
          else if (st === 'take') { p = 3; c = ov.resolved; }
          else if (st === 'drop') { p = 2; c = ov.rejected; }
          else { p = 1; c = ov.empty; }
        }
        if (p > best) { best = p; color = c; }
      }
      colors[s] = color;
    }
    for (let y = 0; y < g.bodyH; y++) {
      scr.put(g.ovX + side, g.bodyY + y, '▀', style({ fg: colors[2 * y], bg: colors[2 * y + 1] }));
    }
  }
}

function drawStatus(app, scr, g) {
  const t = app.theme, y = g.H - 1;
  const bar = style(t.bar), key = style(t.barKey);
  scr.fill(0, y, g.W, 1, ' ', bar);
  let x = 1;
  const text = (s, st) => { x += scr.text(x, y, s, style(st), g.W - x); };
  const badge = (s, color) => { x += pill(scr, x, y, s, color, t, g.W - x) + 1; };
  let hints;
  if (app.editor) {
    badge(`${EDIT_MARK} EDIT`, t.edit);
    hints = [['Esc', 'done'], ['C-c', 'cancel'], ['C-l/C-r', 'reset to left/right']];
  } else {
    const st = app.m.stats();
    badge(app.m.three ? 'MERGE' : 'DIFF', t.accent);
    if (!st.total) badge('identical', t.ok);
    else {
      text(`${app.cur + 1}/${st.total} `, t.barKey);
      if (st.unresolved) badge(`${st.unresolved} ${app.m.three ? 'to resolve' : 'unresolved'}`, t.warn);
      else badge('✓ all resolved', t.ok);
      if (st.edited) badge(`${EDIT_MARK} ${st.edited}`, t.edit);
      if (app.m.three) text(`${st.conflicts} conflict${st.conflicts === 1 ? '' : 's'}, ${st.auto} auto-merged `, t.bar);
    }
    if (app.search) {
      const sr = app.search;
      badge(`/${sr.query}  ${sr.matches.length ? `${sr.idx + 1}/${sr.matches.length}` : 'no matches'}`, t.match.bg);
    }
    if (app.dirty) text('● modified ', { fg: t.danger, bg: t.bar.bg, bold: true });
    if (app.msg) text(` ${app.msg.text}`, { fg: app.msg.warn ? t.warn : t.modalTitle.fg, bg: t.bar.bg, bold: app.msg.warn });
    hints = app.search ? [['n/p', 'next/prev match'], ['Esc', 'end search'], ['?', 'help']]
      : app.m.three ? [['h/c/l', 'ours/base/theirs'], ['H/C/L', 'line'], ['b', 'both'], ['x', 'neither'], ['e', 'edit'], ['Tab', 'next'], ['s', 'save'], ['?', 'help']]
      : [['h/l', 'take'], ['H/L', 'line'], ['b', 'both'], ['x', 'neither'], ['e', 'edit'], ['n/p', 'hunk'], ['s', 'save'], ['?', 'help']];
  }
  // Key hints on the right, as many as fit (help always stays).
  const widthOf = (hs) => hs.reduce((a, [k, d]) => a + k.length + d.length + 3, 0);
  while (hints.length > 1 && x + widthOf(hints) + 2 > g.W) hints.splice(hints.length - 2, 1);
  let hx = g.W - widthOf(hints) + 1;
  if (hx <= x) return;
  for (const [k, d] of hints) {
    hx += scr.text(hx, y, k, key);
    hx += scr.text(hx, y, ` ${d}  `, bar);
  }
}

// Modal: { title, lines: [[[text, styleName], ...], ...], scroll, input }
function drawModal(app, scr, md) {
  const t = app.theme;
  const lineW = (l) => l.reduce((a, [s]) => a + strWidth(s), 0);
  const inner = Math.min(scr.w - 6, Math.max(strWidth(md.title) + 6, ...md.lines.map(lineW), md.input ? 50 : 0));
  const maxBody = scr.h - 4 - (md.input ? 2 : 0);
  const bodyH = Math.min(md.lines.length, maxBody);
  md.scroll = Math.max(0, Math.min(md.scroll || 0, md.lines.length - bodyH));
  md.pageH = bodyH;
  const h = bodyH + 2 + (md.input ? 2 : 0);
  const w = inner + 4;
  const x0 = Math.floor((scr.w - w) / 2), y0 = Math.floor((scr.h - h) / 2);
  const bs = style(t.modalBorder), ms = style(t.modal);
  scr.fill(x0, y0, w, h, ' ', ms);
  scr.put(x0, y0, '╭', bs); scr.put(x0 + w - 1, y0, '╮', bs);
  scr.put(x0, y0 + h - 1, '╰', bs); scr.put(x0 + w - 1, y0 + h - 1, '╯', bs);
  for (let i = 1; i < w - 1; i++) { scr.put(x0 + i, y0, '─', bs); scr.put(x0 + i, y0 + h - 1, '─', bs); }
  for (let i = 1; i < h - 1; i++) { scr.put(x0, y0 + i, '│', bs); scr.put(x0 + w - 1, y0 + i, '│', bs); }
  // Title as a badge sitting on the top border.
  pill(scr, x0 + 2, y0, ` ${md.title} `, t.modalBorder.fg, { ...t, bar: t.modal }, w - 4);
  for (let i = 0; i < bodyH; i++) {
    let x = x0 + 2;
    for (const [s, name] of md.lines[md.scroll + i]) x += scr.text(x, y0 + 1 + i, s, style(t[name || 'modal']), x0 + w - 2 - x);
  }
  if (md.lines.length > bodyH) {
    const more = `${md.scroll + 1}-${md.scroll + bodyH}/${md.lines.length}`;
    scr.text(x0 + w - more.length - 3, y0 + h - 1, ` ${more} `, bs);
  }
  if (md.input) {
    const iy = y0 + h - 2, ix = x0 + 2, iw = w - 4;
    const is = style(t.input);
    scr.fill(ix, iy, iw, 1, ' ', is);
    const b = md.input;
    const col = b.cursorColumn(app.cfg.tabWidth);
    const off = Math.max(0, col - iw + 1);
    scr.text(ix, iy, [...fit(b.line, off + iw)].slice(off).join(''), is, iw);
    scr.cursor = [ix + col - off, iy];
  }
}
