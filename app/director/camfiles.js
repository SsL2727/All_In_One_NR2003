// NR2003's camera files and the camera-set recipes of RaceVision (Nov 2026 build).
//
// Track cameras (<track>.cam, "MACT", version 2):
//   +0 'MACT'  +4 u32 2  +8 u32 body length (groups + pit cameras + tail)
//   then three groups - TV1, TV2, SPECTATOR - each a u32 count (at most 64) and count records of 0x39 bytes:
//     14 floats (0 dlong, 1 lateral, 2 height, 3 takeover offset (<= 0), 5-7 lens, 11 lens of a fixed camera, ...) and a byte (1 = fixed)
//   then the two pit cameras (2 x 9 floats: x, y, z, turn, tilt, roll, lens, two more), a 16 byte tail and whatever follows (kept).
// In the game the three groups live at 0xC585A0 (master) and 0xC548A0 (in use), 0xE44 bytes each (u32 count + 64 records), and the
// pit cameras at 0xC57378 / 0xC573F8.
//
// Car cameras (make_a.cam, "MACC"): +0 'MACC' +4 u32 0 +8 u32 0xD8, then 6 cameras of 9 floats (x, y, z, turn, tilt, roll, lens, two
// more) - the game's cameras 10-15: front, rear, roof forward, roof, right side, left side - and a trailing byte. In the game every car
// model has its six at 0xC57450 + (model * 6 + i) * 0x24 (20 models).
'use strict';

const REC = 0x39, GROUPS = 3, MAX_CAMS = 64, GROUP_STRIDE = 0xE44, PIT = 0x24, TAIL = 16;
const A = { TvMaster: 0xC585A0, TvLive: 0xC548A0, Pit1: 0xC57378, Pit2: 0xC573F8, CarCams: 0xC57450, CarModels: 20, CarCam: 0x24 };
const MACT = 0x5443414d, MACC = 0x4343414d;

// ── track sets ───────────────────────────────────────────────────────────────────────────────
const recFrom = (b, o) => { const f = new Float32Array(14); for (let i = 0; i < 14; i++) f[i] = b.readFloatLE(o + i * 4); return { f, fixed: b[o + 0x38] }; };
const recTo = (r, b, o) => { for (let i = 0; i < 14; i++) b.writeFloatLE(r.f[i], o + i * 4); b[o + 0x38] = r.fixed & 0xff; };
const cloneRec = (r) => ({ f: Float32Array.from(r.f), fixed: r.fixed });
const cloneTrack = (t) => ({ groups: t.groups.map(g => g.map(cloneRec)), pit: Buffer.from(t.pit), tail: Buffer.from(t.tail), extra: Buffer.from(t.extra) });

// -> { groups: [[rec]...3], pit: Buffer(0x48), tail: Buffer(16), extra: Buffer } or throws
function parseTrack(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.readUInt32LE(0) !== MACT) throw new Error('not a track camera file');
  if (buf.readUInt32LE(4) !== 2) throw new Error('track camera file version ' + buf.readUInt32LE(4));
  let o = 12; const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    if (o + 4 > buf.length) throw new Error('cut short');
    const n = buf.readUInt32LE(o); o += 4;
    if (n > MAX_CAMS || o + n * REC > buf.length) throw new Error('bad camera count');
    const list = [];
    for (let i = 0; i < n; i++) { list.push(recFrom(buf, o)); o += REC; }
    groups.push(list);
  }
  if (o + 2 * PIT > buf.length) throw new Error('no pit cameras');
  const pit = Buffer.from(buf.subarray(o, o + 2 * PIT)); o += 2 * PIT;
  const tail = Buffer.alloc(TAIL); buf.copy(tail, 0, o, Math.min(buf.length, o + TAIL));
  if (buf.length - o < TAIL) throw new Error('the tail is not 16 bytes');
  o += TAIL;
  return { groups, pit, tail, extra: Buffer.from(buf.subarray(o)) };
}

function writeTrack(t) {
  const body = t.groups.reduce((s, g) => s + 4 + g.length * REC, 0) + 2 * PIT + TAIL;
  const b = Buffer.alloc(12 + body + t.extra.length);
  b.writeUInt32LE(MACT, 0); b.writeUInt32LE(2, 4); b.writeUInt32LE(body, 8);
  let o = 12;
  for (const g of t.groups) { b.writeUInt32LE(g.length, o); o += 4; for (const r of g) { recTo(r, b, o); o += REC; } }
  t.pit.copy(b, o); o += 2 * PIT; t.tail.copy(b, o); o += TAIL; t.extra.copy(b, o);
  return b;
}

// the three in-memory tables (3 x 0xE44) of a set
function trackTables(t) {
  const b = Buffer.alloc(GROUPS * GROUP_STRIDE);
  t.groups.forEach((g, gi) => {
    const base = gi * GROUP_STRIDE;
    b.writeUInt32LE(Math.min(g.length, MAX_CAMS), base);
    g.slice(0, MAX_CAMS).forEach((r, i) => recTo(r, b, base + 4 + i * REC));
  });
  return b;
}
// tables read from the game (+ pit cameras) -> a set (tail / extra empty: a set read live has none)
function trackFromTables(tables, pit) {
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    const base = g * GROUP_STRIDE, n = tables.readUInt32LE(base);
    if (n > MAX_CAMS) throw new Error('no session is loaded in NR2003 yet');
    const list = []; for (let i = 0; i < n; i++) list.push(recFrom(tables, base + 4 + i * REC));
    groups.push(list);
  }
  return { groups, pit: Buffer.from(pit), tail: Buffer.alloc(TAIL), extra: Buffer.alloc(0) };
}

// ── track recipes (RaceVision's built-in sets) ────────────────────────────────────────────────
const LENS = [5, 6, 7], FIXED_LENS = 11;
function scaleLens(t, k) {                                  // TV1 and TV2 only; a fixed camera also has its own lens
  for (const g of [0, 1]) for (const r of t.groups[g]) {
    for (const i of LENS) r.f[i] = Math.fround(r.f[i] * k);
    if (r.fixed === 1) r.f[FIXED_LENS] = Math.fround(r.f[FIXED_LENS] * k);
  }
  return t;
}
// TV1 also gets TV2's following cameras (none within 60 m of one TV1 has), sorted round the lap; a camera never takes over more than
// 65% of the way back to the one before it; at most 64.
function moreCuts(t) {
  let L = 0, any = false;
  for (const g of t.groups) for (const r of g) { any = true; L = Math.max(L, r.f[0]); }
  L = any ? L * 1.02 : 1000;
  const wrapHalf = (d) => { let x = ((d + L / 2) % L + L) % L; return x - L / 2; };
  const out = t.groups[0].map(cloneRec);
  for (const r of t.groups[1]) {
    if (r.fixed !== 0) continue;
    if (out.some(p => Math.abs(wrapHalf(r.f[0] - p.f[0])) <= 60)) continue;
    out.push(cloneRec(r));
  }
  out.sort((a, b) => a.f[0] - b.f[0]);
  for (let i = 0; i < out.length; i++) {
    const prev = out[(i - 1 + out.length) % out.length];
    let gap = ((out[i].f[0] - prev.f[0]) % L + L) % L;
    if (gap === 0) gap = L;
    out[i].f[3] = Math.fround(Math.max(out[i].f[3], gap * -0.65));
  }
  t.groups[0] = out.slice(0, MAX_CAMS);
  return t;
}

// ── car sets ─────────────────────────────────────────────────────────────────────────────────
// a car set = 6 cameras x 9 floats
function parseCar(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 + 6 * 0x24 || buf.readUInt32LE(0) !== MACC) throw new Error('not a car camera file');
  const cams = [];
  for (let i = 0; i < 6; i++) { const c = []; for (let k = 0; k < 9; k++) c.push(buf.readFloatLE(12 + i * 0x24 + k * 4)); cams.push(c); }
  return { cams, head: Buffer.from(buf.subarray(0, 12)), extra: Buffer.from(buf.subarray(12 + 6 * 0x24)) };
}
function writeCar(c) {
  const b = Buffer.alloc(12 + 6 * 0x24 + (c.extra ? c.extra.length : 1));
  if (c.head && c.head.length === 12) c.head.copy(b, 0); else { b.writeUInt32LE(MACC, 0); b.writeUInt32LE(0, 4); b.writeUInt32LE(0xD8, 8); }
  carBytes(c).copy(b, 12);
  if (c.extra) c.extra.copy(b, 12 + 6 * 0x24);
  return b;
}
function carBytes(c) { const b = Buffer.alloc(6 * 0x24); c.cams.forEach((cam, i) => cam.forEach((v, k) => b.writeFloatLE(v, i * 0x24 + k * 4))); return b; }
function carFromBytes(b) { const cams = []; for (let i = 0; i < 6; i++) { const c = []; for (let k = 0; k < 9; k++) c.push(b.readFloatLE(i * 0x24 + k * 4)); cams.push(c); } return { cams, head: null, extra: Buffer.from([0]) }; }
const cloneCar = (c) => ({ cams: c.cams.map(x => x.slice()), head: c.head ? Buffer.from(c.head) : null, extra: c.extra ? Buffer.from(c.extra) : Buffer.from([0]) });

const F = Math.fround, PI = Math.PI;
// the stock cameras the recipes build on: the roof cam (3), the right side cam's last two values, and how wide the car is
function carBasis(c) {
  const right = c.cams[4], left = c.cams[5];
  const w = Math.max(Math.abs(left[1]), Math.abs(right[1]));
  return { roof: c.cams[3], tail: [right[7], right[8]], half: Math.min(1.05, Math.max(0.9, w + 0.26)) };
}
const place = (x, y, z, pitchUp, lens, tail) => [F(x), F(y), F(z), F(Math.atan2(-y, -x)), F(Math.atan2(pitchUp, Math.hypot(x, y))), 0, F(lens), tail[0], tail[1]];

// TV onboards: right = door cam high on the right, turned in; left = roof cam on the front of the roof looking back
function tvOnboard(c) {
  const b = carBasis(c);
  c.cams[4] = [F(-0.9), F(-(b.half + 0.12)), F(b.roof[2] - 0.15), F(0.2), F(0.08), 0, F(1.2), b.tail[0], b.tail[1]];
  c.cams[5] = [F(b.roof[0] + 0.35), 0, F(b.roof[2] + 0.1), F(PI), F(0.18), 0, F(1.25), b.tail[0], b.tail[1]];
  return c;
}
// ... and the front bumper camera turned round: on the nose looking back up the hood
function tvOnboardNose(c) {
  tvOnboard(c);
  const f = c.cams[0], roofZ = c.cams[3][2];
  c.cams[0] = [F(f[0] - 0.1), 0, F(Math.max(f[2] + 0.55, roofZ * 0.65)), F(PI), F(-0.06), 0, F(1.25), f[7], f[8]];
  return c;
}
// outside the car, fixed to it: right = low front quarter looking back, left = rear quarter higher looking forward
function external(c) {
  const b = carBasis(c);
  c.cams[4] = place(3.2, -2.4, 0.55, -0.05, 1.0, b.tail);
  c.cams[5] = place(-4.0, 2.2, 1.3, 0.7, 0.95, b.tail);
  return c;
}
// right = broadside from 5.5 m off the right, left = head-on from 6 m ahead, low
function external2(c) {
  const b = carBasis(c);
  c.cams[4] = place(0, -5.5, 1.0, 0.4, 0.9, b.tail);
  c.cams[5] = place(6.0, 0, 0.9, 0.3, 0.75, b.tail);
  return c;
}
// one of each: right = TV door cam, left = low front quarter outside the car
function mix(c) {
  tvOnboard(c);
  const b = carBasis(c);
  c.cams[5] = place(3.2, 2.4, 0.55, -0.05, 1.0, b.tail);
  return c;
}

// ── text sets ────────────────────────────────────────────────────────────────────────────────
// A set in RaceVision's text form (a .cam file in the camsets folder that isn't MACT / MACC):
//   kind=track | car, version=N, tail=<32 hex digits>, extra=<hex>
//   [TV1] / [TV2] / [SPECTATOR]: one line per camera, "cam sf=.. cl=.. height=.. takeover=.. u4=.. zoom_in=.. zoom=.. zoom_out=.. aim=..
//     tilt=.. lean=.. view=.. u12=.. u13=.. type=N" (type 1 = fixed)
//   [PIT] (exactly 2) and [CAR] (exactly 6): "cam x=.. y=.. z=.. yaw=.. pitch=.. roll=.. fov=.. u7=.. u8=.."
// Blank lines and lines starting with # or ; are skipped.
const TV_KEYS = ['sf', 'cl', 'height', 'takeover', 'u4', 'zoom_in', 'zoom', 'zoom_out', 'aim', 'tilt', 'lean', 'view', 'u12', 'u13'];
const CAM_KEYS = ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'fov', 'u7', 'u8'];
const GROUP_NAMES = ['TV1', 'TV2', 'SPECTATOR'];
const isBinary = (buf) => Buffer.isBuffer(buf) && buf.length >= 4 && (buf.readUInt32LE(0) === MACT || buf.readUInt32LE(0) === MACC);
const hex = (s) => { const t = String(s).replace(/\s+/g, ''); const b = Buffer.alloc(t.length >> 1); for (let i = 0; i + 1 < t.length; i += 2) b[i >> 1] = parseInt(t.substr(i, 2), 16) || 0; return b; };
// -> { kind: 'track' | 'car', set } or throws (with RaceVision's messages)
function parseText(text) {
  const str = Buffer.isBuffer(text) ? text.toString('latin1') : String(text);
  let kind = null, version = null, tail = null, extra = null, section = '';
  const groups = [[], [], []], pits = [], cars = [];
  for (const raw of str.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    if (line[0] === '[') { const e = line.indexOf(']'); section = line.slice(1, e < 0 ? line.length : e).trim().toUpperCase(); continue; }
    if (/^cam(\s|$)/i.test(line)) {
      const kv = {};
      for (const tok of line.slice(3).trim().split(/\s+/)) { const e = tok.indexOf('='); if (e > 0) kv[tok.slice(0, e).toLowerCase()] = tok.slice(e + 1); }
      const nums = (keys, what) => keys.map(k => { if (!(k in kv)) throw new Error('a ' + what + ' camera lacks ' + k); return Math.fround(parseFloat(kv[k]) || 0); });
      if (section === 'CAR') { cars.push(nums(CAM_KEYS, 'car')); continue; }
      if (section === 'PIT') { if (pits.length >= 2) throw new Error('more than 2 pit cameras'); pits.push(nums(CAM_KEYS, 'pit')); continue; }
      const g = GROUP_NAMES.indexOf(section);
      if (g < 0) throw new Error('a camera outside [TV1] / [TV2] / [SPECTATOR]');
      const f = Float32Array.from(nums(TV_KEYS, 'TV'));
      if (!('type' in kv)) throw new Error('a TV camera lacks type');
      if (groups[g].length < MAX_CAMS) groups[g].push({ f, fixed: (parseInt(kv.type, 10) || 0) & 0xff });
      continue;
    }
    const e = line.indexOf('='); if (e < 0) continue;
    const k = line.slice(0, e).trim().toLowerCase(), v = line.slice(e + 1).trim();
    if (k === 'kind') kind = v.toLowerCase() === 'track' ? 'track' : 'car';
    else if (k === 'version') version = parseInt(v, 10) || 0;
    else if (k === 'tail') tail = hex(v);
    else if (k === 'extra') extra = hex(v);
  }
  if (!kind) throw new Error('no kind line');
  if (kind === 'car') {
    if (cars.length !== 6) throw new Error('a car set needs 6 cameras');
    const head = Buffer.alloc(12); head.writeUInt32LE(MACC, 0); head.writeUInt32LE(version || 0, 4); head.writeUInt32LE(0xD8, 8);
    return { kind, set: { cams: cars, head, extra: extra && extra.length ? extra : Buffer.from([0]) } };
  }
  if (!tail || tail.length !== TAIL) throw new Error('the tail is not 16 bytes');
  if (pits.length !== 2) throw new Error('a track set needs exactly 2 pit cameras');
  const pit = Buffer.alloc(2 * PIT); pits.forEach((c, i) => c.forEach((v, k) => pit.writeFloatLE(v, i * PIT + k * 4)));
  return { kind, set: { groups, pit, tail, extra: extra || Buffer.alloc(0) } };
}
const num = (v) => { const x = Math.fround(v); return Number.isFinite(x) ? String(+x.toPrecision(9)) : '0'; };
function writeText(kind, set) {
  const out = ['# RaceVision camera set', 'kind=' + (kind === 'track' ? 'track' : 'car')];
  if (kind === 'track') {
    out.push('version=2');
    set.groups.forEach((g, gi) => { out.push('', '[' + GROUP_NAMES[gi] + ']'); for (const r of g) out.push('cam ' + TV_KEYS.map((k, i) => k + '=' + num(r.f[i])).join(' ') + ' type=' + r.fixed); });
    out.push('', '[PIT]');
    for (let i = 0; i < 2; i++) out.push('cam ' + CAM_KEYS.map((k, j) => k + '=' + num(set.pit.readFloatLE(i * PIT + j * 4))).join(' '));
    out.push('', 'tail=' + set.tail.toString('hex'));
    if (set.extra && set.extra.length) out.push('extra=' + set.extra.toString('hex'));
  } else {
    out.push('version=' + (set.head && set.head.length === 12 ? set.head.readUInt32LE(4) : 0), '', '[CAR]');
    for (const c of set.cams) out.push('cam ' + CAM_KEYS.map((k, j) => k + '=' + num(c[j])).join(' '));
    if (set.extra && set.extra.length) out.push('', 'extra=' + set.extra.toString('hex'));
  }
  return out.join('\r\n') + '\r\n';
}
// a set file of either form -> the set (throws if it is the other kind)
function parseAny(kind, buf) {
  if (isBinary(buf)) return kind === 'track' ? parseTrack(buf) : parseCar(buf);
  const r = parseText(buf), want = kind === 'track' ? 'track' : 'car';     // the camera sets call a car set 'series'
  if (r.kind !== want) throw new Error('this is a ' + r.kind + ' set');
  return r.set;
}

// RaceVision's recipes: name, kind, title, what it says, how it is made from the game's own set
const RECIPES = [
  { name: 'tv tight', kind: 'track', title: 'Tight', desc: 'TV1 / TV2: a lens about a third tighter (x 0.7) - the car fills more of the picture.', make: t => scaleLens(t, 0.7) },
  { name: 'tv wide', kind: 'track', title: 'Wide', desc: 'TV1 / TV2: a lens about a third wider (x 1.4) - more of the pack in shot.', make: t => scaleLens(t, 1.4) },
  { name: 'tv more cuts', kind: 'track', title: 'More Cuts', desc: "TV1 also gets TV2's following cameras: about twice the cameras, so the picture cuts like a TV broadcast does.", make: moreCuts },
  { name: 'tv more cuts tight', kind: 'track', title: 'More Cuts Tight', desc: 'More cuts, and the tighter lens.', make: t => scaleLens(moreCuts(t), 0.7) },
  { name: 'tv onboard', kind: 'series', title: 'Door and Roof Onboard', desc: 'Onboards that show the car: right side = door cam high on the right of the car, turned in so the door, hood and right front tyre are in the picture; left side = roof cam on the front of the roof looking back down the roof and rear deck at the cars behind.', make: tvOnboard },
  { name: 'tv onboard + nose', kind: 'series', title: 'Door, Roof and Nose Onboard', desc: 'TV onboards, and the front bumper camera turned round: on the nose looking back up the hood at the windshield and the driver.', make: tvOnboardNose },
  { name: 'external', kind: 'series', title: 'Outside Chase', desc: 'Outside the car, fixed to it (it moves with the car, like a TV car-to-car shot): right side = low front quarter on the right, looking back at the car; left side = rear quarter on the left, higher, looking forward at it.', make: external },
  { name: 'external 2', kind: 'series', title: 'Broadside and Head-On', desc: 'Outside the car, fixed to it: right side = broadside from 5.5 m off the right, left side = head-on from 6 m ahead, low (the car coming at the lens).', make: external2 },
  { name: 'mix', kind: 'series', title: 'Mixed Onboard', desc: 'One of each: right side = TV door cam, left side = low front quarter outside the car (looking back at it).', make: mix },
];
// titles RaceVision gives sets found in its camsets folder
const TITLES = { 'tv onboard + roof fwd test': 'Roof Forward Onboard', broadcast: 'Broadcast Onboard', 'broadcast tight': 'Broadcast Onboard Tight' };
for (const r of RECIPES) TITLES[r.name] = r.title;
// the title RaceVision shows for a set: "RaceVision's [Short Track | Intermediate | Large Oval | Superspeedway ]<name> Set" (a track's
// class from its length: under 1400 m, 2900 m, 3700 m), "Borrowed Cameras (<track>)" for a "tv from <track>" set
function setTitle(name, kind, trackLen) {
  if (!name || name === 'stock') return "The game's own";
  let t = TITLES[String(name).toLowerCase()];
  if (!t && /^tv from ./i.test(name)) t = 'Borrowed Cameras (' + name.slice(8) + ')';
  if (!t) t = String(name).replace(/(^|\s)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  const L = Number(trackLen) || 0;
  const cls = kind === 'track' && L > 0 ? (L < 1400 ? 'Short Track ' : L < 2900 ? 'Intermediate ' : L < 3700 ? 'Large Oval ' : 'Superspeedway ') : '';
  return "RaceVision's " + cls + t + ' Set';
}
const setDesc = (name) => /^tv from ./i.test(name || '') ? 'TV cameras borrowed from another version of the track.' : '';

module.exports = {
  A, REC, GROUPS, MAX_CAMS, GROUP_STRIDE, PIT, TAIL, RECIPES, TITLES, TV_KEYS, CAM_KEYS, setTitle, setDesc,
  isBinary, parseText, writeText, parseAny,
  parseTrack, writeTrack, trackTables, trackFromTables, cloneTrack, scaleLens, moreCuts,
  parseCar, writeCar, carBytes, carFromBytes, cloneCar, tvOnboard, tvOnboardNose, external, external2, mix,
};
