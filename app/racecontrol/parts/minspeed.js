// RaceControl engine part (All In One NR2003): NASCAR's minimum speed rule with enforcement.
//
// The posted minimum is 115% of the fastest lap (here: the fastest clean green-flag lap run in the race so far by any car); a car
// has to reach it within three consecutive green-flag laps. A car that runs three clean green-flag laps in a row slower than that is
// black flagged: it is immediately retired using NR2003's native retire-engine flag. Laps that do not count: any lap that began under caution or the pace laps, and any lap
// on which the car used pit road (the in lap and the out lap), so a car coming back from repairs gets its three laps to get up to speed.
// Lap times come from the car's own progress round the track (the engine clock, so time acceleration does not matter).
// Only significantly damaged cars are held to it: a slow lap counts only if the car has at least DAMAGE_BODY of body damage (the four
// panels, 0..1 each, so 1.0 = one panel's worth) or DAMAGE_ENGINE of engine damage. A healthy car that is just slow is left alone.
'use strict';
const A = require('../addr');
const { f2 } = require('../format');
const BLOCK0 = 11323952;                                          // the live car block (same base as qualifying / the director)
const DAMAGE_PANELS = [0x1337, 0x133B, 0x1357, 0x135B], ENGINE_DAMAGE = 0x137F;   // rear, front, right, left; engine damage 0..1
const DAMAGE_BODY = 1.0, DAMAGE_ENGINE = 0.5;
const RETIRED_REASON = 27 * 4; // Retired is item 26 in RetireAI's reason list; the game stores (item + 1) * 4.

const mod = (a, b) => { const n = a % b; return n < 0 ? n + b : n; };

module.exports = function (E) {
  E.MIN_SPEED_DAMAGE = { body: DAMAGE_BODY, engine: DAMAGE_ENGINE };
  const P = E.prototype;

  P.MinSpeedReset = function () {
    this.msCars = new Map(); this.msRef = NaN; this.msValid = 0; this.msLastCaution = -1; this.msWasGreen = null; this.msFlagged = new Map(); this.msLapSeen = 0; this.msRefNum = 0;
  };

  // the posted minimum lap time (s), or NaN until there is a fastest lap to base it on
  P.MinSpeedLimit = function () {
    return this.msValid >= 5 && Number.isFinite(this.msRef) ? this.msRef * (this.MinSpeedPercent / 100.0) : NaN;
  };

  P.MinSpeedTick = function () {
    if (!this.MinSpeedOn) return;
    if (!this.msCars) this.MinSpeedReset();
    if (!this.InRace) { if (this.msCars.size || this.msFlagged.size) this.MinSpeedReset(); return; }
    if (this.lap + 1 < this.msLapSeen) this.MinSpeedReset();          // a new race
    this.msLapSeen = Math.max(this.msLapSeen, this.lap);
    const m = this.m, tl = m.F64(A.TrackLength);
    if (!(tl > 100.0)) return;
    const now = this.Now, green = this.flag === 0 || this.flag === 7;
    if (!green) this.msLastCaution = now;
    if (!green || this.msWasGreen === false) {
      // A lap that began under yellow (or straddled a restart) must never be
      // treated as a green lap. Yellow also breaks a consecutive slow-lap run.
      for (const st of this.msCars.values()) {
        st.lapStart = NaN; st.tainted = true; st.slow = 0; st.times.length = 0;
      }
    }
    this.msWasGreen = green;
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i === 1) continue;
      if (!this.Running(i)) { this.msCars.delete(i); continue; }
      const st = this.msCars.get(i) || { lastD: NaN, lastT: NaN, lapStart: NaN, tainted: false, slow: 0, times: [] };
      this.msCars.set(i, st);
      const d = this.DlongOf(i), onPit = this.OnPitRoad(i);
      if (onPit) st.tainted = true;
      if (!Number.isNaN(st.lastD) && st.lastD > tl * 0.75 && d < tl * 0.25 && tl - st.lastD + d < tl * 0.1) {
        const frac = (tl - st.lastD) / (tl - st.lastD + d), tc = st.lastT + frac * (now - st.lastT);
        if (!Number.isNaN(st.lapStart)) this.MinSpeedLap(i, st, tc - st.lapStart, tl, st.lapStart > this.msLastCaution && green && !st.tainted);
        st.lapStart = tc; st.tainted = onPit;
      }
      st.lastD = d; st.lastT = now;
    }
    this.MinSpeedEnforceTick();
  };

  // a finished lap
  P.MinSpeedLap = function (i, st, lapTime, tl, clean) {
    if (!clean) { st.slow = 0; st.times.length = 0; return; }
    if (!(lapTime > tl / 100.0)) {                                     // reject impossible crossings above 100 m/s (224 mph)
      st.slow = 0; st.times.length = 0;
      return;
    }
    this.msValid++;
    if (!(lapTime >= this.msRef)) { this.msRef = lapTime; this.msRefNum = this.CarNumber(i); }
    const limit = this.MinSpeedLimit();
    if (!Number.isFinite(limit)) { st.slow = 0; return; }
    if (this.msFlagged.has(i)) return;
    if (lapTime > limit && !this.MinSpeedDamaged(i)) {
      if (st.slow > 0) st.slow = 0;
      return;
    }
    if (lapTime > limit) {
      st.slow++; st.times.push(lapTime); if (st.times.length > 6) st.times.shift();
      if (st.slow === 1) this.Log(`minimum speed: #${this.CarNumber(i)} (damaged) ran a green flag lap in ${f2(lapTime)} s, slower than the posted minimum ${f2(limit)} s (${this.MinSpeedPercent}% of the fastest lap, ${f2(this.msRef)} s by #${this.msRefNum}): ${this.MinSpeedLaps - 1} more such lap(s) and it is black flagged`);
      if (st.slow >= this.MinSpeedLaps) this.MinSpeedFlag(i, st, limit);
    } else st.slow = 0;
  };

  // significant damage: the body panels summed, or the engine
  P.MinSpeedDamaged = function (i) {
    const m = this.m, b = BLOCK0 + i * A.Ocd;
    if (typeof m.F32 !== 'function') return false;
    let body = 0;
    for (const o of DAMAGE_PANELS) { const v = m.F32(b + o); if (Number.isFinite(v)) body += Math.min(1, Math.max(0, v)); }
    const eng = m.F32(b + ENGINE_DAMAGE);
    return body >= DAMAGE_BODY || (Number.isFinite(eng) && eng >= DAMAGE_ENGINE);
  };

  P.MinSpeedFlag = function (i, st, limit) {
    const lasts = st.times.slice(-this.MinSpeedLaps).map(f2).join(', ');
    const retireNow = this.MinSpeedPark && i !== 0;
    this.msFlagged.set(i, { at: this.Now, called: false, parked: retireNow, ignoredLogged: false });
    if (retireNow) this.MinSpeedRetire(i);
    this.Log(`BLACK FLAG: #${this.CarNumber(i)} failed the minimum speed rule - ${this.MinSpeedLaps} green flag laps in a row slower than ${f2(limit)} s (${lasts} s; the fastest lap is ${f2(this.msRef)} s) while significantly damaged. ${retireNow ? 'It is retired immediately' : 'It is called to pit road'}`);
  };

  P.MinSpeedRetire = function (i) {
    const m = this.m;
    // Match RetireAI: set the game's reason code and native retirement request for this car slot.
    m.W8(A.ReasonOut + i * A.Ocd, RETIRED_REASON);
    m.WF32(A.RetireEngine + i * A.Ocd, 1);
  };

  // Reassert a native retirement request if NR2003 has not consumed it yet.
  P.MinSpeedEnforceTick = function () {
    if (this.msFlagged.size === 0) return;
    const m = this.m;
    for (const [i, f] of Array.from(this.msFlagged.entries())) {
      // NR2003 can restore the car's active flag after servicing its stop. Keep the
      // retirement asserted so the AI cannot rejoin the race.
      if (f.parked) {
        m.W8(A.PenaltyStop + i * A.Ocd, 0); m.W8(A.Pitting + i * A.Ocd, 0);
        if (this.Running(i)) this.MinSpeedRetire(i);
        continue;
      }
      if (!this.Running(i)) { f.parked = true; continue; }
      if (this.OnPitRoad(i)) {
        f.wasInPits = true;
        continue;
      }
      if (f.wasInPits && this.MinSpeedPark && i !== 0) {
        m.W8(A.PenaltyStop + i * A.Ocd, 0); m.W8(A.Pitting + i * A.Ocd, 0);
        this.MinSpeedRetire(i);
        f.parked = true;
        this.Log(`BLACK FLAG: #${this.CarNumber(i)} completed its penalty stop and is retired (minimum speed rule)`);
        continue;
      }
      if (m.U8(A.PenaltyStop + i * A.Ocd) !== 1) m.W8(A.PenaltyStop + i * A.Ocd, 1);
      if (m.U8(A.Pitting + i * A.Ocd) !== 1) m.W8(A.Pitting + i * A.Ocd, 1);
      if (!f.called) { f.called = true; this.Log(`BLACK FLAG: #${this.CarNumber(i)} is being called to pit road`); }
      else if (!f.ignoredLogged && this.Now - f.at > 5 * 60.0) { f.ignoredLogged = true; this.Log(`BLACK FLAG: #${this.CarNumber(i)} still has not come in after ${Math.round((this.Now - f.at) / 60)} minutes: it keeps being called`); }
    }
  };

  P.MinSpeedFlagged = function (idx) { return !!(this.MinSpeedOn && this.msFlagged && this.msFlagged.has(idx)); };
};
