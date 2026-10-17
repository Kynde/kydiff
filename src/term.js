// Terminal setup and input decoding.
//
// Keys are decoded into names:
//   printable characters as themselves ('a', 'A', '?'), 'space'
//   'enter' 'tab' 'S-tab' 'backspace' 'escape' 'up' 'down' 'left' 'right'
//   'home' 'end' 'pageup' 'pagedown' 'insert' 'delete' 'f1'..'f12'
//   modifiers as prefixes: 'C-d', 'M-x', 'S-left', 'C-right'
// Mouse events are { type: 'mouse', action, button, x, y } (0-based) and
// pastes are { type: 'paste', text }.

import fs from 'node:fs';
import tty from 'node:tty';
import { EventEmitter } from 'node:events';

const CSI_TILDE = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9',
  21: 'f10', 23: 'f11', 24: 'f12',
};
const CSI_LETTER = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };

function withMods(name, mod) {
  const m = (mod || 1) - 1;
  let p = '';
  if (m & 4) p += 'C-';
  if (m & 2) p += 'M-';
  if (m & 1) p += 'S-';
  return p + name;
}

export function decode(data, state = { paste: null }) {
  const events = [];
  let i = 0;
  while (i < data.length) {
    if (state.paste !== null) {
      const end = data.indexOf('\x1b[201~', i);
      if (end < 0) { state.paste += data.slice(i); break; }
      events.push({ type: 'paste', text: state.paste + data.slice(i, end) });
      state.paste = null;
      i = end + 6;
      continue;
    }
    const rest = data.slice(i);
    let m;
    if (rest.startsWith('\x1b[200~')) { state.paste = ''; i += 6; continue; }
    if ((m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest))) {
      const b = +m[1], x = +m[2] - 1, y = +m[3] - 1;
      let action;
      if (b & 64) action = (b & 1) ? 'wheeldown' : 'wheelup';
      else if (m[4] === 'm') action = 'up';
      else if (b & 32) action = 'drag';
      else action = 'down';
      events.push({ type: 'mouse', action, button: b & 3, x, y, shift: !!(b & 4), ctrl: !!(b & 16) });
      i += m[0].length;
      continue;
    }
    if ((m = /^\x1b\[([0-9;]*)([~A-Za-z])/.exec(rest))) {
      const params = m[1].split(';').map(Number);
      let name;
      if (m[2] === '~') name = CSI_TILDE[params[0]];
      else if (m[2] === 'Z') name = 'S-tab';
      else name = CSI_LETTER[m[2]];
      if (name) events.push(withMods(name, params[1]));
      i += m[0].length;
      continue;
    }
    if ((m = /^\x1bO([A-Z])/.exec(rest))) {
      const name = CSI_LETTER[m[1]];
      if (name) events.push(name);
      i += 3;
      continue;
    }
    if (rest[0] === '\x1b') {
      if (rest.length === 1 || rest[1] === '\x1b') { events.push('escape'); i += 1; continue; }
      events.push('M-' + keyName(rest.codePointAt(1)));
      i += 1 + (rest.codePointAt(1) > 0xffff ? 2 : 1);
      continue;
    }
    const cp = rest.codePointAt(0);
    events.push(keyName(cp));
    i += cp > 0xffff ? 2 : 1;
  }
  return events;
}

function keyName(cp) {
  if (cp === 13 || cp === 10) return 'enter';
  if (cp === 9) return 'tab';
  if (cp === 127 || cp === 8) return 'backspace';
  if (cp === 32) return 'space';
  if (cp === 0) return 'C-space';
  if (cp < 27) return 'C-' + String.fromCharCode(cp + 96);
  if (cp < 32) return 'C-' + String.fromCharCode(cp + 64);
  return String.fromCodePoint(cp);
}

// The text a key inserts in an editor, or null.
export function keyText(k) {
  if (k === 'space') return ' ';
  if (k === 'tab') return '\t';
  if (typeof k === 'string' && [...k].length === 1) return k;
  return null;
}

export class Terminal extends EventEmitter {
  constructor({ mouse = true } = {}) {
    super();
    this.mouse = mouse;
    // Input files may have come through stdin, so talk to the tty directly.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      this.input = process.stdin;
      this.output = process.stdout;
      this.fd = 0;
    } else {
      this.fd = fs.openSync('/dev/tty', 'r+');
      this.input = new tty.ReadStream(this.fd);
      this.output = new tty.WriteStream(this.fd);
    }
    this.decodeState = { paste: null };
    this.onData = (d) => { for (const ev of decode(d, this.decodeState)) this.emit('input', ev); };
    this.onResize = () => this.emit('resize');
    this.active = false;
  }

  get cols() { return this.output.columns || 80; }
  get rows() { return this.output.rows || 24; }

  start() {
    if (this.active) return;
    this.active = true;
    this.input.setRawMode(true);
    this.input.setEncoding('utf8');
    this.input.on('data', this.onData);
    this.input.resume();
    this.output.on('resize', this.onResize);
    let s = '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?7l';
    if (this.mouse) s += '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
    this.output.write(s);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.output.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l');
    this.input.off('data', this.onData);
    this.output.off('resize', this.onResize);
    this.input.setRawMode(false);
    this.input.pause();
  }

  write(s) { this.output.write(s); }
}
