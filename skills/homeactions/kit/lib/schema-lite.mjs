// Minimal JSON Schema (2020-12 subset) validator, zero dependencies.
// Supports: type (incl. arrays of types), const, enum, required, properties,
// additionalProperties (false | schema), items, minItems, minimum, maximum, pattern.
// Returns a list of "path: message" strings; empty means valid.

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

function typeMatches(value, t) {
  const actual = typeOf(value);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

export function validate(schema, value, path = "$") {
  const errors = [];
  const err = (msg) => errors.push(`${path}: ${msg}`);
  if (schema === true || schema === undefined) return errors;
  if (schema === false) return [`${path}: not allowed`];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      err(`expected ${types.join("|")}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) err(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) err(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern, "u").test(value)) err(`does not match ${schema.pattern}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) err(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err(`needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) err(`missing required "${key}"`);
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(value)) {
      if (key in props) errors.push(...validate(props[key], sub, `${path}.${key}`));
      else if (schema.additionalProperties === false) err(`unknown property "${key}"`);
      else if (typeof schema.additionalProperties === "object") errors.push(...validate(schema.additionalProperties, sub, `${path}.${key}`));
    }
  }
  return errors;
}
