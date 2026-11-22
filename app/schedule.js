// Race schedule: real-life stage lengths and race distances (data/cup2026.json), applied once to All In One NR2003's stage
// settings — RaceControl and AIMOD both follow those — and optionally to NR2003's race length.
'use strict';
const fs = require('fs');
const path = require('path');

function load(file) {
  return JSON.parse(fs.readFileSync(file || path.join(__dirname, 'data', 'cup2026.json'), 'utf8'));
}

function find(data, id) { return data.races.find(r => r.id === id) || null; }

// Stage settings in the shape the Stage Racing window / RaceControl / the bridge read: N-1 stage ends as PERCENTAGES of the
// race, so the real-life proportions carry over to any race distance. The lap a percentage turns into is ceil(total * p / 100)
// (stagebridge.breakpointsFromConfig); each percentage is chosen so that at the real distance it gives exactly the real stage end.
const lapOf = (total, p) => Math.ceil(total * p / 100);
function percentFor(end, total) {
  const exact = end / total * 100;
  const clean = Math.round(exact * 10000) / 10000;
  if (lapOf(total, clean) === end) return clean;
  return Math.round((end - 0.01) / total * 1e6) / 1e4;       // a hair under the true proportion, never over
}
function stageConfig(race) {
  const total = race.laps;
  return { enabled: true, numStages: race.stages.length + 1, inputMode: 'percent', percentages: race.stages.map(e => percentFor(e, total)), laps: race.stages.slice() };
}

// NR2003's race length (Better Cautions' addresses): quick race and normal sessions keep it in different places, each
// with the setup-screen copy and two multiplayer copies. int16 each.
const A = {
  numSessions: 0xBEBD9F, simState: 0xBEBD30,
  quick: [0xBEBDAD, 0xC0699F, 0x8D32FD, 0xDAF185],
  normal: [0xBEBDBD, 0xC069AF, 0x8D330D, 0xDAF195],
};

// Only from the menus / race setup (simState 2 = a session is running). Refuses implausible current values.
function setRaceLength(mem, laps) {
  if (!(laps >= 1 && laps <= 32000)) return { ok: false, error: 'bad race distance' };
  if (!mem.attach()) return { ok: false, error: 'NR2003 is not running' };
  const b = mem.base - 0x400000;
  if (mem.readU8(b + A.simState) === 2) return { ok: false, error: 'a session is running — set the distance from the race setup screen, before starting it' };
  const quick = mem.readU8(b + A.numSessions) === 2;
  const addrs = (quick ? A.quick : A.normal).map(a => b + a);
  const cur = mem.readBytes(addrs[0], 2);
  const now = cur ? cur.readInt16LE(0) : -1;
  if (!(now >= 1 && now < 32000)) return { ok: false, error: 'the race length in memory looks wrong (different NR2003 build?) — nothing written' };
  const buf = Buffer.alloc(2); buf.writeInt16LE(laps, 0);
  for (const a of addrs) if (!mem.writeBytes(a, buf)) return { ok: false, error: 'write failed' };
  return { ok: true, was: now, laps };
}

module.exports = { load, find, stageConfig, setRaceLength, A };
