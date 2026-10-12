// Client side of the AgentBridge VPX plugin (agent/vpx-plugin): starting a playtest with the plugin
// enabled, and calling its local HTTP API.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vpxExe } from './vpx-cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const bridgePort = Number(process.env.VPX_BRIDGE_PORT || 2114);
const base = `http://127.0.0.1:${bridgePort}/api`;

export function bridgeInstalled() {
  return fs.existsSync(path.join(path.dirname(vpxExe()), 'plugins', 'agentbridge', 'plugin.cfg'));
}

// The user's VPX settings: the most recently written VPinballX.ini of the versioned settings folders
function userIni() {
  const root = path.join(process.env.APPDATA ?? '', 'VPinballX');
  const candidates = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name, 'VPinballX.ini'))
        .filter((f) => fs.existsSync(f))
    : [];
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

// Sets key = value inside [section] of an ini text, replacing an existing value, adding the key at the
// top of the section, or appending the section (a duplicate section might be ignored by the reader)
export function setIniValue(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((l) => l.trim().toLowerCase() === `[${section}]`.toLowerCase());
  if (header < 0) return `${text.replace(/\s*$/, '')}\r\n\r\n[${section}]\r\n${key} = ${value}\r\n`;
  let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const existing = lines.findIndex((l, i) => i > header && i < end && l.split('=')[0].trim().toLowerCase() === key.toLowerCase());
  if (existing >= 0) lines[existing] = `${key} = ${value}`;
  else lines.splice(header + 1, 0, `${key} = ${value}`);
  return lines.join('\r\n');
}

// A private preferences folder for one playtest (VPX -PrefPath): a copy of the user's settings, so
// their own file is never modified, and a log of its own (VPX writes vpinball.log there), so lines
// from other VPX processes running at the same time cannot be mistaken for the playtest's.
// With the bridge, the copy enables the plugin and turns focus pausing off (an agent playtest must
// keep running while the user works in another window).
// With window ({ width, height, x, y }), the playfield runs in a normal (movable, fixed size) window
// instead of the user's display mode. VPX's default is "windowed" at the display's full size, which
// looks like fullscreen, so an explicit size is what makes it a window. Sizes are physical pixels: on a
// display scaled to 150%, 1600 x 1000 shows as 1067 x 667. Keep the aspect of the display the table's
// camera was framed for (16:10 here): a near square window cut off the plunger lane side.
export const DEFAULT_PLAYTEST_WINDOW = { width: 1600, height: 1000, x: 60, y: 60 };
export function createPlaytestPrefs({ withBridge, window = null }) {
  const source = userIni();
  let text = source ? fs.readFileSync(source, 'utf8') : '';
  if (withBridge) {
    text = setIniValue(text, 'Plugin.AgentBridge', 'Enable', '1');
    text = setIniValue(text, 'Plugin.AgentBridge', 'Port', String(bridgePort));
    text = setIniValue(text, 'Player', 'PauseOnFocusLoss', '0');
  }
  if (window) {
    text = setIniValue(text, 'Player', 'PlayfieldFullScreen', '0');
    text = setIniValue(text, 'Player', 'PlayfieldWidth', String(window.width));
    text = setIniValue(text, 'Player', 'PlayfieldHeight', String(window.height));
    text = setIniValue(text, 'Player', 'PlayfieldWndX', String(window.x ?? 40));
    text = setIniValue(text, 'Player', 'PlayfieldWndY', String(window.y ?? 40));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpx-playtest-'));
  fs.writeFileSync(path.join(dir, 'VPinballX.ini'), text);
  return dir;
}

export function playtestLog(prefDir) {
  const file = path.join(prefDir, 'vpinball.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l !== '') : [];
}

async function request(method, route, body, timeoutMs = 15_000) {
  let res;
  try {
    res = await fetch(`${base}${route}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`the VPX bridge is not reachable on port ${bridgePort} (is a playtest running? started with playtest): ${e.cause?.code ?? e.message}`);
  }
  const data = await res.json().catch(() => ({ error: `invalid response (HTTP ${res.status})` }));
  // Script errors come back as 200 with an error field (a normal result for the caller to read)
  if (res.status >= 400) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const info = () => request('GET', '/info');
export const balls = () => request('GET', '/balls');
export const runScript = (code, raw = false) => request('POST', '/script', { code, raw, timeout_ms: 10_000 });
export const input = (action, { press, pulseMs } = {}) => request('POST', '/input', { action, press, pulse_ms: pulseMs });

// Waits until the table is loaded and its game runs (big tables take a while to load)
export async function waitForGame(isAlive, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'not started';
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error('VPX exited while loading the table');
    try {
      const i = await info();
      if (i.game_running) return i;
      last = 'loading';
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the game did not start within ${timeoutMs / 1000}s (${last})`);
}

// Captures the VPX window of the given process; resolves with the PNG bytes
export function screenshot(pid, maxWidth = 1280) {
  const file = path.join(os.tmpdir(), `vpx-shot-${pid}-${Date.now()}.png`);
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'screenshot.ps1'), '-ProcessId', String(pid), '-OutFile', file, '-MaxWidth', String(maxWidth)],
      { windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        try {
          if (error) return reject(new Error(`screenshot failed: ${(stderr || error.message).trim().split(/\r?\n/)[0]}`));
          resolve({ png: fs.readFileSync(file), size: stdout.trim() });
        } finally {
          fs.rmSync(file, { force: true });
        }
      },
    );
  });
}
