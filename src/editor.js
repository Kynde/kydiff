// A small text buffer with a cursor, used for in-place hunk editing and for
// single-line prompts. Cursor x is a string offset into the current line.

import { textWidth } from './screen.js';

export class Buffer {
  constructor(lines, { multiline = true } = {}) {
    this.lines = lines.length ? [...lines] : [''];
    this.multiline = multiline;
    this.y = 0;
    this.x = 0;
    this.want = null; // preferred display column for vertical movement
  }

  get line() { return this.lines[this.y]; }
  text() { return this.lines.join('\n'); }

  set(lines) {
    this.lines = lines.length ? [...lines] : [''];
    this.y = Math.min(this.y, this.lines.length - 1);
    this.x = Math.min(this.x, this.line.length);
  }

  insert(s) {
    s = s.replace(/\r\n?/g, '\n');
    if (!this.multiline) s = s.replace(/\n/g, ' ');
    const parts = s.split('\n');
    const before = this.line.slice(0, this.x), after = this.line.slice(this.x);
    if (parts.length === 1) {
      this.lines[this.y] = before + s + after;
      this.x += s.length;
    } else {
      const last = parts.pop();
      const add = [before + parts[0], ...parts.slice(1), last + after];
      this.lines.splice(this.y, 1, ...add);
      this.y += add.length - 1;
      this.x = last.length;
    }
    this.want = null;
  }

  backspace() {
    if (this.x > 0) {
      const n = charBefore(this.line, this.x);
      this.lines[this.y] = this.line.slice(0, this.x - n) + this.line.slice(this.x);
      this.x -= n;
    } else if (this.y > 0) {
      const prev = this.lines[this.y - 1];
      this.lines.splice(this.y - 1, 2, prev + this.line);
      this.y--;
      this.x = prev.length;
    }
    this.want = null;
  }

  del() {
    if (this.x < this.line.length) {
      const n = charAt(this.line, this.x);
      this.lines[this.y] = this.line.slice(0, this.x) + this.line.slice(this.x + n);
    } else if (this.y < this.lines.length - 1) {
      this.lines.splice(this.y, 2, this.line + this.lines[this.y + 1]);
    }
    this.want = null;
  }

  left() {
    if (this.x > 0) this.x -= charBefore(this.line, this.x);
    else if (this.y > 0) { this.y--; this.x = this.line.length; }
    this.want = null;
  }

  right() {
    if (this.x < this.line.length) this.x += charAt(this.line, this.x);
    else if (this.y < this.lines.length - 1) { this.y++; this.x = 0; }
    this.want = null;
  }

  wordLeft() {
    const s = this.line.slice(0, this.x);
    const m = /[\p{L}\p{N}_]*[^\p{L}\p{N}_]*$/u.exec(s);
    if (this.x === 0) return this.left();
    this.x -= m[0].length || 1;
    this.want = null;
  }

  wordRight() {
    if (this.x === this.line.length) return this.right();
    const m = /^[^\p{L}\p{N}_]*[\p{L}\p{N}_]*/u.exec(this.line.slice(this.x));
    this.x += m[0].length || 1;
    this.want = null;
  }

  vertical(dy, tabWidth) {
    const ny = Math.max(0, Math.min(this.lines.length - 1, this.y + dy));
    if (ny === this.y) {
      this.x = dy < 0 ? 0 : this.line.length;
      return;
    }
    if (this.want === null) this.want = textWidth(this.line.slice(0, this.x), tabWidth);
    this.y = ny;
    this.x = offsetAtColumn(this.line, this.want, tabWidth);
  }

  home() { this.x = 0; this.want = null; }
  end() { this.x = this.line.length; this.want = null; }
  killEnd() { this.lines[this.y] = this.line.slice(0, this.x); }
  killStart() { this.lines[this.y] = this.line.slice(this.x); this.x = 0; }

  // Place the cursor at a display column on line y (for mouse clicks).
  moveTo(y, col, tabWidth) {
    this.y = Math.max(0, Math.min(this.lines.length - 1, y));
    this.x = offsetAtColumn(this.line, col, tabWidth);
    this.want = null;
  }

  cursorColumn(tabWidth) { return textWidth(this.line.slice(0, this.x), tabWidth); }
}

function charBefore(s, x) {
  const c = s.charCodeAt(x - 1);
  return c >= 0xdc00 && c <= 0xdfff && x > 1 ? 2 : 1;
}

function charAt(s, x) {
  const c = s.charCodeAt(x);
  return c >= 0xd800 && c <= 0xdbff ? 2 : 1;
}

function offsetAtColumn(s, col, tabWidth) {
  let x = 0;
  for (const ch of s) {
    const w = textWidth(s.slice(0, x + ch.length), tabWidth);
    if (w > col) break;
    x += ch.length;
  }
  return x;
}
