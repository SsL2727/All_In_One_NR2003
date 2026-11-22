// RaceControl engine — a port of RaceControl 1.0.1's RaceEngine (cautions, pit road timing, wave around, free pass,
// stages, restarts, penalties). The control flow, thresholds and every memory write follow the original; only the
// language changed. Parts live in parts/*.js and are mixed into this class.
'use strict';
const A = require('./addr');
const { GameMemoryError } = require('./gamemem');

const FreePassGiveUp = 45.0, HoldMaxLaps = 3, StageCautionAt = 0.75, EntryFallback = 0.85, OpenBeforeEntry = 0.25;
const { r0 } = require('./format');
const mod = (a, b) => { const n = a % b; return n < 0 ? n + b : n; };
const nan = () => NaN;

class RaceEngine {
  // m: GameMem. opts: { logger(msg), realClock() -> seconds, statePath }
  constructor(m, opts) {
    opts = opts || {};
    this.m = m;
    this.Logger = opts.logger || null;
    const t0 = Date.now();
    this.RealClock = opts.realClock || (() => (Date.now() - t0) / 1000);
    this.writeState = opts.writeState || null;        // (text) => void : the pits_closed hand-off file for AIMOD
    this.clock = 0; this.lastReal = NaN; this.lastSession = NaN;
    this.accelGame = 0; this.accelReal = 0; this.accelLogged = false;
    this.flag = 7; this.lap = 0; this.maxIdx = 0; this.numSessions = 0; this.memoryErrorLogged = false;
    this.lapBase = new Int32Array(64); this.lastDlong = new Float32Array(64); this.lapSynced = new Array(64).fill(false);

    // options (RaceControl's checkboxes / ini keys)
    this.NoMechanicalCautions = false; this.mech = null; this.mechOwnAt = null;
    this.MinSpeedOn = false; this.MinSpeedPercent = 115; this.MinSpeedLaps = 3; this.MinSpeedPark = true; this.msCars = null;
    this.OpenPitsToAll = true; this.GateThroughOneToGo = false; this.OneStopPerCaution = false; this.WaveAroundOn = true; this.ClearClosedPitPenalty = true; this.RestorePaceLap = true;
    this.ForgivePenalties = true; this.FreePassOn = true; this.HoldOneToGoForPits = true;
    this.LappedToBack = true; this.EarlyLineup = true; this.DoubleFile = true; this.Cone = true;
    this.PreferredLane = 1; this.GiveUpRows = 2; this.FrontRows = 3; this.Untangle = true;
    // random choose cone: each caution rolls the lane / rows given up / front rows / cone point within these limits (off = the fixed values above)
    this.ConeRandom = false; this.ConeLanes = 'both'; this.ConeRanges = { giveUp: [0, 4], front: [1, 6], point: [0, 0] };
    this.coneRoll = null; this.coneBase = null; this.Rnd = (opts && opts.rnd) || Math.random;
    this.ConePoint = NaN; this.PlayerChoosesLane = true; this.PlayerLaneNeeded = null;
    this.DoubleFileAt = NaN; this.DoubleFileAtLearned = null;
    this.RaceBack = false; this.StageRacing = true; this.StageThrowCaution = true; this.StageRaceBack = true; this.StageEnds = null;
    this.StartPaceLaps = 1; this.StartPaceAddLaps = true; this.ResetStartPace();   // pace laps before the green (1 = the game's own); laps counted under them added back
    this.GreenWhiteCheckered = true; this.GhostOnPitRoad = true; this.GhostWhilePacing = false;
    this.PitsClosedFirstLap = true; this.OpenWhenPacked = true; this.PitEntry = NaN; this.PitEntryLearned = null; this.PitMerges = [];
    this.GateCatchingCars = true;
    this.StockCautions = false;          // NR2003 runs cautions and restarts itself; Race Control gives the Lucky Dog only
    this.Classic = false;                // 2004 rules: laps down at the yellow, Lucky Dog without a wave around, lead lap outside / lapped inside

    // state
    this.stockLogged = false; this.downAtYellow = new Map(); this.downAtYellowTaken = false; this.scoringSnap = null; this.scoringDogs = new Set(); this.scoringSnapAt = NaN;
    this.pitted = new Set(); this.settle = new Map(); this.excused = new Set(); this.eligible = new Map();
    this.closedLapOffenders = new Set(); this.decided = new Map();
    this.leaderIdx = -1; this.pitOpenLap = -1; this.pitsOpened = false; this.firstPassStarted = false; this.greenTime = NaN;
    this.penaltySeen = new Map(); this.penaltyTick = 0; this.watched = new Map();
    this.restartLap = -1; this.forgiveTick = 0; this.cautionRunning = false; this.stopCalledOff = new Map();
    this.requestSeen = new Array(64).fill(false); this.requestsLogged = new Set();
    this.stopFlagSeen = new Array(64).fill(false); this.stopFlagLogged = new Array(64).fill(-Infinity);
    this.phantomSince = new Array(64).fill(NaN); this.phantomLogged = new Array(64).fill(-Infinity);
    this.startFlagsSeen = new Map();
    this.freePassIdx = -1; this.freePassDone = false; this.freePassTime = 0; this.freePassWaitSince = NaN; this.freePassWaitLogged = false;
    this.holdingOneToGo = false; this.holdLogged = false; this.holdGaveUp = false; this.holdStartPaceLap = -1;
    this.cycleQuietSince = NaN; this.sentEarly = new Set(); this.pitRoadAtCaution = new Set(); this.pitRoadAtCautionTaken = false;
    this.waveLater = new Map(); this.pitsQuietSince = NaN; this.keptBack = new Set(); this.pitMoved = new Set(); this.lastTidy = 0;
    this.lineup = null; this.inside = null; this.outside = null; this.planActive = false; this.planKey = new Map();
    this.planTime = 0; this.lastPlanUpkeep = 0; this.planRestoredLogged = false;
    this.lineupDone = false; this.earlyLineupDone = false; this.doubleFileDone = false; this.delayedGreenHandled = false;
    this.noPitSince = NaN; this.stuckSince = new Map(); this.lastUntangle = 0;
    this.prevFlag = -1; this.flagSince = 0; this.lineCheck5Done = false; this.lineCheck6Done = false; this.lastLineCheck = null; this.lastLineCheckTime = 0;
    this.coneInside = null; this.coneOutside = null; this.coneRunning = false; this.coneAt = 0; this.lastConeTick = 0;
    this.pastCone = new Set(); this.toCone = new Map(); this.coneNeedsLine = false; this.coneLapChecked = false;
    this.onConeLap = new Set(); this.lastConeDlong = new Map(); this.queueLane = 0;
    this.playerOffer = null; this.playerChoice = 0; this.playerOfferTime = 0; this.coneFrom = new Map();
    this.coneFlagSeen = -1; this.coneWaiting = false; this.coneWaitSince = 0; this.coneWaitCars = '';
    this.StageEarlyLaps = 0; this.earlyEnds = new Map();      // Better Cautions' rule: a caution this many laps (or fewer) before a stage end ends that stage (0 = off)
    this.stageThrown = -1; this.stagesDone = new Set(); this.stageRaceLength = -1; this.stageLastDone = -1;
    this.fieldFrozen = false; this.cautionSeen = false; this.stageCaution = false; this.throwCaution = false; this.ghostEndWanted = new Map();
    this.mergeLoggedFor = null; this.openPointName = 'pit entry'; this.entrySamples = []; this.wasOnPitRoad = new Array(64).fill(false);
    this.entrySeen = false; this.fallbackLogged = false; this.pitsOpen = false; this.closedLogged = false;
    this.requestsCancelled = new Set(); this.entryLeader = -1; this.leaderPasses = 0; this.leaderToEntry = -1.0;
    this.toEntry = new Map(); this.passedEntry = new Set(); this.readyToDecide = new Set();
    this.gateClosed = false; this.perCarGate = false; this.stopped = new Set(); this.gateSaved = new Map(); this.gateLogged = new Set(); this.stuckAtOpen = new Set(); this.stuckTaken = false;
    this.publishedClosed = false; this.lastPublish = 0; this.publishedStages = null; this.publishedWave = null; this.shuttingDown = false; this.heldFor = null;
    this.InRace = false; this.TrackName = ''; this.ConeBoard = null;
    this.InitPace();
    this.InitPaceFix();
  }

  get Now() { return this.clock; }
  get Flag() { return this.flag; }
  get Lap() { return this.lap; }
  get Paused() { return this.m.U8(A.SimState) === 3; }
  get CautionHappened() {
    if (!this.pitsOpen && !this.closedLogged && !this.pitsOpened && !this.firstPassStarted && this.pitted.size <= 0 && this.excused.size <= 0) return this.waveLater.size > 0;
    return true;
  }
  get LineupHappened() { return this.lineupDone || this.earlyLineupDone || this.doubleFileDone; }
  get PlayerOfferOpen() { return this.playerOffer != null; }
  get PlayerDriving() { return this.Running(0) && this.CarNumber(0) > 0; }
  get RaceLengthAddr() { return this.numSessions !== 2 ? A.RaceLength : A.RaceLengthQuickRace; }
  get RaceLengthDisplayAddr() { return this.numSessions !== 2 ? A.RaceLengthDisplay : A.RaceLengthDisplayQuickRace; }
  get WhiteFlagOut() { return this.lap === this.m.U16(this.RaceLengthAddr); }
  get TrackLengthMetres() {
    try { const n = this.m.F64(A.TrackLength); return (this.InRace && n > 100.0) ? n : NaN; } catch (e) { if (e instanceof GameMemoryError) return NaN; throw e; }
  }
  get RaceLengthLaps() {
    try { return this.InRace ? this.m.U16(this.RaceLengthAddr) : -1; } catch (e) { if (e instanceof GameMemoryError) return -1; throw e; }
  }
  PlayerTrackPos() {
    try { return (this.Running(0) && this.CarNumber(0) > 0) ? this.DlongOf(0) : NaN; } catch (e) { if (e instanceof GameMemoryError) return NaN; throw e; }
  }

  Log(msg) {
    if (this.Logger) {
      const d = new Date(), p = (n) => String(n).padStart(2, '0');
      this.Logger(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} lap ${this.lap} flag ${this.flag}: ${msg}`);
    }
  }

  CarNumber(idx) { return this.m.U16(A.CarNum + idx * A.Ocd); }
  LapsOf(idx) { return this.m.U16(A.Laps + idx * A.Ocd); }
  DlongOf(idx) { return this.m.F32(A.Dlong + idx * A.Ocd); }
  DlatOf(idx) { return this.m.F32(A.Dlat + idx * A.Ocd); }
  OnPitRoad(idx) { return this.m.U8(A.OnPitRoad + idx) === 1; }
  Running(idx) { return this.m.U8(A.HasNotRetired + idx) === 1 && this.m.U8(A.HasSpawned + idx) === 1; }
  ScoredLaps(idx) { return this.m.I32(A.StandingsCache + idx * 16); }

  Tick() {
    try {
      if (this.ReadRaceState()) { this.RaceTick(); this.memoryErrorLogged = false; }
    } catch (e) {
      if (!(e instanceof GameMemoryError)) throw e;
      if (!this.memoryErrorLogged) this.Log('memory error: ' + e.message);
      this.memoryErrorLogged = true;
    }
  }

  // the game's own clock: whole game ticks over the tick rate when it exposes them (it keeps counting through a pause), else the session clock
  GameSeconds() {
    const m = this.m;
    const ticks = m.I32(A.GameTicks);
    if (ticks <= 0) return m.F64(A.SessionClock);
    let rate = m.I32(A.TickRateFlag) !== 0 ? 36 : m.I32(A.TickRateValue);
    if (rate <= 0 || rate > 10000) rate = 36;
    return ticks / rate;
  }

  ReadRaceState() {
    const m = this.m;
    const b = m.U8(A.SimState);
    const real = this.RealClock();
    const sess = this.GameSeconds();
    if (b === 2 && !Number.isNaN(this.lastReal)) {
      const dr = real - this.lastReal, ds = sess - this.lastSession;
      if (ds > 0.0 && ds < dr * 100.0 + 0.05) { this.clock += ds; this.clockStill = 0.0; }
      else if (ds === 0.0) {
        this.clockStill += dr;
        if (this.clockStill > 1.0) { this.clock += this.clockStill; this.clockStill = 0.0; }
      } else this.clock += dr;
      this.WatchAcceleration(dr, ds);
    }
    this.lastReal = real; this.lastSession = sess;
    const lc = m.I32(A.LapsComplete);
    this.numSessions = m.U8(A.NumSessions);
    const isRace = m.U8(A.SessionNum) + 1 === this.numSessions;
    this.InRace = (b === 2 || b === 3) && isRace && lc !== -1;
    if (b === 2 || b === 3) {
      const name = m.Str(A.TrackName, 32);
      if (this.TrackName && name !== this.TrackName) this.NewTrack(this.TrackName, name);
      this.TrackName = name;
    }
    // before the green: the initial pace lap, and any more Race Control asked for (the game may count those as laps
    // complete; still the start, not a caution). RaceControl 2.0.0 start pacing (parts/startpace.js)
    if (b === 2 && isRace && (lc === -1 || (this.startPacing && m.U8(A.FlagState) !== 7))) {
      this.lap = 0;
      this.flag = m.U8(A.FlagState);
      this.maxIdx = Math.min(m.I32(A.NumCars), 64) - 1;
      this.StartPaceTick(lc);
      this.PreStartTick();
      this.ManageCollisions();
      return false;
    }
    if (b === 2 && !isRace) {
      if (this.startPaceLap0 !== null && this.startPaceLap0 !== undefined) this.ResetStartPace();
      this.flag = 7;
      this.maxIdx = Math.min(m.I32(A.NumCars), 64) - 1;
      this.ManageCollisions();
      return false;
    }
    if (lc !== -1) this.startFlagsSeen.clear();
    if (b === 2 && isRace && lc !== -1 && this.startPaceLap0 !== null && this.startPaceLap0 !== undefined && m.U8(A.FlagState) === 7) {
      this.StartPaceGreen(lc);
      this.ResetStartPace();            // ready for the next race
    }
    if (b !== 2 || !isRace || lc === -1) return false;
    this.lap = lc + 1;
    this.flag = m.U8(A.FlagState);
    this.maxIdx = Math.min(m.I32(A.NumCars), 64) - 1;
    return true;
  }

  // -> { list, leader, first } or null
  FieldFull() {
    const m = this.m;
    const tl = m.F64(A.TrackLength);
    if (tl <= 100.0 || Number.isNaN(tl)) return null;
    const paceD = this.DlongOf(1);
    let list = [], leader = null, first = null;
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i === 1 || !this.Running(i)) continue;
      const d = this.DlongOf(i);
      const car = { Idx: i, Num: this.CarNumber(i), Prog: 0, Gap: 0, Down: 0, Ahead: false, Stuck: false, WaveOk: false };
      car.Prog = this.LapCount(i, d, tl) + d / tl;
      car.Gap = mod(paceD - d, tl);
      if (leader == null || car.Prog > leader.Prog) leader = car;
      if (!this.OnPitRoad(i)) list.push(car);
    }
    if (list.length === 0) return null;
    list = list.map((c, k) => [c, k]).sort((x, y) => (y[0].Prog - x[0].Prog) || (x[1] - y[1])).map(x => x[0]);
    for (const c of list) {
      c.Down = leader.Prog - c.Prog;
      if (c.Down < 1.0 && c.Gap >= leader.Gap - 1.0 && (first == null || c.Gap < first.Gap)) first = c;
    }
    if (first == null) first = list[0];
    for (const c of list) {
      c.Ahead = c !== first && c.Gap < first.Gap;
      c.Stuck = c.Ahead && c.Down < 1.0;
      c.WaveOk = c.Ahead && c.Down >= 1.0;
    }
    return { list, leader, first };
  }
  Field() { const f = this.FieldFull(); return f ? f.list : null; }

  LapCount(idx, d, trackLen) {
    if (idx < 0 || idx >= 64) return this.LapsOf(idx);
    const prev = this.lastDlong[idx];
    this.lastDlong[idx] = d;
    const up = prev > trackLen * 0.75 && d < trackLen * 0.25 && trackLen - prev + d < trackLen * 0.1;
    const down = prev < trackLen * 0.25 && d > trackLen * 0.75 && trackLen - d + prev < trackLen * 0.1;
    if (!this.lapSynced[idx] || (d > trackLen * 0.25 && d < trackLen * 0.75)) {
      this.lapBase[idx] = this.LapsOf(idx); this.lapSynced[idx] = true;
    } else if (up) this.lapBase[idx]++;
    else if (down) this.lapBase[idx]--;
    else if (Math.abs(mod(Math.fround(d - prev) + trackLen / 2.0, trackLen) - trackLen / 2.0) > trackLen * 0.1) this.lapBase[idx] = this.LapsOf(idx);
    return this.lapBase[idx];
  }

  WatchAcceleration(dr, ds) {
    if (Number.isNaN(ds) || ds < 0.0 || ds > 60.0) return;
    this.accelGame += ds; this.accelReal += dr;
    if (this.accelReal < 5.0) return;
    const r = this.accelGame / this.accelReal;
    if (r >= 1.5 && !this.accelLogged) this.Log(`time acceleration is on (about x${r0(r)}): AI pacing and restarts are less tidy at high speed-up`);
    this.accelLogged = r >= 1.5;
    this.accelGame = this.accelReal = 0.0;
  }

  // a new track in the same session: what was learnt about the last one's pit entry and pace car starts again
  NewTrack(was, now) {
    this.entrySamples = []; this.entrySeen = false; this.fallbackLogged = false; this.mergeLoggedFor = null;
    for (let i = 0; i < this.wasOnPitRoad.length; i++) this.wasOnPitRoad[i] = false;
    this.PitEntry = NaN;
    this.paceMergeOffset = this.paceExitTime = this.paceParkedAt = NaN;
    this.paceLeaderAvg = this.paceLeaderAtSend = NaN;
    this.highChecked = false;
    this.Log('track changed (' + was + ' -> ' + now + '): pit entry and pace car measurements start again for this track');
  }

  RaceTick() {
    this.PublishState();
    this.MechanicalTick();
    this.PlayerCallTick();
    this.CautionTimeline();
    this.CautionsTick();
    this.WaveTick();
    if (this.StockCautions !== this.stockLogged) {
      this.stockLogged = this.StockCautions;
      this.Log(this.StockCautions ? 'NR2003 runs cautions and restarts: Race Control gives the Lucky Dog only' : 'Race Control runs cautions and restarts again');
    }
    if (this.StockCautions) {
      if (this.lowSince.size > 0 || this.highOrig != null) this.EndLowLine('NR2003 runs cautions now');
      this.RestartDiagnostics();
    } else {
      this.LineupTick();
      this.SplitHoldTick();
    }
    this.MinSpeedTick();
  }
}

RaceEngine.consts = { FreePassGiveUp, HoldMaxLaps, StageCautionAt, EntryFallback, OpenBeforeEntry };
RaceEngine.util = { mod, nan };

module.exports = { RaceEngine, GameMemoryError };
for (const part of ['penalties', 'wave', 'lineup', 'cautions', 'pits', 'pace', 'pacefix', 'startpace', 'minspeed', 'mechanical']) require('./parts/' + part)(RaceEngine);
