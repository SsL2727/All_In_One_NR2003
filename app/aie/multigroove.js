// AI Enhanced "MultiGroove" (inline in its tick). Every AI car gets its own lateral groove: the game's race line is rewritten, a few points at
// a time, to a line between the two bound lines (left_bound / right_bound: minrace, maxrace or race), each car with its own random
// fraction. Checked against the real AI Enhanced: window, fraction, spacing and lane rules below match its writes.
//
//   * the line starts every tick as the midpoint of the two bound lines (the other fields stay the race line's)
//   * a car that moved since last tick and has no car within 7 m in front or behind, and is between minrace and maxrace at its spot,
//     paints the 3 points around ceil(dlong / 3): every field = right + (left - right) * its fraction
//   * AI Enhanced stops painting (and puts the original line back) while the PACE CAR is between minrace and maxrace: that is its caution
//     test (FUN_0044d3e0 reads 0xC08B14, RaceControl's car 1), done by the service. Pausing while YOU are in the lane is a All In One NR2003 option
//     (pauseForPlayer, off by default); the earlier "player" reading came from feeding that pace-car record in the oracle runs
'use strict';

const REC = 28;                 // bytes per lap point in the game: 7 floats
const NCARS = 44;
const CELL = 3.0, SPACING = 7.0;
const BOUND = { minrace: 0, maxrace: 1, race: 2 };

// a car's fraction: smooth S-shaped random number in 0..1 (AI Enhanced: u < .5 ? .5 (2u)^2 : 1 - .5 (2(1-u))^2)
const shape = (u) => (u < 0.5 ? 0.5 * (2 * u) ** 2 : 1 - 0.5 * (2 * (1 - u)) ** 2);

class MultiGroove {
  // rnd: () => 0..1 (injectable for tests)
  constructor(rnd) {
    this.rnd = rnd || Math.random;
    this.fracs = Array.from({ length: NCARS }, () => shape(this.rnd()));
    this.cache = new Array(NCARS).fill(0);
    this.work = null;
  }

  // lines: { race, minrace, maxrace } each { count, rec: Float32Array(count*7), orig: Buffer } ; opts: { left, right } names
  // cars[i] = { dlong, dlat } | null ; player = { dlong, dlat } | null
  // -> { restore: true } while the player is in the lane, else { write: Buffer } with the new race line bytes
  step(lines, cars, player, opts) {
    const L = lines[opts.left] || lines.race, Rt = lines[opts.right] || lines.minrace;
    const spread = Number.isFinite(opts.spread) ? Math.min(1, Math.max(0, opts.spread)) : 1;
    const n = Math.min(lines.race.count, lines.minrace.count, lines.maxrace.count, L.count, Rt.count);
    const mn = lines.minrace, mx = lines.maxrace;
    const laneAt = (dlong) => {
      const k = Math.min(mn.count - 1, Math.max(0, Math.ceil(dlong / CELL)));
      const a = mn.rec[k * 7 + 3], b = mx.rec[k * 7 + 3];
      return [Math.min(a, b), Math.max(a, b)];
    };
    if (opts.pauseForPlayer !== false && player && Number.isFinite(player.dlong) && Number.isFinite(player.dlat)) {
      const [lo, hi] = laneAt(player.dlong);
      if (lo < player.dlat && player.dlat < hi) return { restore: true };
    }
    // work line: the race line with the lateral column at the midpoint of the two bound lines
    const W = new Float32Array(lines.race.rec);
    for (let i = 0; i < n; i++) W[i * 7 + 3] = (L.rec[i * 7 + 3] + Rt.rec[i * 7 + 3]) * 0.5;
    const spacing = SPACING;        // always 7 m in AI Enhanced's painter; its Spread Cars option is the two INI values (the service sets them)
    const idx = [];
    for (let i = 0; i < NCARS; i++) idx.push(i);
    const dl = (i) => (cars[i] && Number.isFinite(cars[i].dlong) ? cars[i].dlong : 0);
    idx.sort((a, b) => dl(a) - dl(b) || a - b);
    for (let r = 0; r < NCARS; r++) {
      const c = idx[r], d = dl(c);
      if (d === this.cache[c]) continue;
      this.cache[c] = d;
      const behind = r === 0 ? Infinity : d - dl(idx[r - 1]);
      const ahead = r < NCARS - 1 ? dl(idx[r + 1]) - d : Infinity;
      if (!(behind >= spacing && ahead >= spacing) || c === NCARS - 1 || !cars[c]) continue;
      const cell = Math.ceil(d / CELL);
      const lo = Math.max(0, cell - 1), hi = Math.min(cell + 1, n - 1);
      const [llo, lhi] = laneAt(d);
      const lat = cars[c].dlat;
      if (!(llo <= lat && lat <= lhi)) continue;
      const f = (1 - spread) / 2 + this.fracs[c] * spread;
      for (let p = lo; p <= hi; p++) for (let k = 0; k < 7; k++) { const b = Rt.rec[p * 7 + k]; W[p * 7 + k] = b + (L.rec[p * 7 + k] - b) * f; }
    }
    this.work = W;
    return { write: Buffer.from(W.buffer, W.byteOffset, n * REC) };
  }
}

module.exports = { MultiGroove, shape, BOUND, REC };
