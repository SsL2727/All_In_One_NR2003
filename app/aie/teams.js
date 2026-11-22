// AI Enhanced's car info ("Teams and Manufacturers"): who drives which car, which make and which team. AI Enhanced reads, for each of the
// game's 46 car slots, the name of the car's .car file from the game's memory, finds that file in the series folder and takes these keys
// from its first 16 KB: car_number, car_make, team_name, first_name, last_name (FUN_004479f0 / FUN_00448140). Two cars are team mates when
// their team_name is the same, same make when car_make is the same (case ignored, empty never matches: FUN_004406e0).
'use strict';
const fs = require('fs');
const path = require('path');

const NSLOT = 46, NAME_ADDR = 0xad204e, STRIDE = 0x2214, NAME_LEN = 0x30, SERIES_ADDR = 0x897230, READ = 0x4000;
const KEYS = { car_number: 'number', car_make: 'make', team_name: 'team', first_name: 'first', last_name: 'last' };

// the five keys out of the text near the top of a .car file -> { number, make, team, first, last } | null when none of them is there
function parseCar(buf) {
  const t = Buffer.from(buf.subarray(0, Math.min(buf.length, READ))).toString('latin1');
  const out = { number: '', make: '', team: '', first: '', last: '' };
  let found = 0;
  for (const raw of t.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line[0] === '[' || line[0] === ';') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const f = KEYS[line.slice(0, eq).trim().toLowerCase()];
    if (f) { out[f] = line.slice(eq + 1).trim(); found++; }
  }
  return found ? out : null;
}

// every file of a folder tree, by lower-case name -> full path (the first one found wins)
function indexTree(dir, depth = 0, map = new Map()) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return map; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 3) indexTree(p, depth + 1, map); }
    else { const k = e.name.toLowerCase(); if (!map.has(k)) map.set(k, p); }
  }
  return map;
}

// the game writes '?' for characters it cannot show: a '?' in the name matches any one character
function findFile(index, name) {
  const k = name.toLowerCase();
  if (index.has(k)) return index.get(k);
  if (!k.includes('?')) return null;
  const re = new RegExp('^' + k.replace(/[.*+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.') + '$');
  for (const [n, p] of index) if (re.test(n)) return p;
  return null;
}

const same = (a, b) => !!a && !!b && a.length > 0 && a.toLowerCase() === b.toLowerCase();

class TeamTable {
  constructor(opts = {}) { this.opts = opts; this.reset(); }
  reset() { this.entries = new Array(NSLOT).fill(null); this.key = ''; this.series = ''; this.loaded = 0; this.missing = []; this._tree = null; this._treeDir = ''; }

  // read the car file names from the game and (re)build the table when they changed. mem: needs readCString; baseDir: the game folder
  // -> true when the table was rebuilt
  refresh(mem, baseDir) {
    const names = [];
    for (let i = 0; i < NSLOT; i++) names.push(mem.readCString(NAME_ADDR + i * STRIDE, NAME_LEN) || '');
    const series = mem.readCString(SERIES_ADDR, 32) || '';
    const key = baseDir + '|' + series + '|' + names.join('|');
    if (key === this.key) return false;
    this.key = key; this.series = series;
    this.entries = new Array(NSLOT).fill(null); this.missing = []; this.loaded = 0;
    if (!baseDir || !series || /[\\/:*?"<>|]/.test(series)) return true;
    const dir = path.join(baseDir, 'series', series);
    if (this._treeDir !== dir) { this._tree = indexTree(dir); this._treeDir = dir; }
    for (let i = 0; i < NSLOT; i++) {
      const n = names[i]; if (!n) continue;
      const f = findFile(this._tree, n);
      if (!f) { this.missing.push(i); continue; }
      try {
        const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(READ); const got = fs.readSync(fd, b, 0, READ, 0); fs.closeSync(fd);
        const c = parseCar(b.subarray(0, got));
        if (c) { this.entries[i] = Object.assign({ valid: true, slot: i, file: n }, c); this.loaded++; }
      } catch (e) { this.missing.push(i); }
    }
    if (this.opts.log) this.opts.log(`car info: ${this.loaded} cars from ${series}` + (this.missing.length ? `, no .car file for slot(s) ${this.missing.join(', ')}` : ''));
    return true;
  }

  // AI Enhanced reads info for the AI slots 0..42 only: the player's slot (43) never has any
  get(i) { return i >= 0 && i < 43 ? this.entries[i] : null; }
  sameTeam(a, b) { const x = this.get(a), y = this.get(b); return !!(x && y && same(x.team, y.team)); }
  sameMake(a, b) { const x = this.get(a), y = this.get(b); return !!(x && y && same(x.make, y.make)); }
  isValid(i) { return !!this.get(i); }
  any() { return this.loaded > 0; }

  // the Teams and Manufacturers window: one row per car that has info
  rows() { return this.entries.filter(Boolean).map((e) => ({ slot: e.slot, number: e.number, driver: `${e.first} ${e.last}`.trim(), make: e.make, team: e.team })); }
}

// what the module code asks of a team table (a stand-in for tests, and for "no info": nobody is anybody's team mate)
const NO_TEAMS = { get: () => null, sameTeam: () => false, sameMake: () => false, isValid: () => false, any: () => false, rows: () => [] };

module.exports = { TeamTable, parseCar, indexTree, findFile, NO_TEAMS, NSLOT, NAME_ADDR, STRIDE, SERIES_ADDR };
