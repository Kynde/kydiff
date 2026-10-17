# kdiff

A side-by-side terminal diff and merge tool in the spirit of xxdiff: identical
text stays quiet, differences are loud, and every decision is obvious at a
glance. Plain JavaScript with no dependencies, needs Node 20+.

```
kdiff old.js new.js              # compare, merge into either file, save
kdiff -o merged.js a.js b.js     # with a default output file
git show HEAD~3:f.c | kdiff - f.c
kdiff ours.c base.c theirs.c -o merged.c   # 3-way merge
kdiff --git                      # resolve the conflicts of a merge/rebase
```

## How it works

Each difference ("hunk") is resolved by taking the **left** side, the
**right** side, **both**, **neither**, or by **editing** the result in place.
Unresolved hunks are GitHub-style red and green. A taken side lights up with a
▌ bar and a dropped side is struck through. The thin bar between the panes is
amber while a hunk is unresolved, blue once resolved and purple once edited.

- **Both** stacks the hunk as a staircase, first side on top and the second
  below it, with 1/2 badges. Press `b` again to flip the order.
- **Single lines**: `j`/`k` move a line cursor through the differing lines.
  `H`/`L`/`B`/`X` (Shift = this line only) decide just that line. Lines pair
  up across the panes the way they are aligned, so you can take line 1 from
  the right and line 2 from the left.
- **Editing** (`e`) opens a magenta band under the hunk's original lines,
  spanning both panes, and you edit right there. It starts from the current
  result, or left followed by right if nothing is chosen yet. After editing,
  the originals stay visible but dimmed above the edited text.

Saving offers the output file (`-o`), the left file, the right file, or any
other path. That's the xxdiff habit of opening old on the left and new on the
right, merging, and writing the result over whichever file you want. When you
save over one of the inputs, hunks you left unresolved keep that file's version.
For any other path you choose between conflict markers, left or right.

## Three-way merging

With three files the layout is ours | base | theirs, with the base in the
middle. Git's conflict markers show only the two results; here you see the
change each side made to the base:

- Inside a difference, only the lines a side actually changed are colored
  (ours cyan, theirs green, and red for the base lines they replaced). Lines a
  side kept from the base are dimmed, so the two competing *operations* stand
  out.
- Differences only one side made, or both made identically, are merged
  automatically. They show as resolved (dim blue in the overview) and can
  still be changed. `Tab` jumps between the real conflicts.
- `h`/`l` take ours/theirs, `c` takes the base, `b` takes ours then theirs
  (again for theirs then ours), Shift does the same for one line, and `e`
  edits. Unresolved conflicts are written with diff3-style markers.

The column on the far right is an overview of the whole file: one strip per
side, red and green for open differences, blue for resolved ones, amber for the
current one, with the visible region lit up. Click or drag it to jump.

## Keys

`?` shows everything. The essentials:

| key | |
|---|---|
| `n` `p` | next / previous difference |
| `j` `k` / `↓` `↑` | move the line cursor (crosses into the next difference) |
| `Tab` `S-Tab` | next / previous unresolved |
| `h` `l` / `←` `→` | take left / right (ours / theirs) |
| `c` | 3-way: take the base |
| `1` `2` `3` | take the 1st / 2nd / 3rd pane |
| `b` | take both, again to swap order |
| `x` | take neither |
| `-` | back to unresolved |
| `H` `L` `C` `B` `X` / `S-←` `S-→` | the same, for the line under the cursor only |
| `/` | search; `n` `p` then go through the matches, `Esc` ends it |
| `R` | reload the files from disk |
| `M-h` `M-l` | take left / right for all unresolved |
| `e` | edit the result in place (`Esc` done, `C-c` cancel) |
| `E` | edit the result in `$EDITOR` |
| `u` `U` | undo / redo |
| `m` | show a merged-result preview column |
| `z` | fold identical regions |
| `s` | save |
| `q` | quit |

Mouse: click a side to take it (click again to undo), right-click to take it
for that line only, click edited text to edit it, wheel to scroll.

## Configuration

`~/.config/kdiff/config.json` (or under `$XDG_CONFIG_HOME`):

```json
{
  "theme": "dark",
  "tabWidth": 4,
  "fold": false,
  "showMerged": false,
  "autoAdvance": false,
  "syntax": true,
  "keys": { "selectLeft": ["a", "left"], "selectRight": ["d", "right"] },
  "colors": { "sides": [{ "line": { "bg": "#401010" } }] }
}
```

Action names for `keys` are listed in `src/config.js`. A binding replaces that
action's defaults. `colors` is merged over the chosen theme (`dark` or
`light`).

## git

During a merge, rebase or cherry-pick with conflicts, `kdiff --git` goes
through the conflicted files one at a time, or just the paths you name. It
reads ours, base and theirs from git's index, saves to the working tree file,
and runs `git add` on it once no conflict markers are left (unless you pass
`--no-stage`). Quitting moves on to the next file and `Q` stops. It exits with
status 0 only if every file got resolved.

It also works as a regular difftool and mergetool:

```sh
git config --global difftool.kdiff.cmd 'kdiff -L "$MERGED (old)" -L "$MERGED (new)" "$LOCAL" "$REMOTE"'
git config --global difftool.prompt false
git difftool -t kdiff HEAD~1
```

```sh
git config --global mergetool.kdiff.cmd 'kdiff -L "$MERGED (ours)" -L "$MERGED (base)" -L "$MERGED (theirs)" "$LOCAL" "$BASE" "$REMOTE" -o "$MERGED"'
git config --global mergetool.kdiff.trustExitCode true
git mergetool -t kdiff
```

kdiff exits with status 1 if `-o` was given but nothing was saved, so git
knows the file wasn't merged.

## Roadmap

- Reading a file with diff3/zdiff3 conflict markers directly, so a conflicted
  file can be resolved without git's help.
- Better alignment when one side inserts code next to a line the other side
  changed (prefer pairing similar lines).
- Editing identical regions, character-level alignment for moved text.
- A port to C or Rust once the design settles.

## Development

```sh
npm test
```

`src/diff.js` holds the Myers line/word diff, `src/model.js` the merge state,
`src/view.js` the rendering, `src/app.js` the input handling and
`src/term.js` the terminal I/O.
