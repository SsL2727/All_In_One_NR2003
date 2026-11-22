// Incidents and damage for season stats: the bridge's telemetry has no damage, so this reads NR2003's memory while a counted race runs.
//   an incident = a car's body damage (the four panels) rising by more than RISE; the nearest other car within NEAR_M at that moment is
//   the one it touched (contact); several rises within MERGE_S are one incident
//   a caution caused = an incident in the CAUSE_S seconds before the flag left green
// Per car number: incidents, damage taken (the body damage added), contacts (incidents with another car), cautions caused.
'use strict';
const BLOCK0 = 11323952, OCD = 8724;
const DAMAGE_PANELS = [0x1337, 0x133B, 0x1357, 0x135B], POS = 0x19DE;
const CAR_NUM = 11328594, HAS_SPAWNED = 7779164, HAS_NOT_RETIRED = 8025816, NUM_CARS = 9932816, FLAG = 7795076, PACE = 1;
const RISE = 0.002, NEAR_M = 6, MERGE_S = 4, CAUSE_S = 10;

class IncidentWatcher {
  // mem: { readBytes(addr, n) } (Win32Memory / FakeMemory); now: () => seconds
  constructor(mem, now) { this.mem = mem; this.now = now || (() => Date.now() / 1000); this.reset(); }
  reset() { this.cars = new Map(); this.byNum = {}; this.prevFlag = null; this.recent = []; this.cautions = 0; }
  _rd(a, n) { try { return this.mem.readBytes(a, n); } catch (e) { return null; } }
  _u8(a) { const b = this._rd(a, 1); return b ? b[0] : 0; }
  _rec(num) { return this.byNum[num] || (this.byNum[num] = { incidents: 0, damage: 0, contacts: 0, cautionsCaused: 0 }); }

  tick() {
    const nb = this._rd(NUM_CARS, 4); if (!nb) return false;
    const n = Math.min(Math.max(0, nb.readInt32LE(0)), 64);
    const fb = this._rd(FLAG, 4); const flag = fb ? fb.readInt32LE(0) : 7;
    const t = this.now();
    const live = [];
    for (let i = 0; i < n; i++) {
      if (i === PACE || this._u8(HAS_SPAWNED + i) !== 1) continue;
      const blk = this._rd(BLOCK0 + i * OCD, 0x19E6 + 8); if (!blk) continue;
      let body = 0;
      for (const o of DAMAGE_PANELS) { const v = blk.readFloatLE(o); if (Number.isFinite(v)) body += Math.max(0, v); }
      const x = blk.readFloatLE(POS), y = blk.readFloatLE(POS + 4);
      const nm = this._rd(CAR_NUM + i * OCD, 2); const num = nm ? String(nm.readUInt16LE(0)) : '';
      live.push({ i, body, x, y, num, running: this._u8(HAS_NOT_RETIRED + i) === 1 });
    }
    for (const c of live) {
      const st = this.cars.get(c.i);
      if (!st || st.num !== c.num) { this.cars.set(c.i, { num: c.num, body: c.body, lastInc: -1e9 }); continue; }
      const rise = c.body - st.body;
      if (rise > RISE && c.num) {
        const r = this._rec(c.num);
        r.damage = Math.round((r.damage + rise) * 1000) / 1000;
        if (t - st.lastInc > MERGE_S) {
          r.incidents++;
          let near = null, best = NEAR_M;
          for (const o of live) {
            if (o.i === c.i || !Number.isFinite(o.x) || !Number.isFinite(c.x)) continue;
            const d = Math.hypot(o.x - c.x, o.y - c.y);
            if (d < best) { best = d; near = o; }
          }
          if (near) r.contacts++;
          this.recent.push({ t, num: c.num, other: near ? near.num : null });
        }
        st.lastInc = t;
      }
      st.body = c.body;                     // (a repair lowers it: follow it down)
    }
    // the flag left green: the incidents just before it brought out the caution
    if (this.prevFlag === 7 && flag !== 7 && flag > 0) {
      const who = new Set(this.recent.filter(x => t - x.t <= CAUSE_S).map(x => x.num));
      for (const num of who) this._rec(num).cautionsCaused++;
      if (who.size) this.cautions++;
    }
    this.recent = this.recent.filter(x => t - x.t <= CAUSE_S);
    this.prevFlag = flag;
    return true;
  }

  // per car number: { incidents, damage, contacts, cautionsCaused }
  summary() { return JSON.parse(JSON.stringify(this.byNum)); }
}

module.exports = { IncidentWatcher, RISE, NEAR_M, CAUSE_S };
