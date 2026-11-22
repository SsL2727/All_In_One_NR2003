// RaceControl engine part (RaceControl 3.3.x, github.com/NR2003-JT/RaceControl): the caution line kept in the order at the yellow,
// pace laps fitted to the line, the pace car chasing a leader that went by it, tail catch-up, pace car speed matching (track.ini pace speed)
// and the calls to the player's own car (penalty / wave around / free pass / FOLLOW #N). A port of the C# source, parity-tested in tools/rcparity.
'use strict';
const { r0, f1 } = require('../format');
const { GameMemoryError } = require('../gamemem');

const mod = (a, b) => { const n = a % b; return n < 0 ? n + b : n; };
const fr = Math.fround;
// .NET Math.Round: half to even
const roundEven = (x) => { const f = Math.floor(x), d = x - f; if (d > 0.5) return f + 1; if (d < 0.5) return f; return f % 2 === 0 ? f : f + 1; };
// .NET "0.#"
const f1t = (v) => { const s = f1(v); return s.endsWith('.0') ? s.slice(0, -2) : s; };
const FB = Buffer.alloc(4);
const floatBits = (f) => { FB.writeFloatLE(f, 0); return FB.readInt32LE(0); };

const TRACK_LEN = 14339852, PACE_LAP = 11339470, LINE_COUNT = 7778540, LAGGING = 7795345, PACE_LEAD_TIME = 7736756;
const PACE_WAITING = 7736736, PACE_PARKED = 7736880, PACE_CAUTION = 7736648;
const PACE_SPEED = 7647360, PACE_SPEED_KEY = 7647352, PACE_SPEED_NAME = 7643024;
const carPaceLap = (i) => 11330746 + i * 8724;
const lineByte = (i) => 7777928 + i * 13;
const carState = (i) => 11328983 + i * 8724;

module.exports = function (E) {
  const P = E.prototype;

  P.InitPaceFix = function () {
    // options (C# field defaults; the service sets RaceControl's own defaults)
    this.PaceFixes = false; this.PaceLapFit = true; this.TailCatchUp = true; this.PaceMatch = false; this.PaceExitLearned = null; this.GameFolder = null;
    this.WaveEarly = true; this.WavesAtOneToGo = true; this.WaveAtLine = true; this.FreePassLate = false; this.LeadLapHighPull = 1.0;
    // caution line
    this.yellowOrder = null; this.yellowSlow = new Set(); this.slowSince = new Map(); this.lineSpeedAt = new Map(); this.lineSpeed = new Map();
    this.lineFixes = 0; this.lineFixLogAt = NaN; this.yellowPit = new Set(); this.yellowD = new Map(); this.tieSince = new Map(); this.tieSwapped = new Set();
    this.tailLowered = new Map(); this.fitPending = new Map(); this.fitWrites = 0;
    // pace car
    this.paceTarget = -1; this.paceTargetStopped = NaN; this.paceReleasedNow = false; this.paceWaitSeen = false; this.paceGameLeadFresh = false;
    this.paceGapPrev = NaN; this.paceWentBehind = false; this.chaseLeader = -1; this.chaseHeld = new Set(); this.chaseLogged = new Set(); this.chaseLeadPrev = NaN;
    this.paceSpeedOk = null; this.paceMatchArmed = false; this.paceMatchDone = false; this.paceMatchLogged = false; this.paceMatchStart = NaN;
    this.paceMatchLastStep = NaN; this.paceMatchLogAt = NaN; this.paceSpeedTrack = NaN; this.paceSpeedWritten = NaN; this.paceSpeedFor = undefined;
    // wave arounds / free pass
    this.waveLineD = new Map(); this.freePassPending = false; this.freePassDownChosen = 0;
    // player calls
    this.PlayerCall = ''; this.PlayerCallKind = 0; this.callLogged = ''; this.penaltyLogged = '';
    this.clockStill = 0;
  };

  // "a,b,c" saved per track: the pace car's exit time, merge offset and the leader's average speed meanwhile
  P.SetPaceExitSaved = function (value) {
    const a = String(value == null ? '' : value).split(',');
    const num = (s) => { const t = String(s).trim(); return t !== '' && Number.isFinite(Number(t)) ? Number(t) : NaN; };
    if (a.length !== 3) return;
    const r = num(a[0]), r2 = num(a[1]), r3 = num(a[2]);
    if (Number.isNaN(r) || Number.isNaN(r2) || Number.isNaN(r3)) return;
    if (r > 1.0 && r < 60.0 && r2 >= 0.0 && r3 > 5.0 && r3 < 80.0 && Number.isNaN(this.paceExitTime)) {
      this.paceExitTime = r; this.paceMergeOffset = r2; this.paceLeaderAvg = r3;
    }
  };

  P.CarSpeed = function (idx) {
    const b = 11330586 + idx * 8724;
    const x = this.m.F32(b), y = this.m.F32(b + 4);
    const v = Math.sqrt(x * x + y * y);
    return !Number.isNaN(v) && !(v > 150.0) ? v : NaN;
  };

  P.PaceHoldLimit = function (trackLen) {
    let n = Math.max(60.0, trackLen / 24.0);
    const s = (this.PaceFixes && this.PaceSpeedOk()) ? this.TrackPaceSpeed() : NaN;
    if (!Number.isNaN(s) && s > 10) n = Math.max(n, 1.2 * trackLen / (0.6 * s * 0.44704));
    return n;
  };

  P.MinRelease = function (trackLen) { return !this.PaceFixes ? 50 : (trackLen > 3000.0 ? 250 : 80); };

  P.PaceCarPickedUp = function () {
    if (!this.PaceFixes || !this.PaceStatesOk() || this.flag >= 3) return true;
    return this.m.U32(carState(1)) === PACE_CAUTION;
  };

  // ── pace car: not held, the leader just went past it ──────────────────────────────────────────────────────────────────
  P.NoHoldLeaderJustPast = function (waiting) {
    const m = this.m;
    const tl = m.F64(TRACK_LEN);
    if (tl <= 100.0) return;
    const list = this.Field();
    if (list == null || list.length === 0) return;
    const car = list[0];
    const gap = mod(fr(this.DlongOf(1) - this.DlongOf(car.Idx)), tl);
    if (!(gap <= tl * 0.85)) {
      this.paceHolding = false;
      this.paceReleased = this.paceReleasedNow = true;
      this.paceReleaseGap = gap; this.paceReleaseUsed = this.ReleaseDistance(tl); this.paceSentAt = this.Now;
      this.paceLeaderAtSend = this.DlongOf(car.Idx); this.paceAccelSeen = this.accelLogged; this.paceLeaderAtRelease = car.Idx;
      this.paceWentBehind = true; this.chaseLeader = car.Idx; this.chaseLeadPrev = NaN;
      if (waiting) m.W32(PACE_LEAD_TIME, floatBits(1000000));
      this.Log(`pace car sent out: leader #${car.Num} is ${r0(tl - gap)} m past it (pace car not held): out now to catch it from behind, the leader crawls for it`);
    }
  };

  P.LeaderWentBy = function (leader, gap, trackLen) {
    const prev = this.paceGapPrev;
    this.paceGapPrev = gap;
    const first = Number.isNaN(prev) && gap > trackLen * 0.85;
    if (!this.PaceFixes || (!first && (Number.isNaN(prev) || !(prev < trackLen * 0.3) || !(gap > trackLen * 0.7)))) return false;
    this.paceReleaseGap = gap; this.paceReleaseUsed = this.ReleaseDistance(trackLen); this.paceSentAt = this.Now;
    this.paceLeaderAtSend = this.DlongOf(leader.Idx); this.paceAccelSeen = this.accelLogged; this.paceLeaderAtRelease = leader.Idx;
    this.paceWentBehind = true; this.chaseLeader = leader.Idx; this.chaseLeadPrev = NaN;
    this.ReleasePaceCar(`leader #${leader.Num} went by it (${r0(this.CarSpeed(leader.Idx))} m/s): out right behind it to catch it (the game holds the field at a crawl until the pace car gets by the leader)`, true);
    return true;
  };

  // the pace car is out behind the leader: cars between it and the leader get its pace lap and crawl until it gets by
  P.ChaseTick = function () {
    const m = this.m;
    this.chaseHeld.clear();
    if (this.chaseLeader < 0) return;
    const tl = m.F64(TRACK_LEN);
    if (tl <= 100.0) return;
    if (!this.Running(this.chaseLeader) || this.OnPitRoad(this.chaseLeader)) { this.EndChase('leader #' + this.CarNumber(this.chaseLeader) + ' is off the track'); return; }
    const pd = this.DlongOf(1);
    const lead = mod(fr(this.DlongOf(this.chaseLeader) - pd), tl);
    const prev = this.chaseLeadPrev;
    this.chaseLeadPrev = lead;
    const wentBy = !Number.isNaN(prev) && prev < tl * 0.3 && lead > tl * 0.7;
    const inFront = lead > tl * 0.5 && this.CarSpeed(1) > 5.0;
    if (wentBy || inFront) {
      this.EndChase(wentBy ? 'the pace car went by leader #' + this.CarNumber(this.chaseLeader) : 'the pace car came out in front of leader #' + this.CarNumber(this.chaseLeader));
      return;
    }
    const pl = m.I32(PACE_LAP);
    const list = [];
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i === 1 || !this.Running(i) || this.OnPitRoad(i) || mod(fr(this.DlongOf(i) - pd), tl) > lead + 5.0 || (this.PaceLapFit && i !== this.chaseLeader)) continue;
      this.chaseHeld.add(i);
      if (this.tailLowered.has(i)) this.tailLowered.delete(i);
      const a = carPaceLap(i);
      const v = m.I32(a);
      if (v < pl) {
        m.W32(a, pl);
        if (!this.chaseLogged.has(i)) { this.chaseLogged.add(i); list.push('#' + this.CarNumber(i) + (pl - v > 1 ? ' (+' + (pl - v) + ')' : '')); }
      }
    }
    if (list.length > 0) this.Log(`pace car behind leader #${this.CarNumber(this.chaseLeader)} (${r0(lead)} m in front of it): ${list.join(' ')} given the pace car's pace lap so they crawl and the pace car catches them (instead of a lap round to get behind it)`);
  };

  P.EndChase = function (why) {
    if (this.chaseLeader >= 0) {
      if (this.chaseLogged.size > 0) this.Log('pace car catching the leader: done (' + why + ')');
      this.chaseLeader = -1; this.chaseHeld.clear(); this.chaseLogged.clear(); this.chaseLeadPrev = NaN;
    }
  };

  // ── pace speed (track.ini pace_speed_limit_mph) and matching it to the leader ─────────────────────────────────────────
  P.PaceSpeedOk = function () {
    if (this.paceSpeedOk === null) {
      try { this.paceSpeedOk = this.m.U32(PACE_SPEED_KEY) === PACE_SPEED_NAME && this.m.Str(PACE_SPEED_NAME, 32) === 'pace_speed_limit_MPH'; } catch (e) { this.paceSpeedOk = false; }
    }
    return this.paceSpeedOk;
  };

  P.TrackPaceSpeed = function () {
    const m = this.m;
    if (this.paceSpeedFor === this.TrackName) return this.paceSpeedTrack;
    this.paceSpeedFor = this.TrackName;
    this.paceSpeedTrack = NaN;
    const mem = m.F32(PACE_SPEED);
    let src = "the game's memory";
    try {
      const dir = this.GameFolder ? this.GameFolder() : null;
      const fs = require('fs'), path = require('path');
      const ini = (dir == null || !this.TrackName) ? null : path.join(dir, 'tracks', this.TrackName, 'track.ini');
      if (ini != null && fs.existsSync(ini)) {
        for (const line of fs.readFileSync(ini, 'latin1').split(/\r\n|\n|\r/)) {
          const t = line.split(';')[0].trim();
          if (t.toLowerCase().startsWith('pace_speed_limit_mph')) {
            const kv = t.split('=');
            const s = kv.length === 2 ? kv[1].trim() : '';
            const v = s !== '' && Number.isFinite(Number(s)) ? fr(Number(s)) : NaN;
            if (kv.length === 2 && !Number.isNaN(v) && v >= 15 && v <= 150) { this.paceSpeedTrack = v; src = 'track.ini'; }
          }
        }
      }
    } catch (e) { /* ignore */ }
    if (Number.isNaN(this.paceSpeedTrack) && Number.isNaN(this.paceSpeedWritten) && mem >= 15 && mem <= 150) this.paceSpeedTrack = mem;
    if (!Number.isNaN(this.paceSpeedTrack)) {
      this.Log(`pace speed here: ${f1t(this.paceSpeedTrack)} mph (${src})`);
      if (src === 'track.ini' && Math.abs(fr(mem - this.paceSpeedTrack)) > 0.05 && mem >= 5 && mem <= 150) {
        m.W32(PACE_SPEED, floatBits(this.paceSpeedTrack));
        this.Log(`pace speed was ${f1t(mem)} mph in the game's memory: put back to the track's ${f1t(this.paceSpeedTrack)}`);
      }
    }
    return this.paceSpeedTrack;
  };

  P.WritePaceSpeed = function (mph) { this.m.W32(PACE_SPEED, floatBits(mph)); this.paceSpeedWritten = mph; };

  P.RestorePaceSpeed = function (why) {
    if (Number.isNaN(this.paceSpeedWritten)) return;
    try { if (!Number.isNaN(this.paceSpeedTrack) && this.PaceSpeedOk()) this.m.W32(PACE_SPEED, floatBits(this.paceSpeedTrack)); } catch (e) { /* ignore */ }
    if (this.paceMatchLogged) this.Log(`pace car back to ${f1t(this.paceSpeedTrack)} mph (${why})`);
    this.paceSpeedWritten = NaN; this.paceMatchLogged = false;
  };

  P.PaceMatchTick = function () {
    if (!this.PaceMatch || !this.PaceFixes || !this.PaceSpeedOk()) { this.RestorePaceSpeed('speed matching off'); return; }
    const track = this.TrackPaceSpeed();
    if (Number.isNaN(track)) return;
    const tl = this.m.F64(TRACK_LEN);
    let want = track, why = null;
    if (this.paceMatchArmed && !this.paceMatchDone && this.flag <= 2 && tl > 100.0 && this.PaceCarOnTrack()) {
      const f = this.FieldFull();
      const list = f ? f.list : null, leader = f ? f.leader : null;
      const car = list == null ? null : ((leader != null && list.includes(leader)) ? leader : (list[0] || null));
      if (car != null) {
        const gap = car.Gap;
        if (gap <= 70.0) { this.paceMatchDone = true; why = `leader #${car.Num} on its bumper (${r0(gap)} m)`; }
        else if (gap >= tl / 2.0) { this.paceMatchDone = true; why = `leader #${car.Num} more than half a lap back: no slowing for it`; }
        else if (this.Now - this.paceMatchStart > 90.0) { this.paceMatchDone = true; why = 'slowed long enough'; }
        else {
          const k = Math.max(0.6, 1.0 - 0.4 * (gap - 70.0) / 200.0);
          want = fr(roundEven(track * k));
          if (Number.isNaN(this.paceMatchLogAt) || this.Now - this.paceMatchLogAt >= 5.0) {
            this.paceMatchLogAt = this.Now;
            this.Log(`pace car slowed toward ${r0(want)} mph (track ${f1t(track)}): leader #${car.Num} is ${r0(gap)} m behind it`);
            this.paceMatchLogged = true;
          }
        }
      }
    } else if (this.paceMatchArmed && !this.paceMatchDone && this.flag > 2) {
      this.paceMatchDone = true; why = 'flag ' + this.flag;
    }
    const cur = Number.isNaN(this.paceSpeedWritten) ? track : this.paceSpeedWritten;
    if (Math.abs(fr(cur - want)) < 0.05) {
      if (want === track && !Number.isNaN(this.paceSpeedWritten)) {
        if (this.paceMatchLogged) this.Log(`pace car back to ${f1t(track)} mph${why != null ? ' (' + why + ')' : ''}`);
        this.paceSpeedWritten = NaN; this.paceMatchLogged = false;
      }
    } else if (Number.isNaN(this.paceMatchLastStep) || !(this.Now - this.paceMatchLastStep < 0.25)) {
      this.paceMatchLastStep = this.Now;
      const mph = cur > want ? Math.max(want, fr(cur - 1)) : Math.min(want, fr(cur + 1));
      this.WritePaceSpeed(mph);
      if (why != null && want === track && this.paceMatchLogged) this.Log("pace car speeding back up to the track's " + f1t(track) + ' mph (' + why + ')');
    }
  };

  // ── the caution line in the order at the yellow ───────────────────────────────────────────────────────────────────────
  P.Forfeited = function (idx) { return this.yellowPit.has(idx) || this.yellowSlow.has(idx); };

  P.ResetCautionLine = function () {
    this.yellowOrder = null; this.yellowSlow.clear(); this.slowSince.clear(); this.lineSpeedAt.clear(); this.lineSpeed.clear();
    this.yellowPit.clear(); this.yellowD.clear(); this.tieSince.clear(); this.tieSwapped.clear();
    this.lineFixes = 0; this.lineFixLogAt = NaN;
  };

  P.UntangleYellowTies = function (tl) {
    const list = this.yellowOrder.filter(i => this.Running(i) && !this.OnPitRoad(i) && !this.yellowSlow.has(i));
    const seen = new Set();
    for (let j = 0; j + 1 < list.length; j++) {
      const a = list[j], b = list[j + 1];
      if (!this.yellowD.has(a) || !this.yellowD.has(b)) continue;
      let d = mod(fr(this.yellowD.get(a) - this.yellowD.get(b)), tl);
      if (d > tl / 2.0) d -= tl;
      if (Math.abs(d) > 15.0) continue;
      const ahead = mod(fr(this.DlongOf(b) - this.DlongOf(a)), tl);
      if (ahead > 40.0 || ahead < 8.0 || this.CarSpeed(b) >= 15.0) continue;
      const key = a * 1000 + b;
      if (this.tieSwapped.has(key) || this.tieSwapped.has(b * 1000 + a)) continue;
      seen.add(key);
      if (!this.tieSince.has(key)) this.tieSince.set(key, this.Now);
      else if (!(this.Now - this.tieSince.get(key) < 5.0)) {
        const ia = this.yellowOrder.indexOf(a), ib = this.yellowOrder.indexOf(b);
        this.yellowOrder[ia] = b; this.yellowOrder[ib] = a;
        this.tieSwapped.add(key);
        seen.delete(key);
        this.Log(`caution line: #${this.CarNumber(b)} is ${r0(ahead)} m in front of #${this.CarNumber(a)} on track (side by side at the yellow, ${r0(Math.abs(d))} m apart): they keep the order they have on track`);
        j++;
      }
    }
    for (const k of Array.from(this.tieSince.keys())) if (!seen.has(k)) this.tieSince.delete(k);
  };

  P.TakeYellowOrder = function () {
    if (this.yellowOrder != null) return;
    const tl = this.m.F64(TRACK_LEN);
    if (tl <= 100.0) return;
    const f = this.FieldFull();
    if (f == null || f.leader == null) return;
    const ld = this.DlongOf(f.leader.Idx);
    this.yellowOrder = f.list.filter(c => !this.OnPitRoad(c.Idx)).map((c, k) => [c.Idx, mod(fr(ld - this.DlongOf(c.Idx)), tl), k])
      .sort((x, y) => (x[1] - y[1]) || (x[2] - y[2])).map(x => x[0]);
    this.Log('caution line: order at the yellow, from leader #' + f.leader.Num + ':' + this.yellowOrder.map(i => ' #' + this.CarNumber(i)).join(''));
    for (const i of this.yellowOrder) this.yellowD.set(i, this.DlongOf(i));
    const pit = [];
    for (let j = 0; j <= this.maxIdx; j++) {
      if (j !== 1 && this.Running(j) && this.OnPitRoad(j) && !this.yellowPit.has(j)) { this.yellowPit.add(j); this.yellowSlow.add(j); pit.push(j); }
    }
    if (pit.length > 0) this.Log('caution line: on pit road at the yellow, they give up their spot like a car in the wreck (to the end of the line, and behind their group in the lineup after the pit stops):' + pit.map(i => ' #' + this.CarNumber(i)).join(''));
  };

  P.WatchLineSpeeds = function (tl) {
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i === 1 || !this.Running(i)) continue;
      const d = this.DlongOf(i);
      const was = this.lineSpeedAt.get(i);
      if (was === undefined) this.lineSpeedAt.set(i, [this.Now, d]);
      else if (!(this.Now - was[0] < 0.5)) {
        let dd = mod(fr(d - was[1]), tl);
        if (dd > tl / 2.0) dd = 0.0;
        this.lineSpeed.set(i, dd / (this.Now - was[0]));
        this.lineSpeedAt.set(i, [this.Now, d]);
      }
    }
  };

  P.FixCautionLine = function () {
    this.TakeYellowOrder();
    if (this.yellowOrder == null) return;
    const tl = this.m.F64(TRACK_LEN);
    if (tl <= 100.0) return;
    this.WatchLineSpeeds(tl);
    const speeds = Array.from(this.lineSpeed.entries()).filter(kv => !this.OnPitRoad(kv[0])).map(kv => kv[1]).sort((a, b) => a - b);
    const field = speeds.length > 0 ? speeds[Math.floor(speeds.length / 2)] : 0.0;
    for (const [idx, v] of this.lineSpeed) {
      if (this.yellowSlow.has(idx) || this.OnPitRoad(idx)) continue;
      if (v < 4.0 && field > 8.0) {
        if (!this.slowSince.has(idx)) this.slowSince.set(idx, this.Now);
        else if (this.Now - this.slowSince.get(idx) >= 2.0) {
          this.yellowSlow.add(idx);
          this.Log(`caution line: #${this.CarNumber(idx)} has stopped (${r0(v)} m/s, the field ${r0(field)}): to the end of the line`);
        }
      } else this.slowSince.delete(idx);
    }
    if (this.m.U8(LINE_COUNT) !== 1) return;
    this.UntangleYellowTies(tl);
    const line = this.CurrentLine();
    if (line.length < 2) return;
    const onTrack = (i) => this.Running(i) && !this.OnPitRoad(i);
    const want = this.yellowOrder.filter(i => onTrack(i) && !this.yellowSlow.has(i) && line.includes(i));
    if (want.length === 0) return;
    const lead = want[0];
    const ld = this.DlongOf(lead);
    const extra = line.filter(i => onTrack(i) && !this.yellowSlow.has(i) && !want.includes(i)).map((i, k) => [i, mod(fr(ld - this.DlongOf(i)), tl), k])
      .sort((x, y) => (x[1] - y[1]) || (x[2] - y[2])).map(x => x[0]);
    for (const i of extra) {
      const gi = mod(fr(ld - this.DlongOf(i)), tl);
      const at = want.findIndex(w => w !== lead && mod(fr(ld - this.DlongOf(w)), tl) > gi);
      want.splice(at < 0 ? want.length : at, 0, i);
    }
    for (const i of line) if (onTrack(i) && this.yellowSlow.has(i)) want.push(i);
    for (const i of line) if (!want.includes(i)) want.push(i);
    const same = want.length === line.length && want.every((v, k) => v === line[k]);
    if (!same) {
      const row = line.indexOf(lead) + 1;
      const moved = want.filter((i, k) => line.indexOf(i) !== k).length;
      this.WriteLine(want);
      this.lineFixes++;
      if (this.lineFixes === 1 || Number.isNaN(this.lineFixLogAt) || this.Now - this.lineFixLogAt >= 5.0) {
        this.lineFixLogAt = this.Now;
        this.Log(`caution line: the game had leader #${this.CarNumber(lead)} in row ${row} behind #${this.CarNumber(line[0])}, ${moved} cars moved: put back in the order at the yellow${this.lineFixes > 1 ? ` (${this.lineFixes} times this caution)` : ''}`);
      }
    }
  };

  // ── tail catch-up (PaceLapFit off): a pace lap less for cars far behind their car in the line ─────────────────────────
  P.TailCatchUpTick = function () {
    const m = this.m;
    if (m.U8(LINE_COUNT) !== 1) { this.RestoreTail('double file'); return; }
    const tl = m.F64(TRACK_LEN);
    if (tl <= 100.0) return;
    const line = this.CurrentLine();
    if (line.length < 2) return;
    const pl = m.I32(PACE_LAP);
    const paceOn = this.PaceStatesOk() && this.PaceCarOnTrack();
    const pd = this.DlongOf(1);
    let prev = -1, easing = false;
    for (const item of line) {
      const skip = !this.Running(item) || this.OnPitRoad(item) || this.eligible.has(item) || m.U8(lineByte(item)) !== 0 || this.chaseHeld.has(item);
      if (skip || prev < 0) {
        if (this.tailLowered.has(item)) this.RestoreOne(item, skip ? 'pit road or going around' : 'first in the line');
        if (!skip) prev = item;
        easing = false;
        continue;
      }
      const a = carPaceLap(item);
      const behind = mod(fr(this.DlongOf(prev) - this.DlongOf(item)), tl);
      const toPace = mod(fr(pd - this.DlongOf(item)), tl);
      const spotAhead = behind < tl * 0.5 && (!paceOn || behind < toPace);
      const own = m.I32(a) + (this.tailLowered.has(item) ? this.tailLowered.get(item) : 0);
      const prevLowered = this.tailLowered.has(prev);
      let closing = this.CarSpeed(item) - this.CarSpeed(prev);
      if (Number.isNaN(closing) || closing < 0.0) closing = 0.0;
      const brake = 20.0 + closing * closing / 7.0;
      if (this.tailLowered.has(item)) {
        if (!spotAhead) this.RestoreOne(item, 'its spot is not in front of it');
        else if (own < pl) this.RestoreOne(item, "its own pace lap is under the pace car's now");
        else if (easing) this.RestoreOne(item, `easing off with #${this.CarNumber(prev)} in front of it`);
        else if (!prevLowered && behind <= brake) {
          this.RestoreOne(item, `${r0(behind)} m behind #${this.CarNumber(prev)}, closing at ${r0(closing)} m/s: eases off to slot in behind it`);
          easing = true;
        }
      } else if (spotAhead && (prevLowered || (behind > 80.0 && closing < 3.0)) && m.I32(a) >= pl) {
        const n = m.I32(a) - (pl - 1);
        this.tailLowered.set(item, n);
        m.W32(a, m.I32(a) - n);
        easing = false;
        this.Log(`tail catch-up: #${this.CarNumber(item)} is ${r0(behind)} m behind #${this.CarNumber(prev)} in the line${prevLowered ? ' (catching up with it)' : ''}: pace lap under the pace car's so it catches up`);
      } else easing = false;
      prev = item;
    }
    for (const i of Array.from(this.tailLowered.keys())) if (!line.includes(i)) this.RestoreOne(i, 'out of the line');
  };

  P.RestoreOne = function (idx, why) {
    if (!this.tailLowered.has(idx)) return;
    const v = this.tailLowered.get(idx);
    this.tailLowered.delete(idx);
    try { const a = carPaceLap(idx); this.m.W32(a, this.m.I32(a) + v); } catch (e) { if (e instanceof GameMemoryError) return; throw e; }
    this.Log(`tail catch-up: #${this.CarNumber(idx)} back to its own pace lap (${why})`);
  };

  P.RestoreTail = function (why) { for (const i of Array.from(this.tailLowered.keys())) this.RestoreOne(i, why); };

  // ── pace laps fitted to the line (flags 0-1): each car's pace lap matches its real gap to the car it follows ──────────
  P.PaceLapFitTick = function () {
    const m = this.m;
    if (m.U8(LINE_COUNT) !== 1) { this.fitPending.clear(); return; }
    const tl = m.F64(TRACK_LEN);
    if (tl <= 100.0) return;
    const line = this.CurrentLine();
    if (line.length < 2) return;
    const pending = new Map(), done = [];
    let prev = -1, prevLap = 0;
    for (const item of line) {
      if (!this.Running(item)) continue;
      const lagging = m.U8(LAGGING + item) !== 0;
      const a = carPaceLap(item);
      const cur = m.I32(a);
      if (prev < 0) {
        if (lagging) continue;
        const want = this.LeaderFitPaceLap(item, cur, tl);
        if (want !== cur) {
          if (this.fitPending.has(item) && this.fitPending.get(item) === want) {
            m.W32(a, want); this.fitWrites++;
            done.push(`#${this.CarNumber(item)} ${cur}->${want} (first in line, ${r0(mod(fr(this.DlongOf(1) - this.DlongOf(item)), tl))} m behind the pace car)`);
          } else pending.set(item, want);
        }
        prev = item; prevLap = want;
        continue;
      }
      const ahead = prev;
      let want = cur;
      const skip = this.OnPitRoad(item) || this.OnPitRoad(ahead) || this.chaseHeld.has(item) || this.eligible.has(item) || m.U8(lineByte(item)) !== 0;
      const d = this.DlongOf(item), da = this.DlongOf(ahead);
      if (!skip && d >= 25.0 && d <= tl - 25.0 && da >= 25.0 && da <= tl - 25.0) {
        let gap = mod(fr(da - d), tl);
        if (gap > tl / 2.0) gap -= tl;
        want = prevLap - roundEven((gap - fr(da - d)) / tl);
        if (want !== cur) {
          if (this.fitPending.has(item) && this.fitPending.get(item) === want) {
            m.W32(a, want); this.fitWrites++;
            done.push(`#${this.CarNumber(item)} ${cur}->${want} (${r0(Math.abs(gap))} m ${gap >= 0.0 ? 'behind' : 'in front of'} #${this.CarNumber(ahead)})`);
          } else pending.set(item, want);
        }
      }
      if (!lagging) { prev = item; prevLap = want; }
    }
    this.fitPending = pending;
    if (done.length > 0) this.Log(`pace lap fit: ${done.length} car(s) given the pace lap that matches their gap to the car they follow in the line: ${done.join(', ')}`);
  };

  P.LeaderFitPaceLap = function (idx, pl, tl) {
    const m = this.m;
    if (!this.PaceStatesOk() || this.OnPitRoad(idx) || this.chaseHeld.has(idx) || this.eligible.has(idx) || m.U8(lineByte(idx)) !== 0) return pl;
    const d = this.DlongOf(idx), pd = this.DlongOf(1);
    if (d < 25.0 || d > tl - 25.0 || pd < 25.0 || pd > tl - 25.0) return pl;
    const paceLap = m.I32(PACE_LAP);
    let gap = mod(fr(pd - d), tl);
    if (gap > tl * 0.85) gap -= tl;
    return paceLap - roundEven((gap - fr(pd - d)) / tl);
  };

  P.PaceLapOneDown = function (idx) {
    const m = this.m;
    const tl = m.F64(TRACK_LEN);
    const a = carPaceLap(idx);
    if (tl <= 100.0) return m.I32(a) - 1;
    const d = this.DlongOf(idx), pd = this.DlongOf(1);
    const paceLap = m.I32(PACE_LAP);
    const gap = mod(fr(pd - d), tl);
    return paceLap - 1 - roundEven((gap - fr(pd - d)) / tl);
  };

  P.LinePaceLap = function (idx) {
    const m = this.m;
    const tl = m.F64(TRACK_LEN);
    if (tl <= 100.0) return null;
    const line = this.CurrentLine();
    const k = line.indexOf(idx);
    if (k < 0) return null;
    let ahead = 1;
    for (let j = k - 1; j >= 0; j--) {
      const c = line[j];
      if (this.Running(c) && m.U8(LAGGING + c) === 0) { ahead = c; break; }
    }
    const d = this.DlongOf(idx), da = this.DlongOf(ahead);
    const lap = m.I32(carPaceLap(ahead));
    let gap = mod(fr(da - d), tl);
    if (gap > tl / 2.0) gap -= tl;
    return lap - roundEven((gap - fr(da - d)) / tl);
  };

  P.EndPaceLapFit = function () {
    if (this.fitPending.size > 0) this.fitPending.clear();
    if (this.flag === 7 && this.fitWrites > 0) this.fitWrites = 0;
  };

  // a pace lap given back (dropped back / free pass): fitted to the car it follows in the line, not +1
  P.GiveBackPaceLap = function (idx) {
    const m = this.m;
    const a = carPaceLap(idx);
    const cur = m.I32(a);
    const fit = (this.PaceFixes && this.PaceLapFit) ? this.LinePaceLap(idx) : null;
    const v = fit != null ? fit : cur + 1;
    m.W32(a, v);
    if (fit != null && v !== cur + 1) this.Log(`#${this.CarNumber(idx)} pace lap ${cur} -> ${v} (fitted to its gap to the car it follows, not +1)`);
  };

  // ── the calls to the player's own car ─────────────────────────────────────────────────────────────────────────────────
  P.PlayerCallTick = function () {
    let r = { text: '', kind: 0 };
    try { r = this.Compose(); } catch (e) { if (!(e instanceof GameMemoryError)) throw e; r = { text: '', kind: r.kind }; }
    this.PlayerCall = r.text; this.PlayerCallKind = r.kind;
    if (r.text !== this.callLogged) {
      this.callLogged = r.text;
      if (r.text.length > 0) this.Log('your car: ' + r.text);
    }
  };

  P.Compose = function () {
    const out = { text: '', kind: 0 };
    if (!this.PlayerDriving) return out;
    const pen = this.PlayerPenalty(0);
    if (pen.length > 0) {
      const stop = this.m.U8(11332071) !== 0;
      out.text = stop ? 'PENALTY STOP - COME IN TO SERVE IT (' + pen + ')' : 'PENALTY ON YOUR CAR (' + pen + ')';
      out.kind = 3;
      return out;
    }
    if (this.flag < 1 || this.flag > 6 || this.OnPitRoad(0)) return out;
    const st = this.GoingRoundState(0);
    if (st > 0) {
      const fp = this.IsFreePass(0);
      out.kind = fp ? 5 : 4;
      const t = fp ? 'FREE PASS' : 'WAVED AROUND';
      out.text = st === 1 ? t + ': GO AROUND THE PACE CAR' : t + ': CATCH THE BACK OF THE FIELD AND LINE UP AT THE TAIL';
      return out;
    }
    const f = this.FollowCall(0);
    if (f.length > 0) { out.text = f; out.kind = 0; }
    return out;
  };

  P.PlayerPenalty = function (idx) {
    const m = this.m;
    const rules = this.PenaltyRules();
    let text = '';
    for (let i = 0; i < rules.length; i++) {
      if (rules[i] === 0) continue;
      const v = m.U32(rules[i] + 4 + idx * 4);
      if ((v & 0xF) !== 0) {
        const name = i === 11 ? 'passing on the inside' : (i === 14 ? 'passing under yellow' : 'rule ' + i);
        if (text.length === 0) text = name;
        const key = i + ':' + v;
        if (this.penaltyLogged !== key) {
          this.penaltyLogged = key;
          this.Log(`your car: penalty rule ${i} type ${v & 0xF} amount ${(v >>> 4) & 0xFFF} (0x${(v >>> 0).toString(16).toUpperCase()}); stop flag ${m.U8(11332071 + idx * 8724)}, pits ${this.pitsOpen ? 'open' : 'closed'}`);
        }
      }
    }
    if (text.length === 0) this.penaltyLogged = '';
    return text.toUpperCase();
  };

  P.GoingRoundState = function (idx) {
    const e = this.eligible.get(idx);
    if (e === undefined || e.Pitted || e.Restored) return 0;
    return !e.Passed ? 1 : 2;
  };

  P.IsFreePass = function (idx) { return this.freePassIdx === idx; };

  P.FollowCall = function (me) {
    const m = this.m;
    if (m.U8(LINE_COUNT) < 1 || !this.PaceCarOnTrack()) return '';
    const myLine = m.I32(7777920 + me * 13), myRow = m.I32(7777924 + me * 13);
    if (myRow < 0 || myRow > 60) return '';
    let best = -1, bestRow = -1;
    for (let i = 0; i <= this.maxIdx && i < 48; i++) {
      if (i !== me && i !== 1 && this.Running(i) && !this.OnPitRoad(i) && m.I32(7777920 + i * 13) === myLine) {
        const r = m.I32(7777924 + i * 13);
        if (r >= 0 && r < myRow && r > bestRow) { best = i; bestRow = r; }
      }
    }
    return best < 0 ? 'FOLLOW THE PACE CAR' : 'FOLLOW #' + this.CarNumber(best);
  };
};
module.exports.roundEven = roundEven;
