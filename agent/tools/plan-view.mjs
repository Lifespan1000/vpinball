#!/usr/bin/env node
// Draws a top-down plan of a pack's physical parts to a PNG, on a coordinate grid, so layout work can
// be checked against real positions (VPX's own camera is in perspective). Optionally overlays proposed
// shapes from a JSON file: [{ "kind": "line" | "poly" | "circle" | "text", "pts": [[x, y], ...],
// "r": radius, "text": "...", "color": "#rrggbbaa", "width": n }] in VPX units.
//
// Usage: node plan-view.mjs <pack dir> <out.png> [overlay.json] [--scale 0.45]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const scaleAt = args.indexOf('--scale');
const scale = scaleAt >= 0 ? Number(args.splice(scaleAt, 2)[1]) : 0.45;
const [packDir, outFile, overlayFile] = args;
if (!packDir || !outFile) {
  console.error('Usage: node plan-view.mjs <pack dir> <out.png> [overlay.json] [--scale 0.45]');
  process.exit(2);
}

const table = JSON.parse(fs.readFileSync(path.join(packDir, 'table.json'), 'utf8'));
const shapes = [];
const deg = (a) => (a * Math.PI) / 180;
// VPX angles: 0 points up the playfield (towards smaller y), clockwise positive
const toward = ([x, y], angle, length) => [x + Math.sin(deg(angle)) * length, y - Math.cos(deg(angle)) * length];
const xy = (p) => [p.x, p.y];
const outline = (d) => (d.dragpoints ?? []).map((p) => xy(p.center));

// Grid
const W = table.right, H = table.bottom;
for (let x = 0; x <= W; x += 100) shapes.push({ kind: 'line', pts: [[x, 0], [x, H]], color: x % 500 === 0 ? '#c8c8c8ff' : '#e6e6e6ff', width: 1 });
for (let y = 0; y <= H; y += 100) shapes.push({ kind: 'line', pts: [[0, y], [W, y]], color: y % 500 === 0 ? '#c8c8c8ff' : '#e6e6e6ff', width: 1 });
for (let x = 0; x <= W; x += 200) shapes.push({ kind: 'text', pts: [[x + 3, 3]], text: String(x), color: '#909090ff', size: 9 });
for (let y = 200; y <= H; y += 200) shapes.push({ kind: 'text', pts: [[3, y + 2]], text: String(y), color: '#909090ff', size: 9 });
shapes.push({ kind: 'poly', pts: [[0, 0], [W, 0], [W, H], [0, H]], closed: true, color: '#000000ff', width: 2 });

const labels = [];
const label = (pt, text) => labels.push({ kind: 'text', pts: [[pt[0] + 6, pt[1] - 6]], text, color: '#202020ff', size: 9 });

for (const file of fs.readdirSync(path.join(packDir, 'parts')).filter((f) => f.endsWith('.json'))) {
  const name = file.slice(0, -5);
  const d = JSON.parse(fs.readFileSync(path.join(packDir, 'parts', file), 'utf8'));
  const center = d.center ? xy(d.center) : d.position ? xy(d.position) : null;
  // Physical parts are drawn even when invisible (VPW style tables hide them behind primitives)
  switch (d.$type) {
    case 'surface': {
      if (d.collidable === false) break;
      shapes.push({ kind: 'poly', pts: outline(d), closed: true, fill: d.height_top > 60 ? '#8c8cb4c0' : '#9a9a9ac0', color: '#505050ff', width: 1 });
      break;
    }
    case 'rubber':
      if (d.collidable === false) break;
      shapes.push({ kind: 'poly', pts: outline(d), closed: false, color: '#202020ff', width: Math.max(2, (d.thickness ?? 8) * scale) });
      break;
    case 'ramp': {
      if (d.collidable === false || (d.width_bottom ?? 0) < 5 || (d.width_bottom ?? 0) > 400) break;
      const wire = d.type !== 0;
      shapes.push({ kind: 'poly', pts: outline(d), closed: false, color: wire ? '#3c8c3c90' : '#3c64c890', width: Math.max(3, ((d.width_bottom + d.width_top) / 2) * scale) });
      const pts = outline(d);
      label(pts[0], `${name} h${Math.round(d.height_bottom)}`);
      if (pts.length > 1) label(pts.at(-1), `h${Math.round(d.height_top)}`);
      break;
    }
    case 'trigger':
      shapes.push({ kind: 'poly', pts: outline(d), closed: true, color: '#c8a000ff', width: 2 });
      if (center) label(center, name);
      break;
    case 'flipper': {
      const len = d.flipper_radius_max ?? 120;
      shapes.push({ kind: 'line', pts: [center, toward(center, d.start_angle, len)], color: '#c82828ff', width: Math.max(3, (d.base_radius ?? 20) * scale) });
      shapes.push({ kind: 'line', pts: [center, toward(center, d.end_angle, len)], color: '#c8282870', width: 2, dash: true });
      label(center, name);
      break;
    }
    case 'bumper':
      shapes.push({ kind: 'circle', pts: [center], r: d.radius ?? 45, color: '#c86400ff', width: 2 });
      label(center, name);
      break;
    case 'kicker':
      shapes.push({ kind: 'circle', pts: [center], r: d.radius ?? 25, color: '#6400c8ff', width: 2 });
      label(center, name);
      break;
    case 'hittarget':
      if (center) shapes.push({ kind: 'line', pts: [toward(center, (d.rot_z ?? 0) + 90, 16), toward(center, (d.rot_z ?? 0) - 90, 16)], color: '#c80096ff', width: 4 }), label(center, name);
      break;
    case 'gate':
    case 'spinner':
      shapes.push({ kind: 'line', pts: [toward(center, (d.rotation ?? 0) + 90, (d.length ?? 80) / 2), toward(center, (d.rotation ?? 0) - 90, (d.length ?? 80) / 2)], color: '#0096c8ff', width: 3 });
      label(center, name);
      break;
    case 'light':
      if (center) shapes.push({ kind: 'circle', pts: [center], r: 8, color: '#e6c800ff', width: 1 });
      break;
    case 'plunger':
      shapes.push({ kind: 'circle', pts: [center], r: 15, color: '#404040ff', width: 2 });
      label(center, name);
      break;
  }
}

const overlay = overlayFile ? JSON.parse(fs.readFileSync(overlayFile, 'utf8')) : [];
const all = [...shapes, ...labels, ...overlay];
const tmp = path.join(os.tmpdir(), `plan-view-${process.pid}.json`);
fs.writeFileSync(tmp, JSON.stringify({ width: W, height: H, scale, shapes: all }));
try {
  const ps1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-view.ps1');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-InFile', tmp, '-OutFile', path.resolve(outFile)], { stdio: 'inherit', windowsHide: true });
} finally {
  fs.rmSync(tmp, { force: true });
}
