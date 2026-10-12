#!/usr/bin/env node
// Generates a JSON Schema per VPZ part type, so agents editing table packs can validate their JSON
// instead of guessing property names.
//
// Two sources are combined:
// - the field maps in src/utils/JSONSerializer.cpp decide which properties exist (the loader silently
//   skips unknown ones, so an invented property would otherwise be lost without any error);
// - sample packs (converted with `VPinballX -Convert table.vpx out_folder`) give each property its JSON
//   type, observed range and typical values, which the C++ maps do not record.
//
// Usage: node gen-part-schemas.mjs <JSONSerializer.cpp> <out dir> <pack dir>...

import fs from 'node:fs';
import path from 'node:path';

const [serializerPath, outDir, ...packDirs] = process.argv.slice(2);
if (!serializerPath || !outDir || packDirs.length === 0) {
  console.error('Usage: node gen-part-schemas.mjs <JSONSerializer.cpp> <out dir> <pack dir>...');
  process.exit(1);
}

// --- Field maps from the C++ source ---------------------------------------------------------

const source = fs.readFileSync(serializerPath, 'utf8');

const typeNames = {}; // eItemFlipper -> flipper
for (const [, item, name] of source.matchAll(/case (eItem\w+): return "(\w+)";/g)) typeNames[item] = name;

const fieldNamesIn = (text) => [...text.matchAll(/\{\s*FID\(\w+\),\s*"(\w+)"\s*\}/g)].map((m) => m[1]);

const sharedBlock = source.match(/g_sharedPartFields = \{([\s\S]*?)\n\};/);
if (!sharedBlock) throw new Error('g_sharedPartFields not found in ' + serializerPath);
const sharedFields = fieldNamesIn(sharedBlock[1]);

const declaredFields = {}; // part type -> Set of property names
for (const [, item, body] of source.matchAll(/m\[(eItem\w+)\] = MakePartMap\(\{([\s\S]*?)\}\);/g)) {
  const type = typeNames[item];
  if (type) declaredFields[type] = new Set([...sharedFields, ...fieldNamesIn(body)]);
}

// --- Observed values from sample packs ------------------------------------------------------

const MAX_EXAMPLES = 8;

// Accumulates what a property looks like across samples (recursing into objects and arrays)
function newStats() {
  return { count: 0, types: new Set(), min: Infinity, max: -Infinity, values: new Map(), props: null, items: null };
}

// JSON.parse turns the writer's 2600.0 into 2600, which would make float fields look like integers.
// Numbers are therefore classified from their source text (reviver context, Node 21+): the writer always
// prints floats with a fraction or exponent.
const FLOAT = Symbol('float');
function parseKeepingFloats(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && /[.eE]/.test(context?.source ?? '')) return { [FLOAT]: value };
    return value;
  });
}

function observe(stats, value) {
  stats.count++;
  const isFloat = value !== null && typeof value === 'object' && FLOAT in value;
  if (isFloat) value = value[FLOAT];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : isFloat ? 'number' : Number.isInteger(value) ? 'integer' : typeof value;
  stats.types.add(type);
  if (type === 'integer' || type === 'number') {
    stats.min = Math.min(stats.min, value);
    stats.max = Math.max(stats.max, value);
  }
  if (type === 'integer' || type === 'number' || type === 'string' || type === 'boolean') {
    stats.values.set(value, (stats.values.get(value) ?? 0) + 1);
  } else if (type === 'object') {
    stats.props ??= {};
    stats.objectCount = (stats.objectCount ?? 0) + 1;
    for (const [k, v] of Object.entries(value)) observe((stats.props[k] ??= newStats()), v);
  } else if (type === 'array') {
    stats.items ??= newStats();
    for (const v of value) observe(stats.items, v);
  }
}

const parts = {}; // part type -> { count, props: {name: stats}, tables: Set }
for (const packDir of packDirs) {
  const partsDir = path.join(packDir, 'parts');
  if (!fs.existsSync(partsDir)) {
    console.error(`skipping ${packDir}: no parts/ folder`);
    continue;
  }
  for (const file of fs.readdirSync(partsDir).filter((f) => f.endsWith('.json'))) {
    const doc = parseKeepingFloats(fs.readFileSync(path.join(partsDir, file), 'utf8'));
    const type = doc.$type;
    const entry = (parts[type] ??= { count: 0, props: {}, tables: new Set() });
    entry.count++;
    entry.tables.add(path.basename(packDir));
    for (const [k, v] of Object.entries(doc)) if (k !== '$type') observe((entry.props[k] ??= newStats()), v);
  }
}

// --- Schema emission -------------------------------------------------------------------------

const round = (n) => Math.round(n * 1e6) / 1e6; // float32 noise like 0.30000001192092896 reads as 0.3

function toSchema(stats) {
  const schema = {};
  const types = [...stats.types];
  // An integer-valued float field is still a number: only call it integer if no fraction was ever seen
  const jsonTypes = types.includes('number') ? types.filter((t) => t !== 'integer') : types;
  schema.type = jsonTypes.length === 1 ? jsonTypes[0] : jsonTypes;

  if (stats.props) {
    schema.properties = {};
    for (const [k, s] of Object.entries(stats.props)) schema.properties[k] = toSchema(s);
    schema.required = Object.entries(stats.props).filter(([, s]) => s.count === stats.objectCount).map(([k]) => k);
    schema.additionalProperties = false;
  }
  if (stats.items && stats.items.count > 0) schema.items = toSchema(stats.items);

  if (stats.values.size > 0) {
    const byFrequency = [...stats.values.entries()].sort((a, b) => b[1] - a[1]);
    if (Number.isFinite(stats.min)) {
      schema['x-observed-range'] = [round(stats.min), round(stats.max)];
    }
    // Few distinct integers over many samples hints at an enum (e.g. gate type). Still only advisory, as
    // the samples cannot prove another value invalid; strings are excluded since they are mostly names
    // (materials, images, surfaces) that any table defines freely.
    if (stats.values.size <= 6 && stats.count >= 10 && schema.type === 'integer') {
      schema['x-observed-values'] = byFrequency.map(([v]) => v);
    } else {
      schema.examples = byFrequency.slice(0, MAX_EXAMPLES).map(([v]) => (typeof v === 'number' ? round(v) : v));
    }
  }
  return schema;
}

fs.mkdirSync(outDir, { recursive: true });
const index = [];
for (const type of Object.keys({ ...declaredFields, ...parts }).sort()) {
  const declared = declaredFields[type] ?? new Set();
  const entry = parts[type] ?? { count: 0, props: {}, tables: new Set() };
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `vpz-part-${type}.schema.json`,
    title: `VPZ ${type} part`,
    description:
      `A parts/<name>.json document of type "${type}". Generated by agent/tools/gen-part-schemas.mjs from ` +
      `${entry.count} sample part(s) in ${entry.tables.size} table(s); do not edit by hand. x-observed-* and examples ` +
      `describe the samples, not hard limits.`,
    type: 'object',
    properties: { $type: { const: type } },
    required: ['$type'],
    additionalProperties: false,
  };
  const names = new Set([...declared, ...Object.keys(entry.props)]);
  for (const name of [...names].sort()) {
    const stats = entry.props[name];
    const prop = stats ? toSchema(stats) : { description: 'Declared by the serializer but never seen in the samples; type unknown.' };
    // Properties written by the pack writer itself (e.g. external mesh file links) are not in the field maps
    if (!declared.has(name)) prop['x-pack-only'] = true;
    if (name.endsWith('_legacy')) prop.deprecated = true;
    schema.properties[name] = prop;
    if (stats && stats.count === entry.count && entry.count > 0) schema.required.push(name);
  }
  fs.writeFileSync(path.join(outDir, `${type}.schema.json`), JSON.stringify(schema, null, 2) + '\n');
  index.push({ type, samples: entry.count, tables: entry.tables.size, properties: names.size });
}

fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
for (const row of index) console.log(`${row.type.padEnd(12)} ${String(row.samples).padStart(5)} samples  ${String(row.properties).padStart(3)} properties`);
