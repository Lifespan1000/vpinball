// Live test of the playtest bridge over MCP stdio: opens the example table in a VPX window on the
// desktop, drives it, and closes it. Skipped unless the fork's VPX and the AgentBridge plugin are built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bridgeInstalled } from '../bridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const table = path.resolve(here, '..', '..', '..', 'src', 'assets', 'exampleTable.vpx');

let available = false;
try {
  available = bridgeInstalled();
} catch {
  // VPX build missing
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return result.content[0].type === 'text' ? JSON.parse(result.content[0].text) : result.content;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a playtest can be observed and driven through the bridge', { skip: !available && 'VPX or the AgentBridge plugin is not built', timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpx-bridge-'));
  const client = new Client({ name: 'test', version: '0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, '..', 'server.mjs')], cwd: dir }));
    const started = await call(client, 'playtest', { table });
    assert.equal(started.game_running, true);

    // The game keeps running without the window focus (the test process owns the focus)
    const first = await call(client, 'game_state');
    await sleep(1000);
    const second = await call(client, 'game_state');
    assert.ok(second.game_time > first.game_time + 0.5, `game time advanced (${first.game_time} -> ${second.game_time})`);
    assert.equal(second.balls.length, 1, 'the example table starts with a ball in the plunger lane');

    // Holding a flipper raises it, releasing lowers it
    const angle = async () => Number((await call(client, 'run_script', { code: 'AgentBridge.Report LeftFlipper.CurrentAngle' })).reports[0]);
    const rest = await angle();
    await call(client, 'press', { action: 'LeftFlipper', press: true });
    await sleep(300);
    const raised = await angle();
    await call(client, 'press', { action: 'LeftFlipper', press: false });
    await sleep(300);
    assert.notEqual(raised, rest, 'the flipper moved while held');
    assert.equal(await angle(), rest, 'the flipper is back down once released');

    // Script errors are results, and functions can be (re)defined live
    assert.match((await call(client, 'run_script', { code: 'Dim x : x = 1 / 0' })).error, /Division by zero/);
    await call(client, 'run_script', { code: 'Function AgentTwice(x)\nAgentTwice = 2 * x\nEnd Function', raw: true });
    assert.deepEqual((await call(client, 'run_script', { code: 'AgentBridge.Report AgentTwice(21)' })).reports, ['42']);

    // Errors raised outside of run_script's own Sub (as in the table's event handlers) only reach the
    // VPX log: game_state flags new ones once, playtest_log lists them
    assert.equal((await call(client, 'run_script', { code: 'AgentErr = 1 / 0', raw: true })).completed, false);
    // The log is written asynchronously, so the line may land a moment after the call that caused it
    let flagged;
    const waitStart = Date.now();
    do {
      flagged = await call(client, 'game_state');
    } while (!flagged.new_log_problems && Date.now() - waitStart < 5000 && (await sleep(200), true));
    assert.ok(flagged.new_log_problems?.some((l) => /Division by zero/.test(l)), JSON.stringify(flagged.new_log_problems));
    assert.equal((await call(client, 'game_state')).new_log_problems, undefined, 'flagged only once');
    assert.ok((await call(client, 'playtest_log')).lines.some((l) => /Division by zero/.test(l)));

    // A full plunger pull sends the ball up the lane
    const startY = second.balls[0].y;
    const trace = await call(client, 'trace_ball', { duration_ms: 2500, start_action: 'LaunchBall', start_pulse_ms: 1000 });
    const minY = Math.min(...trace.samples.flatMap((s) => s.balls.map((b) => b.y)));
    assert.ok(minY < startY - 500, `the ball went up the playfield (from y=${startY} to y=${minY})`);

    const shot = await call(client, 'screenshot', { max_width: 640 });
    assert.equal(shot[0].type, 'image');
    assert.ok(Buffer.from(shot[0].data, 'base64').length > 10_000, 'the screenshot holds an image');
  } finally {
    await call(client, 'stop_playtest').catch(() => {});
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
