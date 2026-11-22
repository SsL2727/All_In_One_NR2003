// Port of RaceControl 1.2.0's QualTiming: follows every qualifying car round the lap (position trace, lap start from the
// game's own crossing stamps) so the TV timing box can show a live gap to pole at the same point of the lap.
// Float arithmetic follows the original (single precision where the C# used float).
'use strict';
const { gameSeconds } = require('./gamemath');

const fr = Math.fround;
const Block0 = 11323952, Cross0 = 7862678, Stride = 8724, StateOff = 5031, PosX = 6622;
const FocusPtr = 12610019, Rec0 = 12656688, RecSize = 5560;
const OnTrack = new Set([7736620, 7736828]);
const InLap = new Set([7737160, 7737208]);

const roundEven = (x) => { const f = Math.floor(x), d = x - f; if (d > 0.5) return f + 1; if (d < 0.5) return f; return (f % 2 === 0) ? f : f + 1; };

class CarT {
  constructor() {
    this.LastCross = 0; this.LapStart = -1; this.X = []; this.Y = []; this.T = [];
    this.BestX = null; this.BestY = null; this.BestT = null; this.BestMs = 0; this.LastLapMs = 0; this.LastLapAt = 0;
    this.State = 0; this.NextIdx = 0; this.PX = 0; this.PY = 0; this.HavePos = false; this.Path = 0; this.Match = -1;
  }
}

class QualTiming {
  // opts.now() -> ms since epoch (the wall clock used for LastLapAt)
  constructor(opts) {
    this.now = (opts && opts.now) || (() => Date.now());
    this.cars = new Map();
    this.refX = null; this.refY = null; this.refT = null; this.refMs = 0;
    this.NowMs = 0; this.TrackLen = 0;
  }

  get All() { return this.cars; }

  Reset() { this.cars.clear(); this.TrackLen = 0; this.refX = null; this.refY = null; this.refT = null; this.refMs = 0; }

  Of(c) { return this.cars.get(c) || null; }

  static GameMs(m) { return roundEven(gameSeconds(m) * 1000.0) | 0; }

  Update(m, slots) {
    this.NowMs = QualTiming.GameMs(m);
    for (const slot of slots) {
      let v = this.cars.get(slot);
      if (!v) { v = new CarT(); this.cars.set(slot, v); }
      const b = Block0 + slot * Stride;
      v.State = m.U32(b + StateOff);
      const x = m.F32(b + PosX), y = m.F32(b + PosX + 4);
      let step = v.HavePos ? fr(Math.sqrt(fr(fr(fr(x - v.PX) * fr(x - v.PX)) + fr(fr(y - v.PY) * fr(y - v.PY))))) : 0;
      if (!(step >= 0) || !(step < 2000)) step = 0;
      v.PX = x; v.PY = y; v.HavePos = true;
      const c0 = Cross0 + slot * 2048;
      while (v.NextIdx < 512 && m.U32(c0 + v.NextIdx * 4) !== 0) v.NextIdx++;
      while (v.NextIdx > 0 && m.U32(c0 + (v.NextIdx - 1) * 4) === 0) v.NextIdx--;
      const last = v.NextIdx > 0 ? (m.U32(c0 + (v.NextIdx - 1) * 4) & 0xFFFFFFF) >>> 0 : 0;
      const onTrack = OnTrack.has(v.State);
      if (last !== 0 && last !== v.LastCross) {
        if (this.TrackLen <= 0 && onTrack && v.LapStart < 0 && v.Path > 100.0) this.TrackLen = fr(v.Path);
        if (v.LapStart >= 0 && v.LastCross !== 0) {
          const lap = (last | 0) - v.LapStart;
          if (lap > 5000 && lap < 400000) {
            if (v.Path > 100.0) this.TrackLen = fr(v.Path);
            v.LastLapMs = lap; v.LastLapAt = this.now();
            if (v.X.length > 10) {
              v.X.push(x); v.Y.push(y); v.T.push(lap);
              if (v.BestMs === 0 || lap < v.BestMs) { v.BestMs = lap; v.BestX = v.X.slice(); v.BestY = v.Y.slice(); v.BestT = v.T.slice(); }
              if (this.refMs === 0 || lap < this.refMs) { this.refMs = lap; this.refX = v.X.slice(); this.refY = v.Y.slice(); this.refT = v.T.slice(); }
            }
          }
        }
        v.LapStart = onTrack ? (last | 0) : -1;
        v.X = []; v.Y = []; v.T = []; v.Path = 0; v.Match = -1; v.LastCross = last;
        if (v.LapStart >= 0) { v.X.push(x); v.Y.push(y); v.T.push(Math.max(0, this.NowMs - v.LapStart)); }
      } else if (!onTrack) {
        v.LapStart = -1; v.X = []; v.Y = []; v.T = []; v.Path = 0;
      } else if (v.LapStart < 0) {
        v.Path += step;
      } else {
        v.Path += step;
        if (step > 0.5 && v.X.length < 30000) { v.X.push(x); v.Y.push(y); v.T.push(this.NowMs - v.LapStart); }
      }
    }
  }

  Elapsed(car) { const c = this.Of(car); return (c && c.LapStart >= 0) ? Math.max(0, this.NowMs - c.LapStart) : -1; }

  // -> delta in ms, or null
  Delta(car, pole, poleMs) {
    const c = this.Of(car);
    if (!c || c.LapStart < 0 || pole < 0 || poleMs <= 0) return null;
    const elapsed = this.NowMs - c.LapStart;
    if (elapsed < 1500) return null;
    const p = this.Of(pole);
    let bx, by, bt, scale;
    if (p && p.BestX && Math.abs(p.BestMs - poleMs) <= 5) { bx = p.BestX; by = p.BestY; bt = p.BestT; scale = 1.0; }
    else {
      if (!this.refX || this.refMs <= 0) return null;
      bx = this.refX; by = this.refY; bt = this.refT; scale = poleMs / this.refMs;
    }
    const n = bx.length;
    let lo, hi;
    if (c.Match < 0) { lo = 0; hi = Math.min(n - 1, Math.trunc(n / 3)); }
    else { lo = Math.max(0, c.Match - 5); hi = Math.min(n - 1, c.Match + 80); }
    let best = -1, bestD = Number.MAX_VALUE;
    for (let i = lo; i <= hi; i++) {
      const dx = fr(bx[i] - c.PX), dy = fr(by[i] - c.PY);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD > 3600.0) { c.Match = -1; return null; }
    c.Match = best;
    let i0 = best, i1 = best, frac = 0.0;
    if (best + 1 < n) {
      const pr = this._proj(bx, by, best, best + 1, c.PX, c.PY);
      if (pr >= 0.0) { i1 = best + 1; frac = Math.min(1.0, pr); }
    }
    if (i0 === i1 && best > 0) {
      i0 = best - 1;
      frac = Math.max(0.0, Math.min(1.0, this._proj(bx, by, best - 1, best, c.PX, c.PY)));
    }
    const at = (bt[i0] + frac * (bt[i1] - bt[i0])) * scale;
    return roundEven(elapsed - at) | 0;
  }

  _proj(X, Y, i, j, x, y) {
    const dx = fr(X[j] - X[i]), dy = fr(Y[j] - Y[i]);
    const len2 = dx * dx + dy * dy;
    if (len2 < 1E-06) return 0.0;
    return (fr(x - X[i]) * dx + fr(y - Y[i]) * dy) / len2;
  }

  // the car on TV (focus pointer into the game's camera record table), -1 if none
  static Focus(m) {
    const p = m.U32(FocusPtr);
    if (p < Rec0 || (p - Rec0) % RecSize !== 0) return -1;
    const n = (p - Rec0) / RecSize;
    return (n < 0 || n >= 44) ? -1 : n;
  }
}

QualTiming.InLap = InLap;
module.exports = { QualTiming, CarT, roundEven };
