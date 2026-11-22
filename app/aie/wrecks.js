// AI Enhanced "Brake for Wrecks Ahead" (the block of its tick that calls FUN_0043e8b0). Ported from the decompile; the numbers are the
// constants read out of the exe. "A poor man's wreck detection": a car much slower than the race line (under 70% of the line's speed, and
// under 120 mph) is taken as a wreck or a car in trouble, and the speeds of the race line in front of it are cut so that the AI starts
// braking early: at 3k metres before the slow car the line's speed is no more than sqrt(36 k + 100) m/s above the slow car's speed.
//
// cars[i] = { dlong, dlat, speed } | null (i = 0..42 AI slots, 43 = the "player" slot), lines.{race,minrace,maxrace}.rec = Float32Array(count * 7)
// (f0 is the line's speed in units of `scale` m/s), n = number of lap-line points, scale = speed scale * 36
'use strict';

const NCARS = 44, PLAYER = 43, CELL = 3;
const FLT_MAX = 3.4028234663852886e38;
const C = {
  minSpeed: 0.1,          // cars slower than this are standing still: not looked at
  laneMargin: 0.1,        // a car counts when it is in the middle 80% of the lane between minrace and maxrace
  slowFraction: 0.7,      // "very slow": under 70% of the race line's speed ...
  slowMax: 53.6448,       // ... or 120 mph, whichever is lower
  accel: 12,              // braking: sqrt(k * 3 * 12 + 100) + the slow car's speed
  base: 100, minAllowed: 10, maxAllowed: 100, reach: 280,
  slack: 3,               // a car that is more than 3 m/s under the cap does not need telling
};

const clampPt = (d, n) => Math.min(n - 1, Math.max(0, Math.floor(d / CELL)));

// teams: a table with isValid(i) and any() (any car info loaded); AI Enhanced only looks at cars it has car info for
function eligible(i, cars, teams) {
  const c = cars[i];
  if (!c) return false;
  if (i === PLAYER) return true;
  if (teams && teams.any && teams.any()) return teams.isValid(i);
  return c.speed > 0;           // no car info: any car that is moving (AI Enhanced then has no list to go by)
}

// -> { count, caps: Float32Array(n) (FLT_MAX where nothing), apply: Uint8Array(n) (1 where the cap is applied to the lines) }
function wreckCaps(cars, lines, teams, n, scale) {
  const out = { count: 0, caps: null, apply: null };
  if (!(n >= 1) || !(scale > 0) || !lines) return out;
  const { race, minrace, maxrace } = lines;
  if (!race || !minrace || !maxrace || race.count < n || minrace.count < n || maxrace.count < n) return out;
  const caps = new Float32Array(n).fill(FLT_MAX);
  let count = 0;
  for (let i = 0; i < NCARS; i++) {
    if (!eligible(i, cars, teams)) continue;
    const c = cars[i], v = c.speed;
    if (!(Math.abs(v) >= C.minSpeed)) continue;
    const p = clampPt(c.dlong, n);
    const a = minrace.rec[p * 7 + 3], b = maxrace.rec[p * 7 + 3];
    const lo = Math.min(a, b), hi = Math.max(a, b), m = (hi - lo) * C.laneMargin;
    if (!(lo + m <= c.dlat && c.dlat <= hi - m)) continue;
    const thr = Math.min(scale * race.rec[p * 7] * C.slowFraction, C.slowMax);
    if (!(v < thr)) continue;
    count++;
    const base = v >= 0 ? v : 0;
    for (let k = 1; k <= C.reach; k++) {
      let allowed = Math.sqrt(k * CELL * C.accel + C.base) + base;
      if (allowed <= C.minAllowed) allowed = C.minAllowed;
      if (allowed >= C.maxAllowed) break;
      const idx = (((p - k) % n) + n) % n, cap = allowed / scale;
      if (cap < caps[idx]) caps[idx] = cap;
    }
  }
  if (!count) return out;
  // every car marks the points around it (2 behind .. 4 ahead): "fine" when it is under its cap, "has to brake" when it is not
  const fine = new Uint8Array(n), must = new Uint8Array(n);
  const mark = (arr, p) => { for (let d = -2; d <= 4; d++) arr[(((p + d) % n) + n) % n] = 1; };
  for (let i = 0; i < NCARS; i++) {
    if (!eligible(i, cars, teams)) continue;
    const c = cars[i], p = clampPt(c.dlong, n);
    if (caps[p] === FLT_MAX) continue;
    if (c.speed <= caps[p] * scale - C.slack) mark(fine, p); else mark(must, p);
  }
  const apply = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (caps[p] !== FLT_MAX && (!fine[p] || must[p])) apply[p] = 1;
  return { count, caps, apply };
}

// the cap applied to a line's speed field: f0 = min(f0, cap) at the marked points. rec: Float32Array(count * 7) (changed in place) -> points changed
function capLine(rec, count, w) {
  const changed = [];
  const n = Math.min(count, w.caps.length);
  for (let p = 0; p < n; p++) {
    if (!w.apply[p]) continue;
    const cap = w.caps[p];
    if (cap < rec[p * 7]) { rec[p * 7] = cap; changed.push(p); }
  }
  return changed;
}

module.exports = { wreckCaps, capLine, C, FLT_MAX };
