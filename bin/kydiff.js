#!/usr/bin/env node
// kydiff: side-by-side terminal diff and merge.

import { loadFile, Merge } from '../src/model.js';
import { loadConfig, configPath } from '../src/config.js';
import { Terminal } from '../src/term.js';
import { App } from '../src/app.js';
import * as git from '../src/git.js';
import { parseConflicts } from '../src/markers.js';
import { parseText } from '../src/model.js';
import fs from 'node:fs';

const USAGE = `usage: kydiff [options] LEFT RIGHT
       kydiff [options] OURS BASE THEIRS
       kydiff --git [PATH...]
       kydiff FILE-WITH-CONFLICTS

Compare two files side by side and merge them by picking, per difference,
the left side, the right side, both, or neither, or by editing the result.
Save the result over either input or to another file. One file can be "-"
to read it from stdin.

With three files, the base goes in the middle and each side is shown as a
change to it. Changes only one side made are merged automatically; the
conflicts are left to you.

With --git, kydiff resolves the conflicts of a merge, rebase or cherry-pick
in progress: it reads ours, base and theirs from git's index for each
conflicted file (or just the PATHs given), saves to the working tree file
and stages it once no conflicts are left in it.

With a single FILE that has conflict markers, kydiff uses git's index if the
file is unmerged there, and otherwise rebuilds the three versions from the
markers (diff3 or zdiff3 style markers include the base) and saves back to
FILE.

options:
  -o, --output FILE      where the merged result goes by default
  -L, --label NAME       label for the next file (repeatable)
  -w, --ignore-all-space ignore all whitespace when comparing lines
  -b, --ignore-space-change
                         ignore changes in the amount of whitespace
  -f, --fold             start with identical regions folded
  -m, --merged           start with the merged result column shown
      --git              resolve git conflicts (see above)
      --no-stage         with --git, don't git add resolved files
      --theme NAME       dark or light
  -h, --help             show this help

config: ${configPath()}

git:
  git config --global difftool.kydiff.cmd 'kydiff -L "$MERGED (old)" -L "$MERGED (new)" "$LOCAL" "$REMOTE"'
  git config --global mergetool.kydiff.cmd 'kydiff -L "$MERGED (ours)" -L "$MERGED (base)" -L "$MERGED (theirs)" "$LOCAL" "$BASE" "$REMOTE" -o "$MERGED"'
  git config --global mergetool.kydiff.trustExitCode true
  git difftool -t kydiff / git mergetool -t kydiff / kydiff --git`;

function parseArgs(argv) {
  const o = { files: [], labels: [], output: null, diff: {}, cfg: {}, git: false, stage: true };
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
      case '--git': o.git = true; break;
      case '--no-stage': o.stage = false; break;
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
  process.stderr.write(`kydiff: ${msg}\n`);
  process.exit(2);
}

const opts = parseArgs(process.argv.slice(2));
let cfg;
try {
  cfg = loadConfig(opts.cfg);
} catch (e) {
  die(e.message);
}

// A single file with conflicts: from git's index if it is unmerged there.
if (!opts.git && opts.files.length === 1 && opts.files[0] !== '-') {
  try {
    if (git.conflicts(opts.files).length) opts.git = true;
  } catch {
    // Not in a git repository; fall back to the markers.
  }
}

// The three versions rebuilt from FILE's conflict markers.
function loadMarkers(file) {
  const parsed = parseText(fs.readFileSync(file, 'utf8'));
  const c = parseConflicts(parsed.lines);
  if (!c.conflicts) throw new Error('no conflict markers in the file');
  const roles = [['ours', c.ours], ['base', c.base], ['theirs', c.theirs]];
  const files = roles.map(([role, lines], i) => ({
    ...parsed, path: '-', name: file, mtime: null, lines,
    label: `${file} (${role}${c.labels[i] && c.labels[i] !== role ? `: ${c.labels[i]}` : ''}${role === 'base' && c.withoutBase ? ', not recorded' : ''})`,
  }));
  return { files, withoutBase: c.withoutBase };
}

// Each job is one merge to show: { load(prev) -> Merge, output, afterSave }.
let jobs;
if (!opts.git && opts.files.length === 1) {
  const file = opts.files[0];
  let first;
  try {
    first = loadMarkers(file);
  } catch (e) {
    die(`${file}: ${e.message}`);
  }
  jobs = [{
    load: (prev) => new Merge(prev ? loadMarkers(file).files : first.files, opts.diff),
    output: opts.output || file,
    note: first.withoutBase ? `${first.withoutBase} conflict(s) without a base; git config merge.conflictStyle zdiff3 records it` : null,
  }];
} else if (opts.git) {
  let found;
  try {
    found = git.conflicts(opts.files);
  } catch (e) {
    die(e.message);
  }
  if (!found.length) die(opts.files.length ? 'no conflicts in the given paths' : 'no conflicted files');
  jobs = found.map((c) => ({
    name: c.path,
    load: () => new Merge(git.loadConflict(c), opts.diff),
    output: c.path,
    afterSave: (file, clean) => {
      if (!clean || !opts.stage) return clean ? null : 'conflict markers left in, not staged';
      git.stage(c.path);
      return 'staged';
    },
  }));
} else {
  if (opts.files.length !== 2 && opts.files.length !== 3) die(`need two or three files\n\n${USAGE}`);
  if (opts.files.filter((f) => f === '-').length > 1) die('only one file can come from stdin');
  // stdin can only be read once; a reload keeps what was read.
  jobs = [{
    load: (prev) => new Merge(
      opts.files.map((f, i) => (f === '-' && prev ? prev.files[i] : loadFile(f, opts.labels[i]))), opts.diff),
    output: opts.output,
  }];
}

const term = new Terminal({ mouse: cfg.mouse });
let app = null;
const results = [];

let pending = false;
const schedule = () => {
  if (pending) return;
  pending = true;
  setImmediate(() => { pending = false; if (term.active && app) app.draw(); });
};

function finish() {
  term.stop();
  if (jobs.length > 1 || opts.git) {
    const done = results.filter((r) => r.code === 0).map((r) => r.name);
    const left = jobs.map((j) => j.name).filter((n) => !done.includes(n));
    if (done.length) console.log(`kydiff: resolved ${done.join(', ')}`);
    if (left.length) console.log(`kydiff: not resolved ${left.join(', ')}`);
  }
  process.exit(results.length === jobs.length && results.every((r) => r.code === 0) ? 0 : 1);
}

function open(i) {
  const job = jobs[i];
  let model;
  try {
    model = job.load(null);
  } catch (e) {
    term.stop();
    die(`${job.name ? job.name + ': ' : ''}${e.message}`);
  }
  app = new App({
    model, cfg, term, output: job.output, load: job.load, afterSave: job.afterSave,
    queue: jobs.length > 1 ? { index: i + 1, total: jobs.length } : null,
    onExit: (code, abort) => {
      results.push({ name: job.name, code });
      if (abort || i + 1 >= jobs.length) return finish();
      open(i + 1);
      app.prevRows = null;
      schedule();
    },
  });
  if (job.note) app.flash(job.note, true);
}

const crash = (e) => {
  term.stop();
  process.stderr.write(`kydiff: internal error: ${e?.stack || e}\n`);
  process.exit(3);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
process.on('SIGTERM', () => { term.stop(); process.exit(143); });
process.on('SIGHUP', () => { term.stop(); process.exit(129); });

open(0);
term.on('input', (ev) => { app.handle(ev); schedule(); });
term.on('resize', () => { app.prevRows = null; app.buildRows(); schedule(); });
term.start();
app.draw();
