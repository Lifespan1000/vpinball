// Reading, checking and writing VPZ part documents against the generated part schemas.
// Shared by agent/tools/validate-pack.mjs and the MCP server so both apply the same rules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const schemaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'parts');

// JSON.parse turns the writer's 2600.0 into 2600, losing the float/integer distinction that the
// checks (a fraction in an integer field is silently truncated by VPX) and the writer (VPX style
// output keeps diffs small) rely on. Floats are therefore wrapped, using the reviver's source text.
// The source text is kept too: VPX's formatter sometimes prints a different last digit than
// JavaScript for the same double, so untouched values are written back exactly as read.
export const FLOAT = Symbol('float');
const SOURCE = Symbol('source');
const isWrapped = (v) => v !== null && typeof v === 'object' && FLOAT in v;
export const unwrap = (v) => (isWrapped(v) ? v[FLOAT] : v);

export function parsePart(text) {
  return JSON.parse(text, (key, value, context) =>
    typeof value === 'number' && /[.eE]/.test(context?.source ?? '') ? { [FLOAT]: value, [SOURCE]: context.source } : value);
}

// Plain JSON view of a parsed document (floats unwrapped), for returning to callers
export function toPlain(value) {
  if (isWrapped(value)) return value[FLOAT];
  if (Array.isArray(value)) return value.map(toPlain);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]));
  return value;
}

const schemaCache = {};
export function partTypes() {
  return fs.readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json')).map((f) => f.replace('.schema.json', ''));
}
export function loadSchema(type) {
  if (!(type in schemaCache)) {
    const file = path.join(schemaDir, `${type}.schema.json`);
    schemaCache[type] = typeof type === 'string' && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }
  return schemaCache[type];
}

function typeOf(raw) {
  const value = unwrap(raw);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) && !isWrapped(raw) ? 'integer' : 'number';
  return typeof value;
}

function check(schema, raw, where, errors, partial) {
  const value = unwrap(raw);
  if ('const' in schema && value !== schema.const) {
    errors.push(`${where}: expected ${JSON.stringify(schema.const)}, found ${JSON.stringify(value)}`);
    return;
  }
  if (schema.type) {
    const allowed = [schema.type].flat();
    const actual = typeOf(raw);
    // An integer is a valid number
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      errors.push(`${where}: expected ${allowed.join(' or ')}, found ${actual} ${JSON.stringify(value)}`);
      return;
    }
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const name of partial ? [] : (schema.required ?? []))
      if (!(name in value)) errors.push(`${where}: missing property "${name}"`);
    for (const [name, v] of Object.entries(value)) {
      const sub = schema.properties[name];
      if (sub) check(sub, v, `${where}.${name}`, errors, partial);
      else if (schema.additionalProperties === false) errors.push(`${where}: unknown property "${name}" (VPX would ignore it)`);
    }
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => check(schema.items, v, `${where}[${i}]`, errors, partial));
}

// Errors of a parsed part document, empty when valid. With partial, missing properties are allowed at
// every level (VPX keeps its defaults for them), which is how newly authored parts are checked; the
// strict mode flags anything VPX's own writer would have included.
export function checkPart(doc, name, { partial = false } = {}) {
  const schema = loadSchema(doc?.$type);
  if (!schema) return [`${name}: unknown part type ${JSON.stringify(doc?.$type)} (known: ${partTypes().join(', ')})`];
  const errors = [];
  check(schema, doc, name, errors, partial);
  return errors;
}

// Marks the numbers of number-typed fields as floats, so they are written VPX style (2600.0)
function markFloats(schema, value) {
  if (schema?.type === 'number' && typeof value === 'number') return { [FLOAT]: value };
  if (schema?.properties && value && typeof value === 'object' && !Array.isArray(value) && !isWrapped(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, markFloats(schema.properties[k], v)]));
  if (schema?.items && Array.isArray(value)) return value.map((v) => markFloats(schema.items, v));
  return value;
}

// Serializes a pack document like VPX does: 2 space indent, LF, no final newline, floats always with
// a fraction. Also fine for documents without a schema (table.json, collections): floats read from
// the source then keep their text, and nothing else is reformatted.
export function stringifyPart(doc) {
  const marked = markFloats(loadSchema(doc.$type), doc);
  const text = JSON.stringify(
    marked,
    (key, value) => {
      if (!isWrapped(value)) return value;
      const n = value[FLOAT];
      const text = value[SOURCE] !== undefined && Number(value[SOURCE]) === n ? value[SOURCE] : Number.isInteger(n) ? n.toFixed(1) : String(n);
      return `\u0000F${text}\u0000`;
    },
    2,
  );
  return text.replace(/"\\u0000F([^\\]*)\\u0000"/g, '$1');
}
