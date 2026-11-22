// RaceControl engine part (RaceControl 1.1.0 / 1.2.0 beta 2): the pace car pickup (held on pit road, released when the leader is the right
// distance away, timing learned per track), lapped cars dropping to the low line while the lead lap cars go by high (the game's own line
// modes + a moved race line), the caution timeline log and the field-split hold. A port of the C# RaceEngine (parity-tested in tools/rcparity).
'use strict';
const A = require('../addr');
const { r0, f1 } = require('../format');
const { GameMemoryError } = require('../gamemem');

const mod = (a, b) => { const n = a % b; return n < 0 ? n + b : n; };
const PACE_WAITING = 7736736, PACE_PARKED = 7736880,PACE_LEAD_TIME = 7736756, PACE_NAME = 7465572, PACE_CAUTION = 7736648, PACE_LEAVING = 7737108;
const LINE_RACE = 12417364, LINE_LIMP = 12417416;
const HOLD_LEAD = -1000000;
const carState = (i) => 11328983 + i * 8724;
const carLine = (i) => 11328995 + i * 8724;
const carLineNext = (i) => 11328999 + i * 8724;
const carLineShown = (i) => 11331009 + i * 8724;
const FB = Buffer.alloc(4);
const floatBits = (f) => { FB.writeFloatLE(f, 0); return FB.readInt32LE(0); };
const bitsFloat = (v) => { FB.writeInt32LE(v | 0, 0); return FB.readFloatLE(0); };
const hex = (n) => (n >>> 0).toString(16);

module.exports = function (E) {
  const P = E.prototype;

  P.InitPace = function () {
    // options
    this.PaceCarWaits = true; this.PaceReleaseAt = NaN; this.PaceReleaseLearned = null;
    this.LappedDropLow = true; this.LappedHoldUntilPitsDone = true; this.LeadLapHighShare = 0.7; this.HoldGreenIfSplit = false; this.GameAlive = null;
    this.highBackupPath = null;                                      // file the moved race line is saved to (the service sets it)
    // pace car
    this.paceStatesOk = null; this.paceHolding = false; this.paceReleased = false; this.paceLogged = false; this.paceGameLead = 0; this.paceHoldStart = NaN;
    this.paceLastGap = NaN; this.paceLastTime = NaN; this.paceLeaderSpeed = NaN; this.paceLeader = -1; this.paceLeaderAtRelease = -1; this.paceReleaseGap = 0;
    this.paceReleaseUsed = 0; this.paceSentAt = NaN; this.paceAccelSeen = false; this.paceMergeOffset = NaN; this.paceExitTime = NaN; this.paceParkedAt = NaN;
    this.paceLeaderAvg = NaN; this.paceLeaderAtSend = NaN; this.paceCrawlRelease = false; this.paceHoldLogAt = NaN; this.paceWatchAt = NaN;
    this.paceBehindLeaderLogged = false;
    // low line / high line
    this.lowSince = new Map(); this.lowClearSince = new Map(); this.lowRefused = new Set(); this.lowLineOk = null; this.lowLogged = false; this.lowWaitLogged = false;
    this.highOrig = null; this.highArray = 0; this.highPoints = 0; this.highClearSince = NaN; this.highChecked = false; this.holdForLappedLogged = false;
    // hold one to go for lapped cars / caution timeline / split hold
    this.holdReleasedOnce = false; this.lappedHoldStartPaceLap = -1; this.timelineFlag = 7; this.gameHoldLogged = false;
    this.splitAsked = false; this.splitReported = false; this.splitAskFlag = 0;
  };

  // ── caution timeline (a log of what the game's flag does) ─────────────────────────────────────────────────────────────
  P.CautionTimeline = function () {
    const m = this.m;
    if (this.flag !== this.timelineFlag) {
      if (this.flag !== 7 || this.timelineFlag !== 7) {
        this.Log(`caution timeline: flag ${this.timelineFlag} -> ${this.flag} (pace car lap ${m.I32(11339470)}, caution byte ${m.U8(7779163)}${this.holdingOneToGo ? ', Race Control holding one to go' : ''})`);
      }
      this.timelineFlag = this.flag;
      this.gameHoldLogged = false;
    }
    if (this.flag >= 2 && this.flag <= 4 && !this.holdingOneToGo && m.U8(7779163) !== 0 && !this.gameHoldLogged) {
      this.gameHoldLogged = true;
      this.Log(`caution timeline: the game's own caution request is set at flag ${this.flag} (pace car lap ${m.I32(11339470)}): it runs another caution lap`);
    }
  };

  // ── a split field: ask the game for one more caution lap (off by default) ─────────────────────────────────────────────
  P.SplitHoldTick = function () {
    const m = this.m;
    if (this.flag === 0) { this.splitAsked = this.splitReported = false; return; }
    if (this.splitAsked && !this.splitReported && this.flag !== this.splitAskFlag) {
      this.splitReported = true;
      this.Log(this.flag === 4 ? 'field split: the game ran a delayed green - the hold worked' : (this.flag === 7 ? 'field split: the game went green anyway - the caution request at this point has no effect' : 'field split: the game went to flag ' + this.flag + ' after the request (not a delayed green)'));
    }
    if (!this.HoldGreenIfSplit || this.splitAsked || (this.flag !== 5 && this.flag !== 6)) return;
    const list = this.Field();
    if (list == null || list.length < 4) return;
    const list2 = list.map((c, k) => [c, k]).filter(x => !this.GoingAround(x[0].Idx)).sort((x, y) => (x[0].Gap - y[0].Gap) || (x[1] - y[1])).map(x => x[0]);
    for (let i = 1; i < list2.length; i++) {
      const num = list2[i].Gap - list2[i - 1].Gap;
      if (!(num <= 60.0)) {
        this.splitAsked = true; this.splitAskFlag = this.flag;
        m.W8(7779163, 1);
        const why = (ix) => (this.pitted.has(ix) ? ' pitted this caution' : '') + (this.waveLater.has(ix) ? ' wave still queued' : '') + (!this.eligible.has(ix) ? '' : ((this.settle.has(ix) && this.settle.get(ix).FreePass) ? ' free pass' : ' waved/sent around'));
        const wb = why(list2[i].Idx), wa = why(list2[i - 1].Idx);
        this.Log(`field split at flag ${this.flag}: #${list2[i].Num} is ${r0(num)} m behind #${list2[i - 1].Num} (${i} cars ahead of the gap, ${list2.length - i} behind) - asking the game for another caution lap [behind car:${wb.length > 0 ? wb : ' nothing special'}; ahead car:${wa.length > 0 ? wa : ' nothing special'}]`);
        break;
      }
    }
  };

  // ── pace car ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  P.PaceStatesOk = function () {
    if (this.paceStatesOk === null) this.paceStatesOk = this.m.U32(7736740) === PACE_NAME && this.m.I32(7736744) === 29;
    return this.paceStatesOk;
  };

  P.PaceCarTick = function () {
    const m = this.m;
    if (!this.PaceStatesOk()) return;
    const state = m.U32(carState(1));
    const waiting = state === PACE_WAITING;
    if (!waiting) this.paceWaitSeen = false;
    else if (!this.paceWaitSeen && this.PaceFixes) {
      this.paceWaitSeen = true;
      const lt = m.F32(PACE_LEAD_TIME);
      if (lt !== -1000000 && lt !== 1000000 && !Number.isNaN(lt)) {
        if (!this.paceGameLeadFresh) this.Log(`pace car waiting: the game's lead time for this caution is ${r0(lt)} (was read as ${r0(this.paceGameLead)} while parked)`);
        this.paceGameLead = lt;
        this.paceGameLeadFresh = true;
        if (this.paceReleased && this.paceReleasedNow) m.W32(PACE_LEAD_TIME, floatBits(1000000));
      }
    }
    if (!this.PaceCarWaits && this.PaceFixes && this.fieldFrozen && this.flag <= 1 && !this.paceReleased && (waiting || state === PACE_PARKED)) this.NoHoldLeaderJustPast(waiting);
    if (!waiting) {
      if (state === PACE_PARKED && !this.paceReleased && this.PaceFixes && this.PaceCarWaits && this.fieldFrozen && this.flag <= 1) {
        if (!this.paceHolding) {
          if (!this.paceGameLeadFresh) {
            this.paceGameLead = Math.fround(m.F32(PACE_LEAD_TIME));
            if (this.paceGameLead === HOLD_LEAD || this.paceGameLead === 1000000) this.paceGameLead = 0;
          }
          this.paceHolding = true; this.paceHoldStart = this.Now; this.paceHoldLogAt = NaN;
        }
        m.W32(PACE_LEAD_TIME, floatBits(HOLD_LEAD));
        const tl0 = m.F64(14339852);
        const list0 = tl0 > 100.0 ? this.Field() : null;
        if (list0 != null && list0.length > 0) {
          let car = this.paceTarget >= 0 ? (list0.find(c => c.Idx === this.paceTarget) || null) : null;
          if (car == null) { car = list0[0]; this.paceTarget = car.Idx; }
          const g0 = mod(Math.fround(this.DlongOf(1) - this.DlongOf(car.Idx)), tl0);
          if (car.Idx !== this.paceLeader) { this.paceLeader = car.Idx; this.paceLastGap = NaN; this.paceLeaderSpeed = NaN; this.paceGapPrev = NaN; }
          this.LeaderWentBy(car, g0, tl0);
        }
      } else if (this.paceHolding || this.paceReleased) this.PaceCarOut(state);
      return;
    }
    if (this.paceReleased) return;
    if (!this.PaceCarWaits || !this.fieldFrozen || this.flag > 2) {
      if (this.paceHolding) this.ReleasePaceCar('the field is no longer frozen', false);
      return;
    }
    const tl = m.F64(14339852);
    const f = tl > 100.0 ? this.FieldFull() : null;
    const list = f ? f.list : null;
    if (list == null || f.leader == null) return;
    let leader = this.paceTarget >= 0 ? (list.find(c => c.Idx === this.paceTarget) || null) : null;
    if (leader == null) {
      leader = list[0];
      if (this.paceTarget >= 0) this.Log(`pace car held for #${leader.Num} now: #${this.CarNumber(this.paceTarget)} is on pit road or out`);
      this.paceTarget = leader.Idx;
    }
    if (!this.paceHolding) {
      if (!this.paceGameLeadFresh) {
        this.paceGameLead = Math.fround(m.F32(PACE_LEAD_TIME));
        if (this.paceGameLead === HOLD_LEAD || this.paceGameLead === 1000000) this.paceGameLead = 0;
      }
      this.paceHolding = true;
      this.paceHoldStart = this.Now;
      this.paceHoldLogAt = NaN;
    }
    m.W32(PACE_LEAD_TIME, floatBits(HOLD_LEAD));
    const gap = mod(Math.fround(this.DlongOf(1) - this.DlongOf(leader.Idx)), tl);
    if (leader.Idx !== this.paceLeader) { this.paceLeader = leader.Idx; this.paceLastGap = NaN; this.paceLeaderSpeed = NaN; this.paceGapPrev = NaN; }
    if (this.LeaderWentBy(leader, gap, tl)) return;
    const spd = this.PaceFixes ? this.CarSpeed(leader.Idx) : NaN;
    const useSpd = !Number.isNaN(spd) && (spd > 0.5 || leader.Idx !== 0);
    if (Number.isNaN(this.paceLastGap)) { this.paceLastGap = gap; this.paceLastTime = this.Now; }
    else if (this.Now - this.paceLastTime >= 1.0) {
      const d = mod(this.paceLastGap - gap, tl);
      if (d < tl / 4.0) {
        const v = d / (this.Now - this.paceLastTime);
        this.paceLeaderSpeed = Number.isNaN(this.paceLeaderSpeed) ? v : this.paceLeaderSpeed * 0.5 + v * 0.5;
      }
      this.paceLastGap = gap; this.paceLastTime = this.Now;
    }
    if (useSpd) this.paceLeaderSpeed = spd;
    if (useSpd && spd < 2.0 && gap > 30.0) {
      if (Number.isNaN(this.paceTargetStopped)) this.paceTargetStopped = this.Now;
      else if (this.Now - this.paceTargetStopped > 4.0) {
        const car2 = list.find(c => c.Idx !== leader.Idx && leader.Prog - c.Prog < 0.3 && this.CarSpeed(c.Idx) > 5.0);
        if (car2) {
          this.Log(`pace car held for #${car2.Num} now: #${leader.Num} has stopped ${r0(gap)} m from it`);
          this.paceTarget = car2.Idx; this.paceTargetStopped = NaN;
          return;
        }
      }
    } else this.paceTargetStopped = NaN;
    if (!this.paceLogged) {
      this.paceLogged = true;
      this.Log(`pace car held on pit road for leader #${leader.Num} (${r0(gap)} m away): the field is frozen, so it leaves when the leader is ${r0(this.ReleaseDistance(tl))} m from it`);
    }
    if (Number.isNaN(this.paceParkedAt)) this.paceParkedAt = this.DlongOf(1);
    if (Number.isNaN(this.paceHoldLogAt) || this.Now - this.paceHoldLogAt >= 5.0) {
      this.paceHoldLogAt = this.Now;
      this.Log(`pace car held ${r0(this.Now - this.paceHoldStart)} s: leader #${leader.Num} ${r0(gap)} m away at ${r0(Number.isNaN(this.paceLeaderSpeed) ? 0.0 : this.paceLeaderSpeed)} m/s`);
    }
    let rel = this.ReleaseDistance(tl);
    if (!Number.isNaN(this.paceMergeOffset) && !Number.isNaN(this.paceExitTime) && !Number.isNaN(this.paceLeaderAvg)) {
      const x = mod(this.paceLeaderAvg * this.paceExitTime + 60.0 - this.paceMergeOffset, tl);
      if (x >= 50.0 && x <= tl * 0.6) rel = x;
    }
    if (this.PaceFixes && !Number.isNaN(this.paceLeaderAvg) && this.PaceSpeedOk()) {
      const ps = this.TrackPaceSpeed();
      if (!Number.isNaN(ps) && this.paceLeaderAvg < ps * 0.44704) {
        this.Log(`pace car exit: the leader's ${r0(this.paceLeaderAvg)} m/s in it is not used (under the pace speed); the pace car's ${f1(this.paceExitTime)} s and ${r0(this.paceMergeOffset)} m are`);
        this.paceLeaderAvg = NaN;
      }
    }
    let further = false;
    if (this.PaceFixes && !Number.isNaN(this.paceLeaderSpeed) && !Number.isNaN(this.paceMergeOffset) && !Number.isNaN(this.paceExitTime)) {
      const x = this.paceLeaderSpeed * this.paceExitTime + 60.0 - this.paceMergeOffset;
      if (x > rel && x <= tl * 0.6) { rel = x; further = true; }
    }
    rel = Math.max(rel, this.MinRelease(tl));
    if (this.PaceFixes && Number.isNaN(this.paceLeaderSpeed) && this.Now - this.paceHoldStart < 3.0) return;
    const win = !this.PaceFixes ? Math.max(80.0, rel * 0.25) : Math.max(20.0, Math.min(150.0, Math.max(rel * 0.2, 1.5 * (Number.isNaN(this.paceLeaderSpeed) ? 30.0 : this.paceLeaderSpeed))));
    const lo = this.PaceFixes ? Math.max(rel - win, Math.max(50.0, rel * 0.6)) : rel - win;
    const inWindow = gap <= rel && gap >= lo;
    const crawl = !inWindow && (!this.PaceFixes || tl > 2000.0) && !Number.isNaN(this.paceLeaderSpeed) && this.paceLeaderSpeed < 12.0 && this.Now - this.paceHoldStart > 5.0 && gap < Math.min(tl * 0.6, 900.0) && (!this.PaceFixes || gap <= Math.max(rel, 350.0) || this.Now - this.paceHoldStart > 20.0);
    if (inWindow || crawl) {
      this.paceCrawlRelease = crawl;
      this.paceReleaseGap = gap; this.paceReleaseUsed = rel; this.paceSentAt = this.Now;
      this.paceLeaderAtSend = this.DlongOf(leader.Idx);
      this.paceAccelSeen = this.accelLogged;
      this.paceLeaderAtRelease = leader.Idx;
      this.ReleasePaceCar(crawl
        ? `leader #${leader.Num} slowed to ${r0(this.paceLeaderSpeed)} m/s ${r0(gap)} m away, waiting for it (release point ${r0(rel)} m)`
        : `leader #${leader.Num} is ${r0(gap)} m away (${r0(Number.isNaN(this.paceLeaderSpeed) ? 0.0 : this.paceLeaderSpeed)} m/s; sent out at ${r0(rel)} m${further ? ", further out for the leader's speed" : (Number.isNaN(this.PaceReleaseAt) ? ', a first guess for this track' : ', learned here')})`, true);
    } else if (this.Now - this.paceHoldStart > this.PaceHoldLimit(tl)) {
      this.ReleasePaceCar(`held for ${r0(this.PaceHoldLimit(tl))} s`, true);
    }
  };

  P.PaceCarHasLeader = function (leader, trackLen) {
    if (!this.PaceStatesOk()) return true;
    if (!this.PaceCarOnTrack()) return false;
    return leader.Gap <= 200.0;
  };

  P.PaceCarOnTrack = function () {
    const state = this.m.U32(carState(1));
    if (state !== PACE_CAUTION) { if (state === PACE_LEAVING) return !this.OnPitRoad(1); return false; }
    return true;
  };

  P.ReleaseDistance = function (trackLen) {
    const v = Number.isNaN(this.PaceReleaseAt) ? 400.0 : this.PaceReleaseAt;
    return Math.max(this.MinRelease(trackLen), Math.min(trackLen * 0.6, v));
  };

  P.ReleasePaceCar = function (why, now) {
    if (this.paceHolding) {
      this.m.W32(PACE_LEAD_TIME, floatBits(now ? 1000000 : this.paceGameLead));
      this.paceHolding = false; this.paceReleased = true; this.paceReleasedNow = now;
      this.Log('pace car sent out: ' + why);
    }
  };

  P.PaceCarOut = function (state) {
    const m = this.m;
    if (this.accelLogged) this.paceAccelSeen = true;
    if (this.paceHolding || this.paceReleased) {
      const v = Math.fround(m.F32(PACE_LEAD_TIME));
      if (v === -1000000 || v === 1000000) m.W32(PACE_LEAD_TIME, floatBits(this.paceGameLead));
    }
    if (this.paceHolding) { this.paceHolding = false; this.paceReleased = true; }
    if (state !== PACE_CAUTION && this.paceReleased) this.PaceCarExitWatch(state);
    if (state !== PACE_CAUTION || this.paceLeaderAtRelease < 0) {
      if (state === PACE_CAUTION) this.paceReleased = false;
      return;
    }
    const tl = m.F64(14339852);
    if (tl <= 100.0) return;
    const at = this.DlongOf(1);
    let behind = -1, best = Number.MAX_VALUE;
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i !== 1 && this.Running(i) && !this.OnPitRoad(i)) {
        const d = mod(at - this.DlongOf(i), tl);
        if (d < best) { best = d; behind = i; }
      }
    }
    if (behind >= 0) {
      this.Log(`pace car on track ${r0(this.Now - this.paceSentAt)} s after it was sent out: #${this.CarNumber(behind)} right behind it (${r0(best)} m)${behind === this.paceLeaderAtRelease ? ', the leader' : ', not the leader #' + this.CarNumber(this.paceLeaderAtRelease)} (the leader was ${r0(this.paceReleaseGap)} m away when it was sent out)`);
    }
    this.paceMatchArmed = true; this.paceMatchStart = this.Now;
    if (this.paceWentBehind) {
      const ahead = this.Running(this.paceLeaderAtRelease) ? mod(Math.fround(this.DlongOf(this.paceLeaderAtRelease) - at), tl) : NaN;
      this.Log(`pace car on track behind leader #${this.CarNumber(this.paceLeaderAtRelease)} (${r0(ahead)} m in front of it), catching it: release point not changed`);
      this.paceWentBehind = false; this.paceReleased = false; this.paceLeaderAtRelease = -1; this.paceAccelSeen = false; this.paceCrawlRelease = false; this.paceParkedAt = NaN;
      return;
    }
    const took = this.Now - this.paceSentAt;
    let learned = false;
    let timed = took >= 5.0 && took <= 40.0 && (Number.isNaN(this.paceExitTime) || took <= this.paceExitTime * 1.5);
    if (!timed && !Number.isNaN(took)) this.Log(`pace car took ${r0(took)} s to reach the track (${took < 5.0 ? 'too quick to tell' : 'held up by traffic on the way out'}): not used for the timing`);
    if (timed && !Number.isNaN(this.paceParkedAt) && mod(at - this.paceParkedAt, tl) > Math.max(400.0, tl * 0.25)) {
      timed = false;
      this.Log(`pace car counted on track ${r0(mod(at - this.paceParkedAt, tl))} m past its pit road spot (the game switched its state late): not used for the timing`);
    }
    const instant = !Number.isNaN(this.paceHoldStart) && !Number.isNaN(this.paceSentAt) && this.paceSentAt - this.paceHoldStart < 3.0;
    if (instant) timed = false;
    const ps = this.PaceSpeedOk() ? this.TrackPaceSpeed() : NaN;
    const psMs = Number.isNaN(ps) ? NaN : ps * 0.44704;
    let slowLeader = false;
    if (this.PaceFixes && !Number.isNaN(psMs) && this.Running(this.paceLeaderAtRelease) && !Number.isNaN(this.paceLeaderAtSend) && this.Now - this.paceSentAt > 1.0) {
      const avg = mod(this.DlongOf(this.paceLeaderAtRelease) - this.paceLeaderAtSend, tl) / (this.Now - this.paceSentAt);
      if (avg < psMs) {
        slowLeader = true; timed = false;
        this.Log(`pace car release point not changed: the leader averaged ${r0(avg)} m/s while it came out, under the pace speed (${r0(psMs)} m/s)`);
      }
    }
    if (timed && !this.paceAccelSeen && !this.accelLogged && !Number.isNaN(this.paceParkedAt) && !Number.isNaN(this.paceSentAt)) {
      this.paceMergeOffset = mod(at - this.paceParkedAt, tl);
      this.paceExitTime = this.Now - this.paceSentAt;
      if (this.Running(this.paceLeaderAtRelease) && !Number.isNaN(this.paceLeaderAtSend) && this.paceExitTime > 1.0) {
        this.paceLeaderAvg = Math.max(8.0, Math.min(60.0, mod(this.DlongOf(this.paceLeaderAtRelease) - this.paceLeaderAtSend, tl) / this.paceExitTime));
      }
      this.Log(`pace car reaches the track ${r0(this.paceMergeOffset)} m past its pit road spot, ${f1(this.paceExitTime)} s after it is sent, the leader averaging ${r0(this.paceLeaderAvg)} m/s meanwhile: used for the next release here`);
      if (this.PaceExitLearned && !Number.isNaN(this.paceLeaderAvg)) this.PaceExitLearned(`${f1(this.paceExitTime)},${r0(this.paceMergeOffset)},${f1(this.paceLeaderAvg)}`);
      if (!Number.isNaN(this.paceLeaderAvg)) {
        let x = mod(this.paceLeaderAvg * this.paceExitTime + 60.0 - this.paceMergeOffset, tl);
        if (this.PaceFixes && !Number.isNaN(this.PaceReleaseAt) && x >= 50.0 && x <= tl * 0.6) x = Math.max(this.PaceReleaseAt * 0.5, Math.min(this.PaceReleaseAt * 1.5, x));
        if (x >= 50.0 && x <= tl * 0.6) {
          this.PaceReleaseAt = x;
          if (this.PaceReleaseLearned) this.PaceReleaseLearned(x);
          this.Log(`pace car goes when the leader is ${r0(x)} m from it next time here (saved for this track)`);
          learned = true;
        }
      }
    }
    if (this.Running(this.paceLeaderAtRelease) && !this.OnPitRoad(this.paceLeaderAtRelease)) {
      const d = mod(at - this.DlongOf(this.paceLeaderAtRelease), tl);
      const off = d <= tl / 2.0 ? 0.0 - (d - 60.0) : tl - d + 60.0;
      const half = Math.abs(d - tl / 2.0) < tl * 0.15;
      if (slowLeader) { /* already logged */ } else if ((this.accelLogged || this.paceAccelSeen || half || !timed || this.paceCrawlRelease) && Math.abs(off) > 30.0) {
        this.Log('pace car release point not changed: ' + (this.paceCrawlRelease ? 'sent out for a crawling leader' : (half ? "it came out about half a lap from the leader (in front or behind can't be told)" : (instant ? 'it went the moment it was held' : (!timed ? 'held up on the way out' : 'time acceleration was on')))));
      } else if (Math.abs(off) > 30.0 && !learned) {
        const adj = Math.max(-120.0, Math.min(120.0, 0.5 * (this.paceReleaseGap + off - this.paceReleaseUsed)));
        const next = Math.max(50.0, Math.min(tl * 0.85, this.paceReleaseUsed + adj));
        this.Log(`pace car came out ${r0(d <= tl / 2.0 ? d : tl - d)} m ${d <= tl / 2.0 ? 'in front of' : 'behind'} the leader: it goes when the leader is ${r0(next)} m away next time here (was ${r0(this.paceReleaseUsed)})`);
        this.PaceReleaseAt = next;
        if (this.PaceReleaseLearned) this.PaceReleaseLearned(next);
      }
    }
    this.paceReleased = false; this.paceLeaderAtRelease = -1; this.paceAccelSeen = false; this.paceCrawlRelease = false; this.paceParkedAt = NaN;
  };

  // what the cars on pit road in front of a pace car that is on its way out are doing (diagnostics only)
  P.PaceCarExitWatch = function (state) {
    const m = this.m;
    if (Number.isNaN(this.paceSentAt) || this.Now - this.paceSentAt > 120.0 || (!Number.isNaN(this.paceWatchAt) && this.Now - this.paceWatchAt < 4.0)) return;
    this.paceWatchAt = this.Now;
    const tl = m.F64(14339852);
    if (tl <= 100.0) return;
    const base = 11332676;
    const at = this.DlongOf(1);
    const sp = Math.sqrt(Math.pow(m.F32(base + 6634), 2.0) + Math.pow(m.F32(base + 6638), 2.0));
    const list = [];
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i !== 1 && this.Running(i) && this.OnPitRoad(i)) {
        const d = mod(this.DlongOf(i) - at, tl);
        if (!(d > 300.0)) {
          const b = 11323952 + i * 8724;
          const v = Math.sqrt(Math.pow(m.F32(b + 6634), 2.0) + Math.pow(m.F32(b + 6638), 2.0));
          list.push(`#${this.CarNumber(i)} ${r0(d)} m ahead at ${r0(v)} m/s${m.U8(11332070 + i * 8724) !== 0 ? ' (pitting)' : ''}`);
        }
      }
    }
    this.Log(`pace car exit ${r0(this.Now - this.paceSentAt)} s: ${r0(at)} m round the lap at ${r0(sp)} m/s (state 0x${hex(state)}, ${this.OnPitRoad(1) ? 'on pit road' : 'on track, counts as out'})${list.length > 0 ? '; on pit road in front of it: ' + list.join(', ') : '; nothing on pit road in front of it'}`);
  };

  P.ResetPaceCar = function () {
    if (this.paceHolding) { try { this.m.W32(PACE_LEAD_TIME, floatBits(this.paceGameLead)); } catch (e) { /* ignore */ } }
    this.paceHolding = this.paceReleased = this.paceLogged = false;
    this.paceReleasedNow = this.paceWaitSeen = this.paceGameLeadFresh = false;
    this.paceLeader = this.paceLeaderAtRelease = this.paceTarget = -1;
    this.paceTargetStopped = NaN;
    this.paceMatchArmed = this.paceMatchDone = false;
    this.paceLastGap = this.paceLeaderSpeed = this.paceGapPrev = NaN;
    this.paceWentBehind = false;
    this.chaseLeader = -1; this.chaseHeld.clear(); this.chaseLogged.clear(); this.chaseLeadPrev = NaN;
  };

  // ── lapped cars to the low line, lead lap cars high ───────────────────────────────────────────────────────────────────
  P.LineModesOk = function () {
    if (this.lowLineOk === null) this.lowLineOk = this.m.I32(12417372) === 7 && this.m.I32(12417424) === 9;
    return this.lowLineOk;
  };

  P.SetLine = function (idx, mode) {
    const m = this.m;
    m.W32(carLineNext(idx), mode); m.W32(carLine(idx), mode); m.W32(carLineShown(idx), mode);
  };

  P.LappedToDropBack = function (cars) {
    const m = this.m;
    const want = new Map();
    for (const car of cars) {
      const a = m.I32(7777920 + car.Idx * 13), b = m.I32(7777924 + car.Idx * 13);
      if (a >= 0 && a <= 1 && b >= 0) want.set(car.Idx, (b + a) * 2 - a);
    }
    const out = new Set();
    for (const c of cars) {
      if (this.Lapped(c) && want.has(c.Idx) && cars.some(o => !this.Lapped(o) && !this.WavedToTail(o.Idx) && want.has(o.Idx) && want.get(o.Idx) < want.get(c.Idx) && o.Gap > c.Gap)) out.add(c.Idx);
    }
    return out;
  };

  P.LowLineTick = function () {
    const m = this.m;
    if (!this.highChecked) { this.highChecked = true; this.RestoreHighBackup(); }
    if (!this.LappedDropLow || (!this.WaveAroundOn && !this.LappedToBack) || this.flag < 2 || this.flag > 4) {
      if (this.lowSince.size > 0 || this.highOrig != null) this.EndLowLine(this.flag >= 5 ? 'one to go' : 'caution over');
      this.lowRefused.clear();
      this.lowWaitLogged = false;
      return;
    }
    if (!this.LineModesOk()) return;
    if (m.U32(12417440) === 0) {
      if (!this.lowLogged) { this.lowLogged = true; this.Log("lapped cars can't be moved to the low line here: the track has no limp.lp"); }
      return;
    }
    const list = this.Field();
    if (list == null) return;
    const drop = this.LappedToDropBack(list);
    if (this.LappedHoldUntilPitsDone && this.lowSince.size === 0 && drop.size > 0 && !this.PitCycleDone()) {
      if (!this.lowWaitLogged) this.Log('lapped car(s) behind the leader' + Array.from(drop).map(i => ' #' + this.CarNumber(i)).join('') + ' keep their spots while the pit stops go on; they drop to the low line once the stops are done');
      this.lowWaitLogged = true;
      return;
    }
    const added = [];
    for (const i of drop) {
      if (this.lowSince.has(i)) this.lowClearSince.delete(i);
      else if (!this.lowRefused.has(i) && !this.OnPitRoad(i) && m.U32(carLine(i)) === LINE_RACE) {
        this.SetLine(i, LINE_LIMP);
        this.lowSince.set(i, this.Now);
        added.push(i);
      }
    }
    if (added.length > 0) this.Log('low line for lapped car(s)' + added.map(i => ' #' + this.CarNumber(i)).join('') + ': they drop back below the groove while the lead lap cars go by');
    const back = [];
    for (const i of Array.from(this.lowSince.keys())) {
      if (!this.Running(i) || this.OnPitRoad(i) || m.U32(carLine(i)) !== LINE_LIMP) {
        this.lowSince.delete(i); this.lowClearSince.delete(i);
        if (this.Running(i) && !this.OnPitRoad(i) && !this.lowRefused.has(i)) {
          this.lowRefused.add(i);
          this.Log('#' + this.CarNumber(i) + ' was taken off the low line by the game (now in another line mode): left alone this caution');
        }
      } else if (!drop.has(i)) {
        if (!this.lowClearSince.has(i)) this.lowClearSince.set(i, this.Now);
        else if (!(this.Now - this.lowClearSince.get(i) < 2.0)) {
          this.SetLine(i, LINE_RACE);
          this.lowSince.delete(i); this.lowClearSince.delete(i);
          back.push(i);
        }
      }
    }
    if (back.length > 0) this.Log('back on the race line, behind the lead lap cars:' + back.map(i => ' #' + this.CarNumber(i)).join(''));
    this.HighLineTick();
  };

  P.HighLineTick = function () {
    if (this.LeadLapHighShare > 0.0 && this.lowSince.size > 0) {
      this.highClearSince = NaN;
      if (this.highOrig == null) this.ApplyHighLine();
    } else if (this.highOrig != null) {
      if (Number.isNaN(this.highClearSince)) this.highClearSince = this.Now;
      else if (this.Now - this.highClearSince >= 2.0) this.RestoreHighLine('the lapped cars are behind the lead lap cars');
    }
  };

  P.ApplyHighLine = function () {
    const m = this.m;
    const n = m.I32(12122784), race = m.U32(12417376), maxl = m.U32(12417380), minl = m.U32(12417384), limp = m.U32(12417428);
    if (n < 20 || n > 20000 || race === 0 || maxl === 0 || minl === 0 || limp === 0 || race === maxl || race === minl) return;
    let dMax = 0.0, dMin = 0.0;
    for (let i = 0; i < n; i += 8) {
      const ref = m.F32(limp + i * 28 + 20);
      dMax += Math.abs(Math.fround(m.F32(maxl + i * 28 + 20) - ref));
      dMin += Math.abs(Math.fround(m.F32(minl + i * 28 + 20) - ref));
    }
    const high = dMax >= dMin ? maxl : minl;
    const orig = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      orig[j] = m.F32(race + j * 28 + 20);
      if (Number.isNaN(orig[j]) || Math.abs(orig[j]) > 200) return;
    }
    this.highOrig = orig; this.highArray = race; this.highPoints = n;
    this.SaveHighBackup();
    const share = Math.max(0.0, Math.min(1.0, this.LeadLapHighShare));
    for (let k = 0; k < n; k++) {
      const v = m.F32(high + k * 28 + 20);
      if (!Number.isNaN(v) && !(Math.abs(v) > 200)) {
        let d = share * Math.fround(v - orig[k]);
        const pull = Math.max(0.0, Math.min(Math.abs(d), this.LeadLapHighPull));
        d -= Math.sign(d) * pull;
        m.W32(race + k * 28 + 20, floatBits(Math.fround(orig[k] + d)));
      }
    }
    this.Log(`high line for the lead lap cars: the race line is moved ${r0(share * 100.0)}% of the way to the high groove (bound +0x${(high === maxl ? 16 : 20).toString(16).toUpperCase()}), ${f1(this.LeadLapHighPull)} m back from the wall side, while the lapped cars drop back low`);
  };

  P.RestoreHighLine = function (why) {
    if (this.highOrig == null) return;
    const m = this.m;
    try {
      if (m.U32(12417376) === this.highArray && m.I32(12122784) === this.highPoints) {
        for (let i = 0; i < this.highPoints; i++) m.W32(this.highArray + i * 28 + 20, floatBits(this.highOrig[i]));
      }
      this.Log('race line back where it was (' + why + ')');
    } catch (e) { if (!(e instanceof GameMemoryError)) throw e; }
    this.highOrig = null; this.highClearSince = NaN;
    this.DeleteHighBackup();
  };

  // the moved race line is also written to a file, so a RaceControl that did not close properly can put it back at the next start
  P.SaveHighBackup = function () {
    if (!this.highBackupPath) return;
    try {
      const fs = require('fs'), path = require('path');
      let s = this.TrackName + '\n' + this.highArray + '\n' + this.highPoints + '\n';
      for (const f of this.highOrig) s += floatBits(f) + '\n';
      fs.mkdirSync(path.dirname(this.highBackupPath), { recursive: true });
      fs.writeFileSync(this.highBackupPath, s);
    } catch (e) { /* ignore */ }
  };
  P.DeleteHighBackup = function () { if (this.highBackupPath) { try { require('fs').unlinkSync(this.highBackupPath); } catch (e) { /* ignore */ } } };
  P.RestoreHighBackup = function () {
    if (!this.highBackupPath) return;
    try {
      const fs = require('fs');
      if (!fs.existsSync(this.highBackupPath)) return;
      const lines = fs.readFileSync(this.highBackupPath, 'utf8').split(/\r?\n/);
      const arr = parseInt(lines[1], 10), n = parseInt(lines[2], 10), m = this.m;
      if (lines.length >= 3 && lines[0] === this.TrackName && Number.isFinite(arr) && Number.isFinite(n) && lines.length >= 3 + n && m.U32(12417376) === arr && m.I32(12122784) === n) {
        for (let i = 0; i < n; i++) m.W32(arr + i * 28 + 20, parseInt(lines[3 + i], 10));
        this.Log('race line put back from the backup a RaceControl that did not close properly left');
      }
      fs.unlinkSync(this.highBackupPath);
    } catch (e) { /* ignore */ }
  };

  P.LappedStillDropping = function () {
    if (!this.LappedDropLow || (!this.WaveAroundOn && !this.LappedToBack) || !this.LineModesOk()) return false;
    if (this.lowSince.size > 0) return true;
    const list = this.Field();
    if (list != null) return this.LappedToDropBack(list).size > 0;
    return false;
  };

  P.EndLowLine = function (why) {
    const m = this.m;
    const list = [];
    for (const key of this.lowSince.keys()) {
      try {
        if (m.U32(carLine(key)) === LINE_LIMP) { this.SetLine(key, LINE_RACE); list.push(key); }
      } catch (e) { if (!(e instanceof GameMemoryError)) throw e; }
    }
    this.lowSince.clear(); this.lowClearSince.clear(); this.lowRefused.clear();
    if (list.length > 0) this.Log('back on the race line (' + why + '):' + list.map(i => ' #' + this.CarNumber(i)).join(''));
    this.RestoreHighLine(why);
  };
};
