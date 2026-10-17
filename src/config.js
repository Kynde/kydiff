// Defaults for key bindings, colors and options, and loading of the user's
// overrides from $XDG_CONFIG_HOME/kdiff/config.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// [action, keys, description]; grouped for the help screen.
export const ACTIONS = [
  ['Move', [
    ['nextLine', ['j', 'down'], 'next differing line'],
    ['prevLine', ['k', 'up'], 'previous differing line'],
    ['nextHunk', ['n'], 'next difference'],
    ['prevHunk', ['p'], 'previous difference'],
    ['nextUnresolved', ['tab', ']'], 'next unresolved difference'],
    ['prevUnresolved', ['S-tab', '['], 'previous unresolved difference'],
    ['scrollDown', ['J', 'C-e'], 'scroll down one line'],
    ['scrollUp', ['K', 'C-y'], 'scroll up one line'],
    ['halfPageDown', ['C-d'], 'scroll half a page down'],
    ['halfPageUp', ['C-u'], 'scroll half a page up'],
    ['pageDown', ['pagedown', 'space', 'C-f'], 'page down'],
    ['pageUp', ['pageup', 'C-b'], 'page up'],
    ['top', ['g', 'home'], 'go to top'],
    ['bottom', ['G', 'end'], 'go to bottom'],
    ['scrollRight', ['>', 'M-right'], 'scroll right'],
    ['scrollLeft', ['<', 'M-left'], 'scroll left'],
    ['scrollHome', ['0'], 'scroll back to the first column'],
  ]],
  ['Choose', [
    ['selectLeft', ['h', 'left', '1'], 'take the left side'],
    ['selectRight', ['l', 'right', '2'], 'take the right side'],
    ['selectBoth', ['b'], 'take both; again to swap the order'],
    ['selectNeither', ['x'], 'take neither (drop the lines)'],
    ['unselect', ['-', 'backspace'], 'back to unresolved'],
    ['selectAllLeft', ['M-h'], 'take left for every unresolved difference'],
    ['selectAllRight', ['M-l'], 'take right for every unresolved difference'],
    ['edit', ['e', 'enter'], 'edit the result in place'],
    ['editExternal', ['E'], 'edit the result in $EDITOR'],
    ['undo', ['u', 'C-z'], 'undo'],
    ['redo', ['U', 'C-r'], 'redo'],
  ]],
  ['Choose one line', [
    ['selectLineLeft', ['H', 'S-left'], 'take left for the line under the cursor'],
    ['selectLineRight', ['L', 'S-right'], 'take right for the line under the cursor'],
    ['selectLineBoth', ['B'], 'take both for the line; again to swap'],
    ['selectLineNeither', ['X'], 'take neither for the line'],
    ['unselectLine', ['_'], 'line back to unresolved'],
  ]],
  ['View', [
    ['toggleMerged', ['m'], 'show/hide the merged result column'],
    ['toggleFold', ['z'], 'fold/unfold identical regions'],
    ['toggleSyntax', ['C'], 'syntax colors on/off'],
    ['help', ['?', 'f1'], 'this help'],
    ['redraw', ['C-l'], 'redraw the screen'],
  ]],
  ['File', [
    ['save', ['s', 'C-s'], 'save the merged result'],
    ['quit', ['q', 'C-c'], 'quit'],
    ['forceQuit', ['Q'], 'quit without asking'],
  ]],
];

export const EDITOR_HELP = [
  ['Esc', 'finish editing and keep the text'],
  ['C-c', 'cancel, discarding changes'],
  ['C-k / C-u', 'delete to end / start of line'],
  ['C-a / C-e', 'start / end of line'],
  ['C-l / C-r', 'replace with the left / right side'],
];

// Colors. Pills are solid badges in the header and status bar; `syntax` is
// used on changed lines and the quieter `syntaxDim` on identical ones.
const DARK = {
  bar: { fg: '#8b949e', bg: '#161b22' },
  barKey: { fg: '#e3b341', bg: '#161b22', bold: true },
  pillText: '#0d1117',
  accent: '#58a6ff', edit: '#bc8cff', warn: '#ffa657', ok: '#56d364', danger: '#ff7b72',
  eq: { fg: '#7d8590' },
  lineNo: { fg: '#3d444d' },
  current: { fg: '#0d1117', bg: '#e3b341', bold: true },
  cursor: { fg: '#0d1117', bg: '#f0f6fc', bold: true },
  sep: { fg: '#30363d' },
  sepUnresolved: { fg: '#e3b341' },
  sepResolved: { fg: '#58a6ff' },
  sepEdited: { fg: '#bc8cff' },
  fold: { fg: '#79c0ff', bg: '#0f1d2e', italic: true },
  more: { fg: '#e3b341', bold: true },
  ctrl: { fg: '#6e7681' },
  sides: [
    {
      line: { fg: '#f0f6fc', bg: '#3d1b21' }, word: { bg: '#8c2a35' },
      chosen: { fg: '#ffffff', bg: '#5e1f29' }, chosenWord: { bg: '#b8364a' },
      mark: '#ff7b72', num: '#d5605a', filler: '#3b2328', ov: '#f85149', sign: '−',
    },
    {
      line: { fg: '#f0f6fc', bg: '#122d1c' }, word: { bg: '#1f6a35' },
      chosen: { fg: '#ffffff', bg: '#1a4a2a' }, chosenWord: { bg: '#2a8e47' },
      mark: '#56d364', num: '#3fa14f', filler: '#1e3326', ov: '#3fb950', sign: '+',
    },
  ],
  rejected: { fg: '#484f58', strike: true },
  edited: { fg: '#f0f6fc', bg: '#2e2152' },
  editing: { fg: '#ffffff', bg: '#3d2b70' },
  unresolved: { fg: '#e3b341', bg: '#2b2210', italic: true },
  syntax: {
    keyword: { fg: '#d2a8ff' }, string: { fg: '#a5d6ff' }, number: { fg: '#79c0ff' }, constant: { fg: '#79c0ff' },
    comment: { fg: '#9ea7b3', italic: true }, func: { fg: '#ffa657' }, type: { fg: '#ffd580' },
  },
  syntaxDim: {
    keyword: { fg: '#9078b8' }, string: { fg: '#6a92b8' }, number: { fg: '#5a87b5' }, constant: { fg: '#5a87b5' },
    comment: { fg: '#4f5863', italic: true }, func: { fg: '#b5804f' }, type: { fg: '#b09a66' },
  },
  ov: { eq: '#1c2128', eqView: '#444c56', empty: '#2d333b', rejected: '#2d333b', resolved: '#58a6ff', edited: '#bc8cff', current: '#e3b341' },
  modal: { fg: '#c9d1d9', bg: '#161b22' },
  modalBorder: { fg: '#58a6ff', bg: '#161b22' },
  modalTitle: { fg: '#f0f6fc', bg: '#161b22', bold: true },
  modalKey: { fg: '#e3b341', bg: '#161b22', bold: true },
  modalDim: { fg: '#8b949e', bg: '#161b22' },
  input: { fg: '#f0f6fc', bg: '#2d333b' },
};

const LIGHT = {
  bar: { fg: '#57606a', bg: '#eaeef2' },
  barKey: { fg: '#9a6700', bg: '#eaeef2', bold: true },
  pillText: '#ffffff',
  accent: '#0969da', edit: '#8250df', warn: '#bc4c00', ok: '#1a7f37', danger: '#cf222e',
  eq: { fg: '#6e7781' },
  lineNo: { fg: '#c4ccd4' },
  current: { fg: '#ffffff', bg: '#bf8700', bold: true },
  cursor: { fg: '#ffffff', bg: '#1f2328', bold: true },
  sep: { fg: '#d0d7de' },
  sepUnresolved: { fg: '#bf8700' },
  sepResolved: { fg: '#0969da' },
  sepEdited: { fg: '#8250df' },
  fold: { fg: '#0969da', bg: '#ddf4ff', italic: true },
  more: { fg: '#9a6700', bold: true },
  ctrl: { fg: '#8c959f' },
  sides: [
    {
      line: { fg: '#1f2328', bg: '#ffebe9' }, word: { bg: '#ffb3ae' },
      chosen: { fg: '#1f2328', bg: '#ffcbc6' }, chosenWord: { bg: '#ff8a82' },
      mark: '#cf222e', num: '#d1242f', filler: '#f5d0cc', ov: '#cf222e', sign: '−',
    },
    {
      line: { fg: '#1f2328', bg: '#e6ffec' }, word: { bg: '#a6eeb8' },
      chosen: { fg: '#1f2328', bg: '#c3f5cf' }, chosenWord: { bg: '#6fdd8b' },
      mark: '#1a7f37', num: '#1a7f37', filler: '#c6ecd0', ov: '#1a7f37', sign: '+',
    },
  ],
  rejected: { fg: '#afb8c1', strike: true },
  edited: { fg: '#1f2328', bg: '#efe5ff' },
  editing: { fg: '#1f2328', bg: '#ddd0ff' },
  unresolved: { fg: '#9a6700', bg: '#fff8c5', italic: true },
  syntax: {
    keyword: { fg: '#8250df' }, string: { fg: '#0a3069' }, number: { fg: '#0550ae' }, constant: { fg: '#0550ae' },
    comment: { fg: '#6e7781', italic: true }, func: { fg: '#953800' }, type: { fg: '#6639ba' },
  },
  syntaxDim: {
    keyword: { fg: '#a988e0' }, string: { fg: '#5a7aa0' }, number: { fg: '#5a86c0' }, constant: { fg: '#5a86c0' },
    comment: { fg: '#a8b1ba', italic: true }, func: { fg: '#b97a50' }, type: { fg: '#9580c8' },
  },
  ov: { eq: '#eaeef2', eqView: '#afb8c1', empty: '#d8dee4', rejected: '#d8dee4', resolved: '#0969da', edited: '#8250df', current: '#bf8700' },
  modal: { fg: '#1f2328', bg: '#f6f8fa' },
  modalBorder: { fg: '#0969da', bg: '#f6f8fa' },
  modalTitle: { fg: '#1f2328', bg: '#f6f8fa', bold: true },
  modalKey: { fg: '#9a6700', bg: '#f6f8fa', bold: true },
  modalDim: { fg: '#656d76', bg: '#f6f8fa' },
  input: { fg: '#1f2328', bg: '#ffffff' },
};

export const THEMES = { dark: DARK, light: LIGHT };

export const DEFAULTS = {
  theme: 'dark',
  colors: {},
  keys: {},
  tabWidth: 4,
  fold: false,
  foldContext: 3,
  showMerged: false,
  syntax: true,
  autoAdvance: false,
  mouse: true,
};

function deepMerge(base, over) {
  if (Array.isArray(base) && Array.isArray(over)) return base.map((v, i) => (i in over ? deepMerge(v, over[i]) : v));
  if (base && typeof base === 'object' && over && typeof over === 'object' && !Array.isArray(over)) {
    const out = { ...base };
    for (const k in over) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
    return out;
  }
  return over === undefined ? base : over;
}

export function configPath() {
  const dir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(dir, 'kdiff', 'config.json');
}

// overrides (from the command line) win over the config file.
export function loadConfig(overrides = {}, file = configPath()) {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${file}: ${e.message}`);
  }
  const cfg = { ...DEFAULTS, ...user, ...overrides };
  if (!THEMES[cfg.theme]) throw new Error(`unknown theme "${cfg.theme}" (try dark or light)`);
  cfg.themeColors = deepMerge(THEMES[cfg.theme], cfg.colors || {});

  // key -> action, with user bindings replacing an action's defaults.
  cfg.keymap = new Map();
  cfg.bindings = {};
  for (const [, actions] of ACTIONS) {
    for (const [name, keys] of actions) {
      const bound = Array.isArray(user.keys?.[name]) ? user.keys[name] : keys;
      cfg.bindings[name] = bound;
    }
  }
  for (const [name, keys] of Object.entries(cfg.bindings)) for (const k of keys) cfg.keymap.set(k, name);
  return cfg;
}
