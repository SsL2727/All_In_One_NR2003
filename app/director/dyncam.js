// Dynamic cameras (RaceVision, Nov 2026): RaceVision places its own static cameras where the story is - the pit entry as the leaders
// come in, the stall, the race off pit road, a new angle on every crash, low at the restart, the line at the finish - and learns each
// track as it goes (pit road, the width of the track, where crashes happen, which angles worked).
//
// A dynamic camera is one of the game's two pit lane cameras (17 at 0xC57378, 18 at 0xC5739C - RaceVision's "Static A" / "Static B")
// moved to where the template puts it and aimed at the car: 9 floats x, y, z, turn, tilt, roll, lens (radians), two more. The two take
// turns so a camera is never moved while it is on air; each is put back as it was when its shot ends.
//
// Where a template puts the camera ("anchor"): 0 ahead of the car by `ahead` seconds of its speed, `lat` metres beyond the track's edge,
// 1 / 2 `ahead` metres from the pit entry / exit, 3 from the start-finish line, 4 `ahead` metres in front of the car itself, 5 `ahead`
// metres from the crash, 6 `ahead` metres from the choose cone (RaceVision 1.2.0: Race Control says where the cone is). `height` above the car, a lens of `fov` degrees, `hold` seconds at most, and it ends `end` seconds (anchor 0) or
// metres (1-3) after the car passes. Positions come from the track map (Race Control draws it from the cars, map.json).
//
// Which angle: every (template, side) has a learned score (how much of its shots the car was well framed, and your thumbs up / down);
// the pick is the best of score + a bonus for few tries + a little chance, never the same template three times running, and about one
// time in five a random one of the others. The follow rig (dyn_rig) aims the camera from a fast timer of its own, predicting the car
// between the game's physics ticks, smoothed (SmoothDamp, no overshoot); without it the director's own tick aims it.
'use strict';
const fs = require('fs');
const path = require('path');
const { TrackMap } = require('../racecontrol/trackmap');

// RaceVision's templates (RaceVision.exe 0x4E78B8): ahead, lat, height, fov are [min, max]
const TEMPLATES = [
  { id: 'side_tele', label: 'Trackside telephoto', role: 'battle', anchor: 0, ahead: [3.6, 5.5], lat: [20, 45], height: [4, 12], fov: [7, 13], end: -0.8, hold: 9 },
  { id: 'side_mid', label: 'Trackside, mid range', role: 'battle', anchor: 0, ahead: [2.4, 3.4], lat: [12, 22], height: [2, 5], fov: [20, 30], end: 0.3, hold: 7 },
  { id: 'side_low', label: 'Low and wide', role: 'battle', anchor: 0, ahead: [1.6, 2.4], lat: [5, 9], height: [0.8, 1.5], fov: [34, 50], end: 0.6, hold: 6 },
  { id: 'high_corner', label: 'High corner', role: 'battle', anchor: 0, ahead: [1.0, 1.8], lat: [40, 70], height: [25, 45], fov: [38, 52], end: 1.2, hold: 8 },
  { id: 'restart_low', label: 'Restart, trackside', role: 'restart', anchor: 0, ahead: [2.5, 4.0], lat: [8, 16], height: [1, 3], fov: [16, 28], end: 0.5, hold: 9 },
  { id: 'restart_high', label: 'Restart, from above', role: 'restart', anchor: 0, ahead: [1.0, 2.0], lat: [40, 60], height: [25, 40], fov: [40, 55], end: 1.5, hold: 9 },
  { id: 'pit_commit', label: 'Pit entry', role: 'pit_in', anchor: 1, ahead: [10, 30], lat: [6, 14], height: [3, 7], fov: [28, 44], end: 35, hold: 14 },
  { id: 'pit_commit_back', label: 'Pit entry, from up the track', role: 'pit_in', anchor: 1, ahead: [-140, -70], lat: [10, 22], height: [2.5, 6], fov: [16, 26], end: 70, hold: 12 },
  { id: 'pit_commit_high', label: 'Pit entry, from above', role: 'pit_in', anchor: 1, ahead: [-20, 20], lat: [8, 16], height: [16, 28], fov: [38, 54], end: 45, hold: 12 },
  { id: 'pit_stall', label: 'Pit stall', role: 'pit_stall', anchor: 4, ahead: [5.5, 9], lat: [0, 0], height: [1.1, 2.0], fov: [40, 56], end: 0, hold: 9 },
  { id: 'pit_stall_low', label: 'Pit stall, wheel level', role: 'pit_stall', anchor: 4, ahead: [3.5, 5.5], lat: [0, 0], height: [0.55, 0.95], fov: [55, 70], end: 0, hold: 7 },
  { id: 'pit_stall_high', label: 'Pit stall, from the box', role: 'pit_stall', anchor: 4, ahead: [8, 12], lat: [0, 0], height: [3.0, 4.6], fov: [38, 50], end: 0, hold: 9 },
  { id: 'pit_out', label: 'Pit exit', role: 'pit_out', anchor: 2, ahead: [25, 60], lat: [7, 13], height: [2.5, 5], fov: [28, 42], end: 30, hold: 12 },
  { id: 'pit_out_low', label: 'Pit exit, low', role: 'pit_out', anchor: 2, ahead: [15, 40], lat: [5, 8], height: [0.8, 1.4], fov: [40, 54], end: 25, hold: 9 },
  { id: 'pit_out_high', label: 'Pit exit, from above', role: 'pit_out', anchor: 2, ahead: [40, 80], lat: [10, 18], height: [15, 26], fov: [38, 52], end: 40, hold: 11 },
  { id: 'crash_wide', label: 'Crash, wide', role: 'crash', anchor: 5, ahead: [40, 75], lat: [0, 0], height: [8, 20], fov: [32, 50], end: 0, hold: 10 },
  { id: 'crash_close', label: 'Crash, close', role: 'crash', anchor: 5, ahead: [16, 30], lat: [0, 0], height: [1.5, 3.5], fov: [45, 62], end: 0, hold: 8 },
  { id: 'crash_high', label: 'Crash, from above', role: 'crash', anchor: 5, ahead: [30, 55], lat: [0, 0], height: [35, 60], fov: [40, 58], end: 0, hold: 9 },
  { id: 'finish_line', label: 'At the line', role: 'finish', anchor: 3, ahead: [8, 25], lat: [6, 11], height: [1.5, 4], fov: [30, 45], end: 40, hold: 16 },
  { id: 'finish_high', label: 'The line from above', role: 'finish', anchor: 3, ahead: [10, 40], lat: [9, 16], height: [14, 24], fov: [38, 52], end: 40, hold: 14 },
  { id: 'finish_head_on', label: 'Head-on at the line', role: 'finish', anchor: 3, ahead: [110, 170], lat: [5, 10], height: [1.2, 2.6], fov: [9, 15], end: 25, hold: 12 },
  // the choose cone restart (Race Control says where the cone is): metres past the cone; the cars choosing their lane come to it
  { id: 'cone_side', label: 'Cone, trackside', role: 'cone', anchor: 6, ahead: [-45, -20], lat: [7, 14], height: [1.5, 3], fov: [20, 30], end: 0, hold: 14 },
  { id: 'cone_high', label: 'Cone, from above', role: 'cone', anchor: 6, ahead: [-30, 0], lat: [10, 20], height: [14, 26], fov: [34, 46], end: 0, hold: 14 },
  { id: 'cone_past', label: 'Cone, looking back', role: 'cone', anchor: 6, ahead: [25, 55], lat: [6, 12], height: [1.5, 3], fov: [22, 32], end: 0, hold: 14 },
  { id: 'test', label: 'Test camera', role: 'test', anchor: 4, ahead: [24, 24], lat: [0, 0], height: [3, 3], fov: [40, 40], end: 0, hold: 8 },
];
const ROLES = ['pit_in', 'pit_stall', 'pit_out', 'crash', 'restart', 'cone', 'battle', 'finish'];
const SETTING_OF = { pit_in: 'dyn_pit', pit_stall: 'dyn_pit', pit_out: 'dyn_pit', crash: 'dyn_crash', restart: 'dyn_restart', cone: 'dyn_restart', battle: 'dyn_battle', finish: 'dyn_finish' };
const BASES = [{ cam: 17, addr: 0xC57378, name: 'Static A' }, { cam: 18, addr: 0xC5739C, name: 'Static B' }];
const BLOCK0 = 0xACCA30, OCD = 0x2214, POS = 0x19DE;          // car x, y, z then velocity x, y, z (floats)
const DEG = Math.PI / 180, MIN_LEAD_SPEED = 25, AIM_UP = 0.8, COOLDOWN = 6, EXPLORE = 0.22, DEFAULT_HALF_WIDTH = 8, UNTRIED = 0.62;
const RACE_LAPS = 12500413, RACE_LAPS_QUICK = 12500397, NUM_SESSIONS = 12500383;

const u = (r, a) => a[0] + (a[1] - a[0]) * r();
const wrap = (d, L) => ((d % L) + L) % L;
const wrapHalf = (d, L) => { const x = wrap(d + L / 2, L); return x - L / 2; };
const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const safe = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'track';

// Unity's SmoothDamp: settles on the target without overshoot
function smoothDamp(cur, target, st, smoothTime, dt) {
  const T = Math.max(1e-4, smoothTime), omega = 2 / T, x = omega * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target, temp = (st.v + omega * change) * dt;
  st.v = (st.v - omega * temp) * e;
  let out = target + (change + temp) * e;
  if ((target - cur > 0) === (out > target)) { out = target; st.v = dt > 0 ? (out - target) / dt : 0; }
  return out;
}

class Learned {
  constructor(track) {
    this.track = track; this.lap = 0;
    this.pitIn = []; this.pitOut = []; this.pitSide = []; this.stalls = []; this.crashes = [];
    this.width = new Array(81).fill(0); this.widthN = 0;      // |lateral| histogram, 0.5 m bins
    this.cautions = 0; this.pitRateSum = 0; this.arms = {};
  }
  static from(o, track) {
    const L = new Learned(track);
    if (o && typeof o === 'object') for (const k of Object.keys(L)) if (k in o && k !== 'track') L[k] = o[k];
    if (!Array.isArray(L.width) || L.width.length !== 81) L.width = new Array(81).fill(0);
    return L;
  }
  halfWidth() {
    if (this.widthN < 400) return null;
    let acc = 0; const want = this.widthN * 0.99;
    for (let i = 0; i < this.width.length; i++) { acc += this.width[i]; if (acc >= want) return Math.max(5, (i + 1) * 0.5 + 1.0); }
    return 40;
  }
  arm(key) { return this.arms[key] || (this.arms[key] = { n: 0, mean: UNTRIED }); }
  rate(key, score, w) { const a = this.arm(key); a.mean = a.n + w > 0 ? (a.mean * a.n + score * w) / (a.n + w) : score; a.n += w; }
}

class DynCams {
  // opts: { mem, cam (Camera), settings: () => resolved, log, rnd?, learnedDir?, mapFor?: (track) => TrackMap|null, timer?, pitEntryFor?: (track) => Race Control's pit entry dlong }
  constructor(opts) {
    this.o = opts; this.m = opts.mem; this.log = opts.log || (() => {}); this.rnd = opts.rnd || Math.random;
    this.dir = opts.learnedDir || path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'NR2003 Companions', 'racevision', 'learned');
    this.track = ''; this.L = null; this.map = null; this.mapAt = -1e9; this.trackLen = 0;
    this.active = null; this.recent = []; this.cooldownUntil = -1e9; this.nextBase = 0; this.orig = new Map();
    this.carState = new Map(); this.caution = null; this.prevGreen = null; this.lastShot = null; this.dirty = false; this.savedAt = 0;
    this.rigTimer = null; this.rig = null; this.note = '';
  }
  S() { return this.o.settings(); }
  on() { return !!Number(this.S().dyn_cams); }

  // ── the track and what was learned about it ─────────────────────────────────────────────────
  _setTrack(track, len) {
    if (track === this.track && this.L) return;
    this.save(true);
    this.track = track; this.trackLen = len; this.map = null; this.mapAt = -1e9; this.carState.clear(); this.caution = null;
    this.L = Learned.from(this._read(track), track);
    if (track) this.log(`dynamic cameras on ${track}: lap ${len.toFixed(0)} m, half width ${this.halfWidth().toFixed(1)} m`);
  }
  _file(track) { return path.join(this.dir, safe(track) + '.json'); }
  _read(track) { try { return JSON.parse(fs.readFileSync(this._file(track), 'utf8')); } catch (e) { return null; } }
  save(force) {
    if (!this.L || !this.track || !this.dirty || !Number(this.S().dyn_learn)) return;
    const now = Date.now();
    if (!force && now - this.savedAt < 30000) return;
    try { fs.mkdirSync(this.dir, { recursive: true }); this.L.lap = this.trackLen; fs.writeFileSync(this._file(this.track), JSON.stringify(this.L)); this.dirty = false; this.savedAt = now; } catch (e) { /* read-only disk */ }
  }
  forget() {
    if (!this.track) return false;
    try { fs.unlinkSync(this._file(this.track)); } catch (e) { /* none */ }
    this.L = new Learned(this.track); this.dirty = false;
    this.log(`Dynamic cameras: forgot what was learnt about ${this.track}`);
    return true;
  }
  _map() {
    if (this.map) return this.map;
    const now = Date.now();
    if (now - this.mapAt < 30000) return null;
    this.mapAt = now;
    try { this.map = this.o.mapFor ? this.o.mapFor(this.track) : TrackMap.Load(this.track); } catch (e) { this.map = null; }
    if (this.map && this.trackLen > 100 && Math.abs(this.map.Length - this.trackLen) > 50) this.map = null;     // another version of the track
    return this.map;
  }
  halfWidth() {
    const s = Number(this.S().dyn_half_width);
    if (s > 0) return s;
    const h = this.L && this.L.halfWidth();
    return h || DEFAULT_HALF_WIDTH;
  }
  // lateral offset (m, + left of travel) of a world point from the centre line
  _lat(map, x, y) {
    const n = map.Nearest(x, y), [cx, cy] = map.At(n.dlong), [tx, ty] = map.Heading(n.dlong);
    return { dlong: n.dlong, lat: (x - cx) * -ty + (y - cy) * tx };
  }
  pitRoad() {
    const L = this.L; if (!L) return null;
    if (L.pitIn.length && L.pitOut.length) return { pitIn: median(L.pitIn), pitOut: median(L.pitOut), side: Math.sign(median(L.pitSide)) || 1, known: true };
    // estimated from the game's two pit cameras (17 near the entry, 18 near the exit)
    const map = this._map(); if (!map) return null;
    const pts = BASES.map(b => { const o = this.orig.get(b.cam), buf = o || this.m.readBytes(b.addr, 12); return buf ? [buf.readFloatLE(0), buf.readFloatLE(4)] : null; });
    if (pts.some(p => !p || !p.every(Number.isFinite) || (p[0] === 0 && p[1] === 0))) return null;
    const a = this._lat(map, pts[0][0], pts[0][1]), b = this._lat(map, pts[1][0], pts[1][1]);
    // RaceVision takes the pit entry from Race Control when it hasn't seen one itself (PitEntry.<track> in RaceControl.ini; here the
    // built-in Race Control's learned pit entry)
    const rcv = this.o.pitEntryFor ? this.o.pitEntryFor(this.track) : null, rc = rcv == null || rcv === '' ? NaN : Number(rcv);
    const pitIn = Number.isFinite(rc) && rc >= 0 && rc < map.Length ? rc : wrap(a.dlong - 60, map.Length);
    return { pitIn, pitOut: wrap(b.dlong + 60, map.Length), side: Math.sign(a.lat + b.lat) || 1, known: false };
  }

  // ── watching the race: pit road, track width, stalls, crashes, cautions ─────────────────────
  observe(f, events) {
    if (!f || !(f.trackLen > 100) || !f.track) return;
    this._setTrack(f.track, f.trackLen);
    const L = this.L, map = this._map(), t = f.t;
    for (const c of f.cars) {
      if (c.pace) continue;
      const st = this.carState.get(c.slot) || { pit: c.pit, stopAt: -1, stopD: NaN };
      if (c.pit !== st.pit && c.speed > 3) {
        (c.pit ? L.pitIn : L.pitOut).push(c.dlong); if (L.pitIn.length > 25) L.pitIn.shift(); if (L.pitOut.length > 25) L.pitOut.shift();
        this.dirty = true;
        if (c.pit && this.caution) this.caution.pitted.add(c.slot);
      }
      st.pit = c.pit;
      if (map && Number.isFinite(c.x) && Number.isFinite(c.y)) {
        if (c.pit && c.speed > 3) { const l = this._lat(map, c.x, c.y).lat; L.pitSide.push(l); if (L.pitSide.length > 40) L.pitSide.shift(); }
        else if (!c.pit && c.speed > 20 && f.green) { const l = Math.abs(this._lat(map, c.x, c.y).lat); L.width[Math.min(80, Math.floor(l / 0.5))]++; L.widthN++; }
      }
      if (c.pit && c.speed < 0.5) {
        if (st.stopAt < 0) { st.stopAt = t; st.stopD = c.dlong; }
        else if (t - st.stopAt > 2 && !L.stalls.some(d => Math.abs(wrapHalf(d - st.stopD, f.trackLen)) < 5)) { L.stalls.push(st.stopD); if (L.stalls.length > 60) L.stalls.shift(); this.dirty = true; }
      } else st.stopAt = -1;
      this.carState.set(c.slot, st);
    }
    for (const e of events || []) {
      if (e.kind !== 'incident' || e.t <= (this._evSeen || -1)) continue;
      const c = f.cars.find(x => x.slot === e.slot);
      if (c && !L.crashes.some(d => Math.abs(wrapHalf(d - c.dlong, f.trackLen)) < 30)) { L.crashes.push(c.dlong); if (L.crashes.length > 40) L.crashes.shift(); this.dirty = true; }
    }
    if (events && events.length) this._evSeen = Math.max(this._evSeen || -1, ...events.map(e => e.t));
    // cautions: how many of the field pit
    if (this.prevGreen === true && !f.green) this.caution = { pitted: new Set(), field: f.cars.filter(c => !c.pace).length };
    if (this.prevGreen === false && f.green && this.caution) {
      L.cautions++; L.pitRateSum += this.caution.field ? this.caution.pitted.size / this.caution.field : 0; this.caution = null; this.dirty = true;
    }
    this.prevGreen = f.green;
    this.save(false);
  }

  // ── choosing an angle ──────────────────────────────────────────────────────────────────────
  // the role a director shot can have a dynamic camera for, or ''
  roleFor(act, f, pitPhase) {
    if (!act || act.slot === undefined || act.slot < 0) return '';
    const kind = act.kind, car = f.cars.find(c => c.slot === act.slot);
    if (!car) return '';
    if (kind === 'incident') return 'crash';
    if (kind === 'pit') { const p = pitPhase && pitPhase.get(act.slot); return p === 'stall' ? 'pit_stall' : p === 'out' ? 'pit_out' : 'pit_in'; }
    if (kind === 'restart') return 'restart';
    const laps = this.raceLaps(), lead = f.order && f.order[0];
    if (laps > 0 && lead && lead.laps + 1 >= laps && f.green && car.pos <= 3) return 'finish';
    if (kind === 'battle' || kind === 'pass') return 'battle';
    return '';
  }
  raceLaps() {
    const s = this.m.readBytes(NUM_SESSIONS, 1), a = s && s[0] === 2 ? RACE_LAPS_QUICK : RACE_LAPS, b = this.m.readBytes(a, 2);
    return b ? b.readUInt16LE(0) : 0;
  }
  _armScore(t, side, preferred) {
    const a = this.L.arm(t.id + ':' + side);
    let s = a.mean + 0.35 / Math.sqrt(a.n + 1) + this.rnd() * 0.2;
    const n = this.recent.length;
    this.recent.forEach((id, i) => { if (id !== t.id) return; const age = n - i; s -= age <= 2 ? 0.45 : age < 6 ? 0.22 : 0.08; });
    if (!preferred) s -= 0.25;
    return s;
  }
  // -> [{ t, side, score }] best first
  candidates(role, ctx) {
    const list = [];
    const two = this.recent.slice(-2);
    for (const t of TEMPLATES.filter(x => x.role === role)) {
      if (two.length === 2 && two[0] === t.id && two[1] === t.id) continue;           // never the same template three times running
      for (const side of [1, -1]) {
        if ((t.anchor === 1 || t.anchor === 2) && ctx.prefer && side !== ctx.prefer) continue;      // pit road cameras only on pit road's side
        list.push({ t, side, score: this._armScore(t, side, side === (ctx.prefer || side)) });
      }
    }
    list.sort((a, b) => b.score - a.score);
    return list;
  }
  pick(role, ctx) {
    const c = this.candidates(role, ctx);
    if (!c.length) return null;
    if (c.length >= 4 && this.rnd() < EXPLORE) return c[1 + Math.floor(this.rnd() * (c.length - 1))];
    return c[0];
  }

  // ── placing it ─────────────────────────────────────────────────────────────────────────────
  carPos(slot) {
    const b = this.m.readBytes(BLOCK0 + slot * OCD + POS, 24);
    if (!b) return null;
    const p = { x: b.readFloatLE(0), y: b.readFloatLE(4), z: b.readFloatLE(8), vx: b.readFloatLE(12), vy: b.readFloatLE(16), vz: b.readFloatLE(20) };
    if (![p.x, p.y].every(Number.isFinite)) return null;
    if (!Number.isFinite(p.z) || Math.abs(p.z) >= 3000) p.z = 0;
    return p;
  }
  // the inside of the corner at dlong (+1 left of travel, -1 right; +1 on a straight)
  _inside(map, d) {
    const [ax, ay] = map.Heading(d - 40), [bx, by] = map.Heading(d + 40), z = ax * by - ay * bx;
    return Math.abs(z) < 0.02 ? 0 : Math.sign(z);
  }
  // -> placement or null
  place(t, side, car, ctx) {
    const map = this._map(); if (!map) return null;
    const p = this.carPos(car.slot); if (!p) return null;
    const L = map.Length, hw = this.halfWidth(), r = this.rnd;
    let x, y, d = NaN, endD = NaN, endS = NaN;
    const edge = (dl, lat) => map.AtDlat(wrap(dl, L), side * (hw + lat));
    switch (t.anchor) {
      case 0: { const v = Math.max(MIN_LEAD_SPEED, car.speed || 0); d = car.dlong + v * u(r, t.ahead); [x, y] = edge(d, u(r, t.lat)); endS = t.end; break; }
      case 1: case 2: {
        const pr = ctx.pit; if (!pr) return null;
        const a = t.anchor === 1 ? pr.pitIn : pr.pitOut;
        d = a + u(r, t.ahead); [x, y] = edge(d, u(r, t.lat)); endD = a + t.end; break;
      }
      case 3: d = u(r, t.ahead); [x, y] = edge(d, u(r, t.lat)); endD = t.end; break;
      case 4: {
        let hx = p.vx, hy = p.vy; const sp = Math.hypot(hx, hy);
        if (sp > 2) { hx /= sp; hy /= sp; } else [hx, hy] = map.Heading(car.dlong);
        const a = u(r, t.ahead); x = p.x + hx * a; y = p.y + hy * a; break;
      }
      case 6: { if (!ctx.cone || !(ctx.cone.d >= 0)) return null; d = ctx.cone.d + u(r, t.ahead); [x, y] = edge(d, u(r, t.lat)); break; }
      case 5: {
        const spot = ctx.crash || { dlong: car.dlong };
        const dir = r() < 0.6 ? -1 : 1;                       // mostly from up the track, the traffic coming at the wreck
        d = spot.dlong + dir * u(r, t.ahead); [x, y] = edge(d, 2); break;
      }
      default: return null;
    }
    if (![x, y].every(Number.isFinite)) return null;
    const z = p.z + u(r, t.height), fov = u(r, t.fov), hold = t.role === 'test' ? t.hold : u(r, [Math.max(t.hold * 0.6, 2), t.hold]);
    const dist = Math.hypot(x - p.x, y - p.y);
    if (dist > 600) return null;
    return { x, y, z, fov, hold, d, endD, endS, dist0: Math.max(3, Math.hypot(dist, z - p.z)) };
  }

  // ── on air ─────────────────────────────────────────────────────────────────────────────────
  // a director cut: start a dynamic camera for it? -> true if it did (the caller then leaves the camera alone)
  offer(act, f, ctx = {}) {
    if (!this.on() || this.active || !f || !this.track) return false;
    const S = this.S(), role = this.roleFor(act, f, ctx.pitPhase);
    if (!role || !Number(S[SETTING_OF[role]])) return false;
    if (f.t < this.cooldownUntil) return false;
    if (this.rnd() * 100 >= Number(S.dyn_chance)) return false;
    return this.start(role, act.slot, f, { why: act.why || act.kind });
  }
  // the choose cone (RaceVision 1.2.0): while the cars pick their lane at the cone, a camera at the cone on the car coming to it first.
  // cone: { d (metres from the line), active, seq } from Race Control. -> true if it started one
  coneTick(f, cone, busy) {
    const S = this.S();
    if (!cone || !cone.active || !(cone.d >= 0) || cone.seq === this.coneShownFor) return false;
    if (!this.on() || !Number(S.dyn_restart) || this.active || busy || !f || !this.track || !(f.trackLen > 0) || !this._map()) return false;
    let pick = null, best = 1e9;
    for (const c of f.order || f.cars) {
      if (c.pace || c.pit || !(c.speed >= 5) || !Number.isFinite(c.dlong)) continue;
      const to = wrapHalf(cone.d - c.dlong, f.trackLen);          // + = the cone is still ahead of him
      if (to > -15 && to < 600 && to < best) { best = to; pick = c; }
    }
    if (!pick) return false;
    this.coneShownFor = cone.seq;
    this.log(`dynamic cameras: the cone is at ${Math.round(cone.d)} m (Race Control)`);
    return this.start('cone', pick.slot, f, { why: 'the choose cone', cone });
  }
  start(role, slot, f, { why = '', test = false, cone = null } = {}) {
    if (!this._map()) { this.note = 'no track map yet'; this.log(`dynamic cameras: no track map for ${this.track} - skipped`); return false; }
    const car = f.cars.find(c => c.slot === slot);
    if (!car) { this.note = 'no car on track'; return false; }
    const map = this._map(), pit = this.pitRoad();
    const ctx = { pit, crash: role === 'crash' ? { dlong: car.dlong } : null, cone };
    if ((role === 'pit_in' || role === 'pit_out') && !pit) { this.note = 'pit road not known'; return false; }
    ctx.prefer = role.startsWith('pit') ? (pit ? pit.side : 0) : (role === 'crash' ? (Math.sign(car.dlat || 0) || 0) : this._inside(map, car.dlong));
    let pick = null, pl = null;
    for (let i = 0; i < 4 && !pl; i++) {
      pick = test ? { t: TEMPLATES.find(x => x.id === 'test'), side: 1 } : this.pick(role, ctx);
      if (!pick) break;
      pl = this.place(pick.t, pick.side, car, ctx);
    }
    if (!pl) { this.note = "couldn't place it"; return false; }
    const base = BASES[this.nextBase]; this.nextBase = 1 - this.nextBase;
    if (!this.orig.has(base.cam)) { const o = this.m.readBytes(base.addr, 0x24); if (!o) { this.note = "NR2003 isn't ready for a camera change"; return false; } this.orig.set(base.cam, Buffer.from(o)); }
    const shot = { role, slot, t: pick.t, side: pick.side, base, pl, since: f.t, good: 0, total: 0, aim: null, why, test };
    this.active = shot;
    this._aim(f, 0, true);
    if (this.o.cam) this.o.cam.set(base.cam, slot, { call: !!Number(this.S().camera_call) });
    if (!test) { this.recent.push(pick.t.id); if (this.recent.length > 6) this.recent.shift(); }
    const num = car.num, sideTxt = pick.side > 0 ? 'left' : 'right';
    this.log(`dynamic camera: ${pick.t.label} for #${num} (${why || role}), ${pl.dist0.toFixed(0)} m from the car, lens ${pl.fov.toFixed(0)} deg${Number(this.S().dyn_rig) ? ', follow rig' : ''} - Dynamic Camera - ${base.name}: ${pick.t.id} (${sideTxt} side)`);
    this.note = '';
    if (Number(this.S().dyn_rig)) this._startRig(); else this._stopRig();
    return true;
  }

  // the camera's aim at the car: turn, tilt (and the lens with auto zoom)
  _target(p, now) {
    const sh = this.active, S = this.S(), pl = sh.pl;
    const dx = p.x - pl.x, dy = p.y - pl.y, horiz = Math.max(0.5, Math.hypot(dx, dy)), dz = pl.z - (p.z + AIM_UP), dist = Math.hypot(horiz, dz);
    const yaw = Math.atan2(dy, dx) + Number(S.dyn_yaw_fix || 0) * DEG;
    const pitch = (Number(S.dyn_pitch_sign) || 1) * Math.atan2(dz, horiz);
    let fov = pl.fov * DEG;
    if (Number(S.dyn_autozoom)) {
      const width = 2 * pl.dist0 * Math.tan(fov / 2);        // the view width the template's lens gives where the shot started
      fov = Math.max(3 * DEG, Math.min(80 * DEG, 2 * Math.atan(width / 2 / dist)));
    }
    return { yaw, pitch, fov, dist };
  }
  _write(a) {
    const sh = this.active; if (!sh) return;
    const o = this.orig.get(sh.base.cam), b = Buffer.alloc(0x24);
    if (o) o.copy(b);
    b.writeFloatLE(sh.pl.x, 0); b.writeFloatLE(sh.pl.y, 4); b.writeFloatLE(sh.pl.z, 8);
    b.writeFloatLE(a.yaw, 12); b.writeFloatLE(a.pitch, 16); b.writeFloatLE(0, 20); b.writeFloatLE(a.fov, 24);
    this.m.writeBytes(sh.base.addr, b);
  }
  _aim(f, dt, first) {
    const sh = this.active, p = this.carPos(sh.slot);
    if (!p) return false;
    const tg = this._target(p);
    if (first || !this.rigTimer) { sh.aim = { yaw: tg.yaw, pitch: tg.pitch, fov: tg.fov }; this._write(sh.aim); }
    // how well the car is framed: its apparent size (5 m car across the view), and close enough to see
    if (dt > 0) {
      const frac = 5 / Math.max(0.1, 2 * tg.dist * Math.tan((sh.aim ? sh.aim.fov : tg.fov) / 2));
      const q = tg.dist > 400 ? 0 : frac >= 0.04 && frac <= 0.6 ? 1 : frac < 0.04 ? frac / 0.04 : 0.6 / frac;
      sh.total += dt; sh.good += dt * q;
    }
    return true;
  }
  // the follow rig: its own fast timer, the car predicted between the game's physics ticks, SmoothDamp on turn / tilt / lens
  _startRig() {
    if (this.rigTimer) return;
    const timer = this.o.timer || { set: (fn, ms) => setInterval(fn, ms), clear: (h) => clearInterval(h) };
    this.rig = { last: null, lastStep: 0, period: 1 / 36, vy: { v: 0 }, vp: { v: 0 }, vf: { v: 0 }, at: Date.now() / 1000 };
    this.rigTimer = timer.set(() => { try { this._rigStep(); } catch (e) { /* game gone */ } }, 8);
    if (this.rigTimer && this.rigTimer.unref) this.rigTimer.unref();
    this._rigClear = timer.clear;
  }
  _stopRig() { if (this.rigTimer) { (this._rigClear || clearInterval)(this.rigTimer); this.rigTimer = null; this.rig = null; } }
  _rigStep(nowS) {
    const sh = this.active, R = this.rig;
    if (!sh || !R) return;
    const now = nowS !== undefined ? nowS : Date.now() / 1000, dt = Math.max(0.001, Math.min(0.1, now - R.at)); R.at = now;
    const p = this.carPos(sh.slot); if (!p) return;
    // the step clock: when the car moved, a physics tick happened; learn the period
    if (!R.last || p.x !== R.last.x || p.y !== R.last.y) {
      if (R.last && R.lastStep) { const d = now - R.lastStep; if (d > 1 / 200 && d < 0.2) R.period += (d - R.period) * 0.1; }
      R.lastStep = now; R.last = p;
    }
    // where the car is between the physics ticks, and further on by the smoothing time: SmoothDamp trails a steady turn by about
    // its smoothing time, so aiming that far ahead keeps the car in the middle of the picture through a pass
    const smooth = 0.08 * Math.max(0.1, Number(this.S().dyn_smooth) || 1);
    const lead = Math.max(0, now - R.lastStep) + R.period * 0.5 + smooth;
    const q = { x: p.x + p.vx * lead, y: p.y + p.vy * lead, z: p.z + p.vz * lead };
    const tg = this._target(q);
    const cur = sh.aim || tg;
    const yawT = cur.yaw + wrapHalf(tg.yaw - cur.yaw, 2 * Math.PI);
    sh.aim = { yaw: smoothDamp(cur.yaw, yawT, R.vy, smooth, dt), pitch: smoothDamp(cur.pitch, tg.pitch, R.vp, smooth, dt), fov: smoothDamp(cur.fov, tg.fov, R.vf, smooth * 2, dt) };
    this._write(sh.aim);
  }

  // every director tick while a dynamic camera is on: aim (without the rig), and is it over?  -> '' or why it ended
  tick(f, dt) {
    const sh = this.active; if (!sh) return '';
    const car = f.cars.find(c => c.slot === sh.slot);
    if (!car) return this.end('car gone', f);
    if (!this._aim(f, dt, false)) return this.end('car gone', f);
    const age = f.t - sh.since, pl = sh.pl, L = f.trackLen;
    if (age >= pl.hold) return this.end('held long enough', f);
    if (Number.isFinite(pl.endS)) {
      const v = Math.max(MIN_LEAD_SPEED, car.speed || 0), past = wrapHalf(car.dlong - pl.d, L) / v;
      if (past >= pl.endS && age > 1) return this.end('the car has passed', f);
    }
    if (Number.isFinite(pl.endD) && age > 1 && wrapHalf(car.dlong - pl.endD, L) >= 0 && wrapHalf(car.dlong - pl.endD, L) < 200) return this.end('the car has passed', f);
    if (sh.role === 'pit_in' && car.pit && car.speed < 0.5 && age > 2) return this.end('in the stall', f);
    if (sh.role === 'pit_stall') {
      if (car.speed < 0.5) sh.stopped = true;
      else if (sh.stopped && car.speed > 3 && age > 2) return this.end('left the stall', f);
    }
    return '';
  }
  // the camera is put back as it was; the shot's score is learned
  end(why, f) {
    const sh = this.active; if (!sh) return '';
    this._stopRig();
    this.active = null;
    const o = this.orig.get(sh.base.cam);
    if (o) this.m.writeBytes(sh.base.addr, o);
    this.cooldownUntil = (f ? f.t : 0) + COOLDOWN;
    const dur = f ? f.t - sh.since : 0;
    let tail = '';
    if (sh.total >= 2 && Number(this.S().dyn_learn) && !sh.test && this.L) {
      const score = Math.max(0, Math.min(1, sh.good / sh.total));
      this.L.rate(sh.t.id + ':' + sh.side, score, 1); this.dirty = true; tail = `, score ${score.toFixed(2)}`;
    }
    this.lastShot = { key: sh.t.id + ':' + sh.side, label: sh.t.label, test: sh.test };
    this.log(`           dynamic camera ended (${why}) after ${dur.toFixed(1)} s: ${sh.t.label}${tail}`);
    return why;
  }
  // thumbs up / down for the last dynamic shot (counts three times)
  rate(up) {
    const s = this.lastShot || (this.active && { key: this.active.t.id + ':' + this.active.side, label: this.active.t.label });
    if (!s || s.test || !this.L) return { error: 'no dynamic shot to rate yet' };
    this.L.rate(s.key, up ? 1 : 0, 3); this.dirty = true; this.save(true);
    this.log(`${up ? 'thumbs up for' : 'thumbs down for'} ${s.label}`);
    return { ok: true, label: s.label };
  }
  // the test camera on the car on air for 8 s
  test(f, slot) {
    if (!f) return { error: "NR2003 isn't ready for a camera change" };
    if (this.active) this.end('replaced', f);
    if (!(slot >= 0)) return { error: 'no car on track' };
    const ok = this.start('test', slot, f, { why: 'dynamic camera test', test: true });
    return ok ? { ok: true } : { error: this.note || "couldn't place it" };
  }
  // the game left / the director stopped: every camera back, nothing on
  release() {
    this._stopRig();
    if (this.active) { const o = this.orig.get(this.active.base.cam); if (o) try { this.m.writeBytes(this.active.base.addr, o); } catch (e) { /* gone */ } this.active = null; }
    this.save(true);
  }
  gameGone() { this._stopRig(); this.active = null; this.orig.clear(); this.save(true); this.track = ''; this.L = null; this.map = null; }

  // ── for the pages ──────────────────────────────────────────────────────────────────────────
  status() {
    const L = this.L, pr = this.pitRoad(), S = this.S();
    const tmpl = TEMPLATES.filter(t => t.role !== 'test').flatMap(t => [1, -1].map(side => { const a = L && L.arms[t.id + ':' + side]; return { id: t.id, label: t.label, role: t.role, side: side > 0 ? 'left' : 'right', n: a ? a.n : 0, score: a && a.n ? +a.mean.toFixed(3) : null }; }));
    return {
      on: !!Number(S.dyn_cams), track: this.track, map: !!this._map(), note: this.note,
      pitIn: pr ? Math.round(pr.pitIn) : null, pitOut: pr ? Math.round(pr.pitOut) : null, pitSide: pr ? pr.side : 0, pitKnown: !!(pr && pr.known),
      halfWidth: +this.halfWidth().toFixed(1), widthKnown: Number(S.dyn_half_width) > 0 || !!(L && L.halfWidth()),
      stalls: L ? L.stalls.length : 0, crashes: L ? L.crashes.length : 0, cautions: L ? L.cautions : 0,
      pitRate: L && L.cautions ? Math.round(100 * L.pitRateSum / L.cautions) : -1, templates: tmpl,
      active: this.live(), last: this.lastShot ? this.lastShot.label : '',
    };
  }
  // for the preview page: RaceVision's templates, what was learned about `track` (any track, not only the loaded one) and the scores
  previewInfo(track) {
    const L = track === this.track && this.L ? this.L : Learned.from(this._read(track), track), S = this.S();
    const hw = Number(S.dyn_half_width) > 0 ? Number(S.dyn_half_width) : (L.halfWidth() || DEFAULT_HALF_WIDTH);
    const known = L.pitIn.length && L.pitOut.length;
    const templateSpecs = TEMPLATES.filter(t => t.role !== 'test').map(t => ({ id: t.id, label: t.label, role: t.role, anchor: t.anchor, ahead: t.ahead, lat: t.lat, height: t.height, fov: t.fov, end: t.end, hold: t.hold }));
    const templates = TEMPLATES.filter(t => t.role !== 'test').flatMap(t => [1, -1].map(side => { const a = L.arms[t.id + ':' + side]; return { id: t.id, side: side > 0 ? 'L' : 'R', n: a ? a.n : 0, score: a && a.n ? +a.mean.toFixed(3) : null }; }));
    return {
      track, halfWidth: +hw.toFixed(1), pitKnown: !!known, pitIn: known ? median(L.pitIn) : null, pitOut: known ? median(L.pitOut) : null,
      pitSide: L.pitSide.length ? (Math.sign(median(L.pitSide)) || 0) : 0, templateSpecs, templates,
    };
  }
  // what the live map shows
  live() {
    const sh = this.active;
    if (!sh) return { on: false };
    const a = sh.aim || {};
    return { on: true, x: +sh.pl.x.toFixed(1), y: +sh.pl.y.toFixed(1), z: +sh.pl.z.toFixed(1), yaw: +(a.yaw || 0).toFixed(4), fov: +((a.fov || 0) / DEG).toFixed(1), cam: sh.base.cam, role: sh.role, tmpl: sh.t.id, label: sh.t.label, key: sh.t.id + ':' + sh.side, slot: sh.slot };
  }
}

module.exports = { DynCams, TEMPLATES, ROLES, BASES, Learned, smoothDamp };
