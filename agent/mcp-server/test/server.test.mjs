// End to end test of the MCP server, driven over stdio like Claude Code does, on the example table
// bundled with VPX (it has a script, unlike the test assets). Needs the fork's VPX build (skipped otherwise), as the point is that
// edits survive VPX's own load and save.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { vpxExe } from '../vpx-cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const table = path.resolve(here, '..', '..', '..', 'src', 'assets', 'exampleTable.vpx');

let haveVpx = true;
try {
  vpxExe();
} catch {
  haveVpx = false;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  if (result.isError) return { error: text };
  return JSON.parse(text);
}

test('pack editing through MCP survives a VPX round trip', { skip: !haveVpx && 'VPX build not found', timeout: 600_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpx-mcp-'));
  const client = new Client({ name: 'test', version: '0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, '..', 'server.mjs')], cwd: dir }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ['convert_table', 'list_parts', 'get_part', 'update_part', 'create_part', 'delete_part', 'find_feature', 'validate_pack', 'export_parts', 'import_parts', 'playtest'])
      assert.ok(tools.includes(name), `tool ${name} is listed`);

    const pack = path.join(dir, 'pack');
    assert.ok(!(await call(client, 'convert_table', { input: table, output: pack })).error);
    // Converting onto an existing output needs an explicit overwrite (stale parts would otherwise linger)
    assert.match((await call(client, 'convert_table', { input: table, output: pack })).error, /already exists/);

    const flippers = await call(client, 'list_parts', { pack, type: 'flipper' });
    assert.ok(flippers.count >= 2);
    const left = await call(client, 'get_part', { pack, name: 'leftflipper' }); // names are case insensitive
    assert.equal(left.name, 'LeftFlipper');

    // A valid edit is written; an invalid one is refused and leaves the part as it was
    assert.ok(!(await call(client, 'update_part', { pack, name: 'LeftFlipper', set: { strength: left.strength + 1000, center: { x: 300 } } })).error);
    const refused = await call(client, 'update_part', { pack, name: 'LeftFlipper', set: { strenght: 1, elasticity: 'bouncy' } });
    assert.match(refused.error, /unknown property "strenght"/);
    assert.match(refused.error, /elasticity: expected number/);

    assert.ok(!(await call(client, 'create_part', { pack, name: 'AgentFlipper', from: 'LeftFlipper', properties: { center: { x: 200, y: 1000 } } })).error);
    // From scratch: only the given properties, VPX fills in the defaults of the type. Shaped parts get
    // no outline on load (the editor makes it when placing a part), so one must be given.
    assert.match((await call(client, 'create_part', { pack, name: 'AgentLight', type: 'light', properties: { center: { x: 476, y: 900 } } })).error, /needs its outline/);
    const square = [[450, 875], [500, 875], [500, 925], [450, 925]].map(([x, y]) => ({ center: { x, y } }));
    assert.ok(!(await call(client, 'create_part', { pack, name: 'AgentLight', type: 'light', properties: { center: { x: 476, y: 900 }, dragpoints: square } })).error);
    assert.match((await call(client, 'create_part', { pack, name: 'agentlight', type: 'light' })).error, /already exists/);

    const valid = await call(client, 'validate_pack', { pack });
    assert.equal(valid.valid, true, valid.errors?.join('\n'));

    const feature = await call(client, 'find_feature', { pack, token: 'LeftFlipper' });
    assert.ok(feature.parts.some((p) => p.name === 'LeftFlipper' && p.role === 'primary'));
    assert.ok(feature.scriptReferences.length + feature.scriptHandlers.length > 0);

    const deleted = await call(client, 'delete_part', { pack, name: 'Gate' });
    assert.equal(deleted.deleted, 'Gate');

    // Round trip through VPX: the edits must be what VPX loads and saves again
    const vpx = path.join(dir, 'edited.vpx');
    const back = path.join(dir, 'back');
    assert.ok(!(await call(client, 'convert_table', { input: pack, output: vpx })).error);
    assert.ok(!(await call(client, 'convert_table', { input: vpx, output: back })).error);
    const leftBack = await call(client, 'get_part', { pack: back, name: 'LeftFlipper' });
    assert.equal(leftBack.strength, left.strength + 1000);
    assert.equal(leftBack.center.x, 300);
    assert.equal(leftBack.center.y, left.center.y, 'a nested merge keeps the other coordinates');
    assert.equal((await call(client, 'get_part', { pack: back, name: 'AgentFlipper' })).strength, left.strength + 1000);
    const light = await call(client, 'get_part', { pack: back, name: 'AgentLight' });
    assert.equal(light.$type, 'light');
    assert.equal(light.center.x, 476);
    assert.equal(light.dragpoints.length, 4);
    // The properties left out come back with the type's defaults (layer and group fields stay absent: ungrouped)
    const fullLightSchema = await call(client, 'part_schema', { type: 'light' });
    const missing = fullLightSchema.required.filter((k) => !(k in light) && !['legacy_layer', 'named_layer', 'part_group'].includes(k));
    assert.deepEqual(missing, [], `defaults filled in for ${missing.join(', ')}`);
    assert.match((await call(client, 'get_part', { pack: back, name: 'Gate' })).error, /no part named/);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
