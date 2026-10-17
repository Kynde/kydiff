// A small, language-agnostic syntax highlighter. It works one line at a time
// with no state carried between lines, which keeps it fast and predictable;
// block comments are recognised by their usual line shapes.
// Returns [[start, end, kind], ...] with kinds: comment string number
// keyword constant func type.

const KEYWORDS = new Set(`
  if else elif for while do switch case default break continue return goto try catch finally throw throws
  function func fn def lambda class struct enum union interface trait impl type typedef namespace module
  package import from export as use using include require extends implements
  const let var val mut static extern public private protected internal final abstract virtual override
  async await yield new delete typeof instanceof in of is not and or with pass raise except global nonlocal
  void int long short char float double bool boolean string byte unsigned signed auto
  match where loop unsafe pub crate self super this mod ref move dyn go defer select chan map range
  then fi done esac local echo export readonly
`.trim().split(/\s+/));

const CONSTANTS = new Set('true false null nil None True False undefined NaN Infinity NULL nullptr'.split(' '));

const HASH_COMMENT = /\.(py|sh|bash|zsh|rb|pl|pm|ya?ml|toml|conf|cfg|ini|r|mk|cmake|nix|tf|dockerfile|gitignore|env)$|(^|\/)(Makefile|Dockerfile|CMakeLists\.txt)$/i;
const SLASH_COMMENT = /\.(js|mjs|cjs|jsx|ts|tsx|c|h|cc|cpp|cxx|hpp|hh|java|kt|kts|go|rs|cs|swift|scala|dart|php|css|scss|less|zig|proto|groovy|gradle|json5|jsonc|glsl|v|sv)$/i;

export function highlighter(path) {
  const hash = HASH_COMMENT.test(path), slash = SLASH_COMMENT.test(path);
  const known = hash || slash;
  // Unknown file types: allow both comment styles, but # only at line start.
  const re = tokenRegex(hash || !known, slash || !known, known);
  const cache = new Map();
  return (line) => {
    let r = cache.get(line);
    if (!r) {
      r = tokenize(line, re, slash || !known, known);
      if (cache.size > 20000) cache.clear();
      cache.set(line, r);
    }
    return r;
  };
}

function tokenRegex(hash, slash, known) {
  const comment = [];
  if (slash) comment.push(String.raw`\/\*.*?(?:\*\/|$)`, String.raw`(?<!:)\/\/.*$`);
  if (hash) comment.push(known ? '#.*$' : String.raw`^\s*#.*$`);
  return new RegExp([
    String.raw`("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|` + '`(?:[^`\\\\]|\\\\.)*`?)',
    `(${comment.join('|') || '(?!)'})`,
    String.raw`(\b0[xX][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)`,
    String.raw`([\p{L}_$][\p{L}\p{N}_$]*)`,
  ].join('|'), 'gu');
}

function tokenize(line, re, slash, strict) {
  const out = [];
  // Continuation lines of block comments: " * text" or a closing " */".
  if (slash && /^\s*\*(\s|\/|$)/.test(line)) return [[0, line.length, 'comment']];
  for (const m of line.matchAll(re)) {
    const s = m.index, e = s + m[0].length;
    if (m[1]) {
      // A lone apostrophe in prose ("don't") shouldn't color the line.
      if (m[1][0] === "'" && !strict && /\w/.test(line[s - 1] || '')) continue;
      out.push([s, e, 'string']);
    } else if (m[2]) out.push([s, e, 'comment']);
    else if (m[3]) out.push([s, e, 'number']);
    else if (m[4]) {
      const w = m[4];
      if (KEYWORDS.has(w)) out.push([s, e, 'keyword']);
      else if (CONSTANTS.has(w)) out.push([s, e, 'constant']);
      else if (/^\s*\(/.test(line.slice(e))) out.push([s, e, 'func']);
      else if (/^[A-Z][a-z0-9]/.test(w)) out.push([s, e, 'type']);
    }
  }
  return out;
}
