// Runs the VPX executable headlessly. VPX reports command line problems with a modal dialog that
// blocks until someone clicks it, so every input is checked here first, every run has a timeout
// that kills the process tree, and results are read from the log lines the run appended.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function vpxExe() {
  const exe = process.env.VPX_EXE || path.resolve(here, '..', '..', '.build', 'bin', 'vpx', 'Release_BGFX-x64', 'VPinballX_BGFX64.exe');
  if (!fs.existsSync(exe)) throw new Error(`VPX executable not found at ${exe} (build the fork, or set VPX_EXE)`);
  return exe;
}

// Same rules as IsTableFile in src/core/AppCommands.cpp: pack folders need a manifest, .vpz is a
// zipped pack, anything else must be an OLE compound file (.vpx)
export function isTable(p) {
  try {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return fs.existsSync(path.join(p, 'manifest.json'));
    if (path.extname(p).toLowerCase() === '.vpz') return true;
    const fd = fs.openSync(p, 'r');
    try {
      const sig = Buffer.alloc(8);
      fs.readSync(fd, sig, 0, 8, 0);
      return sig.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function requireTable(p, what = 'table') {
  if (!isTable(p)) throw new Error(`${what} '${p}' is not a VPX table (.vpx file, .vpz file, or pack folder with a manifest.json)`);
}

// A pack folder output must not hold an older pack: VPX writes the parts it has but never removes
// files, and the loader picks up every file of parts/, so deleted parts would come back.
export function prepareOutput(p, { overwrite = false } = {}) {
  const parent = path.dirname(path.resolve(p));
  if (!fs.existsSync(parent)) throw new Error(`output folder '${parent}' does not exist`);
  if (!fs.existsSync(p)) return;
  const isFolder = fs.statSync(p).isDirectory();
  if (!overwrite) throw new Error(`output '${p}' already exists (pass overwrite: true to replace it)`);
  if (isFolder) {
    // Only ever clear something that is recognisably a pack, never an arbitrary folder
    if (fs.readdirSync(p).length > 0 && !fs.existsSync(path.join(p, 'manifest.json'))) throw new Error(`refusing to replace '${p}': it is a non-empty folder that is not a pack`);
    fs.rmSync(p, { recursive: true, force: true });
  }
}

function logFiles() {
  const root = path.join(process.env.APPDATA ?? '', 'VPinballX');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name, 'vpinball.log'))
    .filter((f) => fs.existsSync(f));
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already exited
  }
}

// Runs VPX to completion. Resolves with the exit code and the log lines written during the run
// (errors and warnings, plus the command's own INFO result lines).
export function runVpx(args, { timeoutMs = 300_000 } = {}) {
  const exe = vpxExe();
  const before = new Map(logFiles().map((f) => [f, fs.statSync(f).size]));
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      let log = [];
      for (const f of logFiles()) {
        const start = before.get(f) ?? 0;
        const size = fs.statSync(f).size;
        if (size <= start) continue;
        const fd = fs.openSync(f, 'r');
        try {
          const buf = Buffer.alloc(size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          log = log.concat(buf.toString('utf8').split(/\r?\n/));
        } finally {
          fs.closeSync(fd);
        }
      }
      const relevant = log.filter((l) => / (ERROR|WARN|FATAL) /.test(l) || /Command::Execute@/.test(l));
      resolve({ code: timedOut ? null : code, timedOut, log: relevant.slice(-60) });
    };
    child.on('exit', finish);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, log: [`failed to start VPX: ${e.message}`] });
    });
  });
}

// Starts VPX detached (playtesting), returning its pid; the session is left running for the user
export function launchVpx(args) {
  const exe = vpxExe();
  const child = spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

export function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { killTree };
