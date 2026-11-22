// RaceControl engine part: penalties (forgiving "passing under yellow" etc.), pre-start flags, pit request logging.
'use strict';
const { r0, f2, f1, f3t, pct } = require('../format');
const A = require('../addr');

const hex = (n) => (n >>> 0).toString(16).toUpperCase();

module.exports = function (E) {
  const P = E.prototype;

  P.WatchWavedCrossings = function () {
    const m = this.m;
    for (const key of this.eligible.keys()) {
      if (!this.watched.has(key)) this.watched.set(key, { Laps: this.LapsOf(key), GreenCrossings: 0 });
    }
    if (this.watched.size === 0) return;
    m.F64(A.TrackLength);
    let leader = null, list = null;
    for (const [idx, w] of Array.from(this.watched.entries())) {
      const num = this.LapsOf(idx);
      if (num === w.Laps) continue;
      w.Laps = num;
      if (list == null) { const f = this.FieldFull(); list = f ? f.list : []; leader = f ? f.leader : null; }
      const car = list.find(c => c.Idx === idx);
      const car2 = leader;
      const num2 = this.ScoredLaps(idx);
      let text = '';
      if (car2 != null && num2 >= 0 && num2 < 512) {
        const n3 = (m.U32(A.CrossTable + idx * 2048 + num2 * 4) & 0xFFFFFFF) >>> 0;
        const n4 = (m.U32(A.CrossTable + car2.Idx * 2048 + num2 * 4) & 0xFFFFFFF) >>> 0;
        text = (n4 !== 0 && n3 !== 0) ? `, crossed lap ${num2} ${f1((n3 - n4) / 1000.0)} s after leader #${car2.Num}` : `, leader #${car2.Num} has no crossing for lap ${num2}`;
      }
      const text2 = car == null ? 'on pit road or not running'
        : `${r0(car.Gap)} m behind the pace car, ${f2(car.Down)} laps behind the leader on track, line row ${m.I32(A.PacingRow + idx * 13)}${car.Ahead ? ', still ahead of the leader' : ''}`;
      this.Log(`scoring watch #${this.CarNumber(idx)}: laps ${num} (scored ${num2}${text}); ${text2}`);
      if (this.flag === 7 && ++w.GreenCrossings >= 2) this.watched.delete(idx);
    }
  };

  P.PenaltyRules = function () {
    const m = this.m, list = [];
    const n = m.U32(A.PenaltyList);
    if (n === 0) return list;
    const n2 = m.U32(n + 4);
    const n3 = m.I32(n + 8);
    if (n2 === 0 || n3 <= 0 || n3 > 64) return list;
    for (let i = 0; i < n3; i++) list.push(m.U32(n2 + i * 4));
    return list;
  };

  P.HasPenalty = function (idx) {
    for (const item of this.PenaltyRules()) {
      if (item !== 0 && item !== A.PaceCarPenalty && (this.m.U32(item + 4 + idx * 4) & 0xF) !== 0) return true;
    }
    return false;
  };

  P.WatchPenalties = function () {
    if (++this.penaltyTick % 10 !== 0) return;
    const m = this.m, list = this.PenaltyRules();
    for (let i = 0; i < list.length; i++) {
      if (list[i] === 0) continue;
      for (let j = 0; j <= this.maxIdx; j++) {
        const num = m.U32(list[i] + 4 + j * 4);
        const key = i * 64 + j;
        const t = num & 0xF;
        const prev = this.penaltySeen.get(key) || 0;
        if (t !== prev) {
          this.penaltySeen.set(key, t);
          if (t !== 0) this.Log(`penalty: rule ${i} on #${this.CarNumber(j)} type ${t} amount ${(num >>> 4) & 0xFFF} (0x${hex(num)})${this.excused.has(j) ? ' [moved by the lineup]' : ''}`);
          else this.Log(`penalty cleared: rule ${i} on #${this.CarNumber(j)}`);
        }
      }
    }
  };

  P.Excuse = function () { for (const i of this.excused) this.ExcuseCar(i, 'it was moved by the lineup'); };

  P.ExcuseCar = function (idx, why) {
    const m = this.m;
    const a0 = 8849799 + idx * 12;
    if (m.I32(a0 + 8) !== -1074790400) { m.W32(a0 + 4, 0); m.W32(a0 + 8, -1074790400); }
    const a = 8849556 + idx * 4;
    const v = m.U32(a);
    if ((v & 0xF) !== 0) {
      m.W32(a, (v & -65536) | 0);
      this.Log(`removed 'passing under yellow' penalty from #${this.CarNumber(idx)} (0x${hex(v)}), ${why}`);
    }
  };

  P.ForgiveTick = function () {
    const m = this.m;
    if (this.flag !== 7) this.cautionRunning = true;
    else if (this.cautionRunning) { this.cautionRunning = false; this.restartLap = this.lap; this.UnrollCone(); }
    if (this.flag === 7 && this.restartLap >= 0 && this.lap > this.restartLap + 1) this.restartLap = -1;
    if (!this.ForgivePenalties || ++this.forgiveTick % 5 !== 0) return;
    const atRestart = this.flag === 7 && this.restartLap >= 0;
    if (this.flag === 7 && !atRestart) return;
    const list = this.PenaltyRules();
    if (list.length <= 14 || list[14] !== A.PaceCarPenalty) return;
    const rule11 = list[11];
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i === 1 || !this.Running(i) || (i === 0 && this.CarNumber(i) > 0 && !this.excused.has(i))) continue;
      this.ExcuseCar(i, atRestart ? 'at the restart (Race Control set the order)' : 'under caution (Race Control sets the order)');
      if (atRestart && rule11 !== 0) {
        const v = m.U32(rule11 + 4 + i * 4);
        if ((v & 0xF) !== 0) {
          m.W32(rule11 + 4 + i * 4, 0);
          this.Log(`removed 'passing on the inside' penalty from #${this.CarNumber(i)} (0x${hex(v)}) at the restart`);
        }
      }
      this.CallOffPenaltyStop(i, list);
    }
  };

  P.CallOffPenaltyStop = function (idx, rules) {
    const m = this.m;
    if (this.MinSpeedFlagged(idx)) return;            // a black flag for the minimum speed rule: that stop is wanted
    const a = A.PenaltyStop + idx * A.Ocd;
    if (m.U8(a) === 0 || this.OnPitRoad(idx) || this.NeedsRepair(idx)) return;
    for (let i = 0; i < rules.length; i++) {
      if (i !== 11 && i !== 14 && rules[i] !== 0 && (m.U32(rules[i] + 4 + idx * 4) & 0xF) !== 0) return;
    }
    m.W8(a, 0);
    m.W8(A.Pitting + idx * A.Ocd, 0);
    if (!this.stopCalledOff.has(idx)) {
      this.stopCalledOff.set(idx, this.Now);
      this.Log(`#${this.CarNumber(idx)}'s penalty stop called off (its penalty was forgiven)`);
    } else {
      const v = this.stopCalledOff.get(idx);
      if (v >= 0.0 && this.Now - v >= 10.0) {
        this.stopCalledOff.set(idx, -1.0);
        this.Log(`#${this.CarNumber(idx)}'s penalty stop is still being asked for by the game after ${r0(this.Now - v)} s; still called off`);
      }
    }
  };

  P.WatchPenaltyStopFlag = function () {
    const m = this.m;
    let list = null;
    for (let i = 0; i <= this.maxIdx && i < 64; i++) {
      if (i === 1) continue;
      const on = this.Running(i) && m.U8(A.PenaltyStop + i * A.Ocd) !== 0;
      const was = this.stopFlagSeen[i];
      this.stopFlagSeen[i] = on;
      if (!on) { this.phantomSince[i] = NaN; continue; }
      if (list == null) list = this.PenaltyRules();
      const owed = this.Owed(i, list);
      if (!was && this.Now - this.stopFlagLogged[i] >= 30.0) {
        this.stopFlagLogged[i] = this.Now;
        this.Log(`game penalty stop flag set for #${this.CarNumber(i)} (${this.flag === 7 ? 'green' : 'caution'}): ${owed.length === 0 ? 'no penalty showing' : owed.join(', ')}`);
      }
      this.PhantomStop(i, owed);
    }
  };

  P.Owed = function (idx, rules) {
    const out = [];
    for (let i = 0; i < rules.length; i++) {
      if (rules[i] !== 0) {
        const v = this.m.U32(rules[i] + 4 + idx * 4);
        if ((v & 0xF) !== 0) out.push(`rule ${i} type ${v & 0xF} (0x${hex(v)})`);
      }
    }
    return out;
  };

  P.PhantomStop = function (idx, owed) {
    const m = this.m;
    if (this.MinSpeedFlagged(idx)) { this.phantomSince[idx] = NaN; return; }
    if (!this.ForgivePenalties || owed.length > 0 || this.OnPitRoad(idx) || this.NeedsRepair(idx)) this.phantomSince[idx] = NaN;
    else if (Number.isNaN(this.phantomSince[idx])) this.phantomSince[idx] = this.Now;
    else if (!(this.Now - this.phantomSince[idx] < 1.0)) {
      m.W8(A.PenaltyStop + idx * A.Ocd, 0);
      m.W8(A.Pitting + idx * A.Ocd, 0);
      this.stopFlagSeen[idx] = false;
      this.phantomSince[idx] = NaN;
      if (this.Now - this.phantomLogged[idx] >= 30.0) {
        this.phantomLogged[idx] = this.Now;
        this.Log(`phantom penalty stop called off for #${this.CarNumber(idx)} (no penalty showing for 1 s)`);
      }
    }
  };

  // a car the game wants in for repairs (its repair counter is set): its stop is the game's own, not a penalty
  P.NeedsRepair = function (idx) { return this.m.I32(A.RepairNeed + idx * A.Ocd) >= 1; };

  P.PreStartTick = function () {
    const m = this.m;
    let list = null;
    for (let i = 0; i <= this.maxIdx && i < 64; i++) {
      if (i === 1 || !this.Running(i) || m.U8(A.PenaltyStop + i * A.Ocd) === 0) continue;
      if (list == null) list = this.PenaltyRules();
      const owed = this.Owed(i, list);
      const player = i === 0 && this.CarNumber(i) > 0;
      const repair = this.NeedsRepair(i);
      const stale = this.ForgivePenalties && owed.length === 0 && !this.OnPitRoad(i) && !player && !repair;
      const seen = this.startFlagsSeen.get(i) || 0;
      this.startFlagsSeen.set(i, seen + 1);
      if (seen === 0) {
        this.Log(`game penalty stop flag set for #${this.CarNumber(i)} during the pace laps before the start: ${owed.length === 0 ? 'no penalty showing' : owed.join(', ')}${stale ? ' - stale, cleared' : (this.OnPitRoad(i) ? ' - in its pit stall, left alone' : (repair ? ' - it needs repairs, left alone' : ' - left alone'))}`);
      } else if (seen === 1 && stale) {
        this.Log(`game penalty stop flag set again for #${this.CarNumber(i)} before the start (the game sets it back): clearing it every tick until the green`);
      }
      if (stale) { m.W8(A.PenaltyStop + i * A.Ocd, 0); m.W8(A.Pitting + i * A.Ocd, 0); }
    }
  };

  P.WatchPitRequests = function () {
    const m = this.m;
    let list = null;
    for (let i = 0; i <= this.maxIdx && i < 64; i++) {
      if (i === 1) continue;
      const on = this.Running(i) && m.U8(A.Pitting + i * A.Ocd) !== 0;
      const was = this.requestSeen[i];
      this.requestSeen[i] = on;
      if (!on || was || this.OnPitRoad(i)) continue;
      const key = i * 2 + (this.pitsOpen ? 1 : 0);
      if (this.requestsLogged.has(key)) continue;
      this.requestsLogged.add(key);
      if (list == null) list = this.PenaltyRules();
      const pen = [];
      for (let j = 0; j < list.length; j++) {
        if (list[j] !== 0) { const v = m.U32(list[j] + 4 + i * 4); if ((v & 0xF) !== 0) pen.push(`rule ${j} type ${v & 0xF}`); }
      }
      const chk = f3t(m.F64(A.PitCheckValue + i * A.Ocd));
      this.Log(`pit request for #${this.CarNumber(i)} under caution, pits ${this.pitsOpen ? 'open' : 'closed'} (AIMOD's or the game's): penalty flag ${m.U8(A.PenaltyStop + i * A.Ocd)}, penalties ${pen.length === 0 ? 'none' : pen.join(', ')}, pit check value ${chk}, laps ${this.LapsOf(i)}`);
    }
  };

  P.DroppedBackTick = function () {
    const m = this.m;
    let list = null;
    for (const [key, el] of this.eligible) {
      if (!el.FromAhead) continue;
      if (!this.GoingAround(key)) continue;
      if (list == null) list = this.Field() || [];
      const car = list.find(o => o.Idx === key);
      if (car == null || car.Ahead) el.BehindSince = -1.0;
      else if (el.BehindSince < 0.0) el.BehindSince = this.Now;
      else if (!(this.Now - el.BehindSince < 3.0)) {
        el.Restored = true;
        this.GiveBackPaceLap(key);
        this.sentEarly.delete(key);
        this.Log(`#${car.Num} dropped back behind the leader instead of going around the pace car: it stays at the back, pit road no longer waits for it`);
      }
    }
  };
};
