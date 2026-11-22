// RaceControl engine part: cautions, stages, green-white-checkered, collisions.
'use strict';
const { r0, f2, f1, f3t, pct } = require('../format');
const A = require('../addr');

const mod = (a, b) => { const n = a % b; return n < 0 ? n + b : n; };

module.exports = function (E) {
  const P = E.prototype;

  P.ThrowCaution = function () { this.throwCaution = true; };

  P.FreezeField = function () {
    if (!this.fieldFrozen && this.flag === 0 && !this.WhiteFlagOut && !this.stageCaution) {
      this.fieldFrozen = true;
      for (let i = 0; i < 48; i++) this.m.W8(A.RacedBack + i, 1);
    }
  };

  P.ExtendForGreenWhiteCheckered = function () {
    const m = this.m;
    if (this.flag <= 6 && !this.WhiteFlagOut) {
      const num = m.U16(this.RaceLengthAddr);
      if (num >= this.lap && this.lap + 2 > num) {
        m.W16(this.RaceLengthAddr, this.lap + 2);
        m.W16(this.RaceLengthDisplayAddr, this.lap + 2);
        this.Log(`green-white-checkered: race extended to ${this.lap + 2} laps`);
      }
    }
  };

  P.ManageCollisions = function () {
    const m = this.m;
    const pacing = this.flag >= 2 && this.flag <= 6;
    for (let i = 0; i <= this.maxIdx; i++) {
      const load = m.U8(A.CarClassLoad + i * A.Ocd);
      if (load === 0) continue;
      const a = A.CarClass + i * A.Ocd;
      const cur = m.U8(a);
      if ((this.GhostOnPitRoad && this.OnPitRoad(i)) || (this.GhostWhilePacing && pacing)) {
        this.ghostEndWanted.delete(i);
        if (cur !== 0) m.W8(a, 0);
      } else if (cur === 0) {
        let v = this.ghostEndWanted.get(i);
        if (v === undefined) { v = this.Now; this.ghostEndWanted.set(i, v); }
        if (!(this.Now - v < 5.0) || !this.Overlapping(i)) { m.W8(a, load); this.ghostEndWanted.delete(i); }
      }
    }
  };

  P.Overlapping = function (idx) {
    const num = this.m.F64(A.TrackLength);
    if (num <= 100.0) return false;
    const d = this.DlongOf(idx), lat = this.DlatOf(idx);
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i !== idx && i !== 1 && this.Running(i)) {
        const dd = Math.abs(mod(Math.fround(this.DlongOf(i) - d) + num / 2.0, num) - num / 2.0);
        if (dd < 5.5 && Math.abs(Math.fround(this.DlatOf(i) - lat)) < 2.2) return true;
      }
    }
    return false;
  };

  P.CurrentStageEnds = function () {
    if (!this.StageRacing || !this.StageEnds) return null;
    try { return this.ApplyEarly(this.StageEnds(this.m.U16(this.RaceLengthAddr))); } catch (e) { return null; }
  };

  // stage ends that a caution already brought forward (original end -> the lap it really ended on)
  P.ApplyEarly = function (ends) {
    if (!ends || !this.earlyEnds.size) return ends;
    return ends.map(e => (this.earlyEnds.has(e) ? this.earlyEnds.get(e) : e));
  };

  // -> { done, share } or null
  P.LeaderOnLap = function () {
    const done = this.m.I32(A.LapsComplete);
    const num = this.m.F64(A.TrackLength);
    if (num <= 100.0) return null;
    const f = this.FieldFull();
    if (f == null) return null;
    return { done, share: this.DlongOf(f.leader.Idx) / num };
  };

  P.StageNumber = function (ends, end) { return ends.slice().sort((a, b) => a - b).indexOf(end) + 1; };

  P.StageCautionTick = function () {
    const m = this.m;
    const ends = this.CurrentStageEnds();
    const num = m.U16(this.RaceLengthAddr);
    if (num !== this.stageRaceLength) { this.stageRaceLength = num; this.stagesDone.clear(); this.earlyEnds.clear(); }
    let lo;
    if (ends == null || ends.length === 0 || (lo = this.LeaderOnLap()) == null) return;
    const { done, share } = lo;
    if (done < this.stageLastDone - 1) { this.stagesDone.clear(); this.earlyEnds.clear(); }
    this.stageLastDone = done;
    const n2 = done + 1;
    if (ends.includes(n2) && !this.stagesDone.has(n2)) {
      if (this.flag !== 7) {
        this.stagesDone.add(n2);
        this.Log(`stage ${this.StageNumber(ends, n2)} ends on lap ${n2} under the caution already out`);
      } else if (this.StageThrowCaution && !(share < 0.75)) {
        this.stagesDone.add(n2);
        this.stageThrown = n2;
        if (this.MechOwnYellow) this.MechOwnYellow();
        m.W8(A.Yellow, 1);
        this.Log(`stage ${this.StageNumber(ends, n2)} ends on lap ${n2}: caution with the leader ${pct(share)} through the lap; ${this.StageRaceBack ? 'the field races back to the line' : 'the field is frozen (race back at stage ends is off)'}`);
      } else if (!this.StageThrowCaution && !(share < 0.75)) {
        // stages without cautions: the stage ends under green and the race carries on
        this.stagesDone.add(n2);
        this.Log(`stage ${this.StageNumber(ends, n2)} ends on lap ${n2}: no caution (stages without cautions), the race stays green`);
      }
    }
  };

  P.IsStageEnd = function () {
    const num = this.stageThrown;
    this.stageThrown = -1;
    if (num > 0) return true;
    const ends = this.CurrentStageEnds();
    if (ends == null || ends.length === 0) return false;
    const lo = this.LeaderOnLap();
    if (lo == null) return false;
    const { done, share } = lo;
    // stages without cautions: a stage that already ended under green is not a stage end again when a normal caution comes right after it
    const ended = (e) => !this.StageThrowCaution && this.stagesDone.has(e);
    const n2 = (ends.includes(done) && !ended(done) && share <= 0.25) ? done : ((ends.includes(done + 1) && !ended(done + 1) && share >= 0.75) ? done + 1 : -1);
    if (n2 < 0 && this.StageEarlyLaps > 0) {
      // Better Cautions' rule: a caution with N or fewer laps left in a stage ends that stage at the next line the leader crosses
      const next = ends.filter(e => e > done + 1 && !this.stagesDone.has(e)).sort((a, b) => a - b)[0];
      if (next !== undefined && next - done <= this.StageEarlyLaps) {
        const early = done + 1;
        this.earlyEnds.set(next, early);
        this.stagesDone.add(early);
        this.Log(`caution with ${next - done} laps left in stage ${this.StageNumber(ends, next)}: the stage ends early on lap ${early} (was lap ${next}); ${this.StageRaceBack ? 'the field races back to the line' : 'the field is frozen (race back at stage ends is off)'}`);
        return true;
      }
    }
    if (n2 < 0) {
      if (ends.includes(done) || ends.includes(done + 1)) this.Log(`caution near the stage end (leader ${pct(share)} round lap ${done + 1}): a normal caution, the field is frozen`);
      return false;
    }
    this.stagesDone.add(n2);
    this.Log(`stage ${this.StageNumber(ends, n2)} ends on lap ${n2} (caution from another app): ${this.StageRaceBack ? 'the field races back to the line' : 'the field is frozen (race back at stage ends is off)'}`);
    return true;
  };

  P.CautionsTick = function () {
    const m = this.m;
    if (this.throwCaution) {
      this.throwCaution = false;
      if (this.flag === 7) { if (this.MechOwnYellow) this.MechOwnYellow(); m.W8(A.Yellow, 1); this.Log('caution thrown from Race Control'); }
    }
    if (this.flag === 7) { this.fieldFrozen = this.cautionSeen = this.stageCaution = false; this.ResetCautionLine(); }
    if (this.flag !== 7 && !this.cautionSeen) {
      this.cautionSeen = true;
      this.stageCaution = this.StageRacing && this.IsStageEnd() && this.StageRaceBack;
    }
    if (this.StageRacing) this.StageCautionTick();
    if (!this.RaceBack && !this.StockCautions) this.FreezeField();
    if (this.fieldFrozen && this.PaceFixes && this.flag <= 1) this.FixCautionLine();
    if (this.fieldFrozen && this.PaceFixes && this.flag <= 2) this.ChaseTick();
    else this.EndChase(this.flag === 7 ? 'green' : 'flag ' + this.flag);
    if (this.fieldFrozen && this.PaceFixes && this.TailCatchUp && !this.PaceLapFit && this.flag <= 2) this.TailCatchUpTick();
    else if (this.tailLowered.size > 0) this.RestoreTail(this.flag === 7 ? 'green' : (this.PaceLapFit ? 'pace laps fitted to the line instead' : 'the field is packed (flag ' + this.flag + ')'));
    if (this.fieldFrozen && this.PaceFixes && this.PaceLapFit && this.flag <= 1) this.PaceLapFitTick();
    else this.EndPaceLapFit();
    if (this.flag === 7) this.paceGameLeadFresh = false;
    if (this.flag === 7 || this.StockCautions) {
      if (this.paceHolding || this.paceReleased || this.paceLogged) this.ResetPaceCar();
      this.RestorePaceSpeed('green');
    } else { this.PaceCarTick(); this.PaceMatchTick(); }
    if (this.GreenWhiteCheckered) this.ExtendForGreenWhiteCheckered();
    this.ManageCollisions();
  };
};
