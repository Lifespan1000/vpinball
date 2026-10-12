// Part level operations on a VPZ pack folder. A part is the file parts/<sanitized name>.json; its
// name is not stored inside (see docs/VPZ File Format.md). The loader reads the parts listed in
// table.json and then every other file of parts/, so adding a part is just writing its file.

import fs from 'node:fs';
import path from 'node:path';
import { checkPart, loadSchema, parsePart, stringifyPart, toPlain, unwrap } from '../lib/pack-schema.mjs';

export function requirePack(pack) {
  if (!fs.existsSync(path.join(pack, 'manifest.json')) || !fs.existsSync(path.join(pack, 'parts')))
    throw new Error(`'${pack}' is not a pack folder (convert the table with convert_table first)`);
}

// Same mapping as JSONSerializer::SanitizeFileName
export function sanitizeFileName(name) {
  let s = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  return s === '' ? '_' : s;
}

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// name -> file, using table.json names where the file was sanitized, file stems otherwise
function partIndex(pack) {
  requirePack(pack);
  const dir = path.join(pack, 'parts');
  const files = new Map(fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => [f.toLowerCase(), path.join(dir, f)]));
  const index = new Map();
  const tableFile = path.join(pack, 'table.json');
  const listed = fs.existsSync(tableFile) ? (readJSON(tableFile).parts ?? []) : [];
  for (const name of listed) {
    const key = `${sanitizeFileName(name)}.json`.toLowerCase();
    if (files.has(key) && !index.has(name.toLowerCase())) {
      index.set(name.toLowerCase(), { name, file: files.get(key) });
      files.delete(key);
    }
  }
  for (const file of files.values()) {
    const name = path.basename(file, path.extname(file));
    index.set(name.toLowerCase(), { name, file });
  }
  return index;
}

function findPart(pack, name) {
  const entry = partIndex(pack).get(name.toLowerCase());
  if (!entry) throw new Error(`no part named '${name}' in ${pack} (VPX names are case insensitive; use list_parts)`);
  return entry;
}

// Outline points given as just {center: {x, y}} get the other per-point fields VPX writes (smooth,
// slingshot, texture flags, ...) from the part's existing first point, so the pack keeps the shape VPX
// itself would save and diffs stay limited to the coordinates
const DRAGPOINT_DEFAULTS = { ui_locked: false, ui_visible: true, position_z: 0, smooth: false, slingshot: false, auto_texture: true, texture_coordinate: 0 };
function completeDragpoints(points, existing) {
  if (!Array.isArray(points)) return points;
  const { center: _ignored, ...fromExisting } = Array.isArray(existing) && existing[0] ? existing[0] : {};
  const template = { ...DRAGPOINT_DEFAULTS, ...fromExisting };
  return points.map((p) => (p && typeof p === 'object' ? { center: p.center, ...template, ...p } : p));
}

function where(doc) {
  const p = doc.position ?? doc.center;
  if (!p) return undefined;
  return { x: Math.round(unwrap(p.x)), y: Math.round(unwrap(p.y)) };
}

export function listParts(pack, { type, nameContains, group } = {}) {
  const out = [];
  for (const { name, file } of partIndex(pack).values()) {
    if (nameContains && !name.toLowerCase().includes(nameContains.toLowerCase())) continue;
    const doc = parsePart(fs.readFileSync(file, 'utf8'));
    if (type && doc.$type !== type) continue;
    if (group && (doc.part_group ?? '').toLowerCase() !== group.toLowerCase()) continue;
    out.push({ name, type: doc.$type, group: doc.part_group || undefined, at: where(doc), visible: doc.visible });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getPart(pack, name) {
  const { name: actual, file } = findPart(pack, name);
  return { name: actual, ...toPlain(parsePart(fs.readFileSync(file, 'utf8'))) };
}

// Applies a merge patch (nested objects merged, other values replaced) and writes the part only if
// the result validates. Returns the changed properties, or throws with every validation error.
export function updatePart(pack, name, set = {}, unset = []) {
  const { name: actual, file } = findPart(pack, name);
  const doc = parsePart(fs.readFileSync(file, 'utf8'));
  if ('$type' in set && set.$type !== doc.$type) throw new Error(`a part's $type cannot change (${doc.$type}); create a new part instead`);
  const merge = (target, patch) => {
    for (const [k, v] of Object.entries(patch)) {
      const current = target[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && current && typeof current === 'object' && !Array.isArray(current) && unwrap(current) === current) merge(current, v);
      else target[k] = v;
    }
  };
  if (set.dragpoints) set = { ...set, dragpoints: completeDragpoints(set.dragpoints, doc.dragpoints) };
  merge(doc, set);
  for (const k of unset) delete doc[k];
  const errors = checkPart(doc, actual, { partial: true });
  if (errors.length > 0) throw new Error(`not saved, the result is invalid:\n${errors.join('\n')}`);
  fs.writeFileSync(file, stringifyPart(doc));
  return { name: actual, changed: [...Object.keys(set), ...unset.map((k) => `-${k}`)] };
}

// Creates a part, either from scratch (properties left out keep VPX's defaults for that type) or as
// a copy of an existing part with properties overridden. Names are unique, case insensitively.
export function createPart(pack, name, { type, from, properties = {} } = {}) {
  const index = partIndex(pack);
  if (index.has(name.toLowerCase())) throw new Error(`a part named '${index.get(name.toLowerCase()).name}' already exists`);
  let doc;
  if (from) {
    doc = parsePart(fs.readFileSync(findPart(pack, from).file, 'utf8'));
    if (type && type !== doc.$type) throw new Error(`'${from}' is a ${doc.$type}, not a ${type}`);
  } else {
    if (!type) throw new Error('either type or from is required');
    // The editor gives new shaped parts their outline when placing them; loading a part does not, so a
    // flasher, light, ramp, rubber, surface or trigger without dragpoints would have no shape at all
    if (loadSchema(type)?.required?.includes('dragpoints') && !Array.isArray(properties.dragpoints))
      throw new Error(`a new ${type} needs its outline: pass dragpoints ([{"center": {"x": .., "y": ..}}, ...]), or copy an existing ${type} with from`);
    doc = { $type: type };
  }
  Object.assign(doc, properties.dragpoints ? { ...properties, dragpoints: completeDragpoints(properties.dragpoints, doc.dragpoints) } : properties);
  const errors = checkPart(doc, name, { partial: true });
  if (errors.length > 0) throw new Error(`not created, the part is invalid:\n${errors.join('\n')}`);
  const file = path.join(pack, 'parts', `${sanitizeFileName(name)}.json`);
  if (fs.existsSync(file)) throw new Error(`file ${file} already exists (name clashes with another part once sanitized)`);
  fs.writeFileSync(file, stringifyPart(doc));
  return { name, type: doc.$type, file };
}

// Deletes a part and its references from table.json and the collections. References from the script
// or other parts (e.g. a surface name) are reported, not changed.
export function deletePart(pack, name) {
  const { name: actual, file } = findPart(pack, name);
  fs.rmSync(file);
  const lower = actual.toLowerCase();
  const tableFile = path.join(pack, 'table.json');
  if (fs.existsSync(tableFile)) {
    const text = fs.readFileSync(tableFile, 'utf8');
    const table = JSON.parse(text);
    if (Array.isArray(table.parts) && table.parts.some((n) => n.toLowerCase() === lower)) {
      // Rewrite only the parts list line by line, so the rest of table.json keeps its exact text
      fs.writeFileSync(tableFile, removeFromNamedList(text, 'parts', actual));
    }
  }
  const collections = [];
  const collDir = path.join(pack, 'collections');
  if (fs.existsSync(collDir))
    for (const f of fs.readdirSync(collDir).filter((f) => f.endsWith('.json'))) {
      const cfile = path.join(collDir, f);
      const text = fs.readFileSync(cfile, 'utf8');
      const coll = JSON.parse(text);
      if (Array.isArray(coll.parts) && coll.parts.some((n) => n.toLowerCase() === lower)) {
        fs.writeFileSync(cfile, removeFromNamedList(text, 'parts', actual));
        collections.push(path.basename(f, '.json'));
      }
    }
  const references = scriptReferences(pack, actual, 20);
  return { deleted: actual, removedFromCollections: collections, scriptStillReferences: references };
}

// Rewrites table.json or a collection without the entry, keeping every other value's exact text
function removeFromNamedList(text, key, name) {
  const doc = parsePart(text);
  doc[key] = doc[key].filter((n) => n.toLowerCase() !== name.toLowerCase());
  return stringifyPart(doc);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scriptReferences(pack, token, limit) {
  const file = path.join(pack, 'script.vbs');
  if (!fs.existsSync(file)) return [];
  const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(token)}([^A-Za-z0-9]|$)`, 'i');
  const out = [];
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (out.length < limit && re.test(line)) out.push({ line: i + 1, text: line.trim().slice(0, 240) });
    });
  return out;
}

// Gathers what makes up a playfield feature named by a token (typically a switch or object name like
// sw25): parts whose name contains it as a word (sw25, BM_sw25, LM_GI_l12_sw25 but not sw250),
// collections holding them, and script lines mentioning it, with event handlers listed first.
export function findFeature(pack, token, { scriptLimit = 40 } = {}) {
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(token)}([^0-9]|$)`, 'i');
  const parts = listParts(pack).filter((p) => re.test(p.name));
  const kind = (n) => (/^LM_/i.test(n) ? 'lightmap' : /^BM_/i.test(n) ? 'bake_mesh' : n.toLowerCase() === token.toLowerCase() ? 'primary' : 'related');
  const names = new Set(parts.map((p) => p.name.toLowerCase()));
  const collections = [];
  const collDir = path.join(pack, 'collections');
  if (fs.existsSync(collDir))
    for (const f of fs.readdirSync(collDir).filter((f) => f.endsWith('.json'))) {
      const members = readJSON(path.join(collDir, f)).parts ?? [];
      const hits = members.filter((m) => names.has(m.toLowerCase()));
      if (hits.length > 0) collections.push({ collection: path.basename(f, '.json'), members: hits, size: members.length });
    }
  const lines = scriptReferences(pack, token, 10_000);
  const handler = new RegExp(`^\\s*(Public\\s+|Private\\s+)?Sub\\s+${escapeRe(token)}_\\w+`, 'i');
  const handlers = lines.filter((l) => handler.test(l.text));
  const others = lines.filter((l) => !handler.test(l.text));
  return {
    token,
    parts: parts.map((p) => ({ ...p, role: kind(p.name) })),
    collections,
    scriptHandlers: handlers,
    scriptReferences: others.slice(0, scriptLimit),
    scriptReferencesTruncated: Math.max(0, others.length - scriptLimit),
    note: 'Lightmaps (LM_*) hold lighting baked for the source table and rarely belong in another one; handlers often call helper subs defined elsewhere in the script.',
  };
}
