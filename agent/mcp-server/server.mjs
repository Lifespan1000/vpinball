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
import { isProblem, isRunning, killTree, launchVpx, prepareOutput, requireTable, runVpx } from './vpx-cli.mjs';
import * as bridge from './bridge.mjs';

const server = new McpServer({ name: 'vpinball', version: '0.1.0' });

const ok = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// Tool handlers report problems as tool errors (isError) rather than protocol errors, so the model
// sees the message and can correct its call. A handler returning { content } passes it through as is
// (images).
function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      const result = await handler(args);
      return result && Array.isArray(result.content) ? result : ok(result);
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

const sessions = new Map(); // pid -> { table, ini, bridge }

// The playtest the bridge tools talk to (the plugin listens on one fixed port, so one at a time)
function bridgeSession() {
  for (const [pid, session] of sessions) {
    if (session.closed) continue;
    if (!isRunning(pid)) {
      closeSession(pid); // never rejects; finishes in the background
      continue;
    }
    if (session.bridge) return { pid, ...session };
  }
  throw new Error('no playtest with the bridge is running: start one with playtest');
}

// Ended sessions are kept (marked closed, their log read into memory before their preferences folder
// is removed) so playtest_log can still show what they logged, e.g. after a crash
async function closeSession(pid) {
  const session = sessions.get(pid);
  if (!session || session.closed) return;
  session.savedLog = bridge.playtestLog(session.prefDir);
  session.closed = true;
  // Windows keeps the folder locked for ~100ms after VPX exits; fs.rmSync's maxRetries does not cover
  // that EPERM (it fails at once), hence the explicit retries
  const end = Date.now() + 5000;
  for (;;) {
    try {
      fs.rmSync(session.prefDir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (Date.now() > end) return `could not remove ${session.prefDir}: ${e.code ?? e.message}`;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// taskkill returns before the process is gone, and until then it still holds its log file open
async function waitForExit(pid, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (isRunning(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return !isRunning(pid);
}

const sessionLog = (session) => session.savedLog ?? bridge.playtestLog(session.prefDir);

tool(
  'playtest',
  {
    title: 'Playtest a table',
    description:
      "Opens the table in VPX on the user's screen and waits until its game runs. With the bridge (default), the agent can then " +
      'watch and drive the game with game_state, press, trace_ball, run_script and screenshot, and the game keeps running when ' +
      'the VPX window loses focus. Edits to the pack are only picked up by a new playtest.',
    inputSchema: {
      table: z.string().describe('.vpx, .vpz or pack folder'),
      bridge: z.boolean().optional().describe('Enable the AgentBridge plugin for this session (default true)'),
    },
  },
  async ({ table, bridge: withBridge = true }) => {
    requireTable(abs(table));
    if (withBridge) {
      if (!bridge.bridgeInstalled()) throw new Error('the AgentBridge plugin is not built (see agent/vpx-plugin/CMakeLists.txt), or pass bridge: false');
      for (const [pid, session] of sessions)
        if (session.bridge && !session.closed && isRunning(pid)) throw new Error(`a bridge playtest is already running (pid ${pid}): stop_playtest it first`);
      const prefDir = bridge.createPlaytestPrefs({ withBridge: true });
      const pid = launchVpx(['-PrefPath', prefDir, '-Play', abs(table)]);
      sessions.set(pid, { table: abs(table), prefDir, bridge: true, problemsSeen: 0 });
      try {
        const info = await bridge.waitForGame(() => isRunning(pid));
        return { pid, bridge: true, prefs: prefDir, ...info };
      } catch (e) {
        killTree(pid);
        await waitForExit(pid);
        await closeSession(pid);
        throw e;
      }
    }
    const prefDir = bridge.createPlaytestPrefs({ withBridge: false });
    const pid = launchVpx(['-PrefPath', prefDir, '-Play', abs(table)]);
    sessions.set(pid, { table: abs(table), prefDir, bridge: false, problemsSeen: 0 });
    return { pid, bridge: false, prefs: prefDir };
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
    const pids = pid !== undefined ? [pid] : [...sessions.keys()].filter((p) => !sessions.get(p).closed);
    const stopped = [];
    const problems = [];
    for (const p of pids) {
      if (!sessions.has(p)) throw new Error(`pid ${p} was not started by playtest`);
      if (isRunning(p)) {
        killTree(p);
        if (!(await waitForExit(p))) problems.push(`pid ${p} did not exit`);
        stopped.push(p);
      }
      const cleanup = await closeSession(p);
      if (cleanup) problems.push(cleanup);
    }
    return problems.length > 0 ? { stopped, problems } : { stopped };
  },
);

const round1 = (n) => Math.round(n * 10) / 10;
const compactBalls = (balls) => balls.map((b) => ({ x: round1(b.x), y: round1(b.y), z: round1(b.z), vx: round1(b.vx), vy: round1(b.vy) }));

tool(
  'game_state',
  {
    title: 'Game state',
    description:
      'Game time and the balls in play of the running playtest: position (VPX units, x right, y down the playfield, z up; the ' +
      'ball is 50 across) and velocity (units per 10ms physics tick). Use run_script for anything else (lights, switches, score).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    bridgeSession();
    const [info, state] = await Promise.all([bridge.info(), bridge.balls()]);
    // Errors in the table's own event handlers only reach the log, so surface any new ones here
    const session = sessions.get(bridgeSession().pid);
    const problems = sessionLog(session).filter(isProblem);
    const fresh = problems.slice(session.problemsSeen);
    session.problemsSeen = problems.length;
    return { ...info, balls: compactBalls(state.balls), ...(fresh.length > 0 ? { new_log_problems: fresh.slice(-10), hint: 'see playtest_log' } : {}) };
  },
);

const actions = ['LeftFlipper', 'RightFlipper', 'StagedLeftFlipper', 'StagedRightFlipper', 'LeftMagnaSave', 'RightMagnaSave', 'LaunchBall', 'LeftNudge', 'CenterNudge', 'RightNudge', 'Tilt', 'AddCredit', 'AddCredit2', 'StartGame', 'Lockbar', 'Pause', 'ExitGame'];

tool(
  'playtest_log',
  {
    title: 'Playtest log',
    description:
      "VPX log lines written since a playtest started: script errors in the table's event handlers (with script line and column), " +
      'missing assets, plugin problems. Errors in code run by run_script are returned by run_script itself; errors in handlers ' +
      'such as sw25_Hit only show up here.',
    inputSchema: {
      pid: z.number().int().optional().describe('Playtest pid (default: the bridge playtest, or the latest one)'),
      all: z.boolean().optional().describe('All lines instead of errors and warnings only'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ pid, all }) => {
    const entry = pid !== undefined ? sessions.get(pid) : ([...sessions.values()].findLast((s) => s.bridge && !s.closed) ?? [...sessions.values()].at(-1));
    if (!entry) throw new Error('no playtest has been started (or that pid was not started by playtest)');
    const lines = sessionLog(entry);
    const selected = all ? lines : lines.filter(isProblem);
    return { lines: selected.slice(-100), truncated: Math.max(0, selected.length - 100) };
  },
);

tool(
  'press',
  {
    title: 'Press a button',
    description:
      'Presses a player button in the running playtest: hold (press true), release (press false), or tap for pulse_ms. LaunchBall is ' +
      'the plunger: a longer pulse pulls it further (about 1000ms for a full pull). Flippers stay up while held. Start a game with ' +
      'AddCredit then StartGame on tables with credits.',
    inputSchema: {
      action: z.enum(actions),
      press: z.boolean().optional().describe('Hold (true) or release (false); ignored with pulse_ms'),
      pulse_ms: z.number().int().min(10).max(10000).optional(),
    },
  },
  async ({ action, press, pulse_ms }) => {
    bridgeSession();
    return bridge.input(action, { press: press ?? true, pulseMs: pulse_ms });
  },
);

tool(
  'trace_ball',
  {
    title: 'Trace the ball',
    description:
      'Samples the balls of the running playtest over a period, optionally starting with a button press, to see what a shot or ' +
      'a part change does: e.g. start with LaunchBall pulsed for 1000ms and watch where the ball goes. Samples are as frequent ' +
      'as the game allows (a few per 100ms at best).',
    inputSchema: {
      duration_ms: z.number().int().min(100).max(30000),
      interval_ms: z.number().int().min(50).max(5000).optional().describe('Minimum time between samples (default 200)'),
      start_action: z.enum(actions).optional(),
      start_pulse_ms: z.number().int().min(10).max(10000).optional().describe('Pulse length of start_action (default 150)'),
    },
  },
  async ({ duration_ms, interval_ms = 200, start_action, start_pulse_ms = 150 }) => {
    bridgeSession();
    if (start_action) await bridge.input(start_action, { pulseMs: start_pulse_ms });
    const samples = [];
    const end = Date.now() + duration_ms;
    while (Date.now() < end) {
      const t0 = Date.now();
      const state = await bridge.balls();
      samples.push({ t: Math.round(state.game_time * 1000) / 1000, balls: compactBalls(state.balls) });
      const wait = interval_ms - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return { samples };
  },
);

tool(
  'run_script',
  {
    title: 'Run script in the game',
    description:
      "Runs VBScript in the running playtest's script context and returns what it reports with AgentBridge.Report \"text\" " +
      '(one entry per call). By default the code is the body of a Sub: it may Dim variables, and runtime errors are returned. ' +
      'With raw it runs at global scope, to define or replace Subs/Functions live (e.g. a new sw25_Hit handler). Examples: ' +
      'AgentBridge.Report LeftFlipper.CurrentAngle ; AgentBridge.Report Light1.State ; AgentBridge.Report Controller.Switch(25). ' +
      'Compile errors only show as completed: false.',
    inputSchema: { code: z.string(), raw: z.boolean().optional() },
  },
  async ({ code, raw }) => {
    bridgeSession();
    return bridge.runScript(code, raw ?? false);
  },
);

tool(
  'screenshot',
  {
    title: 'Screenshot the playtest',
    description: 'Captures the VPX window of the running playtest, to see the table as the player does. The window must not be minimized.',
    inputSchema: { max_width: z.number().int().min(320).max(2560).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ max_width }) => {
    const { pid } = bridgeSession();
    const { png, size } = await bridge.screenshot(pid, max_width ?? 1280);
    return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `VPX window, ${size}` }] };
  },
);

await server.connect(new StdioServerTransport());
