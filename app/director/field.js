// What the director sees of the race: one snapshot of every car, read from NR2003 (addresses shared with RaceControl).
'use strict';
const RC = require('../racecontrol/addr');

const NCARS = 44;
const DRIVER_ENTRY = 14711636, DRIVER_ENTRY_SIZE = 175, DRIVERS = 60;          // first name @0, last name @16, car number u16 @156 (AIMOD's map)
const VEL_X = 0x19EA, VEL_Z = 0x19EE;
const WORLD_X = 0x19DE, WORLD_Y = 0x19E2, LAP_DISTANCE = 0x186A;
const HEIGHT = 0x19E6, VEL_UP = 0x19F2;          // world height (m) and vertical speed (m/s): RaceVision's blowover check
const FLAG_GREEN = 7;

// the car's body damage: four panels (rear, front, right, left), 0..1 each, in the live car block (AIMOD's map). The director's damage is
// their sum x DAMAGE_SCALE (0..40), so the crash settings keep their old sizes (crash_damage 4 = 0.4 of a panel in one read).
const DAMAGE_PANELS = [0x1337, 0x133B, 0x1357, 0x135B], DAMAGE_SCALE = 10;
const damageOf = (rb, i) => {
  const b = rb(0xACCA30 + i * RC.Ocd + 0x1337, 0x28);
  if (!b) return { sum: NaN, z: null };
  let d = 0;
  const z = DAMAGE_PANELS.map(o => { const v = b.readFloatLE(o - 0x1337); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; });
  for (const v of z) d += v;
  return { sum: d * DAMAGE_SCALE, z };          // z: rear, front, right, left (RaceVision 2.0's bump and run reads the nose and the tail)
};
// the driver's inputs, as RaceVision 2.0 / RaceControl's telemetry read them from the car block: front wheel steer (rad, + = left) @6318,
// gear byte @6390 (0 reverse, 1 neutral, 2.. forward), brake slot @6394 (the real pedal on the car being driven, 0 for the AI), throttle @6398
const INPUTS = 6318, INPUTS_LEN = 84;
const inputsOf = (rb, i) => {
  const b = rb(0xACCA30 + i * RC.Ocd + INPUTS, INPUTS_LEN);
  if (!b) return { steer: 0, gear: null, brkRaw: NaN, thr: 0 };
  const f = (o) => b.readFloatLE(o - INPUTS), g = b[6390 - INPUTS];
  const st = f(6318), t = f(6398);
  return { steer: Number.isFinite(st) ? st * 57.2958 : 0, gear: g <= 10 ? g - 1 : null, brkRaw: f(6394), thr: Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0 };
};
const rpmOf = (rb, i) => { const b = rb(0xC12030 + i * 0x15B8 + 0x1508, 4); return b ? b.readFloatLE(0) : 0; };

// raw read of the game -> { t, trackLen, flag, green, session, cars: [...] }. `mem` is any backend with readBytes at absolute addresses.
function readField(mem, t) {
  const rb = (a, n) => mem.readBytes(a, n);
  const trackLenB = rb(RC.TrackLength, 8);
  if (!trackLenB) return null;
  const trackLen = trackLenB.readDoubleLE(0);
  const flagB = rb(RC.FlagState, 4), sessB = rb(RC.SessionNum, 1), simB = rb(RC.SimState, 1);
  const flag = flagB ? flagB.readInt32LE(0) : -1;
  const spawned = rb(RC.HasSpawned, NCARS), alive = rb(RC.HasNotRetired, NCARS), pit = rb(RC.OnPitRoad, NCARS);
  if (!spawned || !alive || !pit) return null;
  const names = new Map();
  const ent = rb(DRIVER_ENTRY, DRIVER_ENTRY_SIZE * DRIVERS);
  if (ent) {
    for (let k = 0; k < DRIVERS; k++) {
      const o = k * DRIVER_ENTRY_SIZE, num = ent.readUInt16LE(o + 156);
      const s = (a, n) => { const z = ent.indexOf(0, o + a); return ent.toString('latin1', o + a, Math.min(o + a + n, z < 0 ? o + a + n : z)); };
      const first = s(0, 16), last = s(16, 16);
      if (last && num && !names.has(num)) names.set(num, { first, last });
    }
  }
  const cars = [];
  for (let i = 0; i < NCARS; i++) {
    if (spawned[i] !== 1 || alive[i] !== 1) continue;
    const num = rb(RC.CarNum + i * RC.Ocd, 2), laps = rb(RC.Laps + i * RC.Ocd, 2), dl = rb(RC.Dlong + i * RC.Ocd, 4), dt = rb(RC.Dlat + i * RC.Ocd, 4);
    const base = 0xACCA30 + i * RC.Ocd;
    const vx = rb(base + VEL_X, 4), vz = rb(base + VEL_Z, 4), ldist = rb(base + LAP_DISTANCE, 4);
    const wx = rb(base + WORLD_X, 4), wy = rb(base + WORLD_Y, 4), hz = rb(base + HEIGHT, 4), vu = rb(base + VEL_UP, 4);
    if (!num || !laps || !dl || !dt || !vx || !vz) continue;
    const n = num.readUInt16LE(0);
    if (!n) continue;
    const dm = damageOf(rb, i), vxf = vx.readFloatLE(0), vzf = vz.readFloatLE(0);
    const nm = names.get(n);
    cars.push({
      slot: i, num: n, name: nm ? `${nm.first} ${nm.last}`.trim() : '', first: nm ? nm.first : '', last: nm ? nm.last : '', laps: laps.readUInt16LE(0),
      rpm: rpmOf(rb, i), dlong: dl.readFloatLE(0), dlat: dt.readFloatLE(0), ldist: ldist ? ldist.readFloatLE(0) : NaN,
      x: wx ? wx.readFloatLE(0) : NaN, y: wy ? wy.readFloatLE(0) : NaN, speed: Math.hypot(vxf, vzf), head: Math.atan2(vzf, vxf), z: hz ? hz.readFloatLE(0) : NaN, vz: vu ? vu.readFloatLE(0) : NaN, pit: pit[i] === 1,
      player: i === RC.PlayerIdx, pace: i === RC.PaceCarIdx, dmg: dm.sum, dmgZ: dm.z, ...inputsOf(rb, i),
    });
  }
  const track = mem.readCString ? (mem.readCString(RC.TrackName, 64) || '') : '';
  return { t, track: track.trim(), trackLen, flag, green: flag === FLAG_GREEN, session: sessB ? sessB[0] : 0, sim: simB ? simB[0] : 0, cars };
}

// order the cars (racing cars only, no pace car) by progress; adds .pos (1-based), .gapAhead (metres), .gapAheadS (seconds)
function rank(f) {
  const L = f.trackLen > 100 ? f.trackLen : 1000;
  const cars = f.cars.filter(c => !c.pace && Number.isFinite(c.dlong));
  for (const c of cars) c.progress = c.laps * L + c.dlong;
  cars.sort((a, b) => b.progress - a.progress);
  cars.forEach((c, i) => {
    c.pos = i + 1;
    const ahead = cars[i - 1];
    c.gapAhead = ahead ? ahead.progress - c.progress : 0;
    c.gapAheadS = ahead ? c.gapAhead / Math.max(10, c.speed) : 0;
    c.ahead = ahead ? ahead.slot : -1;
  });
  f.order = cars;
  return f;
}

module.exports = { DAMAGE_PANELS, DAMAGE_SCALE, readField, rank, NCARS, FLAG_GREEN };
