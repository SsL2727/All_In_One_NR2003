// The game's process name(s). All In One NR2003 launches config.nr2003_exe, but RaceLab only injects into its own game builds and
// they must keep their supplied file names (NR2003_RaceLabV2.exe, NR2003_MS.exe: "Keep the supplied EXE filename"), so a
// game started for RaceLab runs under one of those names. Every mod that finds the game by name looks for all of them.
'use strict';
const path = require('path');

const RACELAB_EXES = ['NR2003_RaceLabV2.exe', 'NR2003_MS.exe'];

// the exe All In One NR2003 starts: RaceLab's chosen game build when RaceLab is on and one is picked, else the configured exe
function launchExe(config) {
  const c = config || {};
  const rl = c.raceLab || {};
  if (rl.enabled && rl.gameExe && c.nr2003_exe) return path.join(path.dirname(c.nr2003_exe), path.basename(rl.gameExe));
  return c.nr2003_exe || '';
}

// file names, the configured exe first (it wins when more than one is running)
function names(config) {
  const c = config || {};
  const out = [];
  const add = (n) => { if (n && !out.some(o => o.toLowerCase() === n.toLowerCase())) out.push(n); };
  add(c.nr2003_exe ? path.basename(c.nr2003_exe) : 'NR2003.exe');
  add(path.basename(launchExe(c)));
  for (const n of RACELAB_EXES) add(n);
  return out;
}

// lower case without .exe (Get-Process names, the foreground window's process)
function procNames(config) { return names(config).map(n => n.replace(/\.exe$/i, '').toLowerCase()); }
function isGame(config, exeName) { const n = String(exeName || '').toLowerCase(); return names(config).some(x => x.toLowerCase() === n); }
// a PowerShell array literal of the process names, for Get-Process -Name
function psArray(config) { return '@(' + procNames(config).map(n => "'" + n.replace(/[^\w.\-]/g, '') + "'").join(',') + ')'; }

module.exports = { RACELAB_EXES, launchExe, names, procNames, isGame, psArray };
