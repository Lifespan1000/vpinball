#!/usr/bin/env node
// Checks the parts of a VPZ pack folder against the generated part schemas (agent/schemas/parts).
// VPX skips unknown properties on load without any error, so a misspelt or invented property in an
// agent edit is silently lost; this catches it, along with wrong JSON types and missing properties.
// The x-observed-* and examples schema annotations are advisory and not checked.
//
// Usage: node validate-pack.mjs <pack dir> [part file...]   (exit code 1 when anything fails)

import fs from 'node:fs';
import path from 'node:path';
import { checkPart, parsePart } from '../lib/pack-schema.mjs';

const [packDir, ...only] = process.argv.slice(2);
if (!packDir) {
  console.error('Usage: node validate-pack.mjs <pack dir> [part file...]');
  process.exit(2);
}

const partsDir = path.join(packDir, 'parts');
const files = only.length > 0 ? only.map((f) => path.resolve(f)) : fs.readdirSync(partsDir).filter((f) => f.endsWith('.json')).map((f) => path.join(partsDir, f));

let failed = 0;
for (const file of files) {
  let errors;
  try {
    errors = checkPart(parsePart(fs.readFileSync(file, 'utf8')), path.basename(file, '.json'));
  } catch (e) {
    errors = [`invalid JSON: ${e.message}`];
  }
  if (errors.length > 0) {
    failed++;
    for (const e of errors) console.log(`${path.basename(file)}: ${e}`);
  }
}
console.log(`${files.length - failed}/${files.length} part(s) valid`);
process.exit(failed > 0 ? 1 : 0);
