// Standalone companion apps. Bundled releases are copied under userData before launch; users can also select an
// existing install. Built-in services stand down while their corresponding companion is running.
// RaceControl reads All In One NR2003's stage settings through its companion-app interface.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const MODS = {
  raceControl: { label: 'RaceControl 1.2.0 beta 2', exe: 'RaceControl.exe', bundleId: 'Race-Day-Beta-2026-10', bundled: path.join(__dirname, 'beta', 'racecontrol', 'RaceControl.exe'), dirs: ['RaceControl'], port: 8768 },
  aimod:       { label: 'AIMOD 2.2.0 beta 1', exe: 'AIMOD.exe', bundleId: 'AIMOD-2.2.0-beta1', bundled: path.join(__dirname, 'beta', 'aimod', 'AIMOD_v2.2.0-beta1', 'AIMOD.exe'), dirs: ['AIMOD_v2.0', 'AIMOD'], port: 8767 },   // own bundleId: a 2.1 copy already installed under Race-Day-Beta-2026-10 is not reused
  // RaceVision 1.2 accompanies the AIMOD 2.2 RaceBrain beta. Its prior bundle is upgraded on first launch.
  raceVision:  { label: 'RaceVision 1.2.0 beta 1', exe: 'RaceVision.exe', bundleId: 'RaceVision-1.2.0-beta1', bundled: path.join(__dirname, 'beta', 'racevision', 'RaceVision_v1.2.0-beta1', 'RaceVision.exe'), dirs: ['RaceVision'], port: 8090, allowAutoStart: true },
  aiEnhanced:  { label: 'AI Enhanced 0.2.2b', exe: 'AI Enhanced v0_2_2b.exe', bundleId: 'AI-Enhanced-0.2.2b', bundled: path.join(__dirname, 'beta', 'ai-enhanced', 'AI Enhanced v0_2_2b.exe'), dirs: ['AI Enhanced'], requiresAdmin: true },
  windTunnel:  { label: 'Wind Tunnel Deluxe beta', exe: 'WindTunnelForNR.exe', companion: 'WindTunnelForNRRuntime.dll', bundleId: 'Wind-Tunnel-Deluxe-beta', bundled: path.join(__dirname, 'beta', 'windtunnel', 'Wind Tunnel Deluxe Beta Release', 'WindTunnelForNR.exe'), dirs: ['Wind Tunnel Deluxe Beta Release', 'Wind Tunnel Deluxe'], hints: ['G:\\Downloads\\Wind Tunnel Deluxe Beta Release\\Wind Tunnel Deluxe Beta Release\\WindTunnelForNR.exe'], requiresAdmin: true, requiresGame: true },
  seasonGenerator: { label: 'NR Season Generator 1.0', exe: 'NR Season Generator.exe', bundleId: 'NR-Season-Generator-1.0', bundled: path.join(__dirname, 'beta', 'season-generator', 'NR Season Generator V1.0', 'NR Season Generator.exe'), dirs: ['NR Season Generator V1.0', 'NR Season Generator'], requiresAdmin: false },
};
const isRunning = (m, names) => names.has(m.exe.toLowerCase()) || (m.alt || []).some(a => names.has(a.toLowerCase()));

// ── discovery ───────────────────────────────────────────────────────────────
function candidates(key, config) {
  const m = MODS[key];
  const out = [];
  const saved = config && config.extMods && config.extMods[key] && config.extMods[key].exe;
  if (saved) out.push(saved);
  for (const hint of m.hints || []) out.push(hint);
  const base = config && config.nr2003_exe ? path.dirname(config.nr2003_exe) : null;
  if (base) {
    for (const d of m.dirs) out.push(path.join(base, d, m.exe));
    out.push(path.join(base, m.exe));
  }
  return out;
}

// the first existing candidate whose file name is the mod's exe (never an arbitrary program)
function findExe(key, config, exists = fs.existsSync) {
  const want = MODS[key].exe.toLowerCase();
  for (const c of candidates(key, config)) {
    if (path.basename(c).toLowerCase() === want && exists(c)) return c;
  }
  return '';
}

// Copy a bundled companion under userData before launching it. The executable writes settings, logs, presets and
// replay files beside itself, so keeping the writable copy out of resources/app preserves them across deploys.
function installBundled(key, userData, fsx = fs) {
  const m = MODS[key];
  if (!m || !m.bundled || !m.bundleId || !userData) return '';
  const sourceDir = path.dirname(m.bundled);
  const targetDir = path.join(userData, 'external-mods', m.bundleId);
  const rel = path.relative(userData, targetDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  const targetExe = path.join(targetDir, path.basename(m.bundled));
  const ready = path.join(targetDir, `.steelfire-bundle-${key}-ready`);
  try {
    if (!fsx.existsSync(ready)) {
      const copyMissing = (src, dst) => {
        fsx.mkdirSync(dst, { recursive: true });
        for (const entry of fsx.readdirSync(src, { withFileTypes: true })) {
          const from = path.join(src, entry.name), to = path.join(dst, entry.name);
          if (entry.isDirectory()) copyMissing(from, to);
          else if (entry.isFile() && !fsx.existsSync(to)) fsx.copyFileSync(from, to);
        }
      };
      if (!fsx.existsSync(m.bundled)) return '';
      copyMissing(sourceDir, targetDir);
      if (!fsx.existsSync(targetExe)) return '';
      fsx.writeFileSync(ready, m.bundleId, 'utf8');
    }
    return fsx.existsSync(targetExe) ? targetExe : '';
  } catch (e) { return ''; }
}

function isManagedPath(exe, userData) {
  if (!exe || !userData) return false;
  const root = path.resolve(userData, 'external-mods') + path.sep;
  return path.resolve(exe).toLowerCase().startsWith(root.toLowerCase());
}

// ── running? (tasklist, cached so the UI can poll) ──────────────────────────────
let runCache = { at: 0, names: new Set() };
function runningNames(execFileSync = cp.execFileSync, now = Date.now(), ttl = 3000) {
  if (now - runCache.at < ttl) return runCache.names;
  let names = new Set();
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    for (const line of String(out).split(/\r?\n/)) {
      const m = /^"([^"]+)"/.exec(line);
      if (m) names.add(m[1].toLowerCase());
    }
  } catch (e) { names = runCache.names; }
  runCache = { at: now, names };
  return names;
}
function resetRunCache() { runCache = { at: 0, names: new Set() }; }

function status(config, deps = {}) {
  const exists = deps.exists || fs.existsSync;
  const names = runningNames(deps.execFileSync, deps.now);
  const out = {};
  for (const [key, m] of Object.entries(MODS)) {
    const found = findExe(key, config, exists);
    const bundledAvailable = !!(m.bundled && exists(m.bundled));
    const exe = found || (bundledAvailable ? m.bundled : '');
    const auto = !!(config && config.extMods && config.extMods[key] && config.extMods[key].autoStart);
    const companion = exe && m.companion ? path.join(path.dirname(exe), m.companion) : '';
    const companionReady = !m.companion || (!!companion && exists(companion));
    out[key] = { label: m.label, exe, installed: !!exe, bundled: bundledAvailable, running: isRunning(m, names), port: m.port, autoStart: auto,
      companion, companionReady, ready: !!exe && companionReady, requiresGame: !!m.requiresGame };
  }
  return out;
}

// Which mods should be launched now: "launch with NR2003" is on, NR2003 is running, the mod is installed and not
// running, and we haven't already tried this NR2003 session (so closing a mod doesn't relaunch it forever).
// `attempted` is mutated; it is cleared whenever NR2003 is not running.
function autoStartDue(config, names, attempted, exists = fs.existsSync) {
  if (!require('./gameexe').names(config).some(n => names.has(n.toLowerCase()))) { for (const k of Object.keys(attempted)) delete attempted[k]; return []; }
  const due = [];
  for (const [key, m] of Object.entries(MODS)) {
    const on = config && config.extMods && config.extMods[key] && config.extMods[key].autoStart;
    if (!m.allowAutoStart || key === 'raceControl' || key === 'aimod' || !on || attempted[key] || isRunning(m, names) || !findExe(key, config, exists)) continue;
    attempted[key] = true;
    due.push(key);
  }
  return due;
}

// ── launch (UAC prompt: both apps ask for administrator rights, as NR2003 does) ─────────────────────────────────
const psq = (s) => String(s).replace(/'/g, "''");
function launchArgs(exe, elevate = true) {
  const verb = elevate ? " -Verb RunAs" : '';
  const cmd = `Start-Process -FilePath '${psq(exe)}' -WorkingDirectory '${psq(path.dirname(exe))}'${verb}`;
  return ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', cmd];
}
function launch(key, config, deps = {}) {
  const mod = MODS[key];
  if (!mod) return Promise.resolve({ ok: false, error: 'unknown app' });
  const exe = findExe(key, config, deps.exists);
  if (!exe) return Promise.resolve({ ok: false, error: `${mod.label} was not found. Use Locate… to select ${mod.exe}.` });
  if (mod.companion && !(deps.exists || fs.existsSync)(path.join(path.dirname(exe), mod.companion))) return Promise.resolve({ ok: false, error: `${mod.companion} must be beside ${mod.exe}. Locate the complete Wind Tunnel Deluxe folder.` });
  const names = runningNames(deps.execFileSync, deps.now, 0);
  if (mod.requiresGame) {
    if (!require('./gameexe').names(config).some(n => names.has(n.toLowerCase()))) return Promise.resolve({ ok: false, error: 'Start NR2003 first, then launch Wind Tunnel Deluxe.' });
  }
  if (isRunning(mod, names)) return Promise.resolve({ ok: true, already: true });
  const execFile = deps.execFile || cp.execFile;
  return new Promise((resolve) => {
    execFile('powershell.exe', launchArgs(exe, mod.requiresAdmin !== false), { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      resetRunCache();
      if (err) {
        const text = String((stderr || err.message || '')).trim();
        resolve({ ok: false, error: /cancel/i.test(text) ? 'Windows asked for administrator rights and it was declined.' : (text.split(/\r?\n/)[0] || 'launch failed') });
      } else resolve({ ok: true });
    });
  });
}

// ── RaceControl mode ─────────────────────────────────────────────────────────
// RaceControl owns cautions, restarts, GWC and the stage caution. Better Cautions' options (and the bridge's own
// caution / GWC logic) must stay off or the two fight over the pacing line and the finish length.
const BC_OFF = {
  gwcEnabled: false, throwCaution: false,
  bcRaceBackToCautions: false, bcDisableCollisionsCaution: false, bcDisableCollisionsPitRoad: false,
  bcSendLappedToBack: false, bcDoubleFile: false,
};
function applyRaceControlMode(sr) { return Object.assign({}, sr || {}, BC_OFF); }

// Fresh RaceControl installs, including the bundled 1.2 beta, follow All In One NR2003's stage settings ("Stage laps from a stage racing companion app").
// Written only when the app has no settings file yet; RaceControl keeps unknown/missing keys at their defaults.
function seedRaceControlIni(exe, deps = {}) {
  const fsx = deps.fs || fs;
  if (!exe || !path.isAbsolute(exe) || path.basename(exe).toLowerCase() !== MODS.raceControl.exe.toLowerCase()) return false;   // only ever next to a real RaceControl.exe path
  try {
    const ini = path.join(path.dirname(exe), 'RaceControl.ini');
    if (fsx.existsSync(ini)) return false;
    fsx.writeFileSync(ini, 'StageFromCompanionApp=1\r\n', 'utf8');
    return true;
  } catch (e) { return false; }
}

module.exports = { autoStartDue, MODS, BC_OFF, candidates, findExe, installBundled, isManagedPath, runningNames, resetRunCache, status, launchArgs, launch, applyRaceControlMode, seedRaceControlIni };
