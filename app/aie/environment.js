// AI Enhanced's Environment tab, ported: base/lane grip ("env_grip") and Rubber Buildup.
//
// Ported from AI Enhanced v0_2_1b (FUN_00441d90 env grip, FUN_00445880 rubber, FUN_00445540 grid) and checked against the real program
// running next to NR2003 (tools/aie notes in the project memory): the deposit formula, cell mapping, neighbour spill, saturation and the
// grip factor all match what AI Enhanced did with the same inputs.
//
// Everything here is pure: cars in, one grip factor per car out. app/aie/service.js reads the game and writes the stat bytes.
'use strict';

const CELL = 3.0;                 // metres of track per grid column (AI Enhanced: DAT_0049ee00)
const MARGIN = 10.0;              // grid lateral margin around the three lap lines, metres (DAT_0049f094)
const RATE_K = 0.005;             // rubbering rate -> deposit per metre of travel (_DAT_0049f190)
const SPILL = 0.25;               // share of a deposit that also lands in the 4 neighbouring cells (DAT_0049ede0)
const NCARS = 44;

const fl = Math.fround;
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp01 = (x) => (finite(x) ? Math.min(1, Math.max(0, x)) : 0);

// lines: { race, minrace, maxrace } each { lat: Float32Array|number[] (lap point f3), w: (abs of lap point f2, race line only) }
class Environment {
  constructor() {
    this.lines = null;
    this.grid = null;               // { w, h, off, data: Float32Array(w*h) } — rubber level 0..1 per cell
    this.env = { base: 1, maxrace: 1, minrace: 1 };
    this.rubber = { active: false, rate: 1, gripMult: 1 };
  }

  setSettings({ envGrip, rubber } = {}) {
    if (envGrip) this.env = { base: num(envGrip.base, 1), maxrace: num(envGrip.maxrace, 1), minrace: num(envGrip.minrace, 1) };
    if (rubber) this.rubber = { active: !!rubber.active, rate: num(rubber.rate, 1), gripMult: num(rubber.gripMult ?? rubber.grip_mult, 1) };
  }

  envActive() { return this.env.base !== 1 || this.env.maxrace !== 1 || this.env.minrace !== 1; }

  // AI Enhanced builds the grid from the three lines: one column per lap point, 1 m lateral rows from (lowest lateral - 10 m)
  setLines(lines) {
    this.lines = lines || null;
    this.clearRubber();
  }

  clearRubber() {
    const L = this.lines;
    this.grid = null;
    if (!L || !L.race || !L.minrace || !L.maxrace) return;
    const w = L.race.lat.length;
    if (!(w > 0) || !(L.minrace.lat.length > 0) || !(L.maxrace.lat.length > 0)) return;
    let lo = Infinity, hi = -Infinity;
    for (const ln of [L.race, L.minrace, L.maxrace]) for (const v of ln.lat) { if (!finite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(lo <= hi)) return;
    const off = fl(lo - MARGIN);
    const h = Math.max(1, Math.ceil(fl(fl(fl(hi + MARGIN) - off) - 1e-4)));
    this.grid = { w, h, off, data: new Float32Array(w * h) };
  }

  // cars: [{ valid, dlong, dlat, speed }] x 44, dt seconds (the caller clamps it to 0..0.25), inRace false in a replay (AI Enhanced's
  // session byte 3) which still applies grip but lays no rubber. Returns factors[44] = { f1, f2 } (1 = unchanged).
  step(cars, dt, { layRubber = true } = {}) {
    const out = new Array(NCARS);
    for (let i = 0; i < NCARS; i++) out[i] = { f1: 1, f2: 1 };
    const L = this.lines;
    if (L && this.envActive()) this._envGrip(cars, out);
    if (this.rubber.active && this.grid) this._rubber(cars, dt, layRubber, out);
    return out;
  }

  _envGrip(cars, out) {
    const mn = this.lines.minrace.lat, mx = this.lines.maxrace.lat;
    const n = Math.min(mn.length, mx.length);
    if (!n) return;
    const { base, maxrace, minrace } = this.env;
    for (let i = 0; i < NCARS; i++) {
      const c = cars[i];
      if (!c) continue;
      let idx = Math.ceil((c.dlong || 0) / CELL);
      if (!(idx <= n - 1)) idx = n - 1;
      if (!(idx > 0)) idx = 0;
      const hi = mx[idx], lo = mn[idx], diff = hi - lo;
      let f = base;
      if (diff > 0) {
        const lat = c.dlat;
        if (lat < hi) f = lo < lat ? (((lat - lo) / diff) * (maxrace - minrace) + minrace) * base : base * minrace;
        else f = base * maxrace;
      }
      if (!finite(f)) continue;
      out[i].f1 *= f; out[i].f2 *= f;
    }
  }

  _rubber(cars, dt, layRubber, out) {
    const G = this.grid, { rate } = this.rubber;
    let g = this.rubber.gripMult;
    if (!finite(g) || !(g > 0)) g = 1;
    const cell = new Array(NCARS).fill(null);
    // 1. grip from the rubber under each car (before this tick's deposits)
    for (let i = 0; i < NCARS; i++) {
      const c = cars[i];
      if (!c || !finite(c.dlong) || !finite(c.dlat)) continue;
      const y0 = c.dlat - G.off;
      if (!(y0 >= 0) || !(G.h > y0)) continue;
      let x = Math.ceil(c.dlong / CELL);
      x = Math.min(G.w - 1, Math.max(0, x));
      const y = Math.min(G.h - 1, Math.floor(y0));
      cell[i] = { x, y };
      const level = clamp01(G.data[x * G.h + y]);
      const f = (g - 1) * Math.sqrt(level) + 1;
      out[i].f1 *= f; out[i].f2 *= f;
    }
    // 2. lay rubber
    const r = rate * RATE_K;
    if (!layRubber || !(rate > 0) || !(r > 0) || !(dt > 0)) return;
    const wts = this.lines.race.w;
    const add = (x, y, v) => { if (x >= 0 && x < G.w && y >= 0 && y < G.h) { const k = x * G.h + y; G.data[k] = Math.min(1, G.data[k] + v); } };
    for (let i = 0; i < NCARS; i++) {                     // the 44th slot is you: AI Enhanced lays your rubber too (with your speed)
      const cc = cell[i], c = cars[i];
      if (!cc) continue;
      const w = cc.x < wts.length ? wts[cc.x] : 0;
      if (!(w > 0)) continue;
      const d = Math.abs(c.speed || 0) * r * w * dt;
      if (!(d > 0)) continue;
      add(cc.x, cc.y, d);
      const s = d * SPILL;
      add(cc.x, cc.y - 1, s); add(cc.x, cc.y + 1, s); add(cc.x - 1, cc.y, s); add(cc.x + 1, cc.y, s);
    }
  }

  levelAt(dlong, dlat) {
    const G = this.grid;
    if (!G) return 0;
    const y0 = dlat - G.off;
    if (!(y0 >= 0) || !(G.h > y0)) return 0;
    const x = Math.min(G.w - 1, Math.max(0, Math.ceil(dlong / CELL)));
    return clamp01(G.data[x * G.h + Math.floor(y0)]);
  }
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// AI Enhanced stores a grip change by scaling a driver-stat byte and rounding to the nearest integer (roundf), clamped to 0..255
function scaleByte(orig, f) {
  const v = orig * f;
  const r = v < 0 ? -Math.round(-v) : Math.round(v);
  return Math.min(255, Math.max(0, r));
}

module.exports = { Environment, scaleByte, CELL, MARGIN, NCARS };
