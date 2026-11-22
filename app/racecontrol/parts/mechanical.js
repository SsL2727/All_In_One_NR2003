// RaceControl engine part (All In One NR2003): mechanical failures don't bring out the caution (option, off by default).
//
// NR2003 asks for its own cautions through the same request byte RaceControl uses (A.Yellow = 0x76B35B: set it at green and the game
// throws a caution a moment later). This part watches every car under green - when its body damage last rose (a crash or contact) and
// when it last broke down: retired on track, its engine damage rose, or it slowed below SLOW_MPS off pit road. When the game raises its
// own request (not RaceControl's) and in the last LOOKBACK_S seconds no car took body damage but a car broke down, the request is
// cleared before the game acts on it and the race stays green. Anything with a crash in it is left alone.
//
// Not verified in a live race: if the game has already started the caution by the time it is seen, the log says "too late" (and how
// often that happens tells whether clearing the request is fast enough).
'use strict';
const A = require('../addr');

const BLOCK0 = 11323952;
const DAMAGE_PANELS = [0x1337, 0x133B, 0x1357, 0x135B], ENGINE_DAMAGE = 0x137F;
const LOOKBACK_S = 8, SLOW_MPS = 12, BODY_RISE = 0.002, ENGINE_RISE = 0.05, OWN_WRITE_S = 3;

module.exports = function (E) {
  const P = E.prototype;

  P.MechResetState = function () {
    this.mech = new Map();                 // car -> { body, eng, prog, t, crashAt, brokeAt, why, running }
    this.mechCleared = null;               // { at, cars } the last request cleared
    this.mechLastReq = 0;
    this.mechCount = 0;
  };

  // RaceControl's own writes of the request (stage cautions, "throw a caution"): never cleared
  P.MechOwnYellow = function () { this.mechOwnAt = this.Now; };

  P.MechanicalTick = function () {
    if (!this.NoMechanicalCautions) return;
    if (!this.mech) this.MechResetState();
    const m = this.m, now = this.Now, trackLen = m.F64(A.TrackLength);
    const n = Math.min(m.I32(A.NumCars), 64);
    for (let i = 0; i < n; i++) {
      if (i === A.PaceCarIdx || m.U8(A.HasSpawned + i) !== 1) continue;
      const b = BLOCK0 + i * A.Ocd;
      let body = 0;
      for (const o of DAMAGE_PANELS) { const v = m.F32(b + o); if (Number.isFinite(v)) body += Math.max(0, v); }
      const eng = m.F32(b + ENGINE_DAMAGE);
      const prog = this.LapsOf(i) * (trackLen > 0 ? trackLen : 1) + this.DlongOf(i);
      const running = this.Running(i), pit = this.OnPitRoad(i);
      const st = this.mech.get(i);
      if (!st) { this.mech.set(i, { body, eng, prog, t: now, crashAt: -1e9, brokeAt: -1e9, why: '', running }); continue; }
      const dt = now - st.t;
      if (body > st.body + BODY_RISE) st.crashAt = now;
      if (this.flag === 7 && !pit) {
        if (st.running && !running) { st.brokeAt = now; st.why = 'out of the race'; }
        else if (Number.isFinite(eng) && Number.isFinite(st.eng) && eng > st.eng + ENGINE_RISE) { st.brokeAt = now; st.why = 'engine trouble'; }
        else if (running && dt > 0.25 && dt < 2) {
          const v = (prog - st.prog) / dt;
          if (v >= 0 && v < SLOW_MPS && st.lastV >= SLOW_MPS) { st.brokeAt = now; st.why = 'slowed to ' + Math.round(v * 2.237) + ' mph'; }
          st.lastV = v;
        }
      }
      if (dt >= 0.25) { st.prog = prog; st.t = now; }
      st.body = body; st.eng = eng; st.running = running;
    }

    const req = m.U8(A.Yellow) !== 0;
    // a request cleared just before: did the game start the caution anyway?
    if (this.mechCleared && this.flag !== 7 && now - this.mechCleared.at < 3) {
      this.Log(`no caution for a mechanical failure: too late - NR2003 had already started the caution for ${this.mechCleared.cars}`);
      this.mechCleared = null;
    }
    if (!req || this.flag !== 7) return;
    if (this.mechOwnAt != null && now - this.mechOwnAt < OWN_WRITE_S) return;          // RaceControl's own caution
    let crash = null;
    const broke = [];
    for (const [i, st] of this.mech) {
      if (now - st.crashAt < LOOKBACK_S) crash = i;
      else if (now - st.brokeAt < LOOKBACK_S) broke.push(i);
    }
    if (crash != null) {
      if (now - this.mechLastReq > 5) { this.mechLastReq = now; if (broke.length) this.Log(`caution stays: #${this.CarNumber(crash)} took damage too (not only a mechanical failure)`); }
      return;
    }
    if (!broke.length) return;                                                          // a caution with no car to blame: not ours to judge
    m.W8(A.Yellow, 0);
    const cars = broke.map(i => `#${this.CarNumber(i)} (${this.mech.get(i).why})`).join(', ');
    this.mechCleared = { at: now, cars };
    this.mechCount++;
    this.Log(`no caution for a mechanical failure: ${cars} - NR2003's caution request cleared, the race stays green (${this.mechCount} this race)`);
  };
};
