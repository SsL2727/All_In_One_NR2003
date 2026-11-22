// RaceControl engine part: pit road gate bit, wave around, free pass, hold one-to-go, line tidying, settling laps.
'use strict';
const { r0, f2, f1, f3t, pct } = require('../format');
const A = require('../addr');

const mod = (a, b) => { const n = a % b; return n < 0 ? n + b : n; };
const range = (n) => Array.from({ length: n }, (_, i) => i);

module.exports = function (E) {
  const P = E.prototype;

  P.OpenPits = function () {
    const m = this.m;
    const s = m.U16(A.PitState);
    if ((s & 0x100) !== 0) {
      m.W16(A.PitState, (s & -257) | 8);
      if (!this.pitsOpened) this.Log(`pit road opened to all cars (state 0x${s.toString(16).toUpperCase()})`);
      this.pitsOpened = true;
    }
  };

  P.ClearClosedPitPenalties = function () {
    const m = this.m;
    for (let i = 0; i <= this.maxIdx; i++) {
      if (!this.closedLapOffenders.has(i)) {
        const v = m.I32(A.ClosedPitPenalty + i * 4);
        if (v !== 0) {
          m.W32(A.ClosedPitPenalty + i * 4, 0);
          this.Log(`cleared closed-pits penalty on #${this.CarNumber(i)} (0x${(v >>> 0).toString(16).toUpperCase()})`);
        }
      }
    }
  };

  P.CreditLap = function (idx, leader) {
    const m = this.m;
    const num = this.ScoredLaps(idx);
    if (num < 0 || num + 1 >= 512) return false;
    const base = A.CrossTable + idx * 2048;
    const n3 = m.U32(base + num * 4);
    const n4 = m.U32(base + (num + 1) * 4);
    if ((n3 & 0x1FFFFFFF) === 0 || (n4 & 0x1FFFFFFF) !== 0) {
      this.Log(`skipped lap credit for #${this.CarNumber(idx)} (scoring row not as expected)`);
      return false;
    }
    const n5 = (m.U32(A.CrossTable + leader * 2048 + (num + 1) * 4) & 0xF0000000) >>> 0;
    const n6 = (Math.floor(this.GameSeconds() * 1000.0) & 0xFFFFFFF) >>> 0;
    m.W32(base + (num + 1) * 4, ((n6 | n5) >>> 0) | 0);
    m.W32(A.StandingsCache + idx * 16, num + 1);
    return true;
  };

  P.WaveCar = function (c, cars, leadLap, down) {
    const m = this.m;
    if (down === undefined) down = c.Down;
    const pairs = [];
    for (const car of cars) {
      if (car.Idx !== c.Idx) {
        const n = m.I32(A.PacingRow + car.Idx * 13);
        if (n >= 1) pairs.push([n, car]);
      }
    }
    const ordered = pairs.map((p, k) => [p, k]).sort((x, y) => (x[0][0] - y[0][0]) || (x[1] - y[1])).map(x => x[0][1]);
    ordered.push(c);
    this.WriteLine(ordered.map(o => o.Idx));
    const a = A.PaceLap + c.Idx * A.Ocd;
    const was = m.I32(a);
    const pl = (this.PaceFixes && this.PaceLapFit) ? this.PaceLapOneDown(c.Idx) : was - 1;
    m.W32(a, pl);
    if (pl !== was - 1) this.Log(`#${c.Num} pace lap ${was} -> ${pl} to go around the pace car (set to one lap down on it, not minus one)`);
    m.W8(A.PacingWaved + c.Idx * 13, 1);
    this.excused.add(c.Idx);
    this.eligible.set(c.Idx, { Down: down, Pitted: false, Passed: false, Restored: false, FromAhead: c.Ahead, LastGap: -1.0, BehindSince: -1.0, RestoredAt: NaN, LapsAtPass: 0 });
    this.settle.set(c.Idx, { Down: leadLap ? 0.0 : Math.max(0.0, Math.floor(down + 0.001) - 1.0), Waved: true, LeadLap: leadLap, Before: down, FreePass: false, Credited: false });
  };

  P.FreePassTick = function () {
    const m = this.m;
    if (!this.FreePassOn || (!this.WaveAroundOn && !this.Classic)) return;
    if (this.freePassDone) { this.FreePassAtOneToGo(); if (!this.freePassPending) this.FreePassWatch(); return; }
    if (this.flag < 2 || this.flag > 5) return;
    const f = this.FieldFull();
    if (f == null) return;
    const { list, leader, first } = f;
    if (this.Classic) {                 // 2004 rules: the Lucky Dog goes once the pace car has the field (or right away when there is no pace car to wait for)
      if (this.flag === 2 && this.PaceStatesOk() && (!this.PaceCarOnTrack() || !(first.Gap <= 200.0))) return;
    } else if (!this.pitsOpen && this.flag < 5 && (!this.PaceCarPickedUp() || this.NotPickedUp(list, leader, true) != null)) return;
    const cand = list.filter(c => this.DownOf(c) >= 1.0 && this.DownOf(c) < 2.0 && !this.eligible.has(c.Idx) && !this.waveLater.has(c.Idx) && !this.pitted.has(c.Idx) && !this.HasPenalty(c.Idx))
      .map((c, k) => [c, k]).sort((x, y) => (this.DownOf(x[0]) - this.DownOf(y[0])) || (x[1] - y[1])).map(x => x[0]);
    const car = cand.length ? cand[0] : null;
    const tl = m.F64(A.TrackLength);
    for (const item of Array.from(this.pitRoadAtCaution).filter(i => this.Running(i) && this.OnPitRoad(i) && !this.HasPenalty(i))) {
      const d = this.DlongOf(item);
      let down = leader.Prog - (this.LapCount(item, d, tl) + d / tl);
      if (this.Classic) down = this.downAtYellow.has(item) ? this.downAtYellow.get(item) : 0;      // C#'s TryGetValue: 0 when missing
      if (down < 1.0 || down >= 2.0 || (car != null && this.DownOf(car) <= down)) continue;
      if (Number.isNaN(this.freePassWaitSince)) this.freePassWaitSince = this.Now;
      if (this.flag < 5 && this.Now - this.freePassWaitSince < 60.0) {
        if (!this.freePassWaitLogged) this.Log(`free pass: waiting for #${this.CarNumber(item)} (${f2(down)} laps behind the leader) to finish its green flag stop`);
        this.freePassWaitLogged = true;
        return;
      }
    }
    this.freePassDone = true;
    if (car == null) { this.Log('free pass: no car one lap down this caution'); return; }
    this.freePassIdx = car.Idx;
    this.freePassTime = this.Now;
    this.decided.set(car.Idx, 'free pass');
    if (this.WavesAtOneToGo && this.FreePassLate) {
      this.freePassPending = true;
      this.freePassDownChosen = this.DownOf(car);
      this.Log(`lucky dog: #${car.Num} (${f2(this.freePassDownChosen)} laps behind the leader, the first car one lap down) gets the free pass at one to go`);
    } else this.SendFreePass(car, list, this.DownOf(car));
  };

  P.FreePassAtOneToGo = function () {
    if (this.freePassPending && this.flag >= 5 && this.flag <= 6) {
      this.freePassPending = false;
      const list = this.Field();
      const car = list ? (list.find(c => c.Idx === this.freePassIdx) || null) : null;
      const why = car == null ? 'out of the race or on pit road' : (this.OnPitRoad(car.Idx) ? 'on pit road' : (this.HasPenalty(car.Idx) ? 'under penalty' : null));
      if (why != null) {
        this.Log(`lucky dog: #${this.CarNumber(this.freePassIdx)} not sent around at one to go (${why}): no free pass this caution`);
        this.freePassIdx = -1;
      } else {
        this.freePassTime = this.Now;
        this.SendFreePass(car, list, this.DownOf(car));
      }
    }
  };

  P.SendFreePass = function (dog, cars, down) {
    this.WaveCar(dog, cars, false, down);
    const st = this.settle.get(dog.Idx);
    st.Down = Math.max(0.0, Math.floor(down + 0.001) - 1.0);
    st.FreePass = true;
    this.Log(`free pass: #${dog.Num} (${f2(down)} laps behind the leader${this.Classic && this.downAtYellow.has(dog.Idx) ? ' when the leader took the yellow' : ''}, the first car one lap down) goes around the pace car to get its lap back; restarts at the tail (pit road does not wait for it)`);
  };

  // classic (2004) rules: every car's laps down when the leader took the yellow (the game's scoring then decides who is lapped)
  P.TakeDownAtYellow = function () {
    if (this.downAtYellowTaken || this.flag < 1 || this.flag > 6) return;
    const tl = this.m.F64(A.TrackLength);
    if (tl <= 100.0) return;
    const prog = new Map();
    for (let i = 0; i <= this.maxIdx; i++) if (i !== 1 && this.Running(i)) { const d = this.DlongOf(i); prog.set(i, this.LapCount(i, d, tl) + d / tl); }
    if (prog.size === 0) return;
    this.downAtYellowTaken = true;
    const top = Math.max(...prog.values());
    for (const [k, v] of prog) this.downAtYellow.set(k, top - v);
    const lapped = [...this.downAtYellow].filter(([, v]) => v >= 1.0).map((kv, k) => [kv, k]).sort((a, b) => (a[0][1] - b[0][1]) || (a[1] - b[1])).map(x => '#' + this.CarNumber(x[0][0]));
    this.Log(`laps down when the leader took the yellow: ${prog.size - lapped.length} lead lap, ${lapped.length} lapped${lapped.length > 0 ? ' (' + lapped.join(' ') + ')' : ''}${this.flag > 1 ? '; taken late, at flag ' + this.flag : ''}`);
  };

  P.DownOf = function (c) { return this.Classic && this.downAtYellow.has(c.Idx) ? this.downAtYellow.get(c.Idx) : c.Down; };

  // classic rules: 5 s into the green, the game's scored laps against the laps down at the yellow (the Lucky Dog gets one back)
  P.ScoringCheckTick = function () {
    if (this.scoringSnap == null) return;
    if (this.flag !== 7) { this.scoringSnap = null; return; }
    if (this.Now - this.scoringSnapAt < 5.0) return;
    const snap = this.scoringSnap;
    this.scoringSnap = null;
    const scored = new Map();
    for (const k of snap.keys()) if (this.Running(k)) scored.set(k, this.ScoredLaps(k));
    if (scored.size === 0) return;
    const top = Math.max(...scored.values()), out = [];
    for (const [k, v] of [...scored].map((kv, n) => [kv, n]).sort((a, b) => (this.CarNumber(a[0][0]) - this.CarNumber(b[0][0])) || (a[1] - b[1])).map(x => x[0])) {
      const dog = this.scoringDogs.has(k), was = Math.floor(snap.get(k) + 0.001) - (dog ? 1 : 0), now = top - v;
      if (now < was) out.push(`#${this.CarNumber(k)} ${Math.max(0, was + (dog ? 1 : 0))} down at the yellow${dog ? ' (Lucky Dog)' : ''}, scored ${now} down`);
    }
    this.Log(out.length === 0 ? "scoring check after the green: every car's laps match the yellow" : "scoring check after the green: the game's scoring has gained laps the cars did not earn: " + out.join(', '));
  };

  P.FreePassWatch = function () {
    if (this.freePassIdx >= 0 && this.GoingAround(this.freePassIdx) && !(this.Now - this.freePassTime < 45.0)) {
      this.eligible.get(this.freePassIdx).Restored = true;
      this.GiveBackPaceLap(this.freePassIdx);
      this.sentEarly.delete(this.freePassIdx);
      this.Log(`free pass: #${this.CarNumber(this.freePassIdx)} did not get around the pace car in 45 s: it drops to the tail and its lap is credited at the green`);
      this.freePassIdx = -1;
    }
  };

  P.WavedToTail = function (idx) {
    const st = this.settle.get(idx);
    return this.eligible.has(idx) && st !== undefined && st.Waved && !st.LeadLap;
  };

  P.HoldOneToGoTick = function () {
    const m = this.m;
    const pitDone = this.PitCycleDone();
    const forLapped = pitDone && !this.holdReleasedOnce && this.LappedStillDropping();
    let hold = this.flag >= 2 && this.flag <= 4 && !this.holdGaveUp && ((this.HoldOneToGoForPits && !pitDone) || forLapped);
    if (hold && forLapped && !this.holdForLappedLogged) {
      this.holdForLappedLogged = true;
      this.Log('one to go held until the lapped cars have dropped behind the lead lap cars');
    }
    const num = m.I32(11339470);
    if (hold && forLapped && (!this.HoldOneToGoForPits || pitDone)) {
      if (this.lappedHoldStartPaceLap < 0) this.lappedHoldStartPaceLap = num;
      else if (num - this.lappedHoldStartPaceLap >= 1) {
        this.holdReleasedOnce = true; hold = false;
        this.Log('one to go no longer held for the lapped cars: 1 extra caution lap for them already');
      }
    }
    if (hold) {
      if (this.holdStartPaceLap < 0 && this.pitsOpen) this.holdStartPaceLap = num;
      if (this.holdStartPaceLap >= 0 && num - this.holdStartPaceLap >= 3) {
        this.holdGaveUp = true; hold = false;
        this.Log('one to go no longer held: 3 extra caution laps for the pit stops already');
      }
    }
    if (hold) {
      if (m.U8(A.Yellow) === 0) m.W8(A.Yellow, 1);
      if (!this.holdLogged) this.Log('one to go held until the pit stops are done and the field is lined up');
      this.holdLogged = true;
      this.holdingOneToGo = true;
    } else if (this.holdingOneToGo) {
      this.holdingOneToGo = false;
      if (pitDone) this.holdReleasedOnce = true;
      if (m.U8(A.Yellow) !== 0 && this.flag !== 7) m.W8(A.Yellow, 0);
      if (!this.holdGaveUp) this.Log(`one to go released: pit stops done${this.holdForLappedLogged ? ' and the lapped cars behind the lead lap cars' : ''} (${this.holdStartPaceLap >= 0 ? Math.max(0, num - this.holdStartPaceLap) : 0} extra caution lap(s))`);
    }
  };

  P.PitCycleDone = function () {
    if (this.earlyLineupDone) return true;
    if (!this.pitsOpen) return false;
    if (range(this.maxIdx + 1).some(i => i !== 1 && this.Running(i) && this.OnPitRoad(i))) { this.cycleQuietSince = NaN; return false; }
    if (Number.isNaN(this.cycleQuietSince)) this.cycleQuietSince = this.Now;
    const all = range(this.maxIdx + 1).every(i => i === 1 || !this.Running(i) || this.decided.has(i));
    if (this.Now - this.cycleQuietSince >= 3.0) {
      if (!all) return this.pitOpenLap >= 0 ? this.lap >= this.pitOpenLap + 2 : false;
      return true;
    }
    return false;
  };

  P.SendAroundEarly = function () {
    const f = this.FieldFull();
    if (f == null) return;
    const { list, first, leader } = f;
    const tl = this.m.F64(A.TrackLength);
    if (leader != null && leader.Gap > tl / 2.0 && !this.pitsOpen) {
      if (!this.paceBehindLeaderLogged) {
        this.paceBehindLeaderLogged = true;
        this.Log(`the pace car is behind the leader #${leader.Num} (${r0(tl - leader.Gap)} m): nobody is sent around until it is in front of the leader`);
      }
      return;
    }
    if (!this.PaceCarPickedUp()) return;
    for (const item of list.filter(c => c.Stuck && !this.eligible.has(c.Idx) && !this.decided.has(c.Idx) && (!this.pitsOpen || (this.stuckAtOpen.has(c.Idx) && !this.pitted.has(c.Idx))))) {
      this.decided.set(item.Idx, 'around');
      this.sentEarly.add(item.Idx);
      this.WaveCar(item, list, true);
      this.Log(`#${item.Num} is on the lead lap (${f2(item.Down)} laps behind the leader) but in front of #${first.Num}, caught behind the pace car: sent around it now to catch the back of the field, pit road waits for it`);
    }
  };

  P.ReleaseWavesTick = function () {
    if (this.waveLater.size === 0) return;
    if (this.WavesAtOneToGo) {
      if (this.flag < 5 || this.flag > 6) return;
      const cars = this.Field();
      for (const [k, v] of Array.from(this.waveLater.entries())) this.ReleaseWave(k, v, 'one to go', cars);
      return;
    }
    const onPit = range(this.maxIdx + 1).filter(i => i !== 1 && this.Running(i) && this.OnPitRoad(i)).length;
    const anyPit = onPit > 0;
    if (anyPit) this.pitsQuietSince = NaN;
    else if (Number.isNaN(this.pitsQuietSince)) this.pitsQuietSince = this.Now;
    const allDecided = range(this.maxIdx + 1).every(i => i === 1 || !this.Running(i) || this.decided.has(i));
    const done = !anyPit && this.Now - this.pitsQuietSince >= 3.0 && (allDecided || (this.pitOpenLap >= 0 && this.lap >= this.pitOpenLap + 2));
    const tl = this.m.F64(A.TrackLength);
    if (this.WaveAtLine && tl >= 3203.0 && this.pitsOpen && this.flag >= 2 && this.flag < 5) {
      let list = null;
      for (const [k, v] of Array.from(this.waveLater.entries())) {
        const d = this.DlongOf(k);
        const had = this.waveLineD.has(k), was = this.waveLineD.get(k);
        this.waveLineD.set(k, d);
        if (had && !this.OnPitRoad(k) && this.Running(k) && was > tl * 0.75 && d < tl * 0.25 && tl - was + d < tl * 0.1) {
          if (list == null) list = this.Field();
          this.ReleaseWave(k, v, 'crossed the start/finish line', list);
        }
      }
      if (this.waveLater.size === 0) return;
    }
    let early = false;
    if (!done && this.WaveEarly && allDecided && onPit > 0 && this.flag >= 2 && this.flag < 5) {
      const x = 0.6 * this.waveLater.size + 3.0;
      early = onPit <= Math.max(1, Math.trunc(x / 4.0));
    }
    if (!done && !early && this.flag < 5) return;
    const why = done ? 'the pit stops are done' : (early ? `early: ${this.waveLater.size} waved, ${onPit} car(s) still on pit road` : 'one to go');
    const list = this.Field();
    for (const [k, v] of Array.from(this.waveLater.entries())) this.ReleaseWave(k, v, why, list);
  };

  P.WaveStillOk = function (c) {
    if (this.OnPitRoad(c.Idx)) return 'on pit road';
    if (this.HasPenalty(c.Idx)) return 'under penalty';
    if (c.Down < 1.0) return 'no longer a lap down';
    if (!c.Ahead) return 'not in front of the lead lap cars any more';
    return null;
  };

  P.ReleaseWave = function (idx, down, when, cars) {
    this.waveLater.delete(idx);
    this.waveLineD.delete(idx);
    const car = cars ? (cars.find(o => o.Idx === idx) || null) : null;
    if (car == null || this.pitted.has(idx)) {
      this.decided.set(idx, 'pitted');
      this.Log(`#${this.CarNumber(idx)} pitted (or is out) before its wave around: not waved`);
      return;
    }
    const why = this.WavesAtOneToGo ? this.WaveStillOk(car) : null;
    if (why != null) {
      this.decided.set(idx, 'behind');
      this.Log(`wave around: #${car.Num} stays in line at one to go: ${why}`);
    } else {
      this.WaveCar(car, cars, false, down);
      this.Log(`wave around: #${car.Num} goes around the pace car now (${when}), ${f2(down)} laps down at its first time by, and restarts at the tail of the field`);
    }
  };

  P.WaitingForOneToGo = function (idx) {
    if (!this.WavesAtOneToGo) return false;
    if (this.waveLater.has(idx)) return true;
    return this.freePassPending ? idx === this.freePassIdx : false;
  };

  P.FirstPassTick = function () {
    let any = false;
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i !== 1 && !this.decided.has(i)) {
        if (this.pitted.has(i) && this.pitsOpen) this.decided.set(i, 'pitted');
        else if (this.readyToDecide.has(i)) any = true;
      }
    }
    if (!any || this.flag < 2) return;
    const f = this.FieldFull();
    if (f == null) return;
    const { list, leader, first } = f;
    if (this.PaceFixes && leader != null && leader.Gap > this.m.F64(A.TrackLength) / 2.0 && !this.pitsOpen) return;
    if (this.leaderIdx < 0) this.leaderIdx = leader.Idx;
    for (const item of list) {
      if (!this.decided.has(item.Idx) && this.readyToDecide.has(item.Idx) && !this.pitted.has(item.Idx)) {
        if (!item.Ahead) this.decided.set(item.Idx, item.Down < 1.0 ? 'lead' : 'behind');
        else if (item.Stuck) {
          this.decided.set(item.Idx, 'around');
          this.WaveCar(item, list, true);
          this.Log(`#${item.Num} is on the lead lap (${f2(item.Down)} laps behind the leader) but in front of #${first.Num}: around the pace car to its place on the lead lap, no lap gained`);
        } else if (this.HasPenalty(item.Idx)) {
          this.decided.set(item.Idx, 'penalty');
          this.Log(`#${item.Num} stayed out ahead of the first lead lap car but is under penalty, not waved`);
        } else {
          this.decided.set(item.Idx, 'waved');
          this.waveLater.set(item.Idx, item.Down);
          this.Log(`wave around: #${item.Num} stayed out in front of every lead lap car on track (first: #${first.Num}), ${f2(item.Down)} laps behind the leader -> keeps its spot until the pit stops are done, then around the pace car to the tail`);
        }
      }
    }
  };

  P.FollowWavedCars = function () {
    const m = this.m;
    const tl = m.F64(A.TrackLength);
    if (tl <= 100.0) return;
    const paceD = this.DlongOf(1);
    for (const [key, v] of this.eligible) {
      if (v.Restored || v.Pitted || this.OnPitRoad(key)) continue;
      const gap = mod(paceD - this.DlongOf(key), tl);
      if (!v.Passed && v.LastGap >= 0.0 && v.LastGap < tl * 0.25 && gap > tl * 0.75) {
        v.Passed = true; v.LapsAtPass = this.LapsOf(key);
        this.Log(`waved #${this.CarNumber(key)} passed the pace car`);
      }
      v.LastGap = gap;
      if (!v.Passed || this.LapsOf(key) <= v.LapsAtPass) continue;
      v.Restored = true; v.RestoredAt = this.Now;
      if (!this.RestorePaceLap) { this.Log(`waved #${this.CarNumber(key)} crossed the line after passing the pace car (lap gained on track)`); continue; }
      const a = A.PaceLap + key * A.Ocd;
      const n4 = m.I32(a), n5 = m.I32(11339470);
      if (n4 < n5) m.W32(a, n5);
      this.Log(`waved #${this.CarNumber(key)} crossed the line after passing the pace car (lap gained on track); pace lap ${n4} -> ${Math.max(n4, n5)} so it lines up in the field`);
    }
  };

  P.CreditWavesTick = function () {
    let list = null, leader = null;
    for (const [key, v] of this.eligible) {
      if (!v.Restored || Number.isNaN(v.RestoredAt) || this.Now - v.RestoredAt < 2.0) continue;
      v.RestoredAt = NaN;
      const st = this.settle.get(key);
      if (!st || st.Credited || v.Pitted) continue;
      if (this.OnPitRoad(key)) continue;
      if (list == null) { const f = this.FieldFull(); list = f ? f.list : null; leader = f ? f.leader : null; }
      if (list == null) break;
      const car = list.find(o => o.Idx === key);
      if (!car) continue;
      const num = Math.floor(leader.Prog - car.Prog + 0.001);
      if (!(num <= st.Down)) {
        if (this.CreditLap(key, leader.Idx)) {
          st.Credited = true;
          this.Log(`#${this.CarNumber(key)} is around: lap credited now (${num} down on track, ${Math.trunc(st.Down)} down after the ${st.FreePass ? 'free pass' : (st.LeadLap ? 'send-around' : 'wave around')})`);
        }
      }
    }
  };

  P.GoingAround = function (idx) {
    const v = this.eligible.get(idx);
    return !!v && !v.Passed && !v.Pitted && !v.Restored;
  };

  P.TidyLine = function () {
    const m = this.m;
    if (this.Now - this.lastTidy < 0.5) return;
    this.lastTidy = this.Now;
    if (this.inside != null || (this.Classic && this.keptBack.size === 0 && ![...this.eligible.keys()].some(k => this.GoingAround(k)))) return;
    const plan = this.planActive && this.lineup != null;
    if (!plan && m.U8(A.NumPacingLines) !== 1) return;
    const list = this.Field();
    if (list == null) return;
    const order = plan ? this.lineup.slice() : this.CurrentLine();
    if (order.length === 0) return;
    const track = new Map(list.map(c => [c.Idx, c]));
    const going = list.filter(c => this.GoingAround(c.Idx) && order.includes(c.Idx)).map((c, k) => [c, k]).sort((x, y) => (x[0].Gap - y[0].Gap) || (x[1] - y[1])).map(x => x[0].Idx);
    const pits = this.Classic ? [] : order.filter(i => this.Running(i) && this.OnPitRoad(i));
    const rest = order.filter(i => !going.includes(i) && !pits.includes(i));
    const lapped = new Set(list.filter(o => o.Down >= 1.0 && !this.eligible.has(o.Idx) && !this.waveLater.has(o.Idx)).map(o => o.Idx));
    const action = (idx, why) => {
      const at = rest.indexOf(idx); if (at >= 0) rest.splice(at, 1);
      const c = track.get(idx);
      const lead = !this.WavedToTail(idx) && (plan || !this.eligible.has(idx)) && (this.eligible.has(idx) || (c !== undefined && c.Down < 1.0));
      const num = lead ? rest.findIndex(x => lapped.has(x)) : -1;
      rest.splice(num < 0 ? rest.length : num, 0, idx);
      this.Log(`#${this.CarNumber(idx)} ${why}: to the end of the ${lead ? 'lead lap cars' : 'line'}`);
    };
    for (const item of Array.from(this.keptBack).filter(i => !this.GoingAround(i) && !pits.includes(i))) {
      this.keptBack.delete(item);
      if (rest.includes(item)) {
        const el = this.eligible.get(item);
        action(item, el.Pitted ? '(sent around) pitted and is back on track' : (el.Passed ? '(sent around) is past the pace car' : '(sent around) stays at the back'));
      }
    }
    for (const item of Array.from(this.pitMoved).filter(i => !pits.includes(i) && !going.includes(i))) {
      this.pitMoved.delete(item);
      if (rest.includes(item)) action(item, 'is back on track from pit road');
    }
    for (const it of going) {
      if (!this.keptBack.has(it)) { this.keptBack.add(it); this.Log(`waved #${this.CarNumber(it)} goes to the end of the line until it has passed the pace car`); }
    }
    for (const idx2 of pits) {
      if (!this.pitMoved.has(idx2)) {
        this.pitMoved.add(idx2);
        if (rest.concat(going).some(o => order.indexOf(o) > order.indexOf(idx2))) this.Log(`#${this.CarNumber(idx2)} is on pit road: to the end of the line, so cars behind it on track pace on`);
      }
    }
    const list2 = rest.concat(going).concat(pits);
    if (list2.length !== order.length || list2.some((v, i) => v !== order[i])) {
      if (plan) { this.lineup = list2; this.WritePlan(); } else this.WriteLine(list2);
    }
  };

  P.CurrentLine = function () {
    const out = [];
    for (let i = 0; i < 48; i++) {
      const n = this.m.I32(A.PacingOutside1st + i * 8);
      if (n >= 0 && n <= this.maxIdx && n !== 1 && !out.includes(n)) out.push(n);
    }
    return out;
  };

  P.FirstTimeBySummary = function () {
    const f = (d) => {
      const t = Array.from(this.decided.entries()).filter(kv => kv[1] === d).sort((a, b) => a[0] - b[0]).map(kv => ' #' + this.CarNumber(kv[0])).join('');
      return t !== '' ? t : ' none';
    };
    return 'first time by summary - free pass:' + f('free pass') + '; waved:' + f('waved') + '; lead lap, sent around to their place:' + f('around') + '; under penalty:' + f('penalty') + '; pitted:' + f('pitted') + '; lapped, stayed out behind the first lead lap car:' + f('behind');
  };

  P.SettleLaps = function () {
    const m = this.m;
    const now = this.Now;
    if (Number.isNaN(this.greenTime)) this.greenTime = now;
    if (now - this.greenTime < 3.0) return false;
    const trackLen = m.F64(A.TrackLength);
    if (trackLen <= 100.0 || this.leaderIdx < 0) { this.Log('green: could not settle laps (track length or leader unknown)'); return true; }
    if (now - this.greenTime < 10.0) {
      const near = (idx) => this.DlongOf(idx) < 40 || this.DlongOf(idx) > trackLen - 40.0;
      if (near(this.leaderIdx) || Array.from(this.settle.keys()).some(near)) return false;
    }
    const prog = (idx) => this.LapsOf(idx) + this.DlongOf(idx) / trackLen;
    const lead = prog(this.leaderIdx);
    for (const [key, v] of Array.from(this.settle.entries()).sort((a, b) => a[0] - b[0])) {
      const n2 = Math.floor(lead - prog(key) + 0.001);
      const text = `#${this.CarNumber(key)} ${v.FreePass ? 'free pass' : (v.LeadLap ? 'sent around (lead lap)' : (v.Waved ? 'waved' : 'not waved'))}: ${f2(v.Before)} behind at the first time by, now ${n2} down (scored ${this.ScoredLaps(this.leaderIdx) - this.ScoredLaps(key)}), should be ${Math.trunc(v.Down)} down`;
      const el = this.eligible.get(key);
      if (v.Waved && !v.FreePass && !v.LeadLap && el && el.Pitted) this.Log('green: ' + text + ' -> pitted after the wave, left as it is');
      else if (v.Waved && v.Credited) this.Log('green: ' + text + ' -> its lap was credited during the caution (the count on track follows at its next crossing)');
      else if (n2 > v.Down && v.Waved) {
        const ok = this.CreditLap(key, this.leaderIdx);
        this.Log('green: ' + text + ' -> ' + (ok ? 'lap credited' : 'lap credit FAILED') + ((n2 - v.Down > 1.0) ? ' (still more laps short than expected - not credited)' : ''));
      } else if (n2 > v.Down) this.Log('green: ' + text + ' -> lost more laps than expected on its own (pit stop or trouble), left as it is');
      else if (v.Waved && n2 === v.Down && lead - prog(key) - n2 > 0.5) this.Log('green: ' + text + ` -> on the right lap but ${f2(lead - prog(key) - n2)} laps behind the leader on track: it never caught the field`);
      else if (n2 < v.Down && lead - prog(key) > v.Down - 0.5) this.Log('green: ' + text + ' -> ok (just ahead of the leader on track at the restart)');
      else if (n2 < v.Down) this.Log('green: ' + text + ' -> GAINED A LAP ON TRACK' + (v.Waved ? ' beyond the wave' : ' without a wave around'));
      else this.Log('green: ' + text + ' -> ok');
    }
    return true;
  };

  P.ResetWave = function () {
    const m = this.m;
    this.pitted.clear(); this.settle.clear(); this.excused.clear(); this.eligible.clear(); this.closedLapOffenders.clear();
    this.decided.clear(); this.keptBack.clear(); this.pitMoved.clear(); this.sentEarly.clear(); this.waveLater.clear(); this.waveLineD.clear();
    this.pitsQuietSince = NaN; this.pitRoadAtCaution.clear(); this.pitRoadAtCautionTaken = false; this.stopped.clear();
    if (this.holdingOneToGo && m.U8(A.Yellow) !== 0 && this.flag !== 7) m.W8(A.Yellow, 0);
    this.holdingOneToGo = this.holdLogged = this.holdGaveUp = this.holdForLappedLogged = this.holdReleasedOnce = this.paceBehindLeaderLogged = false;
    this.holdStartPaceLap = this.lappedHoldStartPaceLap = -1; this.cycleQuietSince = NaN;
    this.freePassIdx = -1; this.freePassDone = this.freePassPending = false; this.freePassWaitSince = NaN; this.freePassWaitLogged = false;
    this.requestsLogged.clear(); this.stopCalledOff.clear();
    this.downAtYellow.clear(); this.downAtYellowTaken = false;
    this.ResetPits();
    this.leaderIdx = -1; this.pitOpenLap = -1; this.pitsOpened = this.firstPassStarted = false; this.greenTime = NaN;
  };

  P.WaveTick = function () {
    const m = this.m;
    this.LearnPitEntry();
    this.WatchPenalties();
    this.WatchPenaltyStopFlag();
    this.WatchWavedCrossings();
    this.ForgiveTick();
    this.ScoringCheckTick();
    if (this.flag === 7) {
      this.pitRoadAtCautionTaken = false;
      if (this.Classic && this.downAtYellowTaken && this.scoringSnap == null && Number.isNaN(this.greenTime)) {
        this.scoringSnap = new Map(this.downAtYellow);
        this.scoringDogs = new Set([...this.settle].filter(([, v]) => v.FreePass).map(([k]) => k));
        this.scoringSnapAt = this.Now;
        this.downAtYellowTaken = false;
      }
      this.ReleaseClosedBit();
      this.Excuse();
      if ((this.settle.size <= 0 || this.SettleLaps()) && (this.CautionHappened || this.LineupHappened)) { this.ResetWave(); this.ResetLineup(); }
      return;
    }
    if (!Number.isNaN(this.greenTime)) {
      this.Log('new caution before the wave around laps were settled; settling skipped');
      this.watched.clear(); this.ResetWave(); this.ResetLineup();
    }
    this.Excuse();
    this.WatchPitRequests();
    if (this.Classic) this.TakeDownAtYellow();
    if (!this.pitRoadAtCautionTaken) {
      this.pitRoadAtCautionTaken = true;
      this.pitRoadAtCaution.clear();
      for (let i = 0; i <= this.maxIdx; i++) {
        if (i !== 1 && this.Running(i) && this.OnPitRoad(i) && !this.pitRoadAtCaution.has(i)) {
          this.pitRoadAtCaution.add(i);
          this.Log(`#${this.CarNumber(i)} was on pit road when the caution came out (a green flag stop): not counted as pitting under the caution`);
        }
      }
    }
    if (this.flag <= 4) {
      for (let j = 0; j <= this.maxIdx; j++) {
        if (j === 1) continue;
        if (!this.OnPitRoad(j)) this.pitRoadAtCaution.delete(j);
        else if (!this.pitRoadAtCaution.has(j) || this.pitsOpen) {
          this.pitted.add(j);
          const v = this.eligible.get(j);
          if (v && !v.Pitted) { v.Pitted = true; this.Log(`waved #${this.CarNumber(j)} is pitting`); }
        }
      }
    }
    const wasOpen = this.pitsOpen;
    if (this.WaveAroundOn && this.PitsClosedFirstLap && (!this.pitsOpen || this.stuckAtOpen.size > 0) && this.flag >= 2 && this.flag <= 4) this.SendAroundEarly();
    this.FreePassTick();
    const nowOpen = this.flag <= 6 && this.PitsOpenTick();
    if (nowOpen && !wasOpen) {
      for (let k = 0; k <= this.maxIdx; k++) if (m.I32(A.ClosedPitPenalty + k * 4) !== 0) this.closedLapOffenders.add(k);
    }
    if (nowOpen && this.OpenPitsToAll && this.flag >= 1 && this.flag <= 4) this.OpenPits();
    this.PerCarGateTick();
    if (this.ClearClosedPitPenalty && nowOpen && this.OpenPitsToAll && this.flag >= 1 && this.flag <= 4) this.ClearClosedPitPenalties();
    if (nowOpen && !this.firstPassStarted) {
      this.firstPassStarted = true;
      this.watched.clear();
      this.pitOpenLap = this.lap;
      this.StartEntryWatch();
    }
    if (this.firstPassStarted && this.flag <= 4) this.EntryWatchTick();
    if (this.WaveAroundOn && this.firstPassStarted && this.flag >= 1 && this.flag <= 4) this.FirstPassTick();
    if (this.flag >= 1 && this.flag <= 6) this.ReleaseWavesTick();
    if (this.flag >= 1 && this.flag <= 5) this.DroppedBackTick();
    this.HoldOneToGoTick();
    if (this.flag >= 1 && this.flag <= 6) this.FollowWavedCars();
    if (this.flag >= 1 && this.flag <= 6) this.CreditWavesTick();
    if (this.flag >= 1 && this.flag <= 5) this.TidyLine();
  };

  P.WriteLine = function (order) {
    const m = this.m;
    m.W8(A.NumPacingLines, 1);
    for (let i = 0; i < 48; i++) {
      const n = i < order.length ? order[i] : -1;
      m.W32(A.PacingOutside1st + i * 8, n);
      if (n >= 0) { m.W32(A.PacingLineIdx + n * 13, 0); m.W32(A.PacingRow + n * 13, i + 1); }
    }
  };

  P.WriteLanes = function (ins, outs) {
    const m = this.m;
    m.W8(A.NumPacingLines, 2);
    for (let i = 0; i < 48; i++) {
      const a = i < ins.length ? ins[i] : -1;
      const b = i < outs.length ? outs[i] : -1;
      m.W32(A.PacingInside1st + i * 8, a);
      m.W32(A.PacingOutside1st + i * 8, b);
      if (a >= 0) { m.W32(A.PacingLineIdx + a * 13, 1); m.W32(A.PacingRow + a * 13, i); }
      if (b >= 0) { m.W32(A.PacingLineIdx + b * 13, 0); m.W32(A.PacingRow + b * 13, i + 1); }
    }
  };

  P.WritePlan = function () {
    this.planKey.clear();
    if (this.inside != null) {
      this.WriteLanes(this.inside, this.outside);
      this.inside.forEach((v, i) => this.planKey.set(v, 2 * i));
      this.outside.forEach((v, j) => this.planKey.set(v, 2 * j + 1));
    } else {
      this.WriteLine(this.lineup);
      this.lineup.forEach((v, k) => this.planKey.set(v, 2 * k));
    }
    this.planActive = true; this.planTime = this.Now; this.planRestoredLogged = false;
  };

  P.PlanIntact = function () {
    const m = this.m;
    if (this.inside != null) {
      if (m.U8(A.NumPacingLines) !== 2) return false;
      for (let i = 0; i < this.inside.length; i++) if (m.I32(A.PacingInside1st + i * 8) !== this.inside[i]) return false;
      for (let j = 0; j < this.outside.length; j++) if (m.I32(A.PacingOutside1st + j * 8) !== this.outside[j]) return false;
      return true;
    }
    if (m.U8(A.NumPacingLines) !== 1) return false;
    for (let k = 0; k < this.lineup.length; k++) {
      if (m.I32(A.PacingOutside1st + k * 8) !== this.lineup[k] || m.I32(A.PacingRow + this.lineup[k] * 13) !== k + 1) return false;
    }
    return true;
  };

  P.HoldPlan = function () {
    if (!this.planActive) return;
    if (this.Now - this.lastPlanUpkeep >= 0.5) {
      this.lastPlanUpkeep = this.Now;
      if (this.KeepPlanInStep()) { this.WritePlan(); return; }
    }
    if (!this.PlanIntact()) {
      if (this.inside != null) this.WriteLanes(this.inside, this.outside); else this.WriteLine(this.lineup);
      if (!this.planRestoredLogged) this.Log('the game re-ordered the line; ours put back (cars keep their spot and lane)');
      this.planRestoredLogged = true;
    }
  };
};
