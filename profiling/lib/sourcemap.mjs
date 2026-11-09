// Tiny source-map v3 reader (no deps): maps generated line/col -> original source/line and guesses the
// original function name from sourcesContent so minified client bundles give stable Bottom-Up keys.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DEC = new Map([...B64].map((c, i) => [c, i]));

function decodeVlq(str, pos) {
  const out = [];
  let value = 0, shift = 0;
  for (let i = pos.start; i < pos.end; i++) {
    const d = DEC.get(str[i]);
    value += (d & 31) << shift;
    if (d & 32) { shift += 5; continue; }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0; shift = 0;
  }
  return out;
}

/** Identity "map" over plain source text: for unminified files, so anonymous functions can still be named. */
export function plainSource(text) {
  const lines = text.split("\n");
  return { identity: true, lookup: (line, col) => ({ source: undefined, line, col, text: lines[line] }) };
}

export function parseSourceMap(map) {
  const lines = [];
  let src = 0, oLine = 0, oCol = 0, name = 0;
  const m = map.mappings;
  let lineSegs = [];
  let segStart = 0;
  let gCol = 0;
  const flushSeg = (end) => {
    if (end <= segStart) return;
    const f = decodeVlq(m, { start: segStart, end });
    gCol += f[0];
    if (f.length >= 4) {
      src += f[1]; oLine += f[2]; oCol += f[3];
      if (f.length >= 5) name += f[4];
      lineSegs.push([gCol, src, oLine, oCol, f.length >= 5 ? name : -1]);
    }
  };
  for (let i = 0; i <= m.length; i++) {
    const c = m[i];
    if (c === "," || c === ";" || i === m.length) {
      flushSeg(i);
      segStart = i + 1;
      if (c === ";" || i === m.length) { lines.push(lineSegs); lineSegs = []; gCol = 0; }
    }
  }
  const contentLines = (map.sourcesContent ?? []).map((s) => (typeof s === "string" ? s.split("\n") : undefined));
  return {
    /** 0-based line/col -> {source, line (0-based), col, name?} */
    lookup(line, col) {
      const segs = lines[line];
      if (!segs || segs.length === 0) return undefined;
      let lo = 0, hi = segs.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (segs[mid][0] <= col) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (best < 0) best = 0;
      const s = segs[best];
      // A name on this or the next couple of segments is usually the function identifier.
      let nm;
      for (let k = best; k < Math.min(segs.length, best + 3); k++) if (segs[k][4] >= 0) { nm = map.names[segs[k][4]]; break; }
      return { source: map.sources[s[1]], line: s[2], col: s[3], name: nm, text: contentLines[s[1]]?.[s[2]] };
    },
  };
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "new", "await", "async", "typeof", "const", "let", "var", "of", "in", "do", "else"]);

/**
 * Guess a function's original name. V8 reports a function's position at its parameter list, so `col` in the
 * original line is the "(" (or the bare param of `x => ...`). What precedes it tells the name:
 *   function foo<T>(   |   foo(  (method)   |   const foo = (   |   foo: (   |   this.foo = function (
 * A callback argument (`setInterval(() =>`) stays anonymous.
 */
export function nameFromSource(text, col) {
  if (!text || col < 0) return undefined;
  // Mapping may land on the `function` keyword or the method name itself.
  const tail = text.slice(col);
  let t = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(tail);
  if (t) return t[1];
  t = /^(?:(?:static|async|get|set|public|private|protected|override)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/.exec(tail);
  if (t && !KEYWORDS.has(t[1]) && !/[.\w$]$/.test(text.slice(0, col)) && /(?:^|[\s{};,])$/.test(text.slice(0, col))) return t[1];
  let head = text.slice(0, col).replace(/<[^<>()]*>\s*$/, "").trimEnd();
  let m = /(?:^|[^\w$.])(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)$/.exec(head);
  if (m && !KEYWORDS.has(m[1])) {
    if (/\bfunction\s*\*?\s*[\w$]+$/.test(head) || !/\(\s*$/.test(head)) return m[1];
  }
  m = /([A-Za-z_$][\w$]*)\s*(?::\s*[^=()]*?)?\s*[=:]\s*(?:async\s*)?(?:function\s*\*?\s*)?\(?$/.exec(head);
  if (m && !KEYWORDS.has(m[1]) && !/\(\s*\($/.test(head) && !/,\s*\(?$/.test(head)) return m[1];
  m = /\.([A-Za-z_$][\w$]*)$/.exec(head);
  if (m) return m[1];
  // Callback argument: label it by the callee, e.g. "(anonymous→setInterval)".
  m = /([A-Za-z_$][\w$]*)\s*\((?:[^()]*,)?\s*$/.exec(head);
  if (m && !KEYWORDS.has(m[1])) return `(anonymous→${m[1]})`;
  return undefined;
}
