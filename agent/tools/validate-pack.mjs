#!/usr/bin/env node
// Checks the parts of a VPZ pack folder against the generated part schemas (agent/schemas/parts).
// VPX skips unknown properties on load without any error, so a misspelt or invented property in an
// agent edit is silently lost; this catches it, along with wrong JSON types and missing properties.
//
// Only the schema keywords the generator emits are supported (type, const, properties, required,
// additionalProperties, items); the x-observed-* and examples annotations are advisory and not checked.
//
// Usage: node validate-pack.mjs <pack dir> [part file...]   (exit code 1 when anything fails)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'parts');

function typeOf(value, sourceIsFloat) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) && !sourceIsFloat ? 'integer' : 'number';
  return typeof value;
}

// JSON.parse loses the difference between 2600 and 2600.0; keep it so a fraction in an integer field is caught
const FLOAT = Symbol('float');
const parse = (text) =>
  JSON.parse(text, (key, value, context) =>
    typeof value === 'number' && /[.eE]/.test(context?.source ?? '') ? { [FLOAT]: value } : value);

function check(schema, raw, where, errors) {
  const isFloat = raw !== null && typeof raw === 'object' && FLOAT in raw;
  const value = isFloat ? raw[FLOAT] : raw;
  if ('const' in schema && value !== schema.const) {
    errors.push(`${where}: expected ${JSON.stringify(schema.const)}, found ${JSON.stringify(value)}`);
    return;
  }
  if (schema.type) {
    const allowed = [schema.type].flat();
    const actual = typeOf(value, isFloat);
    // An integer is a valid number
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      errors.push(`${where}: expected ${allowed.join(' or ')}, found ${actual} ${JSON.stringify(value)}`);
      return;
    }
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const name of schema.required ?? [])
      if (!(name in value)) errors.push(`${where}: missing property "${name}"`);
    for (const [name, v] of Object.entries(value)) {
      const sub = schema.properties[name];
      if (sub) check(sub, v, `${where}.${name}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${where}: unknown property "${name}" (VPX would ignore it)`);
    }
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => check(schema.items, v, `${where}[${i}]`, errors));
}

const [packDir, ...only] = process.argv.slice(2);
if (!packDir) {
  console.error('Usage: node validate-pack.mjs <pack dir> [part file...]');
  process.exit(2);
}

const schemas = {};
const partsDir = path.join(packDir, 'parts');
const files = only.length > 0 ? only.map((f) => path.resolve(f)) : fs.readdirSync(partsDir).filter((f) => f.endsWith('.json')).map((f) => path.join(partsDir, f));

let failed = 0;
for (const file of files) {
  const errors = [];
  let doc;
  try {
    doc = parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`invalid JSON: ${e.message}`);
  }
  if (doc) {
    const type = doc.$type;
    const schemaFile = path.join(schemaDir, `${type}.schema.json`);
    if (typeof type !== 'string' || !fs.existsSync(schemaFile)) errors.push(`unknown part type ${JSON.stringify(type)}`);
    else check((schemas[type] ??= JSON.parse(fs.readFileSync(schemaFile, 'utf8'))), doc, path.basename(file, '.json'), errors);
  }
  if (errors.length > 0) {
    failed++;
    for (const e of errors) console.log(`${path.basename(file)}: ${e}`);
  }
}
console.log(`${files.length - failed}/${files.length} part(s) valid`);
process.exit(failed > 0 ? 1 : 0);
