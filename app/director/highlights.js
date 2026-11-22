// RaceVision 2.0 highlights besides crashes (racevision_highlights.cpp), few and far between:
//   multi    one car by multi_pass_cars cars or more in ONE corner or ONE straight (superspeedways: last lap only)
//   pass     a last-lap pass for a podium position
//   bump     a bump and run: the nose of the car behind on the tail of the one ahead (front / rear damage), then by it within
//            bump_run_window s, no crash
//   finish   the winner crossing the line, and the runner-up when it is close
// Passes, multi-passes and bump and runs: at most one every highlight_gap game s (the better one stays), the last lap excepted.
// They go into the crash log as records with a `kind` (ids from 1001), so the Replays list, the phone, the reel and the tape take
// them as they take crashes. Nothing goes on air by itself except the finish (replay_finish). Passes use the live order on track
// between cars on the same lap; the position they are for is the official one.
'use strict';

const HB = 240;                         // bins a lap for learning the corners
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

class Highlights {
  // S: () => resolved settings; log(msg)
  constructor(S, log) { this.S = S; this.log = log || (() => {}); this.seq = 1000; this.reset(); }
  reset() {
    this.pairs = new Map(); this.groups = new Map(); this.contacts = []; this.prevZ = new Map();
    this.fin = { winner: -1, second: -1, id: -1, prevLaps: -1, at: -1, real: -1 };
    this.hbX = new Float64Array(HB); this.hbY = new Float64Array(HB); this.hbN = new Int32Array(HB); this.hbSeg = new Int32Array(HB).fill(-1);
    this.hbOk = false; this.hbBuiltAt = -100; this.track = '';
  }

  // ---- corners and straights: the direction of travel against lap distance, learnt from the cars
  _bin(d, L) { const k = Math.floor(d / Math.max(L, 400) * HB); return ((k % HB) + HB) % HB; }
  _build(L) {
    let have = 0;
    for (let k = 0; k < HB; k++) if (this.hbN[k] >= 3) have++;
    if (have < Math.floor(HB * 9 / 10)) { this.hbOk = false; return; }
    const bin = Math.max(L, 400) / HB, ang = new Float64Array(HB);
    let last = 0, any = false;
    for (let k = 0; k < HB; k++) { if (this.hbN[k] >= 3) { last = Math.atan2(this.hbY[k], this.hbX[k]); any = true; } ang[k] = last; }
    if (!any) return;
    const w = Math.max(1, Math.round(30 / bin)), corner = new Int32Array(HB);
    for (let k = 0; k < HB; k++) corner[k] = Math.abs(wrap(ang[(k + w) % HB] - ang[(k - w + HB) % HB])) / (2 * w * bin) > 1 / 700 ? 1 : 0;
    const minLen = Math.max(2, Math.floor(HB / 20));
    for (let pass = 0; pass < 20; pass++) {          // short runs take their neighbours' kind
      let start = 0;
      while (start < HB && corner[start] === corner[(start + HB - 1) % HB]) start++;
      if (start >= HB) break;
      let changed = false;
      for (let k = 0, n = 0; k < HB; k += n) {
        const a = (start + k) % HB; n = 1;
        while (k + n < HB && corner[(start + k + n) % HB] === corner[a]) n++;
        if (n < minLen) { for (let m = 0; m < n; m++) corner[(start + k + m) % HB] ^= 1; changed = true; break; }
      }
      if (!changed) break;
    }
    let start = 0;
    while (start < HB && corner[start] === corner[(start + HB - 1) % HB]) start++;
    let seg = 0;
    for (let k = 0; k < HB; k++) {
      const a = (start + k) % HB;
      if (k > 0 && corner[a] !== corner[(a + HB - 1) % HB]) seg++;
      this.hbSeg[a] = start >= HB ? 0 : seg;
    }
    this.hbOk = true;
  }
  _sample(f, now) {
    const L = f.trackLen;
    for (const c of f.order) {
      if (c.pit || c.speed < 20 || !Number.isFinite(c.head)) continue;
      const k = this._bin(c.dlong, L);
      if (this.hbN[k] >= 400) continue;
      this.hbX[k] += Math.cos(c.head); this.hbY[k] += Math.sin(c.head); this.hbN[k]++;
    }
    if (now - this.hbBuiltAt > 10) { this.hbBuiltAt = now; this._build(L); }
  }
  segAt(d, L) {
    L = Math.max(L, 400);
    if (this.hbOk) return this.hbSeg[this._bin(d, L)];
    return 1000 + Math.floor((((d % L) + L) % L) / (L / 8));
  }
  superspeedway(track) {
    const t = String(track || '').toLowerCase();
    return String(this.S().superspeedways || 'daytona; talladega').toLowerCase().split(/[;,]/).map(s => s.trim()).filter(Boolean).some(x => t.includes(x));
  }

  // ---- the records
  _add(log, kind, car, other, at, end, score, what, lap, lastLap) {
    const S = this.S(), passKind = kind === 'pass' || kind === 'multi' || kind === 'bump';
    if (passKind && !lastLap && S.highlight_gap > 0) {
      const i = log.crashes.findIndex(h => (h.kind === 'pass' || h.kind === 'multi' || h.kind === 'bump') && Math.abs(h.t0 - at) < S.highlight_gap && !h.lastLap);
      if (i >= 0) {
        const h = log.crashes[i];
        if (h.replays > 0 || h.score >= score) return -1;
        this.log(`highlight #${h.id} dropped: ${what} is better`);
        log.crashes.splice(i, 1);
      }
    }
    const cars = new Map();
    const put = (c) => { if (c) cars.set(c.slot, { slot: c.slot, num: c.num, name: c.name, hit: 0, hitAt: at, total: 0 }); };
    put(car); if (other && (!car || other.slot !== car.slot)) put(other);
    const h = { id: ++this.seq, kind, what, t0: at, last: end, impactAt: at, impactCar: car ? car.slot : -1, other: other ? other.slot : -1, lap, lastLap: !!lastLap,
      cars, score, over: true, overAt: end, replays: 0, when: Date.now() };
    const hs = log.crashes.filter(x => x.kind);
    if (hs.length >= 60) log.crashes.splice(log.crashes.indexOf(hs[0]), 1);
    log.crashes.push(h);
    this.log(`HIGHLIGHT #${h.id} ${kind}, lap ${lap}: ${what} - ${[...cars.values()].map(m => '#' + m.num).join(' ')}, worth ${score.toFixed(1)}`);
    return h.id;
  }

  // ---- each update (race sessions): contacts, who got by whom on track, passes by corner / straight, the finish
  // f: the ranked field (cars with .head, .dmgZ, .pos), g: game seconds, log: the CrashLog, race: { lapsTotal, inRace }
  update(f, g, log, race) {
    const S = this.S();
    if (!f || !f.order || !race || !race.inRace) return;
    if (f.track !== this.track) { this.reset(); this.track = f.track; }
    const now = Date.now() / 1000, L = Math.max(f.trackLen || 0, 400), cars = new Map(f.order.map(c => [c.slot, c]));
    this._sample(f, now);
    this._contacts(f, g, cars);
    if (!Number(S.highlights)) return;
    const leaderLaps = f.order.length ? f.order[0].laps : 0, lapsTotal = race.lapsTotal || 0;
    const prog = (c) => c.laps * L + c.dlong;
    const ahead = (a, b) => prog(a) - prog(b);
    const lastLap = (c) => lapsTotal > 0 && leaderLaps >= lapsTotal - 1 && c.laps === lapsTotal - 1;
    const green = !!f.green;
    const list = f.order.filter(c => !c.pace);
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const A = list[x].slot < list[y].slot ? list[x] : list[y], B = A === list[x] ? list[y] : list[x];
      const key = A.slot * 64 + B.slot;
      let p = this.pairs.get(key) || { side: 0, cand: 0, candAt: -1, seen: -1 };
      if (p.seen >= 0 && (g - p.seen > 2 || g < p.seen)) p = { side: 0, cand: 0, candAt: -1, seen: -1 };
      const d = ahead(A, B);
      const ok = green && !A.pit && !B.pit && A.speed > 20 && B.speed > 20 && Math.abs(d) < L / 2;
      if (!ok || Math.abs(d) > 80) { this.pairs.delete(key); continue; }
      p.seen = g;
      if (Math.abs(d) > 40) { p.cand = 0; this.pairs.set(key, p); continue; }
      const s = d > 1 ? 1 : d < -1 ? -1 : 0;
      if (s === 0 || s === p.side) { p.cand = 0; this.pairs.set(key, p); continue; }
      if (p.cand !== s) { p.cand = s; p.candAt = g; this.pairs.set(key, p); continue; }
      if (g - p.candAt < 1.5) { this.pairs.set(key, p); continue; }
      const was = p.side;
      p.side = s; p.cand = 0; this.pairs.set(key, p);
      if (!was) continue;                          // the first look at these two: no pass, just where they are
      const by = s > 0 ? A : B, of = s > 0 ? B : A;
      if (of.speed < 0.85 * by.speed) continue;    // the one passed is slowing (trouble, pit road): not a pass
      this._overtake(by, of, p.candAt, g, L, leaderLaps, lastLap(by), log, cars);
    }
    for (const [slot, gr] of this.groups) {        // out of that corner / straight: the last pass in it has had time to show
      const c = cars.get(slot);
      const moved = !c || this.segAt(c.dlong, L) !== gr.seg;
      if ((moved && g - gr.last > 2) || g - gr.passes[0].t > 15 || g < gr.last) this._close(slot, log, cars, f, L);
    }
    this._finish(f, g, log, lapsTotal, leaderLaps);
  }

  // the cars' damage zones: a hit on the nose of one car near the tail of another (bump and run). Per panel 0..1, as the game keeps them
  _contacts(f, g, cars) {
    const S = this.S(), L = Math.max(f.trackLen || 0, 400);
    for (const c of f.order) {
      if (!c.dmgZ) continue;
      const before = this.prevZ.get(c.slot);
      this.prevZ.set(c.slot, c.dmgZ.slice());
      if (!before) continue;
      const rear = Math.max(0, c.dmgZ[0] - before[0]), front = Math.max(0, c.dmgZ[1] - before[1]);
      const gain = (c.dmgZ.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0)) * 10;      // All In One NR2003's damage scale
      if (!(gain > 0.005) || gain > 50) continue;
      let near = null, best = 15;
      for (const o of f.order) { if (o.slot === c.slot || o.pace) continue; const d = Math.abs((o.laps * L + o.dlong) - (c.laps * L + c.dlong)); if (d < best) { best = d; near = o; } }
      const last = this.contacts.find(k => k.car === c.slot && k.nearCar === (near ? near.slot : -1) && g - k.end < 1);
      if (last) { last.end = g; last.front += front; last.rear += rear; last.gain += gain; if (gain > last.peak) { last.peak = gain; last.peakAt = g; } }
      else this.contacts.push({ car: c.slot, nearCar: near ? near.slot : -1, front, rear, gain, start: g, end: g, peak: gain, peakAt: g, used: false });
    }
    this.contacts = this.contacts.filter(k => g - k.end < 30);
    void S; void cars;
  }

  _inCrash(log, slot, t) { return log.crashes.some(x => !x.kind && x.t0 < t + 12 && x.last > t - 12 && x.cars.has(slot)); }
  _holds(o, log, cars) {
    const v = cars.get(o.of.slot);
    if (!v || v.pit) return false;
    return !this._inCrash(log, o.of.slot, o.t) && !this._inCrash(log, o.by.slot, o.t);
  }
  _bumpBefore(o) {
    const S = this.S();
    let best = null;
    for (const ct of this.contacts) {
      if (ct.used || ct.gain >= S.crash_damage || ct.end < o.t - S.bump_run_window || ct.start > o.t + 0.5) continue;
      const nose = ct.car === o.by.slot && ct.nearCar === o.of.slot && ct.front > 0.0005;
      const tail = ct.car === o.of.slot && ct.nearCar === o.by.slot && ct.rear > 0.0005;
      if ((nose || tail) && (!best || ct.peak > best.peak)) best = ct;
    }
    return best;
  }
  _overtake(by, of, t, g, L, leaderLaps, lastLap, log, cars) {
    const pa = by.pos, pb = of.pos;
    const where = by.dlong - by.speed * (g - t);
    const o = { t, by, of, pos: pa > 0 && pb > 0 ? Math.min(pa, pb) : Math.max(pa, pb), lap: leaderLaps, seg: this.segAt(where, L), lastLap };
    if (o.pos > 0 && o.pos <= 5) this.log(`PASS #${by.num} gets by #${of.num} for P${o.pos}${lastLap ? ' on the last lap' : ''}`);
    let gr = this.groups.get(by.slot);
    if (gr && gr.passes.length && (o.seg !== gr.seg || t - gr.passes[0].t > 15)) { this._close(by.slot, log, cars, null, L); gr = null; }
    if (!gr) { gr = { passes: [], seg: o.seg, last: t }; this.groups.set(by.slot, gr); }
    gr.passes.push(o); gr.seg = o.seg; gr.last = t;
  }
  _close(slot, log, cars, f, L) {
    const S = this.S();
    const gr = this.groups.get(slot);
    this.groups.delete(slot);
    if (!gr) return;
    const ok = gr.passes.filter(o => this._holds(o, log, cars));
    if (!ok.length) return;
    const car = cars.get(slot);
    const prog = (c) => c.laps * L + c.dlong;
    const victims = [];
    for (const o of ok) {
      const v = cars.get(o.of.slot);
      if (car && v && !victims.includes(o.of.slot) && Math.abs(prog(car) - prog(v)) < L / 2 && prog(car) - prog(v) > 0) victims.push(o.of.slot);
    }
    const last = ok.some(o => o.lastLap);
    const posBonus = (pos) => (pos <= 0 ? 0 : pos === 1 ? 4 : pos <= 3 ? 3 : pos <= 5 ? 2 : pos <= 10 ? 1 : 0);
    const forPos = (what, pos) => (pos === 1 ? what + ' FOR THE LEAD' : pos > 0 ? what + ' FOR P' + pos : what);
    if (victims.length >= Math.max(2, S.multi_pass_cars) && (!this.superspeedway(this.track) || last)) {
      let best = 0;
      for (const o of ok) if (o.pos > 0 && (!best || o.pos < best)) best = o.pos;
      this._add(log, 'multi', ok[0].by, null, ok[0].t, ok[ok.length - 1].t, 2 * victims.length + posBonus(best), `${victims.length} CARS IN ONE MOVE`, ok[0].lap, last);
      return;
    }
    for (const o of ok) {
      if (!victims.includes(o.of.slot)) continue;           // it got back by
      const b = Number(S.highlight_bump) && o.pos > 0 && o.pos <= S.bump_run_depth ? this._bumpBefore(o) : null;
      if (b) { b.used = true; this._add(log, 'bump', o.by, o.of, Math.min(o.t, b.peakAt >= 0 ? b.peakAt : b.start), o.t, 3 + posBonus(o.pos), forPos('BUMP AND RUN', o.pos), o.lap, o.lastLap); }
      else if (o.lastLap && o.pos > 0 && o.pos <= 3) this._add(log, 'pass', o.by, o.of, o.t, o.t, 5 + posBonus(o.pos), 'LAST LAP: ' + forPos('PASS', o.pos), o.lap, true);
    }
  }

  // the finish: the winner's line crossing (seen as it happens), then the runner-up's if it comes within 10 s; the replay waits for both
  _finish(f, g, log, lapsTotal, leaderLaps) {
    const F = this.fin;
    if (lapsTotal <= 0 || !f.order.length) { F.prevLaps = -1; return; }
    const crossedAt = (c) => g - Math.min(1, c.dlong / Math.max(c.speed, 10));
    if (F.winner < 0) {
      if (F.prevLaps >= 0 && F.prevLaps < lapsTotal && leaderLaps >= lapsTotal) {
        const w = f.order[0];
        if (w.laps < lapsTotal) { F.prevLaps = leaderLaps; return; }
        F.winner = w.slot; F.at = crossedAt(w);
        F.id = this._add(log, 'finish', w, f.order[1] || null, F.at, F.at + 3, 6, 'THE WIN', lapsTotal, false);
      }
      F.prevLaps = leaderLaps;
      return;
    }
    if (F.second !== -1 || F.real >= 0) return;
    const h = log.crashes.find(x => x.id === F.id);
    if (!h) { F.real = Date.now() / 1000; return; }
    const second = f.order.find(c => c.slot !== F.winner && c.laps >= lapsTotal);
    if (!second) {
      if (g - F.at > 10) { F.second = -2; F.real = Date.now() / 1000; h.what = 'THE WIN'; }
      return;
    }
    F.second = second.slot;
    const m = Math.max(0, crossedAt(second) - F.at);
    h.what = m < 1 ? `WINS BY ${m.toFixed(3)} S` : `WINS BY ${m.toFixed(1)} S`;
    h.other = second.slot;
    for (const k of [...h.cars.keys()]) if (k !== F.winner) h.cars.delete(k);
    h.cars.set(second.slot, { slot: second.slot, num: second.num, name: second.name, hit: 0, hitAt: F.at, total: 0 });
    h.score = 6 + (m < 0.1 ? 4 : m < 0.5 ? 2.5 : m < 1.5 ? 1 : 0);
    if (m < 4) h.last = Math.max(h.last, F.at + m + 1.5);
    F.real = Date.now() / 1000;
    this.log(`HIGHLIGHT #${h.id} finish: ${h.what} - #${(f.order.find(c => c.slot === F.winner) || {}).num}, #${second.num} second`);
  }
  // the finish replay is due: settled, not replayed yet, replay_finish_after s on
  finishDue(log) {
    const S = this.S(), F = this.fin;
    if (!Number(S.replay_finish) || !Number(S.highlights) || F.id < 0 || F.real < 0 || Date.now() / 1000 - F.real < S.replay_finish_after) return null;
    const h = log.crashes.find(x => x.id === F.id);
    return h && h.replays === 0 ? h : null;
  }
}
// a photo finish (under half a second): the finish replay gets its slow-motion look at the line
const finishClose = (x) => x && x.kind === 'finish' && x.score >= 8.5;

module.exports = { Highlights, finishClose };
