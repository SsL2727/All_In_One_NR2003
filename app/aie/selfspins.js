// AI Enhanced "Self Spins" (FUN_004465c0 / FUN_004468b0). Every so often one AI car that is on the track, on its own (nobody within 3 m) and
// on a bend (the race line has curvature there) is picked; for 88 ticks the curvature of the race-line point 4 ahead of it is flattened
// (8 ticks), amplified in its own direction (40 ticks, x3..18) and then reversed (40 ticks, x2..3), which throws the car round. Ported from
// the decompile, not checked against the live program.
//
// opts: { chance } (percent-ish; the odds per pick are candidates x chance / 10000)
'use strict';

const NCARS = 44, PLAYER = 43, CELL = 3.0, LIFE = 0x58;

class SelfSpins {
  constructor(rnd) { this.rnd = rnd || Math.random; this.events = []; this.countdown = 0; this.started = false; }
  reset() { this.events = []; this.countdown = 0; this.started = false; }

  _interval(base) { return Math.max(1, Math.round((this.rnd() + 0.5) * Math.max(1, base))); }

  // cars[i] = { dlong, dlat, speed } | null ; lines = { race, minrace, maxrace } ; ctx = { trackLen }; opts = { chance }
  // -> { sets: [{ point, value }] } absolute new values for field 2 of race-line points
  step(cars, lines, opts, ctx) {
    const out = { sets: [] };
    const n = lines && lines.race ? Math.min(lines.race.count, lines.minrace.count, lines.maxrace.count) : 0;
    if (!n) return out;
    const chance = typeof opts.chance === 'number' ? opts.chance : 20;
    const L = ctx.trackLen > 0 ? ctx.trackLen : 2160;
    const base = Math.max(1, Math.round(L * 40 / 36));
    const dl = (i) => (cars[i] ? cars[i].dlong || 0 : 0), dt = (i) => (cars[i] ? cars[i].dlat || 0 : 0), sp = (i) => (cars[i] ? cars[i].speed || 0 : 0);
    const wrap = (d) => { if (ctx.trackLen > 0) { if (d > ctx.trackLen * 0.5) d -= ctx.trackLen; if (d < -ctx.trackLen * 0.5) d += ctx.trackLen; } return d; };
    const point = (d) => Math.min(n - 1, Math.max(0, Math.floor(d / CELL)));
    const alone = (c) => { for (let k = 0; k < NCARS; k++) if (k !== c && (k === PLAYER || sp(k) > 0) && Math.abs(wrap(dl(k) - dl(c))) <= CELL) return false; return true; };

    if (!this.started) { this.started = true; this.countdown = this._interval(base); }
    if (--this.countdown < 1) {
      this.countdown = this._interval(base);
      this._pick(cars, lines, n, chance, dl, dt, sp, alone, point);
    }
    for (const e of this.events) {
      if (!(sp(e.car) > 0)) { e.age = LIFE; continue; }
      if (alone(e.car)) {
        const p = (point(dl(e.car)) + 4) % n;
        const cur = lines.race.rec[p * 7 + 2];
        if (e.age < 8) out.sets.push({ point: p, value: 0 });
        else {
          const first = e.age - 8 < 40;
          out.sets.push({ point: p, value: Math.abs(cur) * (first ? e.sign : -e.sign) * (first ? e.a : e.b) });
        }
      }
      e.age++;
    }
    this.events = this.events.filter((e) => e.age < LIFE);
    return out;
  }

  _pick(cars, lines, n, chance, dl, dt, sp, alone, point) {
    const cand = [];
    for (let i = 0; i < 43; i++) {
      if (!(sp(i) > 0)) continue;
      const k = point(dl(i));
      const a = lines.minrace.rec[k * 7 + 3], b = lines.maxrace.rec[k * 7 + 3];
      if (Math.min(a, b) - 1 <= dt(i) && dt(i) <= Math.max(a, b) + 1) cand.push(i);
    }
    if (!cand.length) return;
    const p = Math.min(1, Math.max(0, cand.length * chance / 10000));
    if (!(this.rnd() < p)) return;
    const free = cand.filter((i) => !this.events.some((e) => e.car === i));
    if (!free.length) return;
    const car = free[Math.min(free.length - 1, Math.floor(this.rnd() * free.length))];
    if (!alone(car)) return;
    const curv = lines.race.rec[((point(dl(car)) + 1) % n) * 7 + 2];
    if (curv === 0) return;
    this.events.push({ car, sign: curv > 0 ? 1 : -1, a: this.rnd() * 15 + 3, b: this.rnd() + 2, age: 0 });
  }
}

module.exports = { SelfSpins };
