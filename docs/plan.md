# kydiff plan

## The original brief

Kept verbatim as written at the start of the project.

> # Looking to make a TUI diff/merge tool to replace xxdiff in my workflows
>
> I used to use xxdiff a lot as merge tool, for simple little things, but also for really complicated stuff that would've been terrible to do in a terminal. It's upkeep was lagging, and I tried meld and many others, nothing came close.
>
> The things I really liked about it:
>
> 1) clarity
> - side by side
> - the identical parts were boring gray
> - the differences were highlighted in vibrant colors
> - once selected it was blatantly obvious what was selected and what would be merged
> - the overview on the right have a good overview of the whole file, how much they differed and where the differences were
> - scrolling scrolled all two-three files in sync
>
> 2) ease of use
> . this will be easy to replicate with a TUI
> - selecting the segment was real easy, left, right, both (changing order repeated presses), neither
>
> 3) the three
> - it was very easy to use
> - the way it handled conflicts was very intuitive. It allowed me to see all three versions at once and make decisions quickly.
>
> 4) I liked that I was able to open older file left, newer right, then proceed to "merge" the changes into sort of either file and then save that, depending which use case I was doing.
>    The process and visuals were the same and then I just ultimately saved one of the files that the tool had no idea was to be the "merged" file. Great process for 2-say diffs.
>
> And to continue from that:
>
> A1) what I would add
> - the quick editing of merged chunks, so I could make small changes without having to open another editor. xxdiff had this to someextent, but it was a bit clunky.
>
> A2) what I would investigate and see how it could be improved
> - contemporary stuff, like how does git diff play into this?
>
> A3) conflict resolution done here intuitively would be nice
> - the problem is that git conflict shows head and change, but it's no longer clear what the base was, i.e. what the original branch changed then and there
>   and what the other branch changed. it just shows the products, when the things that collidied were the changes, the operations, not the products.
>   with a 3way diff with this tool, we could maybe see the base in the middle and the two competing changes on the sides, and then we could see what the original was and what the two competing changes were, and then we could make a decision about which one to keep or how to merge them. And maybe how to edit them merged.
> - what I did with xxdiff here quite frequently was the S, i.e. both in some order and then a quick edit for the section, but I'm thinking this could be done in a more elegant way. That said, vim is a great tool for this tool and its threeway diff is very good, but it doesn't have the clarity of xxdiff. I think a TUI could be made that would be very good for this, and it would be a great tool for git conflict resolution.
> - that said, I wouldn't want to sacrifice the base use for this altar and we should probably first focus on making the 2way diff right and the 3way one is an extension of that.
>
> A4) for colours and visuals
> - I'd probabbly baseline it with github PR diffs, beacuse that's what we're all quite used to dealing with
> - but I'd then improbe that to be  a tool that is clear to use and segments can be selected and merged and even modified in-place.
>
> A5) use all the landscape available, no menus needed, ? can popup help modal to see the hotkeys, which should be configurable, but the defaults should be intuitive and easy to remember
>
> A6) the overview on the right is a conundrum how well it can be made in a TUI, but we'll have to try
>
> A7) I'm definitely leaning on first doing it with js (not typescript, vanilla is fine) and if it works out, then we can consider a port to C or even rust.

## The plan as agreed

1. **2-way first, done right** (brief 1, 2, 4, A1, A4–A7). Done.
   - Side by side with synced scrolling, gray identical text, GitHub-style
     red/green differences with word highlights. A taken side lights up and a
     dropped side is struck through.
   - Per difference: left, right, both (pressing again swaps the order),
     neither. The result can be saved over either input, to `-o`, or to any
     path.
   - Overview strip on the right, built from half-block characters, with click
     and drag.
   - `?` help, configurable keys and colors, no menus. Vanilla JS, no
     dependencies.
2. **Gaps found after the first version.** Done.
   - Reload (`R`) after saving over an input, with a "saved over" marker on that
     pane.
   - Search (`/`, then `n`/`p`).
3. **3-way with the base in the middle** (brief 3, A3). Done.
   - ours | base | theirs. Differences only one side made, or both made
     identically, are merged automatically. The rest are conflicts.
   - Inside a difference only the lines a side actually changed are colored, so
     the competing *operations* show, not the products.
   - `c` takes the base. Unresolved conflicts are written with diff3-style
     markers.
4. **Git** (A2). Done.
   - `git difftool` / `git mergetool` configuration.
   - `kydiff --git [PATH...]` reads the stages from the index, saves to the
     working tree, and stages each file once it's resolved.
5. **Conflicted files directly.** Done.
   - `kydiff FILE` uses the index when the file is unmerged. Otherwise it rebuilds
     the versions from diff3/zdiff3 (or plain) conflict markers.
6. **Line alignment by similarity.** Done.
   - Inside a difference, similar lines face each other and inserted lines get
     their own rows, rather than lines pairing by position.
   - Where Myers' diff could pair a changed block with either of two
     candidates, it now picks the more similar one. This fixes a function
     inserted next to a changed one stealing the pairing.
7. **Port to C or Rust** (A7), once the design settles. Not started.

## Decisions made along the way

- **Colors:** vivid and modern, never bland. Syntax highlighting is on,
  identical regions use a muted palette, and the header and status bar use
  colored pills.
- **Two different "both" layouts:**
  - Taking both shows a staircase, first side on top and the second below it,
    so the order reads top to bottom (brief 2's "changing order").
  - Lines can also be decided one at a time, xxdiff-style: `j`/`k` move a line
    cursor, Shift+choice applies to that line only, and `n`/`p` jump between
    differences.
- **Editing in place (A1, A3's "S then quick edit"):** happens in a
  full-width band under the hunk's original lines, with the originals still
  visible. There's no permanent merged column in 2-way, because either side
  can be saved. The merged column stays available as an optional preview
  (`m`).
- **3-way defaults:** base in the middle, one-sided changes merged
  automatically, and "both" means ours then theirs.

## Open ideas

- Editing inside identical regions.
- Character-level alignment for moved text.
