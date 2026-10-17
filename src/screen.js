// A cell buffer that is drawn into each frame and serialized to ANSI,
// emitting only rows that changed since the previous frame.

const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || '');

// Display width of a code point: 0 for combining marks, 2 for wide CJK and
// emoji, else 1. Deliberately approximate; good enough for source code.
export function cpWidth(cp) {
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) ||
      (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f) ||
      cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

export function strWidth(s) {
  let w = 0;
  for (const ch of s) w += cpWidth(ch.codePointAt(0));
  return w;
}

// Display width of s with tabs expanded.
export function textWidth(s, tabWidth) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    w += cp === 9 ? tabWidth - (w % tabWidth) : cp < 32 || cp === 127 ? 1 : cpWidth(cp);
  }
  return w;
}

// Truncate s (no tabs) to at most w columns.
export function fit(s, w) {
  let out = '', used = 0;
  for (const ch of s) {
    const cw = cpWidth(ch.codePointAt(0));
    if (used + cw > w) break;
    out += ch; used += cw;
  }
  return out;
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function to256(r, g, b) {
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const cube = 16 + 36 * q(r) + 6 * q(g) + q(b);
  const gray = r === g && g === b;
  if (gray && r > 8 && r < 238) return 232 + Math.round((r - 8) / 10);
  return cube;
}

function colorSgr(hex, base) {
  const [r, g, b] = hexRgb(hex);
  return TRUECOLOR ? `${base};2;${r};${g};${b}` : `${base};5;${to256(r, g, b)}`;
}

// Style objects: { fg, bg, bold, dim, italic, underline, strike, reverse }.
// They are interned into small integers so cells stay cheap.
const styleIds = new Map();
const styleSgr = [];

export function style(s) {
  if (typeof s === 'number') return s;
  const key = JSON.stringify(s || {});
  let id = styleIds.get(key);
  if (id === undefined) {
    const p = ['0'];
    if (s) {
      if (s.bold) p.push('1');
      if (s.dim) p.push('2');
      if (s.italic) p.push('3');
      if (s.underline) p.push('4');
      if (s.reverse) p.push('7');
      if (s.strike) p.push('9');
      if (s.fg) p.push(colorSgr(s.fg, 38));
      if (s.bg) p.push(colorSgr(s.bg, 48));
    }
    id = styleSgr.length;
    styleSgr.push(`\x1b[${p.join(';')}m`);
    styleIds.set(key, id);
  }
  return id;
}

// Merge style objects left to right, ignoring undefined fields.
export function mix(...parts) {
  const out = {};
  for (const p of parts) if (p) for (const k in p) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

export class Screen {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.ch = new Array(w * h).fill(' ');
    this.st = new Uint16Array(w * h);
    this.cursor = null; // [x, y] to show the terminal cursor
  }

  put(x, y, ch, st, cw = 1) {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return;
    if (cw === 2 && x === this.w - 1) { ch = ' '; cw = 1; }
    const i = y * this.w + x;
    // Don't leave half of a wide character behind.
    if (this.ch[i] === '' && x > 0) this.ch[i - 1] = ' ';
    if (x + 1 < this.w && this.ch[i + 1] === '' && cw === 1) this.ch[i + 1] = ' ';
    this.ch[i] = ch; this.st[i] = st;
    if (cw === 2) {
      if (x + 2 < this.w && this.ch[i + 2] === '') this.ch[i + 2] = ' ';
      this.ch[i + 1] = ''; this.st[i + 1] = st;
    }
  }

  // Append a zero-width character to the cell at x.
  combine(x, y, ch) {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return;
    const i = y * this.w + x;
    if (this.ch[i] !== '') this.ch[i] += ch;
  }

  fill(x, y, w, h, ch, st) {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) this.put(c, r, ch, st);
  }

  // Draw plain text (no tabs), clipped to maxW columns. Returns columns used.
  text(x, y, s, st, maxW = this.w - x) {
    let used = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      const cw = cpWidth(cp);
      if (cw === 0) { this.combine(x + used - 1, y, ch); continue; }
      if (used + cw > maxW) break;
      this.put(x + used, y, cp < 32 ? '·' : ch, st, cw);
      used += cw;
    }
    return used;
  }

  rowString(y) {
    let out = '', cur = -1;
    for (let x = 0; x < this.w; x++) {
      const i = y * this.w + x;
      if (this.ch[i] === '') continue;
      if (this.st[i] !== cur) { cur = this.st[i]; out += styleSgr[cur]; }
      out += this.ch[i];
    }
    return out + '\x1b[0m';
  }

  serialize(prev) {
    let out = '\x1b[?2026h\x1b[?25l';
    const rows = [];
    for (let y = 0; y < this.h; y++) {
      const r = this.rowString(y);
      rows.push(r);
      if (!prev || prev[y] !== r) out += `\x1b[${y + 1};1H${r}`;
    }
    if (this.cursor) out += `\x1b[${this.cursor[1] + 1};${this.cursor[0] + 1}H\x1b[?25h`;
    out += '\x1b[?2026l';
    return { out, rows };
  }
}
