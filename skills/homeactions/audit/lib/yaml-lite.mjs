// yaml-lite: a small, zero-dependency YAML subset parser, enough for GitHub Actions workflow files.
// The same source is copied verbatim into the generated placement test (kit/repo/tests/placement.test.mjs.tmpl)
// between the BEGIN/END markers there; a homeactions test keeps the two copies identical.
//
// Supported:
//   - block mappings and block sequences by indentation (spaces only), including "- key: value" items
//     and sequences written at the same indent as their parent key;
//   - plain, 'single-quoted' and "double-quoted" scalars (quoted scalars may not span lines);
//   - block scalars | and > with chomping (- / +) and an optional indentation digit;
//   - flow sequences [a, b] and flow mappings { a: 1 }, nested, and spanning several lines;
//   - comments (# at line start, or after whitespace outside quotes);
//   - plain scalars folded over continuation lines that are indented deeper than their key;
//   - a single leading "---" document marker.
// Scalars: true/false -> boolean, null/~/empty -> null, decimal integers/floats -> number, anything else -> string.
// "on", "yes", "no", "y", "n" stay strings (YAML 1.2 core schema, which is what GitHub workflows rely on).
// Not supported (a YamlError is thrown, never a silent wrong value): anchors (&), aliases (*), tags (!),
// merge keys (<<), complex keys (?), multiple documents, tabs used for indentation.
// Line numbers: every mapping and sequence carries a non-enumerable LINES map (key or index -> 1-based line);
// use lineOf(node, key).

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}

export const LINES = Symbol("yaml-lite.lines");

export function lineOf(node, key) {
  return node && node[LINES] ? node[LINES].get(key) : undefined;
}

function setLine(node, key, line) {
  if (!node[LINES]) Object.defineProperty(node, LINES, { value: new Map(), enumerable: false });
  node[LINES].set(key, line);
}

// Remove a trailing comment outside quotes. Returns the content without the comment, right-trimmed.
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) {
        if (q === "'" && s[i + 1] === "'") i++;
        else q = null;
      }
    } else if (c === "'" || c === '"') {
      // a quote only opens a quoted scalar at the start of a token
      if (i === 0 || /[\s\[\{,:-]/.test(s[i - 1])) q = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).replace(/\s+$/, "");
    }
  }
  return s.replace(/\s+$/, "");
}

function tokenizeLines(text) {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  return raw.map((r, i) => {
    const m = /^( *)(.*)$/.exec(r);
    const indent = m[1].length;
    const body = m[2];
    if (/^\t/.test(body) && body.trim() !== "") throw new YamlError("tab used for indentation", i + 1);
    const content = stripComment(body);
    return { n: i + 1, raw: r, indent, content, blank: content === "" };
  });
}

// Find "key:" at the start of content (outside quotes / flow). Returns { key, rest } or null.
function splitKey(content) {
  let i = 0;
  let key;
  if (content[0] === '"' || content[0] === "'") {
    const q = content[0];
    let j = 1;
    for (; j < content.length; j++) {
      if (content[j] === "\\" && q === '"') j++;
      else if (content[j] === q) {
        if (q === "'" && content[j + 1] === "'") j++;
        else break;
      }
    }
    if (j >= content.length) return null;
    key = parseQuoted(content.slice(0, j + 1));
    i = j + 1;
    if (content[i] !== ":" || (content[i + 1] !== undefined && content[i + 1] !== " ")) return null;
    return { key, rest: content.slice(i + 1).trim() };
  }
  if (/^[\[\{]/.test(content)) return null;
  for (; i < content.length; i++) {
    if (content[i] === ":" && (i + 1 === content.length || content[i + 1] === " ")) {
      key = content.slice(0, i).trim();
      if (key === "") return null;
      if (key === "<<") throw new YamlError("merge keys (<<) are not supported");
      if (key.startsWith("?")) throw new YamlError("complex keys (?) are not supported");
      return { key, rest: content.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseQuoted(s) {
  if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'");
  const inner = s.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = inner[++i];
    const map = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/", " ": " ", e: "\x1b", b: "\b" };
    if (e in map) out += map[e];
    else if (e === "x") {
      out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (e === "u") {
      out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += e;
  }
  return out;
}

function plainScalar(s, line) {
  const t = s.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (/^[&*!]/.test(t)) throw new YamlError(`anchors, aliases and tags are not supported ("${t.slice(0, 20)}")`, line);
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(t)) return Number(t);
  if (/^[-+]?(0|[1-9][0-9]*)?\.[0-9]+([eE][-+]?[0-9]+)?$/.test(t) || /^[-+]?(0|[1-9][0-9]*)[eE][-+]?[0-9]+$/.test(t)) return Number(t);
  return t;
}

function scalar(s, line) {
  const t = s.trim();
  if ((t[0] === '"' || t[0] === "'") && t.length >= 2 && t[t.length - 1] === t[0]) return parseQuoted(t);
  if (t[0] === '"' || t[0] === "'") throw new YamlError("unterminated quoted scalar (quoted scalars may not span lines)", line);
  return plainScalar(t, line);
}

// ---- flow collections --------------------------------------------------------------------------

function parseFlow(src, line) {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  function value() {
    ws();
    const c = src[i];
    if (c === "[") {
      i++;
      const arr = [];
      ws();
      if (src[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (src[i] === ",") {
          i++;
          ws();
          if (src[i] === "]") {
            i++;
            return arr;
          }
          continue;
        }
        if (src[i] === "]") {
          i++;
          return arr;
        }
        throw new YamlError(`bad flow sequence near "${src.slice(i, i + 20)}"`, line);
      }
    }
    if (c === "{") {
      i++;
      const obj = {};
      ws();
      if (src[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const k = token(true);
        ws();
        let v = null;
        if (src[i] === ":") {
          i++;
          v = value();
        }
        obj[k === null ? "null" : String(k)] = v;
        setLine(obj, String(k), line);
        ws();
        if (src[i] === ",") {
          i++;
          ws();
          if (src[i] === "}") {
            i++;
            return obj;
          }
          continue;
        }
        if (src[i] === "}") {
          i++;
          return obj;
        }
        throw new YamlError(`bad flow mapping near "${src.slice(i, i + 20)}"`, line);
      }
    }
    return token(false);
  }
  function token(isKey) {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") {
      const start = i++;
      for (; i < src.length; i++) {
        if (src[i] === "\\" && c === '"') i++;
        else if (src[i] === c) {
          if (c === "'" && src[i + 1] === "'") i++;
          else break;
        }
      }
      i++;
      return parseQuoted(src.slice(start, i));
    }
    const start = i;
    let depth = 0;
    for (; i < src.length; i++) {
      const ch = src[i];
      // GitHub expressions "${{ ... }}" may appear inside plain flow scalars: keep their braces
      if (ch === "$" && src[i + 1] === "{") {
        depth++;
        i++;
        continue;
      }
      if (depth > 0) {
        if (ch === "}" && src[i + 1] === "}") {
          depth--;
          i++;
        }
        continue;
      }
      if (ch === "," || ch === "]" || ch === "}") break;
      if (isKey && ch === ":" && (src[i + 1] === " " || src[i + 1] === undefined || /[,\]\}]/.test(src[i + 1]))) break;
    }
    return plainScalar(src.slice(start, i), line);
  }
  const v = value();
  ws();
  if (i < src.length) throw new YamlError(`unexpected text after flow collection: "${src.slice(i, i + 20)}"`, line);
  return v;
}

function flowBalanced(s) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth <= 0;
}

// ---- block structure ---------------------------------------------------------------------------

export function parse(text) {
  const lines = tokenizeLines(text);
  let pos = 0;
  const skipBlank = () => {
    while (pos < lines.length && lines[pos].blank) pos++;
  };
  skipBlank();
  if (pos < lines.length && /^---(\s|$)/.test(lines[pos].content) && lines[pos].indent === 0) {
    lines[pos].content = lines[pos].content.slice(3).trim();
    lines[pos].blank = lines[pos].content === "";
    skipBlank();
  }

  function isSeqItem(l) {
    return l.content === "-" || l.content.startsWith("- ");
  }

  function parseNode(minIndent) {
    skipBlank();
    if (pos >= lines.length) return null;
    const l = lines[pos];
    if (l.indent < minIndent) return null;
    if (/^(---|\.\.\.)(\s|$)/.test(l.content) && l.indent === 0) throw new YamlError("multiple documents are not supported", l.n);
    if (isSeqItem(l)) return parseSeq(l.indent);
    if (splitKey(l.content)) return parseMap(l.indent);
    // a bare scalar or flow collection on its own line(s)
    return inlineValue(l.content, l.indent - 1, l.n, true);
  }

  function parseMap(indent) {
    const obj = {};
    for (;;) {
      skipBlank();
      if (pos >= lines.length) break;
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError("bad indentation of a mapping entry", l.n);
      if (isSeqItem(l)) break;
      const kv = splitKey(l.content);
      if (!kv) throw new YamlError(`expected "key: value", found "${l.content.slice(0, 40)}"`, l.n);
      pos++;
      const key = kv.key === null ? "null" : String(kv.key);
      setLine(obj, key, l.n);
      if (kv.rest === "") {
        skipBlank();
        const next = lines[pos];
        if (next && next.indent === indent && isSeqItem(next)) obj[key] = parseSeq(indent);
        else if (next && next.indent > indent) obj[key] = parseNode(indent + 1);
        else obj[key] = null;
      } else obj[key] = inlineValue(kv.rest, indent, l.n, false);
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    for (;;) {
      skipBlank();
      if (pos >= lines.length) break;
      const l = lines[pos];
      if (l.indent !== indent || !isSeqItem(l)) {
        if (l.indent > indent) throw new YamlError("bad indentation of a sequence item", l.n);
        break;
      }
      setLine(arr, arr.length, l.n);
      const rest = l.content === "-" ? "" : l.content.slice(2);
      const lead = rest.length - rest.trimStart().length;
      const item = rest.trimStart();
      if (item === "") {
        pos++;
        skipBlank();
        const next = lines[pos];
        arr.push(next && next.indent > indent ? parseNode(indent + 1) : null);
        continue;
      }
      // re-read the rest of this line as a node indented at the item's column
      const col = indent + 2 + lead;
      if (isSeqItem({ content: item }) || (splitKey(item) && !/^[\[\{]/.test(item))) {
        l.indent = col;
        l.content = item;
        arr.push(parseNode(col));
      } else {
        pos++;
        arr.push(inlineValue(item, indent, l.n, false));
      }
    }
    return arr;
  }

  // A value that starts on the current line (already consumed, or about to be when standalone).
  function inlineValue(rest, parentIndent, n, standalone) {
    if (standalone) pos++;
    const block = /^([|>])([-+]?)([1-9]?)([-+]?)$/.exec(rest);
    if (block) return blockScalar(block[1], block[2] || block[4], block[3] ? Number(block[3]) : 0, parentIndent, n);
    if (rest[0] === "[" || rest[0] === "{") {
      let src = rest;
      while (!flowBalanced(src)) {
        if (pos >= lines.length) throw new YamlError("unterminated flow collection", n);
        const nl = lines[pos++];
        if (!nl.blank) src += " " + nl.content.trim();
      }
      return parseFlow(src, n);
    }
    if ((rest[0] === '"' || rest[0] === "'") && !(rest.length >= 2 && rest[rest.length - 1] === rest[0])) {
      throw new YamlError("unterminated quoted scalar (quoted scalars may not span lines)", n);
    }
    // plain scalar continuation lines (deeper than the parent, not themselves keys or items)
    let value = rest;
    if (rest[0] !== '"' && rest[0] !== "'") {
      for (;;) {
        let p = pos;
        while (p < lines.length && lines[p].blank) p++;
        const nl = lines[p];
        if (!nl || nl.indent <= parentIndent || isSeqItem(nl) || splitKey(nl.content)) break;
        value += " " + nl.content.trim();
        pos = p + 1;
      }
    }
    return scalar(value, n);
  }

  function blockScalar(style, chomp, indicator, parentIndent, n) {
    const body = [];
    let blockIndent = indicator ? parentIndent + indicator : -1;
    while (pos < lines.length) {
      const l = lines[pos];
      const rawIndent = /^( *)/.exec(l.raw)[1].length;
      const isBlankRaw = l.raw.trim() === "";
      if (!isBlankRaw) {
        if (blockIndent < 0) {
          if (rawIndent <= parentIndent) break;
          blockIndent = rawIndent;
        }
        if (rawIndent < blockIndent) break;
      }
      body.push(isBlankRaw ? "" : l.raw.slice(blockIndent));
      pos++;
    }
    // trailing blank lines belong to chomping, not content
    let trail = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trail++;
    }
    let text;
    if (style === "|") text = body.join("\n");
    else {
      text = "";
      for (let i = 0; i < body.length; i++) {
        const cur = body[i];
        if (i === 0) {
          text = cur;
          continue;
        }
        const prev = body[i - 1];
        if (cur === "") text += "\n";
        else if (prev === "" || /^\s/.test(cur) || /^\s/.test(prev)) text += (prev === "" ? "" : "\n") + cur;
        else text += " " + cur;
      }
    }
    if (body.length === 0) return chomp === "+" ? "\n".repeat(trail) : "";
    if (chomp === "-") return text;
    if (chomp === "+") return text + "\n" + "\n".repeat(trail);
    return text + "\n";
  }

  const root = parseNode(0);
  skipBlank();
  if (pos < lines.length) throw new YamlError(`unexpected content "${lines[pos].content.slice(0, 40)}"`, lines[pos].n);
  return root;
}
