#!/usr/bin/env node
// MCP server for building and editing Visual Pinball X tables conversationally. Tables are worked on
// as VPZ pack folders (JSON per part + script.vbs + assets); the VPX executable of this fork converts,
// moves parts between tables and runs playtests. Paths are absolute or relative to the server's cwd.

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkPart, loadSchema, parsePart, partTypes } from '../lib/pack-schema.mjs';
import { createPart, deletePart, findFeature, getPart, listParts, requirePack, updatePart } from './pack.mjs';
import { isRunning, killTree, launchVpx, prepareOutput, requireTable, runVpx } from './vpx-cli.mjs';

const server = new McpServer({ name: 'vpinball', version: '0.1.0' });

const ok = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// Tool handlers report problems as tool errors (isError) rather than protocol errors, so the model
// sees the message and can correct its call
function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      return fail(e.message);
    }
  });
}

const abs = (p) => path.resolve(p);

async function vpxCommand(args, timeoutMs) {
  const result = await runVpx(args, { timeoutMs });
  if (result.timedOut) throw new Error(`VPX did not finish within ${timeoutMs / 1000}s and was killed (a blocking dialog is the usual cause). Log:\n${result.log.join('\n')}`);
  if (result.code !== 0) throw new Error(`VPX failed (exit code ${result.code}). Log:\n${result.log.join('\n')}`);
  return result.log;
}

const packArg = z.string().describe('Path of a pack folder (holds manifest.json, table.json, parts/, script.vbs)');

tool(
  'convert_table',
  {
    title: 'Convert a table',
    description:
      'Converts a table between the binary .vpx format and VPZ packs. Work on tables as pack folders (output without extension): ' +
      'every part is then a JSON file and the script is script.vbs. Convert back to .vpx to share or archive a table. ' +
      'Large tables take up to a minute.',
    inputSchema: {
      input: z.string().describe('Table to read: .vpx file, .vpz file, or pack folder'),
      output: z.string().describe('Where to write: a path without extension for a pack folder, or a .vpx / .vpz file'),
      overwrite: z.boolean().optional().describe('Replace an existing output (a pack folder is cleared first so deleted parts do not linger)'),
    },
    annotations: { destructiveHint: true },
  },
  async ({ input, output, overwrite }) => {
    requireTable(abs(input));
    prepareOutput(abs(output), { overwrite });
    const log = await vpxCommand(['-Convert', abs(input), abs(output)], 300_000);
    return { output: abs(output), log };
  },
);

tool(
  'list_parts',
  {
    title: 'List parts',
    description: 'Lists the parts of a pack with their type, part group and playfield position (VPX units; the ball is 50 units across). Filter to keep large tables (1000+ parts) readable.',
    inputSchema: {
      pack: packArg,
      type: z.string().optional().describe(`Part type filter, one of: ${partTypes().join(', ')}`),
      name_contains: z.string().optional().describe('Case insensitive substring of the part name'),
      group: z.string().optional().describe('Part group (layer) name'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ pack, type, name_contains, group }) => {
    const parts = listParts(abs(pack), { type, nameContains: name_contains, group });
    return { count: parts.length, parts };
  },
);

tool(
  'get_part',
  {
    title: 'Read a part',
    description: 'Returns every property of a part.',
    inputSchema: { pack: packArg, name: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ pack, name }) => getPart(abs(pack), name),
);

tool(
  'part_schema',
  {
    title: 'Part type reference',
    description:
      'Returns the schema of a part type: every property VPX knows, its JSON type, and the ranges and typical values seen in real tables ' +
      '(x-observed-range, examples; advisory, not limits). Read it before creating or editing a type you have not used yet.',
    inputSchema: { type: z.string().describe(`One of: ${partTypes().join(', ')}`) },
    annotations: { readOnlyHint: true },
  },
  async ({ type }) => {
    const schema = loadSchema(type);
    if (!schema) throw new Error(`unknown part type '${type}' (known: ${partTypes().join(', ')})`);
    return schema;
  },
);

tool(
  'update_part',
  {
    title: 'Edit a part',
    description:
      'Changes properties of a part. `set` is merged into the part (nested objects such as position are merged, other values replaced); ' +
      '`unset` removes properties so VPX uses its default. The edit is validated against the part schema and nothing is written if it fails. ' +
      'Takes effect when the pack is next loaded (playtest).',
    inputSchema: {
      pack: packArg,
      name: z.string(),
      set: z.record(z.string(), z.unknown()).optional().describe('Properties to set, e.g. {"strength": 3000, "position": {"x": 400}}'),
      unset: z.array(z.string()).optional(),
    },
    annotations: { destructiveHint: true },
  },
  async ({ pack, name, set, unset }) => updatePart(abs(pack), name, set ?? {}, unset ?? []),
);

tool(
  'create_part',
  {
    title: 'Add a part',
    description:
      'Adds a part to a pack, either as a copy of an existing part (`from`, best for consistent look and physics) or from scratch (`type`), ' +
      'with `properties` overriding. Properties left out keep VPX defaults for the type. Use the name the script will refer to (e.g. sw41 for switch 41).',
    inputSchema: {
      pack: packArg,
      name: z.string().describe('Unique part name (case insensitive); this is the name used in the script'),
      from: z.string().optional().describe('Existing part to copy'),
      type: z.string().optional().describe('Part type, required when not copying'),
      properties: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: { destructiveHint: false },
  },
  async ({ pack, name, from, type, properties }) => createPart(abs(pack), name, { from, type, properties: properties ?? {} }),
);

tool(
  'delete_part',
  {
    title: 'Delete a part',
    description: 'Deletes a part and removes it from table.json and collections. Script lines still referring to it are reported so they can be fixed.',
    inputSchema: { pack: packArg, name: z.string() },
    annotations: { destructiveHint: true },
  },
  async ({ pack, name }) => deletePart(abs(pack), name),
);

tool(
  'find_feature',
  {
    title: 'Gather a feature',
    description:
      'Collects everything belonging to a playfield feature named by a token such as a switch name (sw25) or object name (LeftSling): ' +
      'its physics part, bake meshes (BM_*), lightmaps (LM_*), related parts, collections, and the script handlers and lines referring to it. ' +
      'Use before moving a feature to another table or removing it.',
    inputSchema: { pack: packArg, token: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ pack, token }) => findFeature(abs(pack), token),
);

tool(
  'validate_pack',
  {
    title: 'Validate a pack',
    description: 'Checks every part of a pack against the part schemas: unknown (silently ignored by VPX) or misspelt properties, wrong types, invalid JSON.',
    inputSchema: { pack: packArg },
    annotations: { readOnlyHint: true },
  },
  async ({ pack }) => {
    requirePack(abs(pack));
    const dir = path.join(abs(pack), 'parts');
    const errors = [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        errors.push(...checkPart(parsePart(fs.readFileSync(path.join(dir, f), 'utf8')), path.basename(f, '.json'), { partial: true }));
      } catch (e) {
        errors.push(`${f}: invalid JSON: ${e.message}`);
      }
    }
    return { parts: files.length, valid: errors.length === 0, errors: errors.slice(0, 100) };
  },
);

tool(
  'export_parts',
  {
    title: 'Export parts',
    description:
      'Saves the named parts of a table, with every material, image, mesh, part group and collection they use, as a parts pack ' +
      'that import_parts can merge into another table. Use find_feature first to pick the parts of a feature.',
    inputSchema: {
      table: z.string().describe('Source table (.vpx, .vpz or pack folder)'),
      output: z.string().describe('Parts pack to write (path without extension for a folder)'),
      names: z.array(z.string()).min(1),
      overwrite: z.boolean().optional(),
    },
  },
  async ({ table, output, names, overwrite }) => {
    requireTable(abs(table));
    if (names.some((n) => n.includes(','))) throw new Error('part names cannot contain commas');
    prepareOutput(abs(output), { overwrite });
    const log = await vpxCommand(['-ExportParts', abs(table), abs(output), names.join(',')], 300_000);
    return { output: abs(output), log };
  },
);

tool(
  'import_parts',
  {
    title: 'Import parts',
    description:
      'Merges a parts pack into a table and writes the result to `output`. Parts whose name is taken get a numeric suffix (check the log, ' +
      'the script may need the new names). Assets with a clashing name but different content are renamed (`rename`, default) or the ' +
      "table's own are used (`existing`). Script handlers are not moved: port them with the script edits.",
    inputSchema: {
      table: z.string().describe('Target table (.vpx, .vpz or pack folder)'),
      parts: z.string().describe('Parts pack from export_parts'),
      output: z.string().describe('Where to write the merged table; may be the target pack folder itself with overwrite'),
      strategy: z.enum(['rename', 'existing']).optional(),
      overwrite: z.boolean().optional(),
    },
    annotations: { destructiveHint: true },
  },
  async ({ table, parts, output, strategy, overwrite }) => {
    requireTable(abs(table));
    requireTable(abs(parts), 'parts pack');
    let target = abs(output);
    // Importing into the pack folder that is also the source: write elsewhere, then swap
    const inPlace = target.toLowerCase() === abs(table).toLowerCase();
    if (inPlace) {
      if (!overwrite) throw new Error('output is the target table itself; pass overwrite: true to update it in place');
      target = `${target}.importing`;
      prepareOutput(target, { overwrite: true });
    } else prepareOutput(target, { overwrite });
    const log = await vpxCommand(['-ImportParts', abs(table), abs(parts), target, strategy ?? 'rename'], 300_000);
    if (inPlace) {
      prepareOutput(abs(output), { overwrite: true });
      fs.renameSync(target, abs(output));
    }
    return { output: abs(output), log };
  },
);

const sessions = new Map(); // pid -> table

tool(
  'playtest',
  {
    title: 'Playtest a table',
    description:
      'Opens the table in VPX on the user\'s screen to play it. Ask the user to play and report back, or stop it with stop_playtest. ' +
      'Edits to the pack are only picked up by a new playtest.',
    inputSchema: { table: z.string().describe('.vpx, .vpz or pack folder') },
  },
  async ({ table }) => {
    requireTable(abs(table));
    const pid = launchVpx(['-Play', abs(table)]);
    sessions.set(pid, abs(table));
    return { pid, table: abs(table) };
  },
);

tool(
  'stop_playtest',
  {
    title: 'Stop a playtest',
    description: 'Closes a VPX session started by playtest (all of them when pid is omitted).',
    inputSchema: { pid: z.number().int().optional() },
  },
  async ({ pid }) => {
    const pids = pid !== undefined ? [pid] : [...sessions.keys()];
    const stopped = [];
    for (const p of pids) {
      if (!sessions.has(p)) throw new Error(`pid ${p} was not started by playtest`);
      if (isRunning(p)) {
        killTree(p);
        stopped.push(p);
      }
      sessions.delete(p);
    }
    return { stopped };
  },
);

await server.connect(new StdioServerTransport());
