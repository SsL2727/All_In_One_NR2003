// Port of RaceControl 1.2.0 beta 2's Qualifying: single car runs, Indy oval (N-lap average), knockout rounds and Indy road /
// street (two groups, Fast 12, Fast Six), run in the PRACTICE session before qualifying with the AI cars held in their pit
// boxes; in the qualifying session the AI's laps are replaced with them, so the leaderboard and the starting grid follow.
// The player can run too: car 0 is a full participant (state synthesised from game memory or the hub feed), gets a go/hold
// card, calls, a countdown and a banner. Control flow, thresholds and every memory write follow the original.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fx } = require('./format');
const { gameSeconds } = require('./gamemath');
const { QualTiming, roundEven } = require('./qualtiming');
const Entry = require('../season/entry');      // season mode's guaranteed starters (the field cut)
const { GameMemoryError } = require('./gamemem');

const fr = Math.fround;
const Block0 = 11323952, Session = 9927168, Stride = 8724, State = 5031, Countdown = 6922, RunEnd = 6918, Lap = 6778, Vel = 6634;
const Driver0 = 14711636, DriverSize = 175, DriverNum = 156, Cross0 = 7862678, QpRating = 5914, QpMults = 6106;
const QpCoeffs = [7648224, 7648248, 7648200];
const StandingsCaches = [7960982, 8389280];
const RunsMaxHours = 6.0;
const Bubble = 2;
const EngineDmg = 4991, OutReason = 4916, StuckTimer = 6958, RepairNeedOff = 6963, PitRequest = 8118;
const DoneForSession = 12384244, CrashedMode = 12384268, TowAfter = 20.0;
const HeadingIn = new Set([7737148, 7736816, 7736804, 7736696, 7736724, 7737172, 7737160, 7737208, 7737220, 7737232, 12384268]);

const Known = new Map([
  [7736992, 'InGarageSlow'], [7736956, 'InGarageFast'], [7737184, 'InPitStallWaitingSlow'], [7737096, 'InPitStallWaitingFast'],
  [7737048, 'InPitStallSlow'], [7737020, 'InPitStallFast'], [7737084, 'LeavingPitsSlow'], [7737196, 'LeavingPitsFast'],
  [7737220, 'EnteringPitsSlow'], [7737232, 'EnteringPitsFast'], [7737160, 'PitInLapSlow'], [7737208, 'PitInLapFast'],
  [7736620, 'Practicing'], [7736828, 'WarmingUp'],
]);
const Wait = new Set([7737184, 7737096]), Garage = new Set([7736992, 7736956]), Leaving = new Set([7737084, 7737196]);
const OnTrack = new Set([7736620, 7736828]), PitIn = new Set([7737160, 7737208]), Entering = new Set([7737220, 7737232]);
const Stall = new Set([7737048, 7737020]), Damaged = new Set([7737148, 7736816, 7736804, 7736696]);

const Format = { Off: 0, Single: 1, Knockout: 2, IndyOval: 3, IndyRoad: 4 };
const Split = { Rating: 0, List: 1, Random: 2 };
const Release = { PitRoad: 0, Seconds: 1, LapPercent: 2, Gap: 3 };
const BoxShow = { None: 0, Result: 1, Live: 2, Waiting: 3 };
const BoxNames = ['none', 'result', 'live', 'waiting'];
const Ph = { Idle: 0, Holding: 1, Running: 2, Break: 3, Done: 4, GridWait: 5, Grid: 6, Stopped: 7, Scratch: 8, Timing: 9 };     // Timing: QualControl's practice timing
const NoTime = 9000000000.0;

// .NET's HashSet<int> enumerates its entry array in slot order and reuses removed slots last-in-first-out, so after
// removals + re-adds the order differs from insertion order. The original's reads follow that order, so this mimics it.
class NetHashSet {
  constructor(items) { this.e = []; this.map = new Map(); this.free = []; if (items) for (const v of items) this.add(v); }
  add(v) {
    if (this.map.has(v)) return false;
    let i;
    if (this.free.length) { i = this.free.pop(); this.e[i] = { v }; } else { i = this.e.length; this.e.push({ v }); }
    this.map.set(v, i);
    return true;
  }
  delete(v) {
    if (!this.map.has(v)) return false;
    const i = this.map.get(v);
    this.map.delete(v); this.e[i] = null; this.free.push(i);
    return true;
  }
  has(v) { return this.map.has(v); }
  get size() { return this.map.size; }
  clear() { this.e = []; this.map.clear(); this.free = []; }
  *[Symbol.iterator]() { for (const x of this.e) if (x) yield x.v; }
}

// LapFmt: lap times as 1:23.456 / 23.456, or as mph when the speed display is on
const LapFmt = {
  Speed: false, TrackM: 0,
  Time(ms) {
    if (ms <= 0) return '-.---';
    const mins = Math.trunc(ms / 60000), sec = (ms - mins * 60000) / 1000.0;
    if (mins <= 0) return fx(sec, 3);
    return mins + ':' + fx(sec, 3).padStart(6, '0');
  },
  Lap(ms) {
    if (ms > 0 && LapFmt.Speed && LapFmt.TrackM > 100.0) return fx(LapFmt.TrackM / (ms / 1000.0) * 2.2369363, 3);
    return LapFmt.Time(ms);
  },
  // the track's official length from its track.ini (track_length = 1.5 mi / 2.5 k), in metres; 0 when not readable
  OfficialLen: 0,
  Official(trackIni) {
    try {
      for (const line of fs.readFileSync(trackIni, 'latin1').split(/\r?\n/)) {
        const t = line.split(';')[0].trim();
        const eq = t.indexOf('=');
        if (eq >= 0 && t.slice(0, eq).trim().toLowerCase() === 'track_length') {
          const mt = /^\s*([0-9.]+)\s*([a-zA-Z]?)/.exec(t.slice(eq + 1));
          const v = mt ? Number(mt[1]) : NaN;
          if (!mt || !Number.isFinite(v)) return 0.0;
          const m = mt[2].toLowerCase() === 'k' ? v * 1000.0 : v * 1609.344;
          return (m > 100.0 && m < 50000.0) ? m : 0.0;
        }
      }
    } catch (e) { /* no track.ini */ }
    return 0.0;
  },
};

const padL = (s, n) => String(s).padStart(n), padR = (s, n) => String(s).padEnd(n);
const pad2 = n => String(n).padStart(2, '0');
const Ms = ms => LapFmt.Time(ms);
const sgn3 = v => (v < 0 ? '-' : '+') + fx(Math.abs(v), 3);           // "+0.000;-0.000"
const f7 = (v, d) => fx(Number(v.toPrecision(7)), d);                  // .NET Framework formats a float to 7 digits
const f32Bits = (v) => { const a = new Float32Array([v]); return new Int32Array(a.buffer)[0]; };
const dblWords = (d) => { const a = new Float64Array([d]); const u = new Uint32Array(a.buffer); return [u[0], u[1]]; };
const g01 = v => fx(v, 1).replace(/\.0$/, '');                         // "0.#"
const awayRound = v => (v < 0 ? -Math.round(-v) : Math.round(v));   // Math.Round(x, MidpointRounding.AwayFromZero)
const removeOne = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); return i >= 0; };
const stable = (arr, key) => arr.map((v, i) => ({ v, i, k: key(v) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i)).map(x => x.v);
const minOf = a => Math.min(...a), maxOf = a => Math.max(...a);
const avgOf = a => a.reduce((s, x) => s + x, 0) / a.length;

function newRun(car, started) {
  return {
    Car: car, Before: null, WallAt: [], CalledIn: false, Started: started, LeftAt: -1.0, Fresh: 0, ReleasedG: -1.0, ExitG: -1.0,
    GreenG: -1.0, FinishG: -1.0, LapStartG: -1.0, StallDl: NaN, ExitDl: NaN, LastDl: NaN, LastG: -1.0, LapsDone: 0, LastLapMs: 0,
    LastLapAt: -1.0, LapMs: [], Prev: null, GapLogged: false, TargetG: -1.0, JoinDl: NaN, JoinChecked: false,
    Lane: 0, WavedOff: false, WaveChecked: 0,
  };
}

class Qualifying {
  // opts: { wall() -> seconds, rnd(n) -> int in [0,n), rndNext() -> int, now() -> ms, stateDir, runsPath, writeState(files),
  //         writeFiles, hub() -> { Fresh, InCar, HasPlayer, PlayerSpeed } }
  constructor(opts) {
    opts = opts || {};
    const t0 = Date.now();
    this.wallFn = opts.wall || (() => (Date.now() - t0) / 1000);
    this.rndFn = opts.rnd || (n => Math.floor(Math.random() * n));          // Random.Next(n)
    this.rndNextFn = opts.rndNext || (() => Math.floor(Math.random() * 2147483647));   // Random.Next()
    this.rndDoubleFn = opts.rndDouble || (() => Math.random());                        // Random.NextDouble()
    this.nowFn = opts.now || (() => Date.now());
    this.hubFn = opts.hub || (() => ({ Fresh: false, InCar: false, HasPlayer: false, PlayerSpeed: 0 }));
    this.stateDir = opts.stateDir || path.join(process.env.ProgramData || 'C:\\ProgramData', 'NR2003 Companions');
    this.runsPath = opts.runsPath || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'NR2003RaceControl', 'qualifying_runs.txt');
    this.writeFiles = opts.writeFiles !== false;
    this.writeState = opts.writeState || null;                 // test hook: receives [{name,text}]

    this.Mode = Format.Off; this.Laps = 1; this.Rounds = '25:24, 10:12, 5:12'; this.BreakSeconds = 60.0; this.Order = '';
    this.IndyGroupMin = 10.0; this.IndyF12Min = 10.0; this.IndyF6Min = 6.0; this.IndyGroupAdv = 6; this.IndyF12Adv = 6; this.IndySplit = Split.Rating;
    this.indyG1 = null; this.indyG2 = null;
    this.Logger = null; this.QualPace = true; this.DnqSeconds = 90.0; this.MatchStockPace = true; this.FuelPercent = 25.0;
    this.dnq = new Set();
    this.IncludePlayer = true; this.PlayerCall = ''; this.PlayerCallKind = 0; this.playerCallUntil = -1.0; this.playerSt = 7736992;
    this.meInQual = false; this.meNoLapLogged = false; this.PlayerTimer = ''; this.PlayerTimerUrgent = false; this.PlayerReadyPause = true;
    this.readyRequested = false; this.playerHold = false; this.lastTickWall = -1.0; this.meDriving = false; this.meLeftBox = false;
    this.meBoxAt = -1.0; this.ClimbOutWait = 90.0; this.inCarDisagreeLogged = false; this.meLastDl = NaN; this.meLastG = -1.0;
    this.meSpeed = 0; this.meWaitSince = -1.0;
    this.Timing = new QualTiming({ now: this.nowFn });
    this.LiveHeader = ''; this.LiveBoard = [];
    this.ReleaseMode = Release.PitRoad; this.ReleaseValue = 30.0; this.MaxOut = 3;
    this.BoxKind = BoxShow.None; this.BoxCar = -1; this.ResultBestMs = 0; this.ResultPos = 0; this.ResultDiffMs = 0; this.ResultHasDiff = false;
    this.BoxLapMs = 0; this.BoxLapAge = 1000000000.0; this.resultCar = -1; this.resultAt = 0;
    this.phase = Ph.Idle; this.m = null;
    this.field = new NetHashSet(); this.told = new Set(); this.outNow = new NetHashSet();
    this.status = 'Off'; this.Board = [];
    this.gridWaitLogged = false; this.gridWritten = false; this.loadTried = false; this.single = null; this.results = [];
    this.runs = new Map(); this.runNums = new Map(); this.pitSpeeds = []; this.gapNote = '';
    this.koRounds = null; this.koRound = 0; this.koResults = []; this.koEntered = []; this.koEntrants = null; this.koCars = null;
    this.koReleased = null; this.koRec = null; this.koSeen = null; this.koAtFlag = null; this.koFlag = false;
    this.koElapsed = 0; this.koLastGame = 0; this.koLastWall = 0; this.koBreakEnd = 0; this.koNextPrint = 0;
    this.orig = new Map(); this.written = new Set(); this.slowest = 0; this.paceK = 1.0; this.paceN = 0; this.lastGridTick = 0;
    this.standingsOk = new Map(); this.lastState = 0; this.LiveOn = false;
    // RaceControl (Nov 2026): the field cut / DNQ, more than one run, Indy re-qualifying lanes, wave-offs, DNQ scratches
    this.Starters = 0; this.StartersPercent = false; this.dnqNums = []; this.dnqSlots = new Set();
    this.ReQual = false; this.ReQualMinutes = 20.0; this.ReQualMaxRuns = 3; this.WaveOffs = true;
    this.lane1Q = []; this.lane2Q = []; this.runsMade = new Map(); this.withdrawn = new Set(); this.wavedOffFirst = new Set();
    this.reqOpen = false; this.reqDone = false; this.reqEndG = -1.0;
    this.hhTried = false; this.hhLogged = false; this.raceTried = false; this.ScratchDnqs = true;
    this.scratch = new Map(); this.scratchGreenAt = -1.0; this.scratchMeLogged = false;
    this.pendingLane = new Map(); this.meWantsWindow = false;
    this.BoostPercent = 100;  // RaceControl 2.0: strength of the AI qualifying pace bonus (100 = the game's own formula, more = faster)
    this.qcInit();          // QualControl 0.5.0: practice order, saved / reapplied results (qualcontrol.js)
  }

  // ── properties ──────────────────────────────────────────────────────────────
  get Wall() { return this.wallFn(); }
  get Status() { return this.status; }
  get SingleRuns() { return this.Mode === Format.Single || this.Mode === Format.IndyOval; }
  get KnockoutLike() { return this.Mode === Format.Knockout || this.Mode === Format.IndyRoad; }
  get Average() { return this.Mode === Format.IndyOval; }
  get PlayerHolding() { return this.playerHold; }
  get DriveCar() { return this.meDriving ? 0 : -1; }
  get CanStart() { return this.phase === Ph.Holding ? [...this.field].filter(c => Wait.has(this.St(c))).length > 0 : false; }
  get Active() { return this.phase !== Ph.Idle && this.phase !== Ph.Stopped; }
  get ActiveRunners() { return this.single ? this.single.Active.filter(r => !r.CalledIn).map(r => r.Car) : []; }
  get RunnerSlot() {
    if (!this.single || this.single.Active.length === 0) return -1;
    const r = this.single.Active.find(x => !x.CalledIn);
    return r ? r.Car : -1;
  }

  get NotQualified() { return this.dnqNums.slice(); }
  get Lanes() { return this.ReQual ? this.Mode === Format.IndyOval : false; }
  get LanesOpen() { return this.reqOpen; }
  get ReQualLeft() { return !this.reqOpen ? 0.0 : Math.max(0.0, this.reqEndG - this.G()); }
  get PlayerLane() { return !this.lane1Q.includes(0) ? (!this.lane2Q.includes(0) ? 0 : 2) : 1; }
  get PlayerCanPickLane() {
    if (this.reqOpen && this.field.has(0) && this.single != null && !this.single.Active.some(r => r.Car === 0) && this.Runs(0) < this.ReQualMaxRuns) return !this.PendingRun(0);
    return false;
  }

  // ── the field cut (DNQ), more than one run, the Indy re-qualifying lanes ──
  FieldCut(entered) {
    if (this.Starters <= 0 || entered <= 0) return entered;
    const val = this.StartersPercent ? awayRound(entered * this.Starters / 100.0) : this.Starters;
    return Math.max(1, Math.min(entered, val));
  }

  ApplyCut(order) {
    this.dnqNums = []; this.dnqSlots.clear();
    const num = this.FieldCut(order.length);
    if (num >= order.length) return;
    // season mode's guaranteed starters (top N in owner points, chartered cars): never cut; the other places go to the fastest of the rest
    let g = null;
    try { g = this.GuaranteedFn ? this.GuaranteedFn() : null; } catch (e) { g = null; }
    const res = Entry.cut(order, c => this.Num(c), num, g && g.nums);
    if (res.locked.length) this.Log(`GUARANTEED STARTERS (${g.charters.length ? 'charters' : ''}${g.charters.length && g.top.length ? ' + ' : ''}${g.top.length ? 'top ' + g.topN + ' in owner points' : ''}): ${res.locked.map(c => this.Car(c)).join(', ')} make the field on it`);
    for (const item of res.dnq) { this.dnqSlots.add(item); this.dnqNums.push(this.Num(item)); }
    this.Log(`DID NOT QUALIFY (${num} of ${order.length} cars make the field${this.StartersPercent ? (', ' + this.Starters + '%') : ''}): ${res.dnq.map(c => this.Car(c)).join(', ')}`);
    if (this.dnqSlots.has(0)) this.Call(3, "DID NOT QUALIFY: you're outside the top " + num, 30.0);
  }

  Runs(c) { return this.runsMade.has(c) ? this.runsMade.get(c) : 0; }
  PendingRun(c) { return this.single != null ? this.single.Order.slice(this.single.K + 1).includes(c) : false; }
  Official(c) { const x = this.results.find(r => r[1] === c); return x ? x[0] : NoTime; }
  ResultIdx(c) { return this.results.findIndex(r => r[1] === c); }

  ChooseLane(laneNo) {
    if (!this.PlayerCanPickLane && (laneNo !== 0 || this.PlayerLane <= 0)) {
      if (!this.reqOpen) return 'The lanes are not open.';
      return "You can't change lanes now (on a run, or out of runs).";
    }
    removeOne(this.lane1Q, 0); removeOne(this.lane2Q, 0);
    switch (laneNo) {
      case 1:
        this.Withdraw(0);
        this.lane1Q.push(0);
        this.Call(0, 'LANE 1: your time is given up - you go before Lane 2', 15.0);
        return 'In Lane 1: your time is given up.';
      case 2:
        if (this.withdrawn.has(0) || this.Official(0) >= NoTime) {
          this.lane1Q.push(0);
          this.Call(0, 'LANE 1: you have no time to keep', 15.0);
          return 'No time to keep: put in Lane 1.';
        }
        this.lane2Q.push(0);
        this.Call(0, 'LANE 2: you keep your time - you go when Lane 1 is clear', 15.0);
        return 'In Lane 2: you keep your time.';
      default:
        this.meWantsWindow = false;
        this.Call(0, 'OUT OF THE LANES: your time stands', 10.0);
        return 'Out of the lanes.';
    }
  }

  Withdraw(c) {
    const num = this.ResultIdx(c);
    if (!this.withdrawn.has(c)) {
      this.withdrawn.add(c);
      if (num >= 0 && this.results[num][0] < NoTime) {
        this.Log(`${this.Car(c)} gives up its time (${Ms(roundEven(this.results[num][0] * 1000.0) | 0)}) for Lane 1`);
        this.results[num] = [NoTime, c, []];
      }
    }
  }

  Nums(cars) {
    const a = [...cars].map(c => '#' + this.Num(c));
    return a.length !== 0 ? a.join(' ') : 'none';
  }

  ReQualFeed(s1) {
    if (this.reqDone) return;
    if (!this.reqOpen) {
      if (s1.Active.length > 0) return;
      this.OpenReQual(s1);
      if (!this.reqOpen) return;
    }
    if (this.G() >= this.reqEndG) { this.CloseReQual(s1, 'time is up'); return; }
    const inBox = c => Wait.has(this.St(c)) && this.Runs(c) < this.ReQualMaxRuns;
    let num = -1, lane = 0;
    if (this.lane1Q.length > 0) {
      const i = this.lane1Q.findIndex(c => inBox(c));
      lane = 1; num = i >= 0 ? this.lane1Q[i] : -1;
    } else if (!s1.Active.some(r => r.Lane === 1) && this.lane2Q.length > 0) {
      const i = this.lane2Q.findIndex(c => inBox(c));
      lane = 2; num = i >= 0 ? this.lane2Q[i] : -1;
    }
    for (const item of this.lane1Q.concat(this.lane2Q)) {
      if (this.Runs(item) >= this.ReQualMaxRuns || (item !== 0 && Garage.has(this.St(item)))) { removeOne(this.lane1Q, item); removeOne(this.lane2Q, item); }
    }
    if (num >= 0) {
      removeOne(lane === 1 ? this.lane1Q : this.lane2Q, num);
      this.pendingLane.set(num, lane);
      s1.Order.push(num);
      this.Log(`re-qualifying: ${this.Car(num)} goes from Lane ${lane} (${this.lane1Q.length} left in Lane 1, ${this.lane2Q.length} in Lane 2)`);
    } else if (this.lane1Q.length === 0 && this.lane2Q.length === 0 && s1.Active.length === 0 && (!this.field.has(0) || !this.PlayerCanPickLane || !(this.G() < this.reqEndG - 30.0) || !this.meWantsWindow)) {
      this.CloseReQual(s1, 'both lanes are empty');
    }
  }

  OpenReQual(s1) {
    this.reqOpen = true;
    this.reqEndG = this.G() + this.ReQualMinutes * 60.0;
    const timed = stable(this.results.filter(r => r[0] < NoTime), r => r[0]).map(r => r[1]);
    const distinct = [...new Set(s1.Order)];
    const num = this.Starters > 0 ? this.FieldCut(distinct.length) : 0;
    const list = [];
    for (const item of distinct) {
      if (this.Runs(item) >= this.ReQualMaxRuns) { list.push(item); continue; }
      if (item === 0) {
        if (this.wavedOffFirst.has(0)) { this.Withdraw(0); this.lane1Q.push(0); }
        continue;
      }
      switch (this.wavedOffFirst.has(item) ? 1 : this.DecideLane(item, timed, num, true)) {
        case 1: this.Withdraw(item); this.lane1Q.push(item); break;
        case 2: this.lane2Q.push(item); break;
        default: list.push(item); break;
      }
    }
    this.meWantsWindow = this.field.has(0);
    this.Log(`RE-QUALIFYING OPEN for ${g01(this.ReQualMinutes)} min${num > 0 ? (' (' + num + ' make the field)') : ''}: Lane 1 (priority, times given up): ${this.Nums(this.lane1Q)}; Lane 2 (keep their time): ${this.Nums(this.lane2Q)}; staying: ${this.Nums(list)}`);
    if (this.field.has(0)) {
      this.Call(0, this.PlayerLane === 1 ? "RE-QUALIFYING OPEN: you waved off, so you're in Lane 1" : 'RE-QUALIFYING OPEN: pick Lane 1 or Lane 2 in Race Control (Qualifying tab), or keep your time', 30.0);
    }
    this.ShowSingleBoard();
  }

  CloseReQual(s1, why) {
    this.reqOpen = false;
    this.reqDone = true;
    for (let n = s1.Order.length - 1; n > s1.K; n--) {
      this.pendingLane.delete(s1.Order[n]);
      s1.Order.splice(n, 1);
    }
    const list = this.lane1Q.concat(this.lane2Q);
    this.lane1Q = []; this.lane2Q = [];
    this.Log('RE-QUALIFYING CLOSED (' + why + ')' + (list.length > 0 ? (': still in line, no run: ' + this.Nums(list)) : '') + (s1.Active.length > 0 ? '; the cars out finish their runs' : ''));
    if (this.field.has(0) && list.includes(0)) this.Call(3, 'RE-QUALIFYING CLOSED: no run for you', 15.0);
  }

  DecideLane(c, timed, cut, first) {
    const num = timed.indexOf(c) + 1;
    const d = this.rndDoubleFn();
    if (num === 0) return !(d < (first ? 1.0 : 0.85)) ? 0 : 1;
    if (cut > 0 && num > cut) return !(d < (first ? 1.0 : 0.85)) ? 0 : 1;
    if (cut > 0 && num > cut - 2) return !(d < (first ? 0.75 : 0.4)) ? 0 : 2;
    const rp = this.RatingPos(c, timed);
    if (rp > 0 && num - rp >= 5) {
      if (first) return !(d < 0.25) ? (!(d < 0.6) ? 0 : 2) : 1;
      return !(d < 0.15) ? 0 : 2;
    }
    return 0;
  }

  RatingPos(c, timed) {
    const rating = x => this.m.F32(Block0 + x * Stride + QpRating);
    const mine = rating(c);
    if (!(mine > fr(0.2)) || !(mine < 3)) return 0;
    const list = timed.map(rating).filter(r => r > fr(0.2) && r < 3);
    if (list.length < 3) return 0;
    return 1 + list.filter(r => r > mine).length;
  }

  ExpectedScore(c) {
    const list = stable(this.results.filter(r => r[0] < NoTime && r[1] !== c), r => r[0]);
    if (list.length < 3) return NaN;
    const num = this.RatingPos(c, list.map(r => r[1]).concat([c]));
    if (num <= 0) return NaN;
    return list[Math.min(num, list.length) - 1][0];
  }

  WaveOffDue(r) {
    const c = r.Car;
    if (!this.Lanes || !this.WaveOffs || c === 0 || r.WavedOff || r.Before == null || r.LapsDone < 1 || r.LapsDone >= this.Laps || r.LapsDone <= r.WaveChecked) return false;
    r.WaveChecked = r.LapsDone;
    const num = avgOf(r.LapMs.slice(0, r.LapsDone)) / 1000.0;
    const d = this.rndDoubleFn();
    const list = this.results.filter(x => x[0] < NoTime && x[1] !== c).map(x => x[0]).sort((a, b) => a - b);
    const cut = this.Starters > 0 ? this.FieldCut(new Set(this.single.Order).size) : 0;
    const outside = cut > 0 && list.length >= cut && num > list[cut - 1];
    let text = null, want = NaN;
    if (r.Lane === 2) {
      want = this.Official(c);
      if (num >= want && d < 0.8) text = "can't beat its time";
    } else if (r.Lane === 1) {
      if (outside && this.ReQualLeft > 120.0 && this.Runs(c) + 1 < this.ReQualMaxRuns && d < 0.5) text = 'heading outside the field, time to go again';
    } else if (!this.reqDone) {
      want = this.ExpectedScore(c);
      if (!Number.isNaN(want) && num > want * 1.004 && d < 0.5) text = 'well off its pace';
      else if (outside && !Number.isNaN(want) && cut > 0 && list.length >= cut && want <= list[cut - 1] && d < 0.6) text = 'heading outside the field';
    }
    if (text == null) return false;
    r.WavedOff = true;
    r.CalledIn = true;
    this.Wr(c, RunEnd, this.Rd(c, Lap));
    this.Log(`${this.Car(c)} WAVES OFF after timed lap ${r.LapsDone} of ${this.Laps} (${text}: ${r.LapsDone} lap(s) at ${fx(num, 3)}${(Number.isNaN(want) || want >= NoTime) ? '' : ', wanted ' + fx(want, 3)})`);
    return true;
  }

  PostResult(r, laps, noShow) {
    const c = r.Car;
    this.runsMade.set(c, this.Runs(c) + 1);
    const num = r.WavedOff ? NoTime : this.Score(laps);
    const idx = this.ResultIdx(c);
    if (idx < 0) {
      this.results.push([num, c, r.WavedOff ? [] : laps]);
      if (r.WavedOff && !noShow) {
        this.wavedOffFirst.add(c);
        this.Log(this.Car(c) + ': waved off its first run - no time' + ((this.Lanes && !this.reqDone) ? '; it goes to Lane 1 when the lanes open' : ''));
      }
    } else if (num < this.results[idx][0]) {
      const was = this.results[idx][0];
      this.Log(`${this.Car(c)}: ${r.Lane === 1 ? 'Lane 1 run stands: ' : 'faster - replaces its time: '}${Ms(roundEven(num * 1000.0) | 0) + (was < NoTime ? (' (was ' + Ms(roundEven(was * 1000.0) | 0) + ')') : '')}`);
      this.results[idx] = [num, c, laps];
      this.dnq.delete(c);
    } else if (r.Lane > 0 && !noShow) {
      const was = this.results[idx][0];
      this.Log(this.Car(c) + (r.WavedOff ? ': waved off' : ': no faster') + ' - ' + (was < NoTime ? ('keeps ' + Ms(roundEven(was * 1000.0) | 0)) : 'still no time'));
    }
    if (this.reqOpen && r.Lane !== 0 && c !== 0 && this.Runs(c) < this.ReQualMaxRuns) {
      const timed = stable(this.results.filter(x => x[0] < NoTime), x => x[0]).map(x => x[1]);
      const cut = this.Starters > 0 ? this.FieldCut(new Set(this.single.Order).size) : 0;
      const lane = this.DecideLane(c, timed, cut, false);
      switch (lane) {
        case 0: return;
        case 1: this.Withdraw(c); this.lane1Q.push(c); break;
        default: this.lane2Q.push(c); break;
      }
      this.Log(this.Car(c) + ' gets back in line: Lane ' + lane);
    }
  }

  RoundName(i) {
    if (this.Mode !== Format.IndyRoad) return 'ROUND ' + (i + 1);
    return i === 2 ? 'FAST 12' : i === 1 ? 'GROUP 2' : i === 0 ? 'GROUP 1' : 'FAST SIX';
  }
  Score(laps) {
    if (!this.Average) return laps.length <= 0 ? NoTime : minOf(laps);
    if (laps.length < this.Laps) return NoTime;
    return avgOf(laps.slice(0, this.Laps));
  }
  ScoreText(laps) {
    if (!this.Average) return laps.length <= 0 ? '' : ', best ' + fx(minOf(laps), 3);
    const num = this.Score(laps), tm = LapFmt.TrackM > 100.0 ? LapFmt.TrackM : this.TrackM();
    if (num >= NoTime) return ' - ' + laps.length + ' of ' + this.Laps + ' laps: an incomplete run, no time';
    return ', average ' + fx(num, 3) + (tm > 0.0 ? ` (${fx(tm / num * 2.2369363, 3)} mph)` : '');
  }

  // ── the player ──────────────────────────────────────────────────────────────
  TakeReadyRequest() { const r = this.readyRequested; this.readyRequested = false; return r; }

  PlayerResumed() {
    if (this.playerHold) {
      this.playerHold = false;
      const run = this.single ? this.single.Active.find(x => x.Car === 0) : null;
      if (run && run.LeftAt < 0.0) run.Started = this.Wall;
      this.Log('your car: ready - pull out within ' + fx(this.DnqSeconds, 0) + ' s');
    }
  }

  HoldForReady(call) {
    this.Call(1, call);
    if (this.PlayerReadyPause) { this.readyRequested = true; this.playerHold = true; }
  }

  Drive(on) {
    if (on !== this.meDriving) {
      this.meDriving = on; this.meLeftBox = false; this.meBoxAt = -1.0;
      if (!on) this.playerHold = false;
      if (!on && this.PlayerCall.startsWith('IN YOUR BOX')) this.Call(0, '');
      this.Log(on ? 'your car: on your run - broadcast tools go to your cockpit' : 'your car: out of the car / done - broadcast tools go back to the runs');
    }
  }

  DriveTick() {
    if (!this.meDriving) return;
    if (!this.PlayerReady()) { this.Drive(false); return; }
    const item = this.PlayerSt();
    if (OnTrack.has(item)) { this.meLeftBox = true; this.meBoxAt = -1.0; }
    else {
      if (!this.meLeftBox || !Wait.has(item)) return;
      if (this.meBoxAt < 0.0) {
        this.meBoxAt = this.Wall;
        if (this.InCar()) {
          this.Log('your car: stopped in the box - the broadcast waits for you to climb out');
          this.Call(2, 'IN YOUR BOX - climb out of the car to go back to the broadcast');
        }
      }
      if (!this.InCar() || this.Wall - this.meBoxAt > this.ClimbOutWait) this.Drive(false);
    }
  }

  InCar() {
    const flag = this.m.U32(12609492) === 3;
    const cur = this.hubFn();
    if (!cur.Fresh) return flag;
    if (cur.InCar !== flag && !this.inCarDisagreeLogged) {
      this.inCarDisagreeLogged = true;
      this.Log(`your car: the hub says ${cur.InCar ? 'in' : 'out of'} the car, game memory (0xC067D4 = ${this.m.U32(12609492)}) says ${flag ? 'in' : 'out'} - using the hub`);
    }
    return cur.InCar;
  }

  static TimerText(s) {
    if (s <= 0.5) return 'NOW';
    const n = Math.ceil(s);
    return Math.trunc(n / 60) + ':' + pad2(n % 60);
  }

  Call(kind, text, hold) {
    if (hold === undefined) hold = -1.0;
    if (text !== this.PlayerCall) {
      this.PlayerCall = text; this.PlayerCallKind = kind;
      if (text.length > 0) this.Log('your car: ' + text);
    }
    this.playerCallUntil = hold > 0.0 ? this.Wall + hold : -1.0;
  }

  PlayerReady() {
    if (this.IncludePlayer && this.m.U8(7779164) === 1 && this.m.I32(14711792) >= 0) return this.Name(0).length > 0;
    return false;
  }

  PlayerSt() {
    const prev = this.playerSt;
    if (!this.PlayerReady()) this.playerSt = 7736992;
    else if (this.m.U8(7781132) === 0) this.playerSt = 7736620;
    else if (this.Speed(0) < 1.0) this.playerSt = 7737184;
    else {
      const flag = Wait.has(this.playerSt) || Leaving.has(this.playerSt) || Garage.has(this.playerSt);
      this.playerSt = flag ? 7737084 : 7737220;
    }
    if (this.playerSt !== prev && this.meDriving) {
      this.Log(`your car: ${Qualifying.StateName(this.playerSt)} (pit road flag ${this.m.U8(7781132)}, ${fx(this.Speed(0), 1)} m/s, ${fx(this.Dl(0), 0)} m round the lap)`);
    }
    return this.playerSt;
  }

  PlayerSpeed() {
    const cur = this.hubFn();
    if (cur.Fresh && cur.HasPlayer) return (this.meSpeed = cur.PlayerSpeed);
    const g = this.G(), dl = this.Dl(0);
    if (Number.isNaN(dl)) return this.meSpeed;
    if (Number.isNaN(this.meLastDl) || this.meLastG < 0.0 || g < this.meLastG || g - this.meLastG > 5.0) {
      this.meLastDl = dl; this.meLastG = g;
      return this.meSpeed;
    }
    const dt = g - this.meLastG;
    if (dt < 0.25) return this.meSpeed;
    const ahead = this.Ahead(this.meLastDl, dl);
    if (!Number.isNaN(ahead) && ahead < 150.0 * dt) this.meSpeed = ahead / dt;
    this.meLastDl = dl; this.meLastG = g;
    return this.meSpeed;
  }

  PlayerStopped(s) {
    if (!Wait.has(s)) { this.meWaitSince = -1.0; return false; }
    if (this.meWaitSince < 0.0) this.meWaitSince = this.Wall;
    return this.Wall - this.meWaitSince >= 3.0;
  }

  PlayerLeftBox(r) {
    if (this.Speed(0) > 3.0) return true;
    const tm = this.TrackM(), dl = this.Dl(0);
    if (tm <= 0.0 || Number.isNaN(dl) || Number.isNaN(r.StallDl)) return false;
    const ahead = this.Ahead(r.StallDl, dl);
    if (ahead > 15.0) return ahead < tm - 15.0;
    return false;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  Rnd(n) { return this.rndFn(n); }
  RndNext() { return this.rndNextFn(); }
  CarNumber(c) { return this.m.I32(Driver0 + c * DriverSize + DriverNum); }
  static Roster(mem) {
    const list = [];
    const num = mem.I32(14711792);
    const text = (mem.Str(Driver0, 16) + ' ' + mem.Str(Driver0 + 16, 20)).trim();
    if (mem.U8(7779164) === 1 && num >= 0 && text.length > 0) list.push([0, Qualifying.Label(num), text + ' (you)']);
    for (let i = 2; i < 44; i++) {
      const st = mem.U32(Block0 + i * Stride + State);
      if (st >= 7736608 && st <= 7737264) {
        const n = mem.I32(Driver0 + i * DriverSize + DriverNum);
        const t = (mem.Str(Driver0 + i * DriverSize, 16) + ' ' + mem.Str(Driver0 + i * DriverSize + 16, 20)).trim();
        if (n >= 0 && t.length !== 0) list.push([i, Qualifying.Label(n), t]);
      }
    }
    return list;
  }
  LastName(c) {
    const t = this.m.Str(Driver0 + c * DriverSize + 16, 20).trim();
    return (t.length > 0 ? t : this.Name(c)).toUpperCase();
  }
  FirstName(c) { return this.m.Str(Driver0 + c * DriverSize, 16).trim().toUpperCase(); }

  // the run order as the broadcast sees it: finished (f), on track (l), up next (u)
  OrderView() {
    const list = [];
    if (!this.single) return list;
    for (const r of stable(this.results, x => x[0])) list.push([r[1], r[0] < NoTime ? (roundEven(r[0] * 1000.0) | 0) : 0, 'f']);
    for (const r of this.single.Active) if (!list.some(x => x[0] === r.Car)) list.push([r.Car, 0, 'l']);
    for (const c of this.single.Order.slice(this.single.K + 1)) if (!list.some(x => x[0] === c)) list.push([c, 0, 'u']);
    return list;
  }

  // -> { lapNo, lapMs } of a car's run, or null
  RunView(car) {
    if (!this.single) return null;
    let run = this.single.Active.find(x => x.Car === car) || null;
    if (!run) { for (let i = this.single.History.length - 1; i >= 0; i--) if (this.single.History[i].Car === car) { run = this.single.History[i]; break; } }
    if (!run) return null;
    const lapNo = (run.CalledIn || run.FinishG >= 0.0) ? this.Laps + 1 : (run.Before != null ? Math.min(this.Laps, Math.max(0, run.Fresh)) : 0);
    return { lapNo, lapMs: run.LapMs.slice() };
  }

  OnTimedLap(car) {
    if (this.single) return this.single.Active.some(r => r.Car === car && !r.CalledIn && r.Before != null && r.Fresh >= 1);
    return false;
  }

  static StateName(s) {
    switch (s) {
      case 7737148: return 'called a tow';
      case 7736816: return 'being towed';
      case 7736696: case 7736804: return 'limping to the pits';
      case 7736956: case 7736992: return 'went to the garage';
      default: return Known.has(s) ? Known.get(s) : 'state 0x' + s.toString(16);
    }
  }
  St(c) { return c !== 0 ? this.m.U32(Block0 + c * Stride + State) : this.PlayerSt(); }
  Rd(c, off) { return this.m.I32(Block0 + c * Stride + off); }
  Wr(c, off, v) { if (c !== 0) this.m.W32(Block0 + c * Stride + off, v); }
  SessionKind() { return this.m.U8(Session); }
  NextKind() {
    const n = this.m.U8(12500457) + 1;
    if (n >= this.m.U8(12500383)) return -1;
    return this.m.U16(12500387 + n * 8);
  }
  static Label(v) {
    if (v === 100) return '00';
    if (v >= 2000) {
      const n = Math.trunc(v / 1000), r = v % 1000;
      if (n >= 2 && n <= 3 && r < Math.pow(10.0, n)) return String(r).padStart(n, '0');
    }
    return String(v);
  }
  Num(c) { return Qualifying.Label(this.m.I32(Driver0 + c * DriverSize + DriverNum)); }
  Name(c) { return (this.m.Str(Driver0 + c * DriverSize, 16) + ' ' + this.m.Str(Driver0 + c * DriverSize + 16, 20)).trim(); }
  Car(c) { return '#' + this.Num(c) + ' ' + this.Name(c); }
  Crossings(c) {
    const out = [];
    for (let i = 0; i < 512; i++) {
      const v = this.m.U32(Cross0 + c * 2048 + i * 4);
      if (v === 0) break;
      out.push((v & 0xFFFFFFF) >>> 0);
    }
    return out;
  }
  Fuel(c) {
    const b = Block0 + c * Stride;
    const p1 = this.m.U32(b + 1304), p2 = this.m.U32(b + 1312);
    if (p1 === 0 || p2 === 0) return -1.0;
    const a = (BigInt(this.m.U32(p1 + 4)) << 32n) | BigInt(this.m.U32(p1));
    const k = (BigInt(this.m.U32(p2 + 4)) << 32n) | BigInt(this.m.U32(p2));
    const buf = Buffer.alloc(8); buf.writeBigUInt64LE((a ^ k) & 0xFFFFFFFFFFFFFFFFn, 0);
    const d = buf.readDoubleLE(0);
    return (d >= 0.0 && d < 1000.0) ? d : -1.0;
  }
  Capacity(c) {
    const p = this.m.U32(Block0 + c * Stride + 1418);
    if (p === 0) return -1.0;
    const v = this.m.F32(p + 36);
    return (v > fr(1) && v < fr(1000)) ? v : -1.0;
  }
  SetQualFuel(c) {
    if (this.FuelPercent <= 0.0 || c === 0) return;
    const cap = this.Capacity(c), fuel = this.Fuel(c);
    if (cap <= 0.0 || fuel < 0.0) { this.Log(this.Car(c) + ': fuel not readable, left as it is'); return; }
    const target = cap * this.FuelPercent / 100.0;
    if (target >= fuel) { this.Log(`${this.Car(c)}: fuel ${fx(fuel, 1)} of ${fx(cap, 1)} (already light enough)`); return; }
    const b = Block0 + c * Stride;
    const p1 = this.m.U32(b + 1304), p2 = this.m.U32(b + 1312);
    const a = (BigInt(this.m.U32(p1 + 4)) << 32n) | BigInt(this.m.U32(p1));
    const [lo, hi] = dblWords(target);
    const x = a ^ ((BigInt(hi) << 32n) | BigInt(lo));
    this.m.W32(p2, Number(x & 0xFFFFFFFFn) | 0);
    this.m.W32(p2 + 4, Number((x >> 32n) & 0xFFFFFFFFn) | 0);
    this.Log(`${this.Car(c)}: qualifying fuel ${fx(fuel, 1)} -> ${fx(target, 1)} of ${fx(cap, 1)} (read back ${fx(this.Fuel(c), 1)})`);
  }
  PaceNow(c) {
    const b = Block0 + c * Stride;
    return `rating ${f7(this.m.F32(b + QpRating), 2)}, multipliers ${f7(this.m.F32(b + QpMults), 4)} ${f7(this.m.F32(b + QpMults + 4), 4)} ${f7(this.m.F32(b + QpMults + 8), 4)}`;
  }
  Pace(c, on) {
    if (!this.QualPace || c === 0) return;
    const b = Block0 + c * Stride;
    const rating = this.m.F32(b + QpRating);
    if (!(rating > fr(0.2)) || !(rating < fr(3))) return;
    for (let i = 0; i < 3; i++) {
      let value = 1.0;
      if (on) {
        const k = this.m.F32(QpCoeffs[i]);
        if (!(k >= 0) || !(k < 1)) break;
        value = fr(1 + fr(fr(fr(rating - 1) * k) * fr(this.BoostPercent / 100.0)));     // RaceControl 2.0: BoostPercent (100 = the game's own formula)
      }
      this.m.W32(b + QpMults + i * 4, f32Bits(value));
    }
  }
  Speed(c) {
    if (c === 0) return this.PlayerSpeed();
    const vx = this.m.F32(Block0 + c * Stride + Vel), vy = this.m.F32(Block0 + c * Stride + Vel + 4);
    return Math.sqrt(fr(fr(vx * vx) + fr(vy * vy)));
  }
  Log(s) {
    if (!this.Logger) return;
    const d = new Date();
    this.Logger(`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} qualifying: ${s}`);
  }

  G() { return gameSeconds(this.m); }
  Dl(c) { return this.m.F32(11330202 + c * 8724); }
  TrackM() {
    const v = this.m.F64(14339852);
    return (v > 100.0 && v < 100000.0) ? v : 0.0;
  }
  Ahead(from, to) {
    const tm = this.TrackM();
    if (tm <= 0.0 || Number.isNaN(from) || Number.isNaN(to)) return NaN;
    const d = (to - from) % tm;
    return d < 0.0 ? d + tm : d;
  }

  // hold the cars in their boxes / call back a car that is out when it should not be
  Upkeep(allowed) {
    if (this.PlayerReady()) this.field.add(0);
    for (let i = 2; i < 44; i++) {
      const st = this.St(i);
      if (!Known.has(st)) continue;
      this.field.add(i);
      if (allowed && allowed.has(i)) continue;
      if (Wait.has(st)) {
        if (this.Rd(i, Countdown) < 5000000) this.Wr(i, Countdown, 10000000);
      } else if ((Leaving.has(st) || OnTrack.has(st)) && this.Rd(i, RunEnd) > this.Rd(i, Lap)) {
        this.Wr(i, RunEnd, this.Rd(i, Lap));
        if (!this.told.has(i)) {
          this.told.add(i);
          this.Log('calling in ' + this.Car(i) + ' (it was ' + Known.get(st) + ')');
        }
      }
    }
  }

  // ── tick ────────────────────────────────────────────────────────────────────
  Tick(mem) {
    this.m = mem;
    if (!this.m) return;
    this.LiveOn = false;
    if (this.playerCallUntil > 0.0 && this.Wall > this.playerCallUntil) { this.PlayerCall = ''; this.playerCallUntil = -1.0; }
    const now = this.Wall;
    if (this.lastTickWall >= 0.0 && this.single && this.m.U8(12500272) === 3) {
      for (const r of this.single.Active) r.Started += now - this.lastTickWall;
    }
    this.lastTickWall = now;
    this.PlayerTimer = ''; this.PlayerTimerUrgent = false;
    if (this.phase === Ph.Running || this.phase === Ph.Break || this.phase === Ph.Done) this.DriveTick();
    else this.Drive(false);
    const kind = this.SessionKind();
    switch (this.phase) {
      case Ph.Idle:
        if (this.Mode === Format.Off) { this.status = 'Off'; break; }
        if (kind !== 5) this.loadTried = false;
        else if (!this.loadTried) {
          this.loadTried = true;
          if (this.LoadRuns()) { this.StartGrid(); break; }
        }
        if (kind !== 7) this.raceTried = false;
        else if (!this.raceTried) {
          this.raceTried = true;
          if (this.ScratchDnqs && this.Starters > 0 && this.m.I32(7795072) < 0 && this.LoadRuns(true)) { this.StartScratch(); break; }
        }
        if (kind === 4 && this.NextKind() === 5) { if (this.PracticeOrder) this.NewTiming(); else this.NewPractice(); }
        else if (kind === 4 && this.NextKind() === 7 && !this.hhTried) {
          this.hhTried = true;
          if (this.Starters > 0 && this.LoadRuns(true)) { this.phase = Ph.GridWait; this.gridWritten = true; break; }
        } else this.status = 'Waiting for the practice session before qualifying';
        if (kind !== 4) this.hhTried = false;
        break;
      case Ph.Timing:
        if (kind !== 4) { this.Log('practice ended before the running order was set from it (the times are kept until the next practice)'); this.phase = Ph.Idle; break; }
        if (this.Mode === Format.Off) { this.phase = Ph.Stopped; this.Log('practice timing stopped: qualifying is off'); break; }
        this.TimingTick();
        break;
      case Ph.Stopped:
        if (kind !== 4) this.phase = Ph.Idle;
        this.status = 'Stopped for this practice session';
        break;
      case Ph.Holding: {
        if (kind !== 4) { this.Log('practice ended before qualifying started'); this.phase = Ph.Idle; break; }
        if (this.Mode === Format.Off) { this.Stop(); break; }
        this.Upkeep(null);
        const f = [...this.field];
        const waiting = f.filter(c => Wait.has(this.St(c))).length;
        this.status = `Holding the cars in their boxes: ${waiting} of ${this.field.size} there, ${f.filter(c => Garage.has(this.St(c))).length} in the garage. Start when the count stops growing.`;
        this.WriteState('waiting', 0, 0.0, null, 0);
        break;
      }
      case Ph.Running:
      case Ph.Break:
        if (kind !== 4) { this.PracticeOver(); break; }
        if (this.koRounds) this.KnockoutTick();
        else if (this.single) this.SingleTick();
        else this.phase = Ph.Idle;
        if ((this.phase === Ph.Running || this.phase === Ph.Break || this.phase === Ph.Done) && this.SessionKind() === 4) {
          this.LiveOn = true;
          this.Timing.Update(this.m, this.field);
        }
        break;
      case Ph.Done:
        if (kind !== 4) { this.phase = this.runs.size > 0 ? Ph.GridWait : Ph.Idle; this.gridWaitLogged = false; break; }
        this.Upkeep(null);
        this.status = 'Done: every car is held in its box until practice ends. Then go to the qualifying session.';
        this.LiveHeader = 'QUALIFYING COMPLETE';
        this.LiveOn = true;
        this.Timing.Update(this.m, this.field);
        if (this.SingleRuns) this.WriteSingleState('done'); else this.WriteState('done', 0, 0.0, null, 0);
        break;
      case Ph.GridWait:
        if (kind === 5) { this.StartGrid(); return; }
        if (kind === 4 && this.gridWritten && this.dnqNums.length > 0) { this.HappyHourTick(); return; }
        if (kind === 7 && !this.gridWaitLogged) {
          this.gridWaitLogged = true;
          this.Log(this.gridWritten ? 'the race loaded: the grid from qualifying stands' : 'the race loaded without a qualifying session: no grid written');
          this.raceTried = true;
          if (this.dnqNums.length > 0 && this.ScratchDnqs && this.m.I32(7795072) < 0) {
            this.runs.clear(); this.runNums.clear();
            this.gridWritten = false; this.dnqSlots.clear(); this.hhLogged = false;
            this.StartScratch();
            break;
          }
          if (this.dnqNums.length > 0) {
            this.Log('the race loaded: the DNQ cars ' + this.dnqNums.map(n => '#' + n).join(' ') + ' are still in the field (NR2003 sets it when the weekend loads) - they start from the back');
          }
          this.phase = Ph.Idle;
          this.runs.clear(); this.runNums.clear();
          this.gridWritten = false;
          this.dnqNums = []; this.dnqSlots.clear(); this.hhLogged = false;
        }
        this.status = 'Go to the qualifying session: the grid is written there (qualify yourself if you like).';
        break;
      case Ph.Grid:
        if (kind !== 5) this.FinishGrid(); else this.GridTick();
        break;
      case Ph.Scratch:
        this.ScratchTick(kind);
        break;
      default: break;
    }
  }

  // Happy Hour (practice before the race): the cars that didn't qualify stay in their boxes
  HappyHourTick() {
    const list = [];
    for (let i = 2; i < 44; i++) {
      const st = this.St(i);
      if (!Known.has(st) || !this.dnqNums.includes(this.Num(i))) continue;
      list.push(i);
      if (Wait.has(st)) {
        if (this.Rd(i, Countdown) < 5000000) this.Wr(i, Countdown, 10000000);
      } else if ((Leaving.has(st) || OnTrack.has(st)) && this.Rd(i, RunEnd) > this.Rd(i, Lap)) {
        this.Wr(i, RunEnd, this.Rd(i, Lap));
      }
    }
    if (!this.hhLogged && list.length > 0) {
      this.hhLogged = true;
      this.Log("Happy Hour: the cars that didn't qualify stay in their boxes: " + this.Nums(list));
      if (this.PlayerReady() && this.dnqNums.includes(this.Num(0))) this.Call(3, "YOU DIDN'T QUALIFY: Happy Hour laps are yours, but you start from the back", 20.0);
    }
    this.status = 'Happy Hour: ' + this.dnqNums.length + " car(s) that didn't qualify are held in their boxes. Then the race.";
  }

  // the race: the DNQ cars are taken out before the green (engine damage past the must-pit line, called in, a tow)
  StartScratch() {
    this.scratch.clear(); this.scratchGreenAt = -1.0; this.scratchMeLogged = false;
    this.phase = Ph.Scratch;
    this.Log('the race loaded: taking the DNQ cars out before the green: ' + this.dnqNums.map(n => '#' + n).join(' ') + ' (engine damage past the must-pit line and called in; a tow if still out when the pace car pulls off)');
  }

  EndScratch(why) {
    const still = [...this.scratch.values()].filter(v => !v.Out).map(v => '#' + v.Num);
    this.Log('DNQ cars: ' + why + ' - ' + [...this.scratch.values()].filter(v => v.Out).length + ' out of the race' + (still.length > 0 ? (', still running: ' + still.join(' ')) : ''));
    this.phase = Ph.Idle;
    this.scratch.clear(); this.dnqNums = []; this.dnqSlots.clear(); this.scratchGreenAt = -1.0;
  }

  WrF(c, off, v) { if (c !== 0) this.m.W32(Block0 + c * Stride + off, f32Bits(v)); }
  RdF(c, off) { return this.m.F32(Block0 + c * Stride + off); }

  ModeName(p) {
    if (Known.has(p)) return Known.get(p);
    if (p === DoneForSession) return 'DoneForSession';
    try {
      const t = this.m.Str(this.m.U32(p + 4), 32);
      if (t.length > 2 && [...t].every(ch => ch >= ' ' && ch < '\u007f')) return t;
    } catch (e) { if (!(e instanceof GameMemoryError)) throw e; }
    return '0x' + (p >>> 0).toString(16);
  }

  ScratchTick(kind) {
    if (kind !== 7) { this.EndScratch('the race session ended'); return; }
    const vals = () => [...this.scratch.values()];
    const left = this.dnqNums.length - vals().filter(v => v.Out).length;
    this.status = 'Race start: taking the ' + this.dnqNums.length + " car(s) that didn't qualify out of the race (" + left + ' still in)';
    if (this.m.U8(12500272) !== 2) return;
    const lap = this.m.I32(7795072);
    const flagNo = this.m.U8(7795076);
    const green = lap >= 0 || flagNo === 7;
    const pulling = flagNo >= 4 && flagNo <= 6;
    const g = gameSeconds(this.m);
    if (!this.scratchMeLogged && this.PlayerReady() && this.dnqNums.includes(this.Num(0))) {
      this.scratchMeLogged = true;
      this.Log("you didn't qualify: your car is never touched - you start from the back");
      this.Call(3, "YOU DIDN'T QUALIFY: you start from the back", 20.0);
    }
    for (let i = 2; i < 44; i++) {
      if (!this.scratch.has(i) && this.m.U8(7779164 + i) === 1) {
        const n = this.Num(i);
        if (this.dnqNums.includes(n)) this.scratch.set(i, { Num: n, Mode: this.St(i), CalledAt: -1.0, TowAt: -1.0, Out: false, ResetLogged: false, ReqLogged: false });
      }
    }
    for (const [key, v] of this.scratch) {
      if (v.Out) continue;
      const b = Block0 + key * Stride;
      const st = this.St(key);
      const reason = this.m.U8(b + OutReason);
      const onPit = this.m.U8(7781132 + key) === 1;
      if (st !== v.Mode) {
        this.Log(`#${v.Num} (DNQ): ${this.ModeName(v.Mode)} -> ${this.ModeName(st)}, on pit road ${onPit ? 1 : 0}, repair need ${this.m.I32(b + RepairNeedOff)}, engine damage ${f7(this.RdF(key, EngineDmg), 2)}${!green ? '' : (lap >= 0 ? ', lap ' + lap : ', green')}`);
        v.Mode = st;
      }
      if (this.m.U8(8025816 + key) !== 1 || st === DoneForSession || reason > 0) {
        v.Out = true;
        this.Log(`#${v.Num} (DNQ) is out of the race ${green ? 'after the green' : 'before the green'} (${this.ModeName(st)}, out reason ${reason})`);
        continue;
      }
      if (green) continue;
      const dmg = this.RdF(key, EngineDmg);
      if (dmg < fr(0.95)) {
        this.WrF(key, EngineDmg, 0.95);
        if (v.CalledAt < 0.0) this.Log(`#${v.Num} (DNQ): engine damage ${f7(dmg, 2)} -> 0.95 (must pit)`);
        else if (!v.ResetLogged) {
          v.ResetLogged = true;
          this.Log(`#${v.Num} (DNQ): engine damage back to ${f7(dmg, 2)} (${this.ModeName(st)}) - set to 0.95 again (and every time after)`);
        }
      }
      if (v.CalledAt < 0.0) v.CalledAt = g;
      if (!onPit && !HeadingIn.has(st) && this.m.U8(b + PitRequest) === 0) {
        this.m.W8(b + PitRequest, 1);
        if (!v.ReqLogged) { v.ReqLogged = true; this.Log('#' + v.Num + ' (DNQ): called in (' + this.ModeName(st) + ')'); }
      }
      if (!onPit && !HeadingIn.has(st) && (pulling || g - v.CalledAt > TowAfter)) {
        this.WrF(key, StuckTimer, 13);
        if (v.TowAt < 0.0) {
          v.TowAt = g;
          this.Log('#' + v.Num + ' (DNQ): still on track (' + this.ModeName(st) + ')' + (pulling ? ' as the pace car pulls off' : (' ' + fx(TowAfter, 0) + ' s after the call')) + ': asking for a tow');
        }
      }
    }
    if (!green) return;
    if (this.scratchGreenAt < 0.0) {
      this.scratchGreenAt = g;
      const still = vals().filter(v => !v.Out).map(v => '#' + v.Num);
      this.Log('green flag: DNQ cars out of the race ' + vals().filter(v => v.Out).length + ' of ' + this.dnqNums.length + (still.length > 0 ? ('; still running (from the back, damaged): ' + still.join(' ')) : ''));
    }
    if (this.scratch.size > 0 && vals().every(v => v.Out)) this.EndScratch('all out');
    else if (lap >= 5 || g - this.scratchGreenAt > 300.0) this.EndScratch('no longer watched (lap ' + lap + ')');
  }

  NewPractice() {
    this.field.clear(); this.told.clear(); this.outNow.clear(); this.runs.clear(); this.results = []; this.Board = [];
    this.Timing.Reset(); this.LiveBoard = []; this.dnq.clear(); this.meInQual = false; this.PlayerCall = ''; this.playerCallUntil = -1.0;
    this.single = null; this.koRounds = null;
    this.lane1Q = []; this.lane2Q = []; this.runsMade.clear(); this.withdrawn.clear(); this.wavedOffFirst.clear();
    this.reqOpen = this.reqDone = false; this.reqEndG = -1.0;
    this.dnqNums = []; this.dnqSlots.clear(); this.hhLogged = false;
    this.resultCar = -1; this.BoxKind = BoxShow.None; this.BoxCar = -1;
    this.ResetSaved();
    this.phase = Ph.Holding;
    const what = !this.SingleRuns
      ? (this.Mode === Format.IndyRoad ? 'Indy road / street: groups, Fast 12, Fast Six' : 'knockout rounds ' + this.Rounds)
      : (this.Average ? 'Indy oval runs, ' + this.Laps + '-lap average' : 'single car runs, ' + this.Laps + ' timed lap(s)');
    this.Log('practice session: holding the AI cars in their pit boxes (' + what + ')');
  }

  Start() {
    if (this.CanStart) { if (this.SingleRuns) this.StartSingle(); else this.StartKnockout(); }
  }

  Stop() {
    if (!this.m || !this.Active) return;
    if (this.phase === Ph.Timing) { this.phase = Ph.Stopped; this.Log('stopped: no practice timing or qualifying for the rest of this practice session'); return; }
    if (this.phase === Ph.Holding || this.phase === Ph.Running || this.phase === Ph.Break || this.phase === Ph.Done) {
      this.LetGo();
      this.phase = Ph.Stopped;
      this.Log('stopped: the cars are let go for the rest of this practice session');
    } else {
      this.phase = Ph.Idle;
      this.Log('stopped: no grid written');
    }
    this.FinalState();
  }

  // Race Control closing: let the held cars go and leave a final hand-off state
  Shutdown() {
    if (!this.m) return;
    try {
      if (this.phase === Ph.Holding || this.phase === Ph.Running || this.phase === Ph.Break || this.phase === Ph.Done) {
        this.LetGo();
        this.Log('Race Control closing: the cars are let go for the rest of this practice session');
      }
      if (this.phase !== Ph.Idle && this.phase !== Ph.Grid && this.phase !== Ph.Timing) this.FinalState();
    } catch (e) { if (!(e instanceof GameMemoryError)) throw e; }
  }

  LetGo() {
    for (const c of this.field) {
      if (c !== 0 && Wait.has(this.St(c)) && this.Rd(c, Countdown) > 5000000) this.Wr(c, Countdown, 60 + this.Rnd(600));
    }
    const set = new NetHashSet(this.outNow);
    if (this.single) for (const r of this.single.Active) set.add(r.Car);
    for (const c of set) this.Pace(c, false);
  }

  FinalState() {
    this.Drive(false);
    this.playerHold = false;
    this.BoxKind = BoxShow.None; this.BoxCar = -1;
    this.outNow.clear();
    this.lastState = -1.0;
    if (this.SingleRuns) { if (this.single) this.WriteSingleState('done', true); }
    else this.WriteState('done', 0, 0.0, null, 0);
  }

  // ── single car runs ─────────────────────────────────────────────────────────
  StartSingle() {
    const list = [...this.field].filter(c => Wait.has(this.St(c)));
    const order = [];
    let text = 'random draw';
    const names = (this.Order || '').split(/[, ;\r\n\t]+/).filter(s => s.length > 0).map(s => s.replace(/^#+/, ''));
    if (names.length > 0) {
      const dict = new Map();
      for (const c of list) dict.set(this.Num(c), c);
      for (const n of names) { if (dict.has(n) && !order.includes(dict.get(n))) order.push(dict.get(n)); }
      text = 'your order (' + order.length + ' listed cars found, the rest drawn after them)';
    }
    const rest = list.filter(c => !order.includes(c)).map(c => ({ c, k: this.RndNext() }));
    rest.sort((a, b) => a.k - b.k);                           // stable
    for (const r of rest) order.push(r.c);
    this.single = { Order: order, K: -1, Active: [], History: [], Last: null };
    this.pitSpeeds = [];
    this.resultCar = -1; this.BoxKind = BoxShow.None; this.BoxCar = -1;
    this.phase = Ph.Running;
    this.Log((this.Average ? 'INDY OVAL QUALIFYING, ' : 'SINGLE CAR QUALIFYING, ') + order.length + ' cars, ' + this.Laps + (this.Average ? '-lap average runs' : ' timed lap(s) each') + ', order by ' + text + ': ' + order.map(c => '#' + this.Num(c)).join(' '));
    if (this.ReleaseMode === Release.Gap) {
      this.Log(`release: each car aims to take the green ${fx(this.ReleaseValue, 0)} s after the car before finishes (at most ${this.MaxOut} out at once)`);
    }
    const notIn = [...this.field].filter(c => !order.includes(c)).map(c => '#' + this.Num(c));
    if (notIn.length > 0) this.Log('not in their box yet (they join the end of the order when they show up): ' + notIn.join(' '));
    this.ShowSingleBoard();
    this.lastState = -1.0;
    this.WriteSingleState('running');
  }

  SingleTick() {
    const s = this.single;
    this.Upkeep(new Set(s.Active.map(r => r.Car)));
    for (const c of [...this.field].sort((a, b) => a - b)) {
      if (!s.Order.includes(c) && Wait.has(this.St(c))) {
        s.Order.push(c);
        this.Log('late arrival ' + this.Car(c) + ' joins at position ' + s.Order.length);
      }
    }
    if (this.Lanes && s.K + 1 >= s.Order.length) this.ReQualFeed(s);
    if (s.K + 1 < s.Order.length && this.ReleaseNext(s)) this.ReleaseSingleCar(s);
    if (s.Active.length === 0 && s.K + 1 >= s.Order.length && (!this.Lanes || this.reqDone)) { this.SingleDone(); return; }
    this.LiveHeader = this.reqOpen ? ('RE-QUALIFYING  ' + Qualifying.TimerText(this.ReQualLeft)) : 'SINGLE-CAR QUALIFYING';
    this.LiveBoard = stable(this.results.filter(r => r[0] < NoTime), r => r[0]).map(r => [r[1], roundEven(r[0] * 1000.0) | 0]);
    for (const r of s.Active.slice()) this.RunTick(s, r);
    if (this.field.has(0) && !s.Active.some(r => r.Car === 0)) {
      const from = Math.min(s.K + 1, s.Order.length);
      let idx = s.Order.indexOf(0, from);
      if (idx < from) idx = -1;
      const lane = this.PlayerLane;
      if ((idx > s.K || (this.reqOpen && lane === 0 && this.Runs(0) > 0)) && OnTrack.has(this.St(0))) {
        this.Call(3, (this.reqOpen && idx < 0) ? "RE-QUALIFYING: pick a lane first - these laps don't count" : "NOT YOUR TURN YET: these laps don't count - back to your box");
      } else if (idx === s.K + 1) this.Call(0, "YOU'RE NEXT: wait in your pit box");
      else if (idx > s.K + 1) this.Call(0, `YOUR RUN: ${idx - s.K - 1} cars before you`);
      else if (lane === 1) this.Call(0, `LANE 1: ${this.lane1Q.indexOf(0)} car(s) ahead of you`);
      else if (lane === 2) this.Call(0, `LANE 2: you go when Lane 1 is clear (${this.lane1Q.length} in Lane 1, ${this.lane2Q.indexOf(0)} ahead of you in Lane 2)`);
    }
    this.PlayerTimerSingle(s);
    this.BoxFocus(s);
    const text = s.Active.map(r => this.Car(r.Car) + (r.Lane > 0 ? (' (lane ' + r.Lane + ')') : '') + ' - ' + (r.WavedOff ? 'waved off' : (r.CalledIn ? 'in-lap' : ((r.Before == null || r.Fresh === 0) ? 'out lap' : ('timed lap ' + Math.min(this.Laps, r.Fresh) + ' of ' + this.Laps))))).join('   ');
    this.status = (this.reqOpen ? `RE-QUALIFYING ${Qualifying.TimerText(this.ReQualLeft)} left - Lane 1: ${this.lane1Q.length} waiting, Lane 2: ${this.lane2Q.length} waiting. ` : '') + (s.Active.length === 0 ? 'Next car rolling off' : text);
    this.WriteSingleState('running');
  }

  ReleaseSingleCar(s1) {
    s1.K++;
    const run = newRun(s1.Order[s1.K], this.Wall);
    run.ReleasedG = this.G();
    run.Prev = s1.Last;
    if (this.pendingLane.has(run.Car)) { run.Lane = this.pendingLane.get(run.Car); this.pendingLane.delete(run.Car); }
    run.StallDl = this.Dl(run.Car);
    if (run.Car === 0) {
      const o = { toLine: NaN };
      const out = this.PredictOut(run.StallDl, run, o);
      const fin = (this.ReleaseMode === Release.Gap && run.Prev && s1.Active.includes(run.Prev)) ? this.PredictFinish(run.Prev) : NaN;
      run.TargetG = !Number.isNaN(out) ? run.ReleasedG + out : (!Number.isNaN(fin) ? fin + this.ReleaseValue : -1.0);
    }
    s1.Active.push(run);
    s1.History.push(run);
    s1.Last = run;
    this.Wr(run.Car, Countdown, 1);
    this.Log(`[${s1.K + 1}/${s1.Order.length}] ${this.Car(run.Car)} rolls off pit road${this.ReleaseMode === Release.Gap ? this.gapNote : ''}`);
    this.gapNote = '';
    if (run.Car === 0) {
      this.meInQual = true;
      this.Drive(true);
      this.HoldForReady(`${run.Lane > 0 ? ('LANE ' + run.Lane + ': ') : ''}YOUR RUN: GO NOW - out lap, then ${this.Laps} timed lap${this.Laps === 1 ? '' : 's'}`);
    } else {
      this.SetQualFuel(run.Car);
      this.Pace(run.Car, true);
      this.Log(this.Car(run.Car) + ': ' + this.PaceNow(run.Car));
    }
  }

  PlayerTimerSingle(s1) {
    const run = s1.Active.find(x => x.Car === 0);
    if (!run) {
      const last = s1.Last;
      if (this.ReleaseMode === Release.Gap && s1.K + 1 < s1.Order.length && s1.Order[s1.K + 1] === 0 && last && s1.Active.includes(last)) {
        const f = this.PredictFinish(last);
        if (!Number.isNaN(f)) this.PlayerTimer = 'AT THE GREEN IN|' + Qualifying.TimerText(f + this.ReleaseValue - this.G());
      }
    } else if (!run.CalledIn && !(run.GreenG >= 0.0)) {
      if (run.LeftAt < 0.0 && this.DnqSeconds - (this.Wall - run.Started) < 30.0) {
        this.PlayerTimer = 'PULL OUT IN|' + Qualifying.TimerText(this.DnqSeconds - (this.Wall - run.Started));
        this.PlayerTimerUrgent = true;
      } else if (run.TargetG >= 0.0) {
        this.PlayerTimer = 'AT THE GREEN IN|' + Qualifying.TimerText(run.TargetG - this.G());
      }
    }
  }

  BoxFocus(s1) {
    const src = s1.Active.filter(r => !r.CalledIn);
    const run = src.find(r => r.Before != null && r.Fresh >= 1);
    const run2 = src.find(r => r.LeftAt >= 0.0);
    this.BoxLapMs = 0; this.BoxLapAge = 1000000000.0;
    if (this.resultCar >= 0 && this.Wall - this.resultAt < 5.0) { this.BoxKind = BoxShow.Result; this.BoxCar = this.resultCar; }
    else if (run) {
      this.BoxKind = BoxShow.Live; this.BoxCar = run.Car;
      if (run.LastLapAt >= 0.0) { this.BoxLapMs = run.LastLapMs; this.BoxLapAge = this.Wall - run.LastLapAt; }
    } else if (run2) { this.BoxKind = BoxShow.Waiting; this.BoxCar = run2.Car; }
    else if (this.resultCar >= 0) { this.BoxKind = BoxShow.Result; this.BoxCar = this.resultCar; }
    else { this.BoxKind = BoxShow.None; this.BoxCar = -1; }
  }

  ReleaseNext(s1) {
    if (s1.Active.length === 0) return true;
    const last = s1.Last;
    if (!last || !s1.Active.includes(last)) return true;
    if (s1.Active.length >= Math.max(1, this.MaxOut)) return false;
    if (last.LeftAt < 0.0) return false;
    switch (this.ReleaseMode) {
      case Release.Seconds: return this.Wall - last.LeftAt >= this.ReleaseValue;
      case Release.LapPercent: {
        if (last.CalledIn) return true;
        if (last.Before == null || last.Fresh < this.Laps) return false;
        const t = this.Timing.Of(last.Car);
        if (!t || this.Timing.TrackLen <= 0) return false;
        return t.Path / this.Timing.TrackLen * 100.0 >= this.ReleaseValue;
      }
      case Release.Gap: return this.GapDue(s1, last);
      default: return false;
    }
  }

  // ── the gap release: aim for the green a set time after the car before finishes ──
  PitSpeed(done) {
    const list = done.map(x => [this.Ahead(x.StallDl, x.ExitDl), x.ExitG - x.ReleasedG]).filter(x => !Number.isNaN(x[0]));
    if (list.length >= 3 && maxOf(list.map(x => x[0])) - minOf(list.map(x => x[0])) > 150.0) {
      const mx = avgOf(list.map(x => x[0])), my = avgOf(list.map(x => x[1]));
      const a = list.reduce((s, x) => s + (x[0] - mx) * (x[0] - mx), 0);
      const b = list.reduce((s, x) => s + (x[0] - mx) * (x[1] - my), 0);
      const k = b > 0.0 ? a / b : NaN;
      if (k > 3.0 && k < 60.0) return k;
    }
    if (this.pitSpeeds.length < 5) return NaN;
    const sorted = this.pitSpeeds.slice().sort((a, b) => a - b);
    return sorted[Math.trunc(sorted.length / 2)];
  }

  // seconds from the stall to the green flag line; o.toLine receives the average exit-to-line time
  PredictOut(stallDl, self, o) {
    o.toLine = NaN;
    const list = this.single.History.filter(x => x !== self && x.ExitG > x.ReleasedG && x.ReleasedG >= 0.0 && x.GreenG > x.ExitG && !Number.isNaN(x.StallDl) && !Number.isNaN(x.ExitDl)).reverse().slice(0, 6);
    if (list.length === 0) return NaN;
    o.toLine = avgOf(list.map(x => x.GreenG - x.ExitG));
    const v = this.PitSpeed(list);
    const d = this.Ahead(stallDl, list[0].ExitDl);
    if (Number.isNaN(d)) return NaN;
    const useDist = !Number.isNaN(v) && list.every(x => !Number.isNaN(this.Ahead(x.StallDl, x.ExitDl)));
    const avg = avgOf(list.map(x => x.ExitG - x.ReleasedG - (useDist ? this.Ahead(x.StallDl, x.ExitDl) / v : 0.0)));
    return Math.max(1.0, avg + (useDist ? d / v : 0.0) + o.toLine);
  }

  LapGuess(p) {
    const frac = this.TrackM() > 0.0 ? this.Ahead(0.0, this.Dl(p.Car)) / this.TrackM() : 0.0;
    if (p.LapStartG >= 0.0 && frac > 0.3 && frac < 0.98 && this.LiveBoard.length > 0) {
      const delta = this.Timing.Delta(p.Car, this.LiveBoard[0][0], this.LiveBoard[0][1]);
      if (delta !== null) return (this.LiveBoard[0][1] + delta / frac) / 1000.0;
    }
    if (p.LastLapMs > 0) return p.LastLapMs / 1000.0;
    const list = this.single.History.filter(x => x.LastLapMs > 0).map(x => x.LastLapMs);
    if (list.length > 0) return list.slice().sort((a, b) => a - b)[Math.trunc(list.length / 2)] / 1000.0;
    const tm = this.TrackM(), ahead = this.Ahead(0.0, this.Dl(p.Car)), dt = this.G() - p.LapStartG;
    if (p.LapStartG >= 0.0 && tm > 0.0 && ahead > 0.2 * tm && ahead < 0.98 * tm && dt > 1.0) return dt * tm / ahead;
    return NaN;
  }

  PredictFinish(p) {
    if (p.FinishG >= 0.0) return p.FinishG;
    const lap = this.LapGuess(p);
    if (Number.isNaN(lap)) return NaN;
    if (p.GreenG >= 0.0) return p.LapStartG + (this.Laps - Math.min(this.Laps, p.Fresh) + 1) * lap;
    const o = { toLine: NaN };
    const out = this.PredictOut(p.StallDl, p, o);
    const t = (p.ExitG >= 0.0 && !Number.isNaN(o.toLine)) ? p.ExitG + o.toLine : p.ReleasedG + out;
    if (!Number.isNaN(t)) return t + this.Laps * lap;
    return NaN;
  }

  GapDue(s1, prev) {
    const c = s1.Order[s1.K + 1];
    const o = { toLine: NaN };
    const out = this.PredictOut(this.Dl(c), null, o);
    const fin = this.PredictFinish(prev);
    const g = this.G();
    if (Number.isNaN(out) || Number.isNaN(fin)) return false;
    const due = fin + this.ReleaseValue - out;
    if (g < due) return false;
    this.gapNote = ` (out lap about ${fx(out, 1)} s; aiming for the green ${fx(this.ReleaseValue, 0)} s after #${this.Num(prev.Car)} finishes${g - due > 3.0 ? `, ${fx(g - due, 1)} s late` : ''})`;
    return true;
  }

  LogGap(r) {
    if (!r.GapLogged && r.Prev && !(r.Prev.FinishG < 0.0) && !(r.GreenG < 0.0)) {
      r.GapLogged = true;
      const d = r.GreenG - r.Prev.FinishG;
      this.Log(`#${this.Num(r.Car)} took the green ${fx(Math.abs(d), 1)} s ${d >= 0.0 ? 'after' : 'before'} #${this.Num(r.Prev.Car)} finished${this.ReleaseMode === Release.Gap ? ` (aim ${fx(this.ReleaseValue, 0)} s)` : ''}`);
    }
  }

  RunMarks(r, s, cur) {
    const car = r.Car;
    if (Leaving.has(s)) {
      const dl = this.Dl(car), g = this.G();
      if (r.LastG < 0.0 || g > r.LastG + 1.0) {
        if (r.LastG >= 0.0) {
          const v = this.Ahead(r.LastDl, dl) / (g - r.LastG);
          if (v > 3.0 && v < 60.0) {
            this.pitSpeeds.push(v);
            if (this.pitSpeeds.length > 2000) this.pitSpeeds.splice(0, 500);
          }
        }
        r.LastDl = dl; r.LastG = g;
      }
    }
    if (r.ExitG < 0.0 && r.LeftAt >= 0.0 && OnTrack.has(s)) { r.ExitG = this.G(); r.ExitDl = this.Dl(car); }
    if (cur.length === 0) return;
    r.LapStartG = cur[Math.min(cur.length, this.Laps) - 1] / 1000.0;
    if (r.GreenG < 0.0) { r.GreenG = cur[0] / 1000.0; this.LogGap(r); }
    const n = Math.min(cur.length - 1, this.Laps);
    if (n > r.LapsDone) {
      for (let i = r.LapsDone + 1; i <= n; i++) r.LapMs.push((cur[i] - cur[i - 1]) | 0);
      r.LapsDone = n;
      r.LastLapMs = (cur[n] - cur[n - 1]) | 0;
      r.LastLapAt = this.Wall;
    }
    if (!(r.FinishG < 0.0) || cur.length <= this.Laps) return;
    r.FinishG = cur[this.Laps] / 1000.0;
    for (const x of this.single.History.filter(h => h.Prev === r)) this.LogGap(x);
  }

  RunLaps(r, cur) {
    let list = [];
    for (let i = 1; i < Math.min(cur.length, this.Laps + 1); i++) {
      const t = (cur[i] - cur[i - 1]) / 1000.0;
      if (t > 5.0 && t < 400.0) list.push(t);
      else if (i < r.WallAt.length) list.push(this.roundD(r.WallAt[i] - r.WallAt[i - 1], 3));
    }
    if (list.length < r.LapMs.length) list = r.LapMs.filter(ms => ms > 5000 && ms < 400000).map(ms => ms / 1000.0);
    return list;
  }

  FieldToGarage() {
    if (this.field.size >= 4) return [...this.field].filter(c => Garage.has(this.St(c))).length >= Math.trunc(this.field.size / 2);
    return false;
  }

  RunResult(r, cur) {
    const laps = this.RunLaps(r, cur);
    const score = this.Score(laps);
    if (!(score >= NoTime)) {
      const best = roundEven(score * 1000.0) | 0;
      const list = this.results.filter(x => x[0] < NoTime && x[1] !== r.Car).map(x => roundEven(x[0] * 1000.0) | 0);
      this.resultCar = r.Car; this.resultAt = this.Wall; this.ResultBestMs = best;
      this.ResultHasDiff = list.length > 0;
      this.ResultDiffMs = this.ResultHasDiff ? best - minOf(list) : 0;
      this.ResultPos = 1 + list.filter(o => o < best).length;
    }
  }

  RunTick(s1, r) {
    const car = r.Car;
    const st = this.St(car);
    this.Pace(car, true);
    if (r.LeftAt < 0.0 && (Leaving.has(st) || OnTrack.has(st))) r.LeftAt = this.Wall;
    if (car === 0 && r.LeftAt < 0.0 && this.PlayerLeftBox(r)) {
      r.LeftAt = this.Wall;
      this.Log(`your car: left the box (${fx(this.Wall - r.Started, 1)} s after the go)`);
    }
    if (car === 0 && this.playerHold && r.LeftAt < 0.0) r.Started = this.Wall;
    if (car === 0 && r.LeftAt >= 0.0) this.playerHold = false;
    if (r.Before == null && r.LeftAt < 0.0 && !Leaving.has(st) && !OnTrack.has(st) && !PitIn.has(st) && this.Wall - r.Started > this.DnqSeconds) {
      const had = this.results.some(x => x[1] === car);
      this.Log(had ? `${this.Car(car)} didn't pull out in ${fx(this.DnqSeconds, 0)} s: no run (it keeps what it had)` : `${this.Car(car)} didn't pull out in ${fx(this.DnqSeconds, 0)} s: DNQ (starts at the back)`);
      if (car === 0) { this.Call(3, had ? "NO RUN: you didn't pull out in time" : "DNQ: you didn't pull out in time", 15.0); this.Drive(false); this.playerHold = false; }
      this.Wr(car, Countdown, 10000000);
      this.Pace(car, false);
      if (!had) this.dnq.add(car);
      r.WavedOff = true;
      this.PostResult(r, [], true);
      s1.Active.splice(s1.Active.indexOf(r), 1);
      this.ShowSingleBoard();
      return;
    }
    if (r.Before == null && OnTrack.has(st)) { r.Before = this.Crossings(car); r.JoinDl = this.Dl(car); }
    const list = r.Before != null ? this.Crossings(car).slice(r.Before.length) : [];
    if (r.Before != null && !r.JoinChecked && list.length > 0) {
      r.JoinChecked = true;
      const tm = this.TrackM(), d = this.Ahead(r.JoinDl, 0.0);
      if (tm > 0.0 && !Number.isNaN(d) && d < 0.4 * tm) {
        this.Log(`${this.Car(car)} came onto the track ${fx(d, 0)} m before the line: that crossing is its out lap, the timed lap starts next time by`);
        r.Before.push(list[0]);
        list.shift();
      }
    }
    r.Fresh = list.length;
    while (r.WallAt.length < r.Fresh) r.WallAt.push(this.Wall);
    this.RunMarks(r, st, list);
    let text = null;
    if (!r.CalledIn) {
      if (Garage.has(st) && this.FieldToGarage()) return;
      if (Damaged.has(st) || (r.LeftAt >= 0.0 && Garage.has(st))) text = Qualifying.StateName(st);
      else {
        let cameBack = false;
        if (r.Before != null) {
          if (car !== 0) cameBack = Entering.has(st) || Wait.has(st) || Stall.has(st);
          else cameBack = this.PlayerStopped(st);
        }
        if (cameBack) text = 'came back to pit road on its own';
        else if (!this.WaveOffDue(r)) {
          if (r.Fresh >= this.Laps + 1) {
            this.Wr(car, RunEnd, this.Rd(car, Lap));
            r.CalledIn = true;
            this.RunResult(r, list);
            if (car === 0) this.Call(2, this.resultCar === 0 ? `RUN COMPLETE: ${Ms(this.ResultBestMs)}, P${this.ResultPos} - bring it in to your box and climb out` : 'RUN COMPLETE - bring it in to your box and climb out');
          } else if (Leaving.has(st) || OnTrack.has(st)) this.Wr(car, RunEnd, this.Rd(car, Lap) + 50);
        }
      }
      if (car === 0 && !r.CalledIn && text == null) {
        this.Call(1, (r.Before == null && !OnTrack.has(st)) ? 'YOUR RUN: GO NOW' : (r.Fresh === 0 ? 'OUT LAP: your time starts at the line' : `TIMED LAP ${Math.min(this.Laps, r.Fresh)} OF ${this.Laps}`));
      }
    }
    const flag = r.CalledIn && (Entering.has(st) || Wait.has(st) || Garage.has(st) || Stall.has(st) || (car === 0 && r.Fresh >= this.Laps + 2));
    if (text == null && !flag && this.Wall - r.Started < 600.0) return;
    let laps = this.RunLaps(r, list);
    const sorted = this.results.filter(x => x[0] < NoTime).map(x => x[0]).sort((a, b) => a - b);
    const usual = sorted.length >= 3 ? sorted[Math.trunc(sorted.length / 2)] : (laps.length > 0 ? minOf(laps) : 0.0);
    if (usual > 0.0 && !this.Average) {
      const over = laps.filter(x => x > 2.0 * usual);
      if (over.length > 0) this.Log(this.Car(car) + ': lap(s) ' + over.map(x => fx(x, 3)).join(', ') + ' not counted (over twice the usual lap)');
      laps = laps.filter(x => x <= 2.0 * usual);
    }
    if (text != null && car === 0 && this.Lanes && this.Average && r.Before != null && laps.length < this.Laps && text === 'came back to pit road on its own') {
      r.WavedOff = true;
      text = null;
      this.Log('your car: back on pit road before the last timed lap - waved off');
      this.Call(2, "WAVED OFF: this run doesn't count", 15.0);
    }
    if (text != null) {
      const timed = this.results.some(x => x[1] === car && x[0] < NoTime);
      if (laps.length === 0 && !timed) { this.Log('#' + this.Num(car) + ' DNQ: ' + text + ' before finishing a timed lap'); this.dnq.add(car); }
      else if (laps.length === 0) this.Log(this.Car(car) + ': ' + text + ' before finishing a timed lap - it keeps what it had');
      else this.Log(this.Car(car) + ': ' + text + ' - the timed lap(s) it finished stand');
    }
    this.PostResult(r, laps);
    if (car === 0 && text != null) this.Call(laps.length === 0 ? 3 : 2, laps.length !== 0 ? 'RUN OVER: your timed lap(s) stand' : (this.Official(0) < NoTime ? 'RUN OVER: no timed lap - your time stands' : 'DNQ: no timed lap finished'), 15.0);
    else if (car === 0) this.Call(this.PlayerCallKind, this.PlayerCall, 8.0);
    const lapsTxt = laps.map(t => fx(t, 3)).join(', ');
    this.Log(this.Car(car) + (r.WavedOff ? (': waved off' + (laps.length > 0 ? (' (laps ' + lapsTxt + ')') : '')) : (laps.length > 0 ? (': laps ' + lapsTxt + this.ScoreText(laps)) : ': no lap time read')));
    this.Pace(car, false);
    s1.Active.splice(s1.Active.indexOf(r), 1);
    this.ShowSingleBoard();
  }

  roundD(x, d) { const p = Math.pow(10, d); return roundEven(x * p) / p; }

  ShowSingleBoard() {
    const list = [];
    let n = 0;
    const cut = (this.Starters > 0 && this.single) ? this.FieldCut(new Set(this.single.Order).size) : 0;
    for (const r of stable(this.results, x => x[0])) {
      if (cut > 0 && n === cut) list.push('    ---- the field: ' + cut + ' cars ----');
      list.push(`${padL(++n, 2)}. #${padR(this.Num(r[1]), 4)} ${padR(this.Name(r[1]), 24)} ${r[0] < NoTime ? LapFmt.Lap(roundEven(r[0] * 1000.0) | 0) : (this.withdrawn.has(r[1]) ? 'time given up (Lane 1)' : (this.dnq.has(r[1]) ? 'DNQ' : 'no time'))}`);
    }
    if (this.single) {
      for (const r of this.single.Active) list.push(`    #${padR(this.Num(r.Car), 4)} ${padR(this.Name(r.Car), 24)} ${r.Lane > 0 ? ('on track (lane ' + r.Lane + ')') : 'on track'}`);
      for (const c of this.single.Order.slice(this.single.K + 1)) list.push(`    #${padR(this.Num(c), 4)} ${padR(this.Name(c), 24)} waiting`);
      if (this.reqOpen) list.push('    Lane 1: ' + this.Nums(this.lane1Q) + '    Lane 2: ' + this.Nums(this.lane2Q));
    }
    this.Board = list;
  }

  SingleDone() {
    this.Log('all cars have run; holding everyone in their boxes until practice ends');
    this.TakeSingleRuns();
    this.phase = Ph.Done;
    this.WriteSingleState('done');
  }

  TakeSingleRuns() {
    this.runs.clear(); this.runNums.clear();
    for (const r of this.results) {
      if (r[2].length !== 0 && !(r[0] >= NoTime)) {
        this.runs.set(r[1], this.Average ? new Array(r[2].length).fill(roundEven(r[0] * 1000.0) | 0) : r[2].map(t => roundEven(t * 1000.0) | 0));
        this.runNums.set(r[1], this.Num(r[1]));
      }
    }
    const order = stable(this.results, r => r[0]).map(r => r[1]);
    if (this.single) for (const c of new Set(this.single.Order)) if (!order.includes(c)) order.push(c);
    this.ApplyCut(order);
    if (this.runs.size > 0 || this.dnqNums.length > 0) this.SaveRuns();
    this.WriteResults(this.Average ? 'INDY OVAL QUALIFYING (' + this.Laps + '-LAP AVERAGE)' : 'SINGLE CAR QUALIFYING',
      order.map(c => { const v = this.Official(c); return [c, v < NoTime ? (roundEven(v * 1000.0) | 0) : null]; }));
  }

  PracticeOver() {
    if (this.koRounds) {
      this.Log('PRACTICE ENDED before the knockout rounds were done: no grid written (make practice longer)');
      this.koRounds = null; this.phase = Ph.Idle;
      this.FinalState();
      return;
    }
    if (this.single) {
      for (const item of this.single.Active.slice()) {
        const laps = this.RunLaps(item, []);
        this.PostResult(item, laps);
        this.Log(this.Car(item.Car) + ': practice ended during its run - ' + (laps.length > 0
          ? ('laps ' + laps.map(t => fx(t, 3)).join(', ') + (this.Score(laps) < NoTime ? ' stand' + this.ScoreText(laps) : this.ScoreText(laps)))
          : 'no timed lap finished, no time'));
        this.Pace(item.Car, false);
        this.single.Active.splice(this.single.Active.indexOf(item), 1);
      }
    }
    this.Log((this.single && this.single.K + 1 < this.single.Order.length)
      ? ('PRACTICE ENDED after ' + (this.single.K + 1) + ' of ' + this.single.Order.length + ' cars (make practice longer): the cars without a run go to the back')
      : 'practice ended');
    this.TakeSingleRuns();
    this.phase = this.runs.size > 0 ? Ph.GridWait : Ph.Idle;
    this.FinalState();
  }

  static ParseRounds(text) {
    const out = [];
    for (const part of (text || '').split(/[,;]/).filter(s => s.length > 0)) {
      const a = part.split(':');
      if (a.length === 2) {
        const m = parseFloat(a[0].trim()), n = parseInt(a[1].trim(), 10);
        if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(a[0].trim()) && /^[-+]?\d+$/.test(a[1].trim()) && m > 0.0) out.push([m, Math.max(1, n)]);
      }
    }
    return out;
  }

  // ── knockout rounds (and Indy road / street) ────────────────────────────────
  StartKnockout() {
    if (this.Mode === Format.IndyRoad) { this.StartIndyRoad(); return; }
    this.koRounds = Qualifying.ParseRounds(this.Rounds);
    if (this.koRounds.length === 0) {
      this.Log('no knockout rounds set (minutes : cars, e.g. 25:24, 10:12, 5:12)');
      this.koRounds = null;
      return;
    }
    this.koResults = []; this.koEntered = []; this.koEntrants = null; this.koRound = 0;
    const total = this.koRounds.reduce((a, r) => a + r[0], 0) + this.BreakSeconds / 60.0 * (this.koRounds.length - 1);
    this.Log(`KNOCKOUT QUALIFYING: ${this.koRounds.length} rounds, ${this.koRounds.map((r, i) => 'R' + (i + 1) + ' ' + g01(r[0]) + ' min' + (i < this.koRounds.length - 1 ? (' (top ' + r[1] + ' advance)') : '')).join(', ')}. Needs about ${fx(total + 3.0, 0)} minutes of practice.`);
    this.StartRound();
  }

  StartIndyRoad() {
    let source = [...this.field].filter(c => Wait.has(this.St(c)));
    let text;
    if (this.IndySplit === Split.Rating) {
      source = stable(source, c => -this.m.F32(Block0 + c * Stride + QpRating));
      text = 'driver rating, alternating';
    } else if (this.IndySplit === Split.List) {
      const wanted = (this.Order || '').split(/[, ;\r\n\t]+/).filter(s => s.length > 0).map(s => s.replace(/^#+/, ''));
      const keyed = source.map(c => { const i = wanted.indexOf(this.Num(c)); return { c, a: i >= 0 ? i : 2147483647, b: this.RndNext() }; });
      keyed.sort((x, y) => x.a - y.a || x.b - y.b);
      source = keyed.map(x => x.c);
      text = 'the running order list, alternating';
    } else {
      const keyed = source.map(c => ({ c, k: this.RndNext() }));
      keyed.sort((x, y) => x.k - y.k);
      source = keyed.map(x => x.c);
      text = 'random draw';
    }
    this.indyG1 = source.filter((c, i) => i % 2 === 0);
    this.indyG2 = source.filter((c, i) => i % 2 === 1);
    this.koRounds = [[this.IndyGroupMin, this.IndyGroupAdv], [this.IndyGroupMin, this.IndyGroupAdv], [this.IndyF12Min, this.IndyF12Adv], [this.IndyF6Min, 0]];
    this.koResults = []; this.koEntered = []; this.koEntrants = null; this.koRound = 0;
    const total = 2.0 * this.IndyGroupMin + this.IndyF12Min + this.IndyF6Min + this.BreakSeconds / 60.0 * 3.0;
    this.Log(`INDY ROAD / STREET QUALIFYING: Group 1 and Group 2 (${g01(this.IndyGroupMin)} min, top ${this.IndyGroupAdv} of each through), Fast 12 (${g01(this.IndyF12Min)} min, top ${this.IndyF12Adv} through), Fast Six (${g01(this.IndyF6Min)} min). Groups by ${text}. Needs about ${fx(total + 3.0, 0)} minutes of practice.`);
    this.Log('Group 1: ' + this.indyG1.map(c => '#' + this.Num(c)).join(' '));
    this.Log('Group 2: ' + this.indyG2.map(c => '#' + this.Num(c)).join(' '));
    this.StartRound();
  }

  IndyRoundCars() {
    if (this.koRound === 0) return new NetHashSet(this.indyG1);
    if (this.koRound === 1) return new NetHashSet(this.indyG2);
    if (this.koRound === 2) {
      const pick = (grp, res) => stable(grp.filter(c => res.has(c)), c => res.get(c)).concat(grp.filter(c => !res.has(c))).slice(0, this.IndyGroupAdv);
      return new NetHashSet(pick(this.indyG1, this.koResults[0]).concat(pick(this.indyG2, this.koResults[1])));
    }
    return new NetHashSet(this.koEntrants || []);
  }

  StartRound() {
    const r = this.koRounds[this.koRound];
    const last = this.koRound === this.koRounds.length - 1;
    this.koCars = this.Mode === Format.IndyRoad ? this.IndyRoundCars() : (this.koEntrants == null ? new NetHashSet(this.field) : new NetHashSet(this.koEntrants));
    this.koEntered.push(this.koCars);
    this.koRec = new Map([...this.koCars].map(c => [c, []]));
    this.koSeen = new Map([...this.koCars].map(c => [c, this.Crossings(c).length]));
    this.koAtFlag = new Map(); this.koReleased = new NetHashSet(); this.koFlag = false; this.koElapsed = 0.0;
    this.koLastGame = gameSeconds(this.m); this.koLastWall = this.Wall; this.koNextPrint = 60.0;
    this.phase = Ph.Running;
    this.Log(`${this.RoundName(this.koRound)}: ${this.koCars.size} cars, ${g01(r[0])} minutes${last ? '' : (', top ' + r[1] + ' advance')}`);
  }

  RoundClock() {
    const game = gameSeconds(this.m), wall = this.Wall, dw = wall - this.koLastWall;
    if (this.m.U8(12500272) !== 3) {
      if (game > this.koLastGame) this.koElapsed += Math.min(game - this.koLastGame, dw * 64.0 + 0.5);
      else if ([...this.outNow].some(c => this.Speed(c) > 5.0)) this.koElapsed += dw;
    }
    this.koLastGame = game; this.koLastWall = wall;
    return this.koElapsed;
  }

  KoCollect() {
    for (const car of [...this.koRec.keys()]) {
      const list = this.Crossings(car);
      if (list.length > this.koSeen.get(car)) {
        const st = this.St(car);
        const ok = OnTrack.has(st) || PitIn.has(st);
        for (let i = this.koSeen.get(car); i < list.length; i++) this.koRec.get(car).push([list[i], ok]);
        this.koSeen.set(car, list.length);
      }
    }
  }

  KoBests() {
    const out = new Map();
    for (const [car, rec] of this.koRec) {
      const lim = this.koAtFlag.has(car) ? this.koAtFlag.get(car) : rec.length;
      let best = 2147483647;
      for (let i = 0; i + 1 < rec.length; i++) {
        const a = rec[i], b = rec[i + 1];
        const d = b[0] - a[0];
        if (a[1] && b[1] && i < lim && d > 5000 && d < 400000 && d < best) best = d;
      }
      if (best < 2147483647) out.set(car, best);
    }
    return out;
  }

  KnockoutTick() {
    const r = this.koRounds[this.koRound];
    const last = this.koRound === this.koRounds.length - 1;
    const cutoff = !last ? r[1] : 0;
    const sortedBy = (map) => stable([...map.entries()], e => e[1]);
    if (this.phase === Ph.Break) {
      this.Upkeep(null);
      const left = this.koBreakEnd - this.Wall;
      this.status = `Break before round ${this.koRound + 1}: ${fx(Math.max(0.0, left), 0)} s`;
      const L = Math.trunc(Math.max(0.0, left));
      this.LiveHeader = `${this.RoundName(this.koRound)} STARTS IN ${Math.trunc(L / 60)}:${pad2(L % 60)}`;
      const prev = sortedBy(this.koResults[this.koResults.length - 1]);
      this.LiveBoard = prev.map(kv => [kv[0], kv[1]]);
      this.WriteState('break', this.koRound, left, prev.map(kv => [kv[0], kv[1]]), this.koRounds[this.koRound - 1][1], this.koRound + 1);
      if (left <= 0.0) this.StartRound();
      return;
    }
    this.Upkeep(this.outNow);
    if (this.field.has(0) && !this.koCars.has(0) && OnTrack.has(this.St(0))) this.Call(3, 'NOT IN ' + this.RoundName(this.koRound) + ": these laps don't count");
    if (this.koEntrants == null && this.Mode !== Format.IndyRoad && !this.koFlag) {
      for (const c of this.field) {
        if (!this.koRec.has(c)) { this.koRec.set(c, []); this.koSeen.set(c, this.Crossings(c).length); this.koCars.add(c); }
      }
    }
    const elapsed = this.RoundClock();
    const total = r[0] * 60.0;
    const left = Math.max(0.0, total - elapsed);
    for (const c of this.koCars) {
      if (!this.koFlag && !this.koReleased.has(c) && (Wait.has(this.St(c)) || (c === 0 && !Garage.has(this.St(c))))) {
        this.outNow.add(c);
        this.Wr(c, Countdown, 1 + 8 * this.koReleased.size);
        this.koReleased.add(c);
        this.SetQualFuel(c);
        if (c === 0) {
          this.meInQual = true;
          this.Drive(true);
          this.HoldForReady(this.RoundName(this.koRound) + ': GO - set your best lap');
        }
      }
    }
    if (!this.koFlag && this.outNow.has(0)) {
      this.PlayerTimer = 'TIME LEFT|' + Qualifying.TimerText(left);
      this.PlayerTimerUrgent = left < 60.0;
    }
    this.KoCollect();
    for (const c of this.koCars) {
      if (this.outNow.has(c) && Damaged.has(this.St(c))) {
        this.outNow.delete(c);
        this.Pace(c, false);
        this.Log('#' + this.Num(c) + ' out of round ' + (this.koRound + 1) + ': damaged (' + Qualifying.StateName(this.St(c)) + ')');
      }
    }
    for (const c of this.koCars) this.Pace(c, this.outNow.has(c));
    if (!this.koFlag) {
      for (const c of this.koCars) {
        const st = this.St(c);
        if (Leaving.has(st) || OnTrack.has(st)) this.Wr(c, RunEnd, this.Rd(c, Lap) + 50);
      }
      if (left <= 0.0) {
        this.koFlag = true;
        for (const c of this.koCars) {
          this.koAtFlag.set(c, this.koRec.get(c).length);
          const st = this.St(c);
          if (OnTrack.has(st)) this.Wr(c, RunEnd, this.Rd(c, Lap) + 1);
          else if (Leaving.has(st)) this.Wr(c, RunEnd, this.Rd(c, Lap));
          else if (Wait.has(st)) { this.outNow.delete(c); this.Wr(c, Countdown, 10000000); }
        }
        this.Log(this.RoundName(this.koRound) + ': time! Cars finish the lap they are on and come in.');
        if (this.koCars.has(0)) this.Call(2, this.RoundName(this.koRound) + ': CHECKERED - finish this lap and come in');
      }
    } else {
      for (const c of this.koCars) {
        const st = this.St(c);
        if (this.outNow.has(c) && (Wait.has(st) || Garage.has(st) || Stall.has(st))) this.outNow.delete(c);
        else if (c === 0 && this.outNow.has(c) && (Entering.has(st) || !this.koAtFlag.has(c) || !this.koRec.has(c) || this.koRec.get(c).length > this.koAtFlag.get(c))) this.outNow.delete(c);
      }
      if (![...this.koCars].some(c => this.outNow.has(c))) { this.EndRound(); return; }
    }
    const source = sortedBy(this.KoBests());
    if (elapsed >= this.koNextPrint && !this.koFlag) {
      this.koNextPrint += 60.0;
      this.Log(`R${this.koRound + 1} ${fx(left / 60.0, 1)} min left: ` + source.slice(0, 6).map((kv, i) => (i + 1) + '. #' + this.Num(kv[0]) + ' ' + Ms(kv[1])).join('  '));
    }
    const L = Math.trunc(left);
    this.status = `${this.RoundName(this.koRound)} (${this.koRound + 1} of ${this.koRounds.length}): ${this.koFlag ? 'checkered, cars coming in' : `${Math.trunc(L / 60)}:${pad2(L % 60)} left`}`;
    this.Board = source.map((kv, i) => `${padL(i + 1, 2)}. #${padR(this.Num(kv[0]), 4)} ${padR(this.Name(kv[0]), 24)} ${Ms(kv[1])}${(cutoff > 0 && i === cutoff - 1) ? '   ---- cut' : ''}`);
    this.LiveHeader = this.koFlag ? (this.RoundName(this.koRound) + '  -  CHECKERED FLAG') : `${this.RoundName(this.koRound)}  -  ${Math.trunc(L / 60)}:${pad2(L % 60)}`;
    this.LiveBoard = source.map(kv => [kv[0], kv[1]]);
    this.WriteState(this.koFlag ? 'checkered' : 'running', this.koRound + 1, left, source.map(kv => [kv[0], kv[1]]), cutoff);
  }

  EndRound() {
    this.KoCollect();
    const best = this.KoBests();
    this.koResults.push(best);
    const r = this.koRounds[this.koRound];
    const last = this.koRound === this.koRounds.length - 1;
    const list = stable([...best.entries()], e => e[1]);
    this.Log(this.RoundName(this.koRound) + ' RESULTS: ' + list.map((kv, i) => (i + 1) + '. #' + this.Num(kv[0]) + ' ' + Ms(kv[1]) + ((!last && i === r[1] - 1) ? ' |' : '')).join('  '));
    let noTime = [...this.koCars].filter(c => !best.has(c));
    if (noTime.length > 0) this.Log('no time: ' + noTime.map(c => '#' + this.Num(c)).join(' '));
    if (last) { if (this.Mode === Format.IndyRoad) this.IndyGrid(); else this.KnockoutGrid(); return; }
    const prev = this.koResults.length > 1 ? this.koResults[this.koResults.length - 2] : new Map();
    noTime = stable(noTime, c => (prev.has(c) ? prev.get(c) : 2147483647));
    this.koEntrants = list.map(kv => kv[0]).concat(noTime).slice(0, r[1]);
    if (this.koCars.has(0)) {
      const pos = list.findIndex(kv => kv[0] === 0) + 1;
      const through = (this.Mode !== Format.IndyRoad || this.koRound >= 2) ? this.koEntrants.includes(0) : (pos > 0 && pos <= this.IndyGroupAdv);
      this.Call(!through ? 3 : 0, (pos > 0 ? ('P' + pos + ' - ') : 'no time - ') + (through ? ('THROUGH TO ' + this.RoundName(this.koRound + 1)) : ('OUT IN ' + this.RoundName(this.koRound))), 20.0);
    }
    if (list.length < r[1]) this.Log('only ' + list.length + ' cars set a time; ' + (r[1] - list.length) + ' more go through in their previous order');
    this.koRound++;
    this.koBreakEnd = this.Wall + this.BreakSeconds;
    this.phase = Ph.Break;
  }

  KnockoutGrid() {
    const list = [];
    const dict = new Map();
    const placed = new Set();
    for (let n = this.koResults.length - 1; n >= 0; n--) {
      const res = this.koResults[n];
      const prev = n > 0 ? this.koResults[n - 1] : new Map();
      const source = [...this.koEntered[n]].filter(c => !placed.has(c));
      for (const c of stable(source.filter(c => res.has(c)), c => res.get(c))) { list.push(c); dict.set(c, res.get(c)); placed.add(c); }
      const without = source.filter(c => !res.has(c)).map((c, i) => ({ c, i })).sort((a, b) => ((prev.has(a.c) ? prev.get(a.c) : 2147483647) - (prev.has(b.c) ? prev.get(b.c) : 2147483647)) || a.c - b.c).map(x => x.c);
      for (const c of without) { list.push(c); placed.add(c); if (prev.has(c)) dict.set(c, prev.get(c)); }
    }
    for (const c of [...this.field].sort((a, b) => a - b)) { if (!placed.has(c)) { placed.add(c); list.push(c); } }
    this.WriteGrid('KNOCKOUT QUALIFYING GRID', list, dict);
  }

  IndyGrid() {
    const grid = [];
    const deciding = new Map();
    const placed = new Set();
    const place = (cars, res, prev) => {
      for (const c of stable(cars.filter(c => res.has(c)), c => res.get(c))) {
        if (!placed.has(c)) { placed.add(c); grid.push(c); deciding.set(c, res.get(c)); }
      }
      for (const c of stable(cars.filter(c => !res.has(c)), c => (prev == null || !prev.has(c)) ? 2147483647 : prev.get(c))) {
        if (!placed.has(c)) { placed.add(c); grid.push(c); if (prev != null && prev.has(c)) deciding.set(c, prev.get(c)); }
      }
    };
    place([...this.koEntered[3]], this.koResults[3], this.koResults[2]);
    place([...this.koEntered[2]], this.koResults[2], null);
    const rest = (grp, res) => stable(grp.filter(c => !placed.has(c)), c => (!res.has(c)) ? 2147483647 : res.get(c));
    const l1 = rest(this.indyG1, this.koResults[0]), l2 = rest(this.indyG2, this.koResults[1]);
    for (let i = 0; i < Math.max(l1.length, l2.length); i++) {
      for (const [lst, res] of [[l1, this.koResults[0]], [l2, this.koResults[1]]]) {
        if (i < lst.length && !placed.has(lst[i])) {
          placed.add(lst[i]); grid.push(lst[i]);
          if (res.has(lst[i])) deciding.set(lst[i], res.get(lst[i]));
        }
      }
    }
    for (const c of [...this.field].sort((a, b) => a - b)) { if (!placed.has(c)) { placed.add(c); grid.push(c); } }
    this.WriteGrid('INDY ROAD / STREET QUALIFYING GRID', grid, deciding);
  }

  WriteGrid(title, grid, deciding) {
    this.ApplyCut(grid);
    this.runs.clear(); this.runNums.clear();
    let prevMs = 0;
    const out = [];
    for (const c of grid) {
      const v = deciding.has(c) ? Math.max(deciding.get(c), prevMs + 1) : (prevMs + 100);
      prevMs = v;
      this.runs.set(c, [v]);
      this.runNums.set(c, this.Num(c));
      out.push([c, deciding.has(c) ? deciding.get(c) : null]);
    }
    this.WriteResults(title, out);
    this.SaveRuns();
    this.WriteState('done', this.koRounds.length, 0.0, out, 0);
    this.koRounds = null;
    this.phase = Ph.Done;
  }

  WriteResults(title, order) {
    this.TakeFinal(order);                  // QualControl: the order and the round each car reached, for Save results
    const list = [];
    let n = 0;
    for (const o of order) {
      if (this.dnqSlots.size > 0 && this.dnqSlots.has(o[0]) && !list.some(x => x.startsWith('    ---- did not qualify'))) list.push('    ---- did not qualify ----');
      list.push(`${padL(++n, 2)}. #${padR(this.Num(o[0]), 4)} ${padR(this.Name(o[0]), 24)} ${o[1] != null ? Ms(o[1]) : 'no time'}${this.dnqSlots.has(o[0]) ? '  DNQ' : ''}`);
    }
    this.Board = list;
    this.Log(title + ':\r\n    ' + list.join('\r\n    '));
  }

  // ── the qualifying session: write the practice laps into the game's leaderboard ─
  StartGrid() {
    for (const c of [...this.runs.keys()]) {
      if (this.Num(c) !== this.runNums.get(c)) {
        this.Log('slot ' + c + ' is now #' + this.Num(c) + ', not #' + this.runNums.get(c) + ': skipped');
        this.runs.delete(c);
      }
    }
    this.orig.clear(); this.written.clear();
    this.meNoLapLogged = false;
    if (this.runs.size === 0) { this.Log('no qualifying times to write'); this.phase = Ph.Idle; return; }
    this.slowest = maxOf([...this.runs.values()].map(v => minOf(v)));
    this.phase = Ph.Grid;
    this.Log('qualifying session: every lap the AI post is replaced with their practice laps until the session ends (cars without a run go to the back)');
  }

  IsAi(c) {
    if (c === 0) return false;
    const s = this.St(c);
    return s >= 7736608 && s <= 7737264;
  }

  QualSlots() { const l = [0]; for (let c = 2; c < 44; c++) l.push(c); return l; }

  OrigBest(c) {
    const v = this.orig.get(c);
    if (!v || v.length < 2) return null;
    let best = 2147483647;
    for (let i = 1; i < v.length; i++) best = Math.min(best, (v[i] - v[i - 1]) | 0);
    return best;
  }

  PaceFactor() {
    const list = [];
    for (const [c, laps] of this.runs) {
      const ob = this.OrigBest(c);
      if (ob != null && laps.length > 0 && minOf(laps) > 0) {
        const x = ob / minOf(laps);
        if (x > 0.8 && x < 1.25) list.push(x);
      }
    }
    list.sort((a, b) => a - b);
    this.paceN = list.length;
    if (this.exactTimes || !this.MatchStockPace || list.length < 3) return 1.0;
    const val = list.length % 2 === 1 ? list[Math.trunc(list.length / 2)] : (list[list.length / 2 - 1] + list[list.length / 2]) / 2.0;
    return Math.max(0.85, Math.min(1.15, val));
  }

  GridTick() {
    if (this.Wall - this.lastGridTick < 0.5) return;
    this.lastGridTick = this.Wall;
    this.paceK = this.PaceFactor();
    this.status = 'Qualifying session: ' + this.written.size + ' AI cars set to their practice times';
    for (const i of this.QualSlots()) {
      if (!this.runs.has(i) && !this.IsAi(i) && (i !== 0 || !this.meInQual || !this.IncludePlayer)) continue;
      const arr = new Array(16);
      for (let j = 0; j < 16; j++) arr[j] = this.m.U32(Cross0 + i * 2048 + j * 4);
      if (i === 0 && arr[1] === 0 && !this.meNoLapLogged) {
        this.meNoLapLogged = true;
        this.Log('your car has no lap in this qualifying session yet: drive out and complete a lap (any speed) so your practice time can be written');
        this.Call(1, 'QUALIFYING SESSION: run one lap (any speed) - your practice time replaces it', 30.0);
      }
      if (arr[0] === 0) continue;
      let k = 0;
      while (k + 1 < arr.length && arr[k + 1] !== 0) k++;
      let value = this.orig.get(i);
      if (!value) { value = []; this.orig.set(i, value); }
      while (value.length <= k) value.push((arr[value.length] & 0xFFFFFFF) >>> 0);
      if (k < 1) continue;
      let v2;
      if (this.runs.has(i)) {
        v2 = this.runs.get(i).map(x => roundEven(x * this.paceK) | 0);
      } else {
        const l2 = stable([...this.orig.keys()].filter(x => !this.runs.has(x) && this.OrigBest(x) != null), x => this.OrigBest(x));
        const idx = l2.indexOf(i);
        v2 = [(roundEven(this.slowest * this.paceK) | 0) + 1000 + (idx >= 0 ? idx : l2.length) * 10];
      }
      let acc = (arr[0] & 0xFFFFFFF) >>> 0;
      for (let l = 1; l <= k; l++) {
        acc = (acc + (l - 1 < v2.length ? v2[l - 1] : (maxOf(v2) + 500))) >>> 0;
        const out = (((arr[l] & 0xF0000000) >>> 0) | (acc & 0xFFFFFFF)) >>> 0;
        if (out !== arr[l]) this.m.W32(Cross0 + i * 2048 + l * 4, out | 0);
      }
      let bestIdx = 1, bestVal = 2147483647;
      for (let n = 1; n <= k; n++) {
        const t = n - 1 < v2.length ? v2[n - 1] : (maxOf(v2) + 500);
        if (t < bestVal) { bestVal = t; bestIdx = n; }
      }
      const [lo, hi] = dblWords(bestVal / 1000.0);
      for (const base of StandingsCaches) {
        const a = base + i * 16;
        if (this.m.I32(a) === k) {
          if (this.m.I32(a + 4) !== bestIdx) this.m.W32(a + 4, bestIdx);
          this.m.W32(a + 8, lo | 0);
          this.m.W32(a + 12, hi | 0);
        }
      }
      if (this.runs.has(i)) this.standingsOk.set(i, Math.abs(this.m.F64(StandingsCaches[0] + i * 16 + 8) * 1000.0 - bestVal) < 2.0);
      if (this.runs.has(i) && !this.written.has(i)) { this.written.add(i); this.Log('#' + this.Num(i) + ' set to ' + Ms(minOf(v2))); }
    }
  }

  FinishGrid() {
    if (this.standingsOk.size > 0) {
      const bad = [...this.standingsOk].filter(kv => !kv[1]);
      this.Log(`standings check: ${[...this.standingsOk.values()].filter(v => v).length} of ${this.standingsOk.size} cars showed their practice time in the game's standings` +
        (bad.length > 0 ? ' (not: ' + bad.map(kv => '#' + this.Num(kv[0]) + ' ' + Ms(minOf(this.runs.get(kv[0]))) + ' wanted, ' + Ms(roundEven(this.m.F64(StandingsCaches[0] + kv[0] * 16 + 8) * 1000.0) | 0) + ' shown').join(' ') + ')' : ''));
    }
    this.standingsOk.clear();
    const second = stable([...this.orig.keys()].filter(x => !this.runs.has(x) && this.OrigBest(x) != null), x => this.OrigBest(x));
    const src = stable([...this.runs.keys()], c => minOf(this.runs.get(c))).concat(second);
    this.Log('qualifying session over, times written for ' + this.written.size + ' cars. AI order: ' + src.map(c => '#' + this.Num(c)).join(' ') + ((this.runs.has(0) || this.meInQual) ? '' : " (your own lap slots in by its time)"));
    const diffs = [...this.runs.keys()].filter(c => this.OrigBest(c) != null).map(c => minOf(this.runs.get(c)) - this.OrigBest(c));
    if (diffs.length > 0) {
      this.Log(`pace check: practice laps were on average ${sgn3(avgOf(diffs) / 1000.0)} s against the game's own qualifying laps (${diffs.length} cars)`);
    }
    if (this.paceK !== 1.0) {
      const mins = [...this.runs.values()].map(v => minOf(v));
      const avgMin = mins.length ? avgOf(mins) : 0;
      this.Log(`matched the game's qualifying pace: practice times x${fx(this.paceK, 4)} (median of ${this.paceN} cars; about ${sgn3(this.runs.size > 0 ? avgMin * (this.paceK - 1.0) / 1000.0 : 0.0)} s on a ${fx(this.runs.size > 0 ? avgMin / 1000.0 : 0.0, 3)} s lap), order unchanged`);
    } else if (this.exactTimes) {
      this.Log('the saved times were written exactly as saved (no pace matching)');
    } else if (this.MatchStockPace) {
      this.Log("game's qualifying pace not matched: fewer than 3 cars had both a practice time and a game qualifying lap");
    }
    this.writtenPaceK = this.paceK;
    if (this.savedPath && !this.exactTimes && this.paceK !== 1.0) { const msg = this.SaveResults(this.savedPath); this.Log('saved results updated with the times as written: ' + msg); }
    this.paceK = 1.0;
    this.gridWritten = true;
    this.gridWaitLogged = false;
    this.phase = Ph.GridWait;
  }

  // the practice times survive a reload into the qualifying session (up to 6 hours, same track)
  SaveRuns() {
    try {
      let s = 'track ' + this.m.Str(14348560, 64).trim() + '\n';
      s += 'saved ' + new Date().toISOString() + '\n';
      for (const [c, v] of this.runs) s += this.runNums.get(c) + ' ' + v.join(',') + '\n';
      if (this.dnqNums.length > 0) s += 'dnq ' + this.dnqNums.join(' ') + '\n';
      if (this.exactTimes) s += 'exact 1\n';                                     // reapplied saved results (QualControl)
      if (!this.writeFiles) return;
      fs.mkdirSync(path.dirname(this.runsPath), { recursive: true });
      fs.writeFileSync(this.runsPath, s);
    } catch (e) { this.Log("couldn't save the qualifying times: " + e.message); }
  }

  LoadRuns(dnqOnly) {
    if (!this.writeFiles) return false;
    try {
      if (!fs.existsSync(this.runsPath)) return false;
      let track = '', saved = NaN, dnqList = [], exactFile = false;
      const b = this.m.Str(14348560, 64).trim();
      const dict = new Map();
      for (const line of fs.readFileSync(this.runsPath, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        const sp = t.indexOf(' ');
        if (sp < 0) continue;
        const key = t.slice(0, sp), rest = t.slice(sp + 1).trim();
        if (key === 'track') { track = rest; continue; }
        if (key === 'saved') { saved = Date.parse(rest); continue; }
        if (key === 'dnq') { dnqList = rest.split(' ').filter(x => x.length > 0); continue; }
        if (key === 'exact') { exactFile = rest === '1'; continue; }
        const list = rest.split(',').map(x => { const n = parseInt(x, 10); return Number.isFinite(n) && /^\s*[-+]?\d+\s*$/.test(x) ? n : 0; }).filter(n => n > 5000);
        if (list.length > 0) dict.set(key, list);
      }
      const hours = (Date.now() - saved) / 3600000;
      if (track.toLowerCase() !== b.toLowerCase() || !(hours >= 0.0) || hours > RunsMaxHours) return false;
      if (dnqOnly) {
        if (dnqList.length === 0) return false;
        this.dnqNums = dnqList.slice();
        this.Log(`the DNQs from the qualifying run saved ${fx(hours, 1)} h ago at ${track}: ${dnqList.map(n => '#' + n).join(' ')}`);
        return true;
      }
      if (dict.size === 0) return false;
      this.dnqNums = dnqList.slice();
      this.exactTimes = exactFile;
      this.runs.clear(); this.runNums.clear();
      for (const c of this.QualSlots()) {
        if (!((c === 0) ? !this.PlayerReady() : !this.IsAi(c)) && dict.has(this.Num(c))) {
          this.runs.set(c, dict.get(this.Num(c)));
          this.runNums.set(c, this.Num(c));
        }
      }
      if (this.runs.size === 0) return false;
      this.Log(`qualifying session: ${this.runs.size} cars' times loaded from the qualifying run saved ${fx(hours, 1)} h ago at ${track}`);
      return true;
    } catch (e) { this.Log("couldn't load the saved qualifying times: " + e.message); return false; }
  }

  // hand-off files for broadcast tools: %PROGRAMDATA%\NR2003 Companions\qualifying_state.txt / .json
  Emit(files) {
    if (this.writeState) this.writeState(files);
    if (!this.writeFiles) return;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      for (const f of files) {
        const p = path.join(this.stateDir, f.name), tmp = p + '.tmp';
        fs.writeFileSync(tmp, f.text);
        try { fs.unlinkSync(p); } catch (e) { /* not there yet */ }
        fs.renameSync(tmp, p);
      }
    } catch (e) { /* the hand-off file is a convenience */ }
  }

  WriteSingleState(ph, final) {
    if (!this.SingleRuns || !this.single || this.Wall - this.lastState < 0.1) return;
    this.lastState = this.Wall;
    const source = stable(this.results.filter(r => r[0] < NoTime), r => r[0]).map(r => [r[1], roundEven(r[0] * 1000.0) | 0]);
    const values = this.single.Order || [];
    const values2 = final ? [] : this.single.Active.filter(r => !r.CalledIn).map(r => r.Car);
    const kind = BoxNames[this.BoxKind];
    const lanesWord = this.reqOpen ? 'open' : (this.reqDone ? 'closed' : 'later');
    const dnq = [...this.dnqSlots].sort((a, b) => a - b);
    const txt = 'mode single\nphase ' + ph + '\nround 1\nrounds 1\ntime_left 0\ncutoff 0\non_track ' + values2.join(' ') + '\norder ' + values.join(' ') +
      '\nboard ' + source.map(b => b[0] + ':' + b[1]).join(' ') + '\n' + 'focus ' + this.BoxCar + '\nfocus_kind ' + kind + '\n' + 'drive ' + this.DriveCar + '\n' +
      (this.Lanes ? ('lanes ' + lanesWord + '\nlane1 ' + this.lane1Q.join(' ') + '\nlane2 ' + this.lane2Q.join(' ') + '\nrequal_left ' + roundEven(this.ReQualLeft) + '\n') : '') +
      'dnq ' + dnq.join(' ') + '\n';
    const json = '{"mode":"single","phase":"' + ph + '","focus":' + this.BoxCar + ',"focus_kind":"' + kind + '","drive":' + this.DriveCar +
      (this.Lanes ? (',"lanes":"' + lanesWord + '","lane1":[' + this.lane1Q.join(',') + '],"lane2":[' + this.lane2Q.join(',') + '],"requal_left":' + roundEven(this.ReQualLeft)) : '') +
      ',"dnq":[' + dnq.join(',') + '],"order":[' + values.join(',') +
      '],"board":[' + source.map(b => '{"slot":' + b[0] + ',"best_ms":' + b[1] + '}').join(',') + ']}';
    this.Emit([{ name: 'qualifying_state.txt', text: txt }, { name: 'qualifying_state.json', text: json }]);
  }

  WriteState(ph, round, left, board, cutoff, nextRound) {
    if (!this.KnockoutLike || this.Wall - this.lastState < 0.1) return;
    this.lastState = this.Wall;
    board = board || [];
    const onTrack = [...this.outNow].filter(c => { const s = this.St(c); return OnTrack.has(s) || PitIn.has(s) || Leaving.has(s); }).sort((a, b) => a - b);
    const withTime = board.filter(b => b[1] != null);
    const txt = 'mode knockout\nphase ' + ph + '\nround ' + round + '\nrounds ' + (this.koRounds ? this.koRounds.length : round) + '\ntime_left ' + roundEven(left) +
      '\ncutoff ' + cutoff + '\non_track ' + onTrack.join(' ') + '\nboard ' + withTime.map(b => b[0] + ':' + b[1]).join(' ') + '\ndrive ' + this.DriveCar +
      '\ndnq ' + [...this.dnqSlots].sort((a, b) => a - b).join(' ') + '\n';
    const json = '{"mode":"knockout","phase":"' + ph + '","round":' + round + ',"time_left":' + String(this.roundD(left, 1)) + ',"cutoff":' + cutoff +
      ',"drive":' + this.DriveCar + ',"dnq":[' + [...this.dnqSlots].sort((a, b) => a - b).join(',') + ']' + ((nextRound || 0) > 0 ? (',"next_round":' + nextRound) : '') + ',"on_track":[' + onTrack.join(',') + '],"board":[' +
      board.map(b => '{"slot":' + b[0] + ',"number":"' + this.Num(b[0]) + '","best_ms":' + (b[1] != null ? b[1] : 'null') + '}').join(',') + ']}';
    this.Emit([{ name: 'qualifying_state.txt', text: txt }, { name: 'qualifying_state.json', text: json }]);
  }
}

Qualifying.Format = Format; Qualifying.Release = Release; Qualifying.Split = Split; Qualifying.BoxShow = BoxShow; Qualifying.Phase = Ph;
Qualifying.Wait = Wait; Qualifying.Known = Known; Qualifying.LapFmt = LapFmt;
require('./qualcontrol').install(Qualifying, Ph, { Known, LapFmt, Format, BoxShow });
module.exports = { Qualifying, Format, Release, Split, BoxShow, LapFmt, sgn3 };
