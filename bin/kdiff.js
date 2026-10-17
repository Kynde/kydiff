#!/usr/bin/env node
// kdiff: side-by-side terminal diff and merge.

import { loadFile, Merge } from '../src/model.js';
import { loadConfig, configPath } from '../src/config.js';
import { Terminal } from '../src/term.js';
import { App } from '../src/app.js';

const USAGE = `usage: kdiff [options] LEFT RIGHT
       kdiff [options] OURS BASE THEIRS

Compare two files side by side and merge them by picking, per difference,
the left side, the right side, both, or neither, or by editing the result.
Save the result over either input or to another file. One file can be "-"
to read it from stdin.

With three files, the base goes in the middle and each side is shown as a
change to it. Changes only one side made are merged automatically; the
conflicts are left to you.

options:
  -o, --output FILE      where the merged result goes by default
  -L, --label NAME       label for the next file (repeatable)
  -w, --ignore-all-space ignore all whitespace when comparing lines
  -b, --ignore-space-change
                         ignore changes in the amount of whitespace
  -f, --fold             start with identical regions folded
  -m, --merged           start with the merged result column shown
      --theme NAME       dark or light
  -h, --help             show this help

config: ${configPath()}

git:
  git config --global difftool.kdiff.cmd 'kdiff -L "$MERGED (old)" -L "$MERGED (new)" "$LOCAL" "$REMOTE"'
  git config --global mergetool.kdiff.cmd 'kdiff -L "$MERGED (ours)" -L "$MERGED (base)" -L "$MERGED (theirs)" "$LOCAL" "$BASE" "$REMOTE" -o "$MERGED"'
  git config --global mergetool.kdiff.trustExitCode true
  git difftool -t kdiff / git mergetool -t kdiff`;

function parseArgs(argv) {
  const o = { files: [], labels: [], output: null, diff: {}, cfg: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) die(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '-h': case '--help': console.log(USAGE); process.exit(0);
      case '-o': case '--output': o.output = val(); break;
      case '-L': case '--label': o.labels.push(val()); break;
      case '-w': case '--ignore-all-space': o.diff.ignoreAllSpace = true; break;
      case '-b': case '--ignore-space-change': o.diff.ignoreSpaceChange = true; break;
      case '-f': case '--fold': o.cfg.fold = true; break;
      case '-m': case '--merged': o.cfg.showMerged = true; break;
      case '--theme': o.cfg.theme = val(); break;
      case '--': o.files.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith('-') && a !== '-') die(`unknown option ${a}\n\n${USAGE}`);
        o.files.push(a);
    }
  }
  return o;
}

function die(msg) {
  process.stderr.write(`kdiff: ${msg}\n`);
  process.exit(2);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.files.length !== 2 && opts.files.length !== 3) die(`need two or three files\n\n${USAGE}`);
if (opts.files.filter((f) => f === '-').length > 1) die('only one file can come from stdin');

// stdin can only be read once; a reload keeps what was read.
const load = (prev) => new Merge(
  opts.files.map((f, i) => (f === '-' && prev ? prev.files[i] : loadFile(f, opts.labels[i]))), opts.diff);

let model, cfg;
try {
  cfg = loadConfig(opts.cfg);
  model = load(null);
} catch (e) {
  die(e.message);
}

const term = new Terminal({ mouse: cfg.mouse });
const app = new App({ model, cfg, term, output: opts.output, load });

let pending = false;
const schedule = () => {
  if (pending) return;
  pending = true;
  setImmediate(() => { pending = false; if (term.active) app.draw(); });
};

const crash = (e) => {
  term.stop();
  process.stderr.write(`kdiff: internal error: ${e?.stack || e}\n`);
  process.exit(3);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
process.on('SIGTERM', () => { term.stop(); process.exit(143); });
process.on('SIGHUP', () => { term.stop(); process.exit(129); });

term.on('input', (ev) => { app.handle(ev); schedule(); });
term.on('resize', () => { app.prevRows = null; app.buildRows(); schedule(); });
term.start();
app.draw();
