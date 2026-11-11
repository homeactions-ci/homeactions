// Tiny, deterministic template engine, zero dependencies.
//   {{a.b.c}}                       value at a dotted path (strings/numbers/booleans; arrays join with ", ")
//   {{join a.b " "}}                array at a.b joined by the quoted separator
//   {{json a.b}}                    JSON.stringify of the value
//   {{#if a.b}} … {{else}} … {{/if}}      truthy test (empty arrays and "none" are falsy)
//   {{#unless a.b}} … {{/unless}}
//   {{#each a.b}} … {{this}} / {{this.x}} / {{@index}} … {{/each}}
// Unknown paths throw: a template can never silently render an empty value.
// Literal "{{" in output (e.g. GitHub's "${{ … }}") is written as "{{{{" in templates? No:
// GitHub expressions are written verbatim as "${{ … }}" and protected by the "$" prefix, which
// this engine never treats as a tag. Anything else left as "{{" after rendering is an error.

const TAG = /(?<!\$)\{\{\s*([^{}]+?)\s*\}\}/g;

export class TemplateError extends Error {}

export function lookup(ctx, dotted, scope) {
  if (dotted === "this") return scope?.this;
  if (dotted === "@index") return scope?.index;
  const parts = dotted.split(".");
  let cur;
  if (parts[0] === "this") {
    cur = scope?.this;
    parts.shift();
  } else cur = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined || !(p in Object(cur))) throw new TemplateError(`unknown template path "${dotted}"`);
    cur = cur[p];
  }
  return cur;
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v === "none") return false;
  return Boolean(v);
}

function scalar(v, dotted) {
  if (v === undefined) throw new TemplateError(`undefined value at "${dotted}"`);
  if (Array.isArray(v)) return v.join(", ");
  if (v !== null && typeof v === "object") throw new TemplateError(`"${dotted}" is an object; use {{json ${dotted}}}`);
  return String(v);
}

// Find the matching close for a block opened at `start` (index just after the open tag).
function findBlock(src, start, name) {
  const re = new RegExp(`(?<!\\$)\\{\\{\\s*(#(?:if|unless|each)\\b[^}]*|/(?:if|unless|each)|else)\\s*\\}\\}`, "g");
  re.lastIndex = start;
  let depth = 0;
  let elseAt = -1;
  let elseEnd = -1;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[1].trim();
    if (tag.startsWith("#")) depth++;
    else if (tag === "else") {
      if (depth === 0 && elseAt < 0) {
        elseAt = m.index;
        elseEnd = re.lastIndex;
      }
    } else {
      if (depth === 0) {
        if (tag !== `/${name}`) throw new TemplateError(`expected {{/${name}}}, found {{${tag}}}`);
        return { closeAt: m.index, closeEnd: re.lastIndex, elseAt, elseEnd };
      }
      depth--;
    }
  }
  throw new TemplateError(`unclosed {{#${name}}}`);
}

export function render(src, ctx, scope) {
  let out = "";
  let i = 0;
  const open = /(?<!\$)\{\{\s*#(if|unless|each)\s+([^}]+?)\s*\}\}/g;
  for (;;) {
    open.lastIndex = i;
    const m = open.exec(src);
    if (!m) break;
    out += renderInline(src.slice(i, m.index), ctx, scope);
    const [, name, arg] = m;
    const blk = findBlock(src, open.lastIndex, name);
    const body = src.slice(open.lastIndex, blk.elseAt >= 0 ? blk.elseAt : blk.closeAt);
    const elseBody = blk.elseAt >= 0 ? src.slice(blk.elseEnd, blk.closeAt) : "";
    const value = lookup(ctx, arg.trim(), scope);
    if (name === "each") {
      if (!Array.isArray(value)) throw new TemplateError(`{{#each ${arg}}} needs an array`);
      value.forEach((item, index) => (out += render(body, ctx, { this: item, index })));
    } else {
      const cond = name === "if" ? truthy(value) : !truthy(value);
      out += render(cond ? body : elseBody, ctx, scope);
    }
    i = blk.closeEnd;
  }
  return out + renderInline(src.slice(i), ctx, scope);
}

function renderInline(src, ctx, scope) {
  return src.replace(TAG, (_all, expr) => {
    const e = expr.trim();
    if (/^(#|\/|else$)/.test(e)) throw new TemplateError(`stray block tag {{${e}}}`);
    let m;
    if ((m = /^join\s+(\S+)\s+"((?:[^"\\]|\\.)*)"$/.exec(e))) {
      const v = lookup(ctx, m[1], scope);
      if (!Array.isArray(v)) throw new TemplateError(`{{join ${m[1]}}} needs an array`);
      return v.join(JSON.parse(`"${m[2]}"`));
    }
    if ((m = /^json\s+(\S+)$/.exec(e))) return JSON.stringify(lookup(ctx, m[1], scope));
    return scalar(lookup(ctx, e, scope), e);
  });
}

/** Any "{{" left that is not part of a GitHub "${{" expression. */
export function leftoverTags(text) {
  return [...text.matchAll(/(?<!\$)\{\{/g)].length;
}
