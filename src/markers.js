// Rebuilding ours, base and theirs from a file with conflict markers:
//
//   <<<<<<< ours label
//   ours lines
//   ||||||| base label      (diff3 and zdiff3 styles only)
//   base lines
//   =======
//   theirs lines
//   >>>>>>> theirs label
//
// Text outside the conflicts goes to all three versions. Without a base
// section the base of that conflict is empty, so both sides read as
// additions.

const MARK = /^(<{7}|\|{7}|={7}|>{7})(?: (.*))?\r?$/;

export function parseConflicts(lines) {
  const out = { ours: [], base: [], theirs: [], conflicts: 0, withoutBase: 0, labels: [null, null, null] };
  let state = null; // null outside a conflict, else 'ours' | 'base' | 'theirs'
  let sawBase = false;
  for (const line of lines) {
    const m = MARK.exec(line);
    const kind = m ? m[1][0] : null;
    if (state === null) {
      if (kind === '<') {
        state = 'ours';
        sawBase = false;
        out.conflicts++;
        out.labels[0] ??= m[2] || null;
      } else {
        out.ours.push(line); out.base.push(line); out.theirs.push(line);
      }
      continue;
    }
    if (kind === '|' && state === 'ours') { state = 'base'; sawBase = true; out.labels[1] ??= m[2] || null; continue; }
    if (kind === '=' && (state === 'ours' || state === 'base')) {
      state = 'theirs';
      if (!sawBase) out.withoutBase++;
      continue;
    }
    if (kind === '>' && state === 'theirs') { state = null; out.labels[2] ??= m[2] || null; continue; }
    out[state].push(line);
  }
  if (state !== null) throw new Error('unterminated conflict (no >>>>>>> line)');
  return out;
}
