// RaceVision 1.1.0's camera library: cameras 22-28 it adds to the game's 21, and up to twelve of your own (29-40).
//
// NR2003 has 21 cameras. Every added camera is one of the game's cameras (its BASE) whose placement is rewritten in the game's memory
// just before the switch: the library keeps the original values of every camera block it touches and puts them back as soon as another
// camera is on. A camera's placement is a "tune": x, y, z (metres), turn, tilt, roll (degrees, + tilt = down) and lens (degrees); a tune
// with fewer values changes only those, the rest stays as the game has it. Where the placement lives depends on the base camera:
//
//   1       cockpit 1          0x74EBBC          3 floats   x, y, z  (the eye; turn / tilt / roll / lens are not applied here)
//   4 6 8   chase / chase 2 / rear chase   0xC5C190 (4, 6) or 0xC5C168 (8)    10 floats
//   5 7     far chase / far chase 2        0xC5856C                           10 floats
//   10-15   front, rear, roof forward, roof, right side, left side: a block per car and setup   9 floats   ((cam + (a + 4 b) * 6) * 0x24 + 0xC572E8)
//   16      helicopter         0xC5C1B8          1 float    height
//   17 18   pit lane 1 / 2     0xC57378 / 0xC5739C   9 floats
//
// 10-float blocks: [0] -x, [1] y, [6] z, [3] turn, [4] tilt, [5] roll, [7] lens (angles in radians). 9-float blocks: [0] x, [1] y, [2] z, [3-6]
// turn, tilt, roll, lens (radians). Helicopter: [0] height. Cockpit: [0-2] x, y, z. (Decoded from RaceVision.exe.)
'use strict';

const RAD = 0.01745329238474369;
const BUILTIN = {
  22: { base: 1, name: 'In-car right', key: 'incar3_eye' },
  23: { base: 16, name: 'Drone', key: 'drone_height' },
  24: { base: 4, name: 'Side tracking' }, 25: { base: 4, name: 'Low rear' }, 26: { base: 8, name: 'Front quarter' },
  27: { base: 5, name: 'Overhead' }, 28: { base: 5, name: 'Pack view' },
};
// what the built-in cameras use when the settings have no cam_tune_N (strings in RaceVision.exe)
const BUILTIN_TUNE = { 22: [-0.25, -0.5, 0.05], 24: [0.5, -5.5, 1.2, 90, 3], 25: [3.2, 0, 0.55, 0, 2], 26: [-4.5, -2.5, 1.0, 151, 4], 27: [0.5, 0, 16, 0, 80], 28: [32, 0, 10, 0, 12] };
const TUNE_DEFAULTS = { chase2_view: [4.5, -2.2, 1.0, 26, 4], far_chase2_view: [15, 0, 7.5, 0, 20], incar3_eye: [-0.25, -0.5, 0.05], drone_height: [30] };
const GAME_NAMES = {
  1: 'Cockpit 1', 2: 'Cockpit 2', 3: 'Cockpit 3', 4: 'Chase', 5: 'Far chase', 6: 'Chase 2', 7: 'Far chase 2', 8: 'Rear chase',
  9: 'Dark / unused', 10: 'Front', 11: 'Rear', 12: 'Roof forward', 13: 'Roof', 14: 'Right side', 15: 'Left side', 16: 'Helicopter',
  17: 'Pit lane 1', 18: 'Pit lane 2', 19: 'TV 1', 20: 'TV 2', 21: 'Spectator',
};
const FIRST_CUSTOM = 29, LAST_CUSTOM = 40;

const nums = (v) => String(v == null ? '' : v).split(/[,;\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);

// -> { addr, count, kind } of the base camera's placement block, or null (camera has none we can tune)
function blockOf(base, readU32) {
  switch (base) {
    case 1: return { addr: 0x74EBBC, count: 3, kind: 'cockpit' };
    case 4: case 6: return { addr: 0xC5C190, count: 10, kind: 'chase' };
    case 5: case 7: return { addr: 0xC5856C, count: 10, kind: 'chase' };
    case 8: return { addr: 0xC5C168, count: 10, kind: 'chase' };
    case 16: return { addr: 0xC5C1B8, count: 1, kind: 'height' };
    case 17: return { addr: 0xC57378, count: 9, kind: 'block' };
    case 18: return { addr: 0xC5739C, count: 9, kind: 'block' };
    default: return null;
  }
}
// cameras 10-15 live in a per-car block; `car` = { a: u32 @ rec+0xC125C2.., b: u32 }
const carBlock = (cam, a, b) => (a < 4 && b < 5 ? { addr: ((cam + (a + b * 4) * 6) * 0x24) + 0xC572E8, count: 9, kind: 'block' } : null);

// the floats to write for a tune (merged over the block's current values)
function applyTune(kind, cur, t) {
  const out = cur.slice();
  const at = (i) => (i < t.length && Number.isFinite(t[i]) ? t[i] : undefined);
  const put = (idx, v, scale = 1) => { if (v !== undefined) out[idx] = Math.fround(v * scale); };
  if (kind === 'cockpit') { put(0, at(0)); put(1, at(1)); put(2, at(2)); }
  else if (kind === 'height') put(0, at(0));
  else if (kind === 'chase') {
    const x = at(0); if (x !== undefined) out[0] = Math.fround(-x);
    put(1, at(1)); put(6, at(2)); put(3, at(3), RAD); put(4, at(4), RAD); put(5, at(5), RAD); put(7, at(6), RAD);
  } else {                                                   // 'block'
    put(0, at(0)); put(1, at(1)); put(2, at(2)); put(3, at(3), RAD); put(4, at(4), RAD); put(5, at(5), RAD); put(6, at(6), RAD);
  }
  return out;
}
// the tune as the player edits it, read back from a block (inverse of applyTune)
function readTune(kind, f) {
  const d = (v) => Math.round(v / RAD * 100) / 100, r2 = (v) => Math.round(v * 100) / 100;
  if (kind === 'cockpit') return [r2(f[0]), r2(f[1]), r2(f[2])];
  if (kind === 'height') return [r2(f[0])];
  if (kind === 'chase') return [r2(-f[0]), r2(f[1]), r2(f[6]), d(f[3]), d(f[4]), d(f[5]), d(f[7])];
  return [r2(f[0]), r2(f[1]), r2(f[2]), d(f[3]), d(f[4]), d(f[5]), d(f[6])];
}

class CameraLibrary {
  // mem: { readBytes, writeBytes }; getSettings() -> raw settings object (ini keys)
  constructor(mem, getSettings, log) {
    this.m = mem; this.get = getSettings || (() => ({})); this.log = log || (() => {});
    this.orig = new Map();            // block address -> original Buffer
    this.touched = null;              // address of the block carrying a tune right now
  }

  // ── the library as the settings describe it ──
  enabled() { return String(this.get().custom_cams === undefined ? 1 : this.get().custom_cams) !== '0'; }
  customIds() {
    const s = this.get(), out = [];
    for (let n = FIRST_CUSTOM; n <= LAST_CUSTOM; n++) if (s['cam_new_' + n]) out.push(n);
    return out;
  }
  // { id, base, name, builtin } for 1-21, 22-28 and the customs, in the player's order, hidden ones marked
  list() {
    const s = this.get();
    const labels = (n, d) => (s['cam_label_' + n] ? String(s['cam_label_' + n]) : d);
    const out = [];
    for (let n = 1; n <= 21; n++) out.push({ id: n, base: n, name: labels(n, GAME_NAMES[n]), kind: 'game' });
    if (this.enabled()) {
      for (const [n, b] of Object.entries(BUILTIN)) out.push({ id: +n, base: b.base, name: labels(n, b.name), kind: 'builtin' });
      for (const n of this.customIds()) {
        const def = String(s['cam_new_' + n]).split(',');
        out.push({ id: n, base: parseInt(def[0], 10) || 4, name: labels(n, def.slice(1).join(',').trim() || 'Custom ' + n), kind: 'custom' });
      }
    }
    const hidden = new Set(nums(s.cam_hidden)), order = nums(s.cam_order);
    const rank = new Map(order.map((n, i) => [n, i]));
    out.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1000 + a.id) - (rank.has(b.id) ? rank.get(b.id) : 1000 + b.id));
    for (const c of out) c.hidden = hidden.has(c.id);
    return out;
  }
  has(id) { return id <= 21 ? id >= 1 : this.list().some(c => c.id === id); }
  def(id) { return this.list().find(c => c.id === id) || null; }

  // the tune of a camera (array of numbers) or null when it has none
  tuneOf(id) {
    const s = this.get();
    let v = null;
    if (id === 6) v = s.chase2_view !== undefined ? s.chase2_view : TUNE_DEFAULTS.chase2_view.join(', ');
    else if (id === 7) v = s.far_chase2_view !== undefined ? s.far_chase2_view : TUNE_DEFAULTS.far_chase2_view.join(', ');
    else if (id === 22) v = s.incar3_eye !== undefined ? s.incar3_eye : TUNE_DEFAULTS.incar3_eye.join(', ');
    else if (id === 23) v = s.drone_height !== undefined ? s.drone_height : TUNE_DEFAULTS.drone_height.join(', ');
    else if (s['cam_tune_' + id] !== undefined && String(s['cam_tune_' + id]).trim() !== '') v = s['cam_tune_' + id];
    else if (BUILTIN_TUNE[id]) v = BUILTIN_TUNE[id].join(', ');
    else if (id >= 1 && id <= 21) {
      if (s['cam_tune_' + id] !== undefined) v = s['cam_tune_' + id];
    }
    const t = nums(v);
    return t.length ? t : null;
  }

  // ── the game ──
  _u32(a) { const b = this.m.readBytes(a, 4); return b ? b.readUInt32LE(0) : null; }
  _block(base, slot) {
    if (base >= 10 && base <= 15) {
      if (slot === undefined || slot === null || slot < 0) return null;
      const a = this._u32(slot * 0x15B8 + 0xC125C2), b = this._u32(slot * 0x15B8 + 0xC125C6);
      return a === null || b === null ? null : carBlock(base, a, b);
    }
    return blockOf(base);
  }
  _read(blk) { const b = this.m.readBytes(blk.addr, blk.count * 4); if (!b) return null; const f = []; for (let i = 0; i < blk.count; i++) f.push(b.readFloatLE(i * 4)); return f; }
  _write(blk, f) {
    const b = Buffer.alloc(blk.count * 4);
    for (let i = 0; i < blk.count; i++) b.writeFloatLE(f[i], i * 4);
    return this.m.writeBytes(blk.addr, b);
  }

  // put the original values back wherever a tune is in place
  restore() {
    for (const [addr, buf] of this.orig) { try { this.m.writeBytes(addr, buf); } catch (e) { /* game gone */ } }
    this.orig.clear(); this.touched = null;
  }

  // the camera to show in the game for `id` (writes its tune first); ids the game knows pass through after the last tune is undone
  activate(id, slot, tuneOverride) {
    const def = this.def(id);
    const base = def ? def.base : id;
    const tune = tuneOverride && tuneOverride.length ? tuneOverride : (this.enabled() || id <= 21 ? this.tuneOf(id) : null);
    const blk = (tune && ((tuneOverride && tuneOverride.length) || id >= 22 || id === 6 || id === 7 || this.get()['cam_tune_' + id] !== undefined)) ? this._block(base, slot) : null;
    if (this.touched && (!blk || blk.addr !== this.touched)) this.restore();
    if (!blk) return base;
    const cur = this._read(blk);
    if (!cur) return base;
    if (!this.orig.has(blk.addr)) { const b = this.m.readBytes(blk.addr, blk.count * 4); if (b) this.orig.set(blk.addr, Buffer.from(b)); }
    const stock = this.orig.has(blk.addr) ? floatsOf(this.orig.get(blk.addr), blk.count) : cur;
    const next = applyTune(blk.kind, stock, tune);
    if (next.some((v, i) => Math.fround(v) !== Math.fround(cur[i]))) this._write(blk, next);
    this.touched = blk.addr;
    return base;
  }

  // the tune the game has on the camera showing now, for the editor: { cam, base, tune }
  describe(id, slot) {
    const def = this.def(id), base = def ? def.base : id;
    const blk = this._block(base, slot);
    if (!blk) return { cam: id, base, tune: null, editable: false };
    const f = this._read(blk);
    let tune = f ? readTune(blk.kind, f) : null;
    if (tune && blk.kind === 'cockpit') {
      const configured = this.tuneOf(id) || [];
      tune = tune.concat(configured.slice(3, 7));
      while (tune.length < 7) tune.push(0);
    }
    return { cam: id, base, kind: blk.kind, tune, editable: true };
  }
}

function floatsOf(buf, n) { const f = []; for (let i = 0; i < n; i++) f.push(buf.readFloatLE(i * 4)); return f; }

module.exports = { CameraLibrary, BUILTIN, BUILTIN_TUNE, TUNE_DEFAULTS, GAME_NAMES, FIRST_CUSTOM, LAST_CUSTOM, applyTune, readTune, blockOf, carBlock, nums };
