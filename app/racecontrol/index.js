// RaceControlService — RaceControl built into All In One NR2003 (a port of RaceControl 1.0.1's engine, verified against the
// original: tools/rcparity). Cautions, pit road timing, wave around, free pass, stages, double file / choose cone.
//
// Stages come from All In One NR2003's Stage Racing window — set once, here and for AIMOD. Off by default and in read-only
// test mode by default (the engine runs on a shadow of NR2003's memory: nothing is written to the game).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const gameExe = require('../gameexe');   // the game's process names (RaceLab's builds too)
const { RaceEngine } = require('./engine');
const { GameMem, GameMemoryError } = require('./gamemem');
const { Qualifying, Format, Release, Split, LapFmt } = require('./qualifying');
const { TrackMap, TrackMapRecorder } = require('./trackmap');
const { gameHwnd, pressKey, focusGame } = require('./gamewindow');
const { QualBoxModel } = require('./qualbox');
const { ConeBoardModel, statusOf, sampleCone, sampleStatus, samplePit } = require('./gfx');
const { LiveGfx } = require('./live');
const { OverlayFeed } = require('./feed');
const QC = require('./qualcontrol');
const { Win32Memory, ShadowMemory } = require('../ai/memory');
const { breakpointsFromConfig } = require('../stagebridge');
const { journal } = require('../crashjournal');

const TICK_MS = 20;
const STATE_FILE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'NR2003RaceControl', 'state.txt');   // AIMOD reads this
const LOG_TAIL = 60;

const DEFAULTS = {
  enabled: false,
  dryRun: true,                  // read-only test mode: the engine runs on a shadow copy, nothing is written to NR2003
  RaceBack: false,               // cars race back to the line (off: the field freezes in order)
  StockCautions: false,          // NR2003 runs cautions and restarts itself; Race Control gives the Lucky Dog only (RaceControl Nov 2026)
  GreenWhiteCheckered: true,
  StageThrowCaution: true,       // throw the stage caution 3/4 through the last lap
  StageRaceBack: true,           // race back at stage ends
  PitsClosedFirstLap: true, OpenWhenPacked: true, OpenPitsToAll: true, HoldOneToGo: true, GhostOnPitRoad: true,
  // RaceControl 1.1.0 / 1.2.0: the pace car waits on pit road for the leader (release point learned per track), lapped cars hold their spot
  // during the pit stops and then drop to the low line while the lead lap cars go high
  PaceCarWaits: true, LappedDropLow: true, LappedHoldUntilPitsDone: true, LeadLapHighShare: 0.7, HoldGreenIfSplit: false,
  // RaceControl 3.3.11: pace car fixes (caution line kept in the order at the yellow, pace laps fitted to the line, the pace car catching a
  // leader that went by it), pace car speed matched to the leader, waved cars released early / at the line, the high line held back from the wall
  PaceFixes: true, PaceLapFit: true, PaceMatch: false, WaveEarly: true, WaveAtLine: true, LeadLapHighPull: 1.0,
  // RaceControl 2.0.0: pace laps before the green (1 = the game's own), and the laps the game counts under them added back to the race
  StartPaceLaps: 1, StartPaceAddLaps: true,
  // RaceControl 2.0: the overlay feed (overlay_feed.json for a standalone RaceVision 2.0) and who draws the timing box / broadcast panel /
  // cone board: auto = a layout picked for that panel in the built-in RaceVision draws it, else Race Control's own; RaceVision; RaceControl
  OverlayFeed: true, OverlaysDrawnBy: 'auto',
  WaveAround: true, OneStopPerCaution: true, NoMechanicalCautions: false, MinSpeed: true, MinSpeedPercent: 115, MinSpeedLaps: 3, MinSpeedPark: true, FreePass: true,
  DoubleFile: true, Cone: true, Untangle: true, GhostWhilePacing: false,
  PreferredLane: 1, GiveUpRows: 2, FrontRows: 3, ConePoint: 0,
  // random choose cone: each caution rolls the lane / rows given up / front rows / cone point (m, 0 = the pace car) within these limits
  ConeRandom: false, ConeLanes: 'both', GiveUpRowsMin: 0, GiveUpRowsMax: 4, FrontRowsMin: 1, FrontRowsMax: 6, ConePointMin: 0, ConePointMax: 0,
  StageEarlyLaps: 0,             // a caution this many laps (or fewer) before a stage end ends the stage early (0 = off)
  EarlyLineup: true, RestorePaceLap: true, ForgivePenalties: true,
  // qualifying (RaceControl 1.2.0): run in the practice session before qualifying, written to the real grid
  QualFormat: 'off',             // 'off' | 'single' | 'knockout' | 'indyoval' | 'indyroad'
  // QualControl 0.5.0: time the practice before qualifying for the running order (fastest first or last); RaceControl 2.0: the AI
  // qualifying pace bonus's strength (100 = the game's own formula); the merge window's race field (up to 46 with a patched exe)
  QualPracticeOrder: false, QualFastestLast: false, QualBoost: 100, QualMergeCars: 43, QualMergePlayerIn: true,
  QualLaps: 1, QualRounds: '25:24, 10:12, 5:12', QualBreak: 60, QualDnq: 90, QualOrder: '', QualFuel: 25,
  QualRelease: 'pitroad', QualReleaseValue: 30, QualMaxOut: 3, QualPace: true, QualMatchPace: true, ShowQualBox: true,   // QualRelease: 'pitroad' | 'seconds' | 'percent' | 'gap'
  // Indy: the oval is a single car run ranked by the average of QualIndyLaps laps; road / street is Group 1 / Group 2, Fast 12, Fast Six
  QualIndyLaps: 4, QualIndySplit: 'rating', QualIndyGroupMin: 10, QualIndyGroupAdv: 6, QualIndyF12Min: 10, QualIndyF12Adv: 6, QualIndyF6Min: 6, QualIndyBreak: 60,
  // RaceControl (Nov 2026): Indy oval re-qualifying lanes (Lane 1 gives up its time, Lane 2 keeps it) and AI wave-offs
  QualReQual: false, QualReQualMin: 20, QualReQualRuns: 3, QualWaveOffs: true,
  // the field cut: 0 = every car starts; otherwise only the top N cars (or N % of the field) make it, the rest did not qualify
  QualStarters: 0, QualStartersUnit: 'cars', QualDnqScratch: true,      // QualStartersUnit: 'cars' | 'percent'
  // the player's own run: in the order, a ready card with the game paused, calls and a countdown over the game
  QualPlayer: true, QualReadyPause: true, QualClimbOut: 90, ShowPlayerCalls: true, ShowResumeCard: true, PauseKey: 'Pause',
  QualStyle: 'box', QualLapUnit: 'time',       // the timing box, or the broadcast panel; lap times as time or as mph
  QualBox: { x: null, y: null, scale: 1 },     // the timing box / broadcast panel: fractions of the game window, and a size factor
  PlayerBanner: { x: null, y: null, scale: 1 },
  ResumeCard: { x: null, y: null, scale: 1 },   // the "your qualifying run - game paused" card: fractions of the game window, and a size factor
  // broadcast graphics over the game (and as web pages for OBS): the choose cone board and the caution panel; positions are "x, y, scale" in 1080-high units
  ShowBoard: true, ShowCautionGfx: true, BoardScroll: 6, BoardPos: '', CautionPos: '', LivePage: false, LivePort: 8774, LiveLan: false,
  tracks: {},                    // learned per track: { pitEntry, doubleFileAt }
};

class RaceControlService {
  // opts: { userData, getConfig, saveConfig, log, memory? (tests), externalRunning? () => bool, statePath?, realClock? }
  constructor(opts) {
    this.opts = opts;
    this.logFile = path.join(opts.userData, 'race_control.log');
    this.statePath = opts.statePath === undefined ? STATE_FILE : opts.statePath;
    // RaceControl (Nov 2026): the track map, drawn from the AI cars the first lap of a session (shared with RaceVision)
    this.mapRec = new TrackMapRecorder(); this.trackMap = null; this.mapTrack = ''; this._lastMap = 0;
    this.shadow = new ShadowMemory(opts.memory || new Win32Memory(() => this._exeName(), () => this._exePath()));
    this.shadow.passthrough = this.cfg().dryRun === false;
    this.shadow.tag = 'RC';
    this.mem = this.shadow;
    this.gm = new GameMem(this.mem);
    this.qual = null; this.qualModel = new QualBoxModel(); this._lastQual = 0; this.qualBoxNow = null; this.qualBroadNow = null; this.bannerNow = null; this.ready = null;
    this.coneModel = new ConeBoardModel(); this.gfxNow = null; this.gfxSampleUntil = 0;
    this.live = new LiveGfx({ getData: () => this.gfxData() });
    // RaceControl 2.0's overlay feed: the boards' data for layouts (All In One NR2003's RaceVision, or a standalone RaceVision 2.0 via the file)
    this.feed = new OverlayFeed({ log: (m) => this.log(m) });
    this.engine = null; this.pid = 0; this.attached = false; this.track = null;
    this.logTail = []; this.timer = null; this.error = ''; this.note = '';
  }

  _exePath() { return this.opts.getConfig().nr2003_exe || ''; }
  _exeName() { return gameExe.names(this.opts.getConfig()); }

  cfg() {
    const c = this.opts.getConfig();
    c.raceControl = Object.assign({}, DEFAULTS, c.raceControl || {});
    return c.raceControl;
  }

  setConfig(patch) {
    const c = this.opts.getConfig();
    c.raceControl = Object.assign(this.cfg(), patch || {});
    this.opts.saveConfig();
    if (patch && ('enabled' in patch || 'dryRun' in patch)) {
      this._release();
      if ('dryRun' in patch) { this.shadow.clear(); this.shadow.passthrough = c.raceControl.dryRun === false; }
    }
    this._applyOptions();
    this._applyQual();
    return c.raceControl;
  }

  start() { this.timer = setInterval(() => this._tick(), TICK_MS); }
  stop() { clearInterval(this.timer); this.live.stop(); this._release(); this.mem.detach(); }

  // hand pit road back, remove our gate, tell AIMOD the pits are not closed
  _release() {
    try { if (this.engine && this.attached && this.mem.isAlive()) this.engine.Shutdown(); } catch (e) { /* ignore */ }
    try { if (this.qual && this.attached && this.mem.isAlive()) this.qual.Shutdown(); } catch (e) { /* ignore */ }
    this.engine = null; this.track = null;
    this.qual = null; this.qualBoxNow = null; this.qualBroadNow = null; this.bannerNow = null; this.ready = null; this.qualModel.reset();
    this.gfxNow = null; this.coneModel.reset();
  }

  // ── qualifying ──────────────────────────────────────────────────────────────
  _newQual() {
    const q = new Qualifying({ writeFiles: this.shadow.passthrough, runsPath: path.join(this.opts.userData, 'qualifying_runs.txt') });
    q.Logger = m => this.log(m);
    this.qual = q;
    this._applyQual();
    return q;
  }

  _applyQual() {
    const q = this.qual; if (!q) return;
    const c = this.cfg();
    q.Mode = { knockout: Format.Knockout, single: Format.Single, indyoval: Format.IndyOval, indyroad: Format.IndyRoad }[c.QualFormat] || Format.Off;
    q.Laps = q.Mode === Format.IndyOval ? Math.max(2, Math.min(10, c.QualIndyLaps | 0 || 4)) : Math.max(1, Math.min(5, c.QualLaps | 0 || 1));
    q.Order = String(c.QualOrder || ''); q.Rounds = String(c.QualRounds || '');
    q.BreakSeconds = Math.max(0, Math.min(600, Number(q.Mode === Format.IndyRoad ? c.QualIndyBreak : c.QualBreak) || 0));
    q.DnqSeconds = Math.max(15, Math.min(600, Number(c.QualDnq) || 90));
    q.FuelPercent = Math.max(0, Math.min(100, Number(c.QualFuel) || 0));
    q.ReleaseMode = { seconds: Release.Seconds, percent: Release.LapPercent, gap: Release.Gap }[c.QualRelease] ?? Release.PitRoad;
    q.MaxOut = Math.max(1, Math.min(10, c.QualMaxOut | 0 || 3));
    q.ReleaseValue = Math.max(0, Math.min(600, Number(c.QualReleaseValue) || 0));
    q.QualPace = !!c.QualPace; q.MatchStockPace = !!c.QualMatchPace;
    q.BoostPercent = Math.max(50, Math.min(300, Number(c.QualBoost) || 100));                    // RaceControl 2.0
    q.PracticeOrder = !!c.QualPracticeOrder; q.FastestLast = !!c.QualFastestLast;               // QualControl 0.5.0: the running order from practice
    q.IndySplit = { list: Split.List, random: Split.Random }[c.QualIndySplit] ?? Split.Rating;
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    q.IndyGroupMin = num(c.QualIndyGroupMin, 1, 60, 10); q.IndyGroupAdv = num(c.QualIndyGroupAdv, 1, 20, 6) | 0;
    q.IndyF12Min = num(c.QualIndyF12Min, 1, 60, 10); q.IndyF12Adv = num(c.QualIndyF12Adv, 1, 12, 6) | 0; q.IndyF6Min = num(c.QualIndyF6Min, 1, 60, 6);
    q.IncludePlayer = c.QualPlayer !== false; q.PlayerReadyPause = c.QualReadyPause !== false; q.ClimbOutWait = num(c.QualClimbOut, 10, 600, 90);
    q.ReQual = !!c.QualReQual; q.ReQualMinutes = num(c.QualReQualMin, 1, 120, 20) | 0; q.ReQualMaxRuns = num(c.QualReQualRuns, 2, 10, 3) | 0;
    q.WaveOffs = c.QualWaveOffs !== false;
    q.Starters = num(c.QualStarters, 0, 100, 0) | 0; q.StartersPercent = c.QualStartersUnit === 'percent';
    q.ScratchDnqs = c.QualDnqScratch !== false;
    q.GuaranteedFn = () => (this.opts.getGuaranteed ? this.opts.getGuaranteed() : null);    // season mode's guaranteed starters (the field cut)
    LapFmt.Speed = c.QualLapUnit === 'speed';
    q.writeFiles = this.shadow.passthrough;
  }

  _qualTick() {
    const now = Date.now();
    if (now - this._lastQual < 100) return;
    this._lastQual = now;
    if (!this.qual) this._newQual();
    try {
      try { LapFmt.TrackM = LapFmt.OfficialLen > 0.0 ? LapFmt.OfficialLen : this.gm.F64(14339852); } catch (e) { if (!(e instanceof GameMemoryError)) throw e; }
      this.qual.Tick(this.gm);
      const c = this.cfg();
      if (this.qual.LiveOn) this.qualModel.trackHeld(this.qual); else this.qualModel.heldCar = -1;
      const show = c.ShowQualBox !== false && this.qual.LiveOn;
      this.qualBoxNow = show && c.QualStyle !== 'broadcast' ? this.qualModel.data(this.qual, this.gm) : null;
      this.qualBroadNow = show && c.QualStyle === 'broadcast' ? this.qualModel.broadcast(this.qual, this.gm) : null;
      this.bannerNow = c.ShowPlayerCalls !== false && this.qual.PlayerCall ? { text: this.qual.PlayerCall, kind: this.qual.PlayerCallKind, timer: this.qual.PlayerTimer, urgent: this.qual.PlayerTimerUrgent } : null;
      // RaceControl 3.3.11: in a race, the calls to your car (penalty, wave around / free pass, FOLLOW #N) use the same banner
      if (!this.bannerNow && !this.qual.LiveOn && this.engine && c.ShowPlayerCalls !== false && this.engine.PlayerCall) this.bannerNow = { text: this.engine.PlayerCall, kind: this.engine.PlayerCallKind, timer: '', urgent: false };
      if (this.qual.TakeReadyRequest()) this._readyStart();
      this._readyTick();
    } catch (e) {
      if (!(e instanceof GameMemoryError)) throw e;
      this.qualBoxNow = null; this.qualBroadNow = null; this.bannerNow = null;
    }
  }

  // ── the player's turn: the game is paused (its own pause, else the pause key) with a ready card until the player resumes ──
  static get PauseCode() { return [232, -1, -1, -1, -1, 106, 3, 163, 168, 188, 190, 0, 232]; }
  static get ResumeCode() { return [83, 86, 87, 232, -1, -1, -1, -1, 139, 21, 168, 188, 190, 0]; }
  _matches(at, code) {
    try { for (let i = 0; i < code.length; i++) if (code[i] >= 0 && this.gm.U8(at + i) !== code[i]) return false; return true; } catch (e) { return false; }
  }
  _pauseGame() {
    if (!this.shadow.passthrough) return 'not (read-only test mode)';
    if (this._matches(5530848, RaceControlService.PauseCode) && this.gm.CallGame(5530848)) return 'through its own pause';
    pressKey(this.pid, this.cfg().PauseKey || 'Pause');
    return 'with the pause key';
  }
  _resumeGame() {
    if (!this.shadow.passthrough) return;
    if (!this._matches(5531104, RaceControlService.ResumeCode) || !this.gm.CallGame(5531104)) { pressKey(this.pid, this.cfg().PauseKey || 'Pause'); return; }
    focusGame(this.pid);
  }
  _readyStart() {
    if (!this.attached || !this.engine) return;
    this.ready = null;
    if (!this.engine.Paused) this.log('your qualifying turn: NR2003 paused ' + this._pauseGame() + ' - set your camera, then resume');
    this.ready = { seenPaused: this.engine.Paused, at: Date.now(), warned: false, call: this.qual.PlayerCall };
  }
  _readyTick() {
    const r = this.ready;
    if (!r) return;
    if (!this.qual.PlayerHolding) { this.ready = null; return; }
    if (this.engine.Paused) r.seenPaused = true;
    else if (r.seenPaused) { this.log('your qualifying turn: game resumed - pull out within ' + Math.round(this.qual.DnqSeconds) + ' s'); this.qual.PlayerResumed(); this.ready = null; }
    else if (Date.now() - r.at > 3000 && !r.warned) { r.warned = true; this.log("the game did not pause for your turn (fallback pause key '" + (this.cfg().PauseKey || 'Pause') + "'; set it in the Qualifying page) - click RESUME when ready"); }
  }
  // the card's RESUME button
  qualResume() {
    if (!this.ready || !this.qual) return false;
    try { if (this.engine && this.engine.Paused) this._resumeGame(); } catch (e) { /* ignore */ }
    this.qual.PlayerResumed();
    this.ready = null;
    return true;
  }

  // everything the player overlay draws: the banner, the broadcast panel, the ready card (null parts are hidden)
  overlayData() {
    const c = this.cfg();
    const data = {
      banner: this.bannerNow || null, broad: this._drawnElsewhere('tele') ? null : this.qualBroadNow || null,
      // the game paused card can be switched off: RaceControl still sees you unpause the game yourself (_readyTick)
      ready: c.ShowResumeCard !== false && this.ready && this.qual && this.qual.PlayerHolding ? { call: this.qual.PlayerCall, dnq: this.qual.DnqSeconds } : null,
      layouts: { banner: c.PlayerBanner || {}, broad: c.QualBox || {}, card: c.ResumeCard || {} },
    };
    return data.banner || data.broad || data.ready ? data : null;
  }

  // what the timing box should show right now (null = hidden, or drawn from a layout instead: RaceControl 2.0's "Overlays drawn by")
  qualBoxData() { return this._drawnElsewhere('qual') ? null : this.qualBoxNow; }
  // which of the boards a layout draws instead (RaceControl 2.0: OverlaysDrawnBy = RaceVision): the built-in RaceVision tells us
  // per board (a layout picked for that panel); OverlaysDrawnBy 'RaceVision' hands them all over, 'RaceControl' keeps them all here
  _drawnElsewhere(board) {
    const by = String(this.cfg().OverlaysDrawnBy || 'auto');
    if (by === 'RaceControl') return false;
    if (by === 'RaceVision') return true;
    try { const d = this.opts.drawnByLayouts ? this.opts.drawnByLayouts() : null; return !!(d && d[board]); } catch (e) { return false; }
  }
  // the feed as last built (the built-in RaceVision's rc.* data); null while there is no game
  overlayFeed() { return this.feed.now; }
  _feedTick() {
    const e = this.engine, c = this.cfg();
    let session = 'other';
    try { session = e && e.InRace ? 'race' : (() => { const k = this.qual ? this.qual.SessionKind() : 0; return k === 7 ? 'race' : k === 5 ? 'qualifying' : k === 4 ? 'practice' : 'other'; })(); } catch (err) { session = 'other'; }
    const board = e && this.gfxNow && this.gfxNow.coneUp ? e.ConeBoard : null;
    const names = (idx) => { try { return this.qual ? { first: this.qual.FirstName(idx), last: this.qual.LastName(idx) } : null; } catch (err) { return null; } };
    this.feed.publish(session, this.qualBoxNow, this.qualBroadNow, board, names, c.OverlayFeed !== false && this.attached);
  }

  qualState() {
    const q = this.qual;
    return {
      format: this.cfg().QualFormat, status: q ? q.Status : 'Off', canStart: q ? q.CanStart : false, active: q ? q.Active : false,
      live: q ? q.LiveOn : false, board: q ? q.Board.slice() : [],
      // the re-qualifying lanes: your lane (0 = none), whether you can pick one, and the time left
      lanes: q ? { open: q.LanesOpen, mine: q.PlayerLane, canPick: q.PlayerCanPickLane, left: q.LanesOpen ? Math.round(q.ReQualLeft) : 0 } : null,
      dnq: q ? q.NotQualified : [],
      // QualControl: practice timing for the running order, saved results, the merge window
      timing: q ? q.PracticeTiming : false, hasResults: q ? q.HasResults : false, reapplied: q ? q.Reapplied : false,
      merge: this._mergeView(),
    };
  }

  // ── QualControl 0.5.0 (racecontrol/qualcontrol.js) ──
  _qcDir() { return path.join(this.opts.userData, 'qualifying', 'Saved results'); }
  _qcDialog() { try { return require('electron').dialog; } catch (e) { return null; } }
  _qcSafe(fn) { if (!this.qual || !this.attached) return { message: 'Start NR2003 and load the weekend first.' }; try { return fn(); } catch (e) { if (e instanceof GameMemoryError) return { message: 'The game could not be read.' }; throw e; } }
  // "Set the order from practice": the running order list is the practice order from now on
  qualPracticeOrder() {
    return this._qcSafe(() => {
      const nums = this.qual.SetOrderFromPractice();
      if (!nums) return { message: this.qual.PracticeTiming ? 'No practice laps yet.' : 'Practice timing is not running.' };
      this.setConfig({ QualOrder: nums.join(' ') });
      return { message: 'Running order set from practice: ' + nums.length + ' cars. The cars are being called in; Start when they are in.' };
    });
  }
  qualKeepList() { return this._qcSafe(() => { this.qual.KeepList(); return { message: 'Running order list kept; the cars are being called in.' }; }); }
  async qualSaveResults() {
    const q = this.qual;
    if (!q || !q.HasResults) return { message: 'No qualifying results to save yet.' };
    const d = this._qcDialog(); if (!d) return { message: 'No file dialog here.' };
    fs.mkdirSync(this._qcDir(), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10), clean = (s) => String(s || '').replace(/[<>:"/\|?*]+/g, ' ').trim();
    const r = await d.showSaveDialog({ title: 'Save the qualifying results', defaultPath: path.join(this._qcDir(), `${clean(q.TrackName) || 'track'} ${q.TypeKey} ${stamp}.txt`), filters: [{ name: 'Qualifying results', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) return { message: '' };
    return { message: q.SaveResults(r.filePath) };
  }
  async qualReapply() {
    if (!this.qual || !this.attached) return { message: 'Start NR2003 and load the weekend first.' };
    const d = this._qcDialog(); if (!d) return { message: 'No file dialog here.' };
    fs.mkdirSync(this._qcDir(), { recursive: true });
    const r = await d.showOpenDialog({ title: 'Reapply saved qualifying results', defaultPath: this._qcDir(), properties: ['openFile'], filters: [{ name: 'Qualifying results', extensions: ['txt'] }] });
    if (r.canceled || !r.filePaths[0]) return { message: '' };
    let f;
    try { f = QC.readResultsFile(r.filePaths[0]); } catch (e) { return { message: "That isn't a saved qualifying results file (" + e.message + ')' }; }
    return this._qcSafe(() => ({ message: this.qual.ReapplyResults(f) }));
  }
  // the merge window: sessions in their tie-break order (the first wins a tie)
  async qualMergeAdd() {
    const d = this._qcDialog(); if (!d) return this.qualState();
    fs.mkdirSync(this._qcDir(), { recursive: true });
    const r = await d.showOpenDialog({ title: 'Add saved qualifying sessions to merge', defaultPath: this._qcDir(), properties: ['openFile', 'multiSelections'], filters: [{ name: 'Qualifying results', extensions: ['txt'] }] });
    this.mergeSessions = this.mergeSessions || [];
    this.mergeNote = '';
    for (const p of r.canceled ? [] : r.filePaths) {
      if (this.mergeSessions.some(s => s.Path.toLowerCase() === p.toLowerCase())) continue;
      try { this.mergeSessions.push(QC.readResultsFile(p)); } catch (e) { this.mergeNote = path.basename(p) + ': ' + e.message; }
    }
    return this.qualState();
  }
  qualMergeRemove(i) { if (this.mergeSessions) this.mergeSessions.splice(i | 0, 1); return this.qualState(); }
  qualMergeMove(i, by) { const s = this.mergeSessions || []; const j = (i | 0) + (by | 0); if (i >= 0 && j >= 0 && i < s.length && j < s.length) [s[i], s[j]] = [s[j], s[i]]; return this.qualState(); }
  _merged() {
    const s = this.mergeSessions || [];
    if (!s.length) return null;
    const c = this.cfg(), merged = QC.merge(s), cars = Math.max(1, Math.min(46, c.QualMergeCars | 0 || 43));
    return { merged, field: QC.field(merged, cars, c.QualMergePlayerIn !== false), cars };
  }
  _mergeView() {
    const s = this.mergeSessions || [], m = this._merged();
    const out = { sessions: s.map(x => ({ name: path.basename(x.Path), track: x.Track, type: x.Type, cars: x.Cars.length })), lines: [], note: this.mergeNote || '' };
    if (!m) return out;
    const showRound = s.some(x => x.Cars.some(c => c.Round > 1));
    m.merged.forEach((e, i) => {
      if (i === m.cars && m.merged.length > m.cars) out.lines.push(`     ---- the cut: ${m.cars} cars ----`);
      const c = e.Car, nm = c.IsPlayer ? c.Name + ' (you)' : c.Name;
      out.lines.push(`${String(i + 1).padStart(3)}. #${String(c.Num).padEnd(4)} ${(nm.length <= 22 ? nm : nm.slice(0, 21) + '.').padEnd(22)} ${(c.Time != null ? (c.Time / 1000).toFixed(3) : 'no time').padStart(9)}${e.Raised ? '*' : ' '} S${e.Session + 1}${showRound ? ' R' + c.Round : ''}${e.Others.length ? '  (also S' + e.Others.map(x => x + 1).join(', S') + ')' : ''}${m.field.has(e) ? '' : '  DNQ'}`);
    });
    if (s.some(x => x.Cars.some(c => !c.File && !c.IsPlayer))) out.note = (out.note ? out.note + '; ' : '') + "some cars have no .car file: matched by number + name, and they can't go in a roster";
    return out;
  }
  async qualMergeSave() {
    const m = this._merged(); if (!m) return { message: 'Add saved sessions to merge first.' };
    const d = this._qcDialog(); if (!d) return { message: 'No file dialog here.' };
    const r = await d.showSaveDialog({ title: 'Save the merged results', defaultPath: path.join(this._qcDir(), 'merged ' + new Date().toISOString().slice(0, 10) + '.txt'), filters: [{ name: 'Qualifying results', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) return { message: '' };
    QC.writeResultsFile(QC.toResults(this.mergeSessions, m.merged, m.field), r.filePath);
    this.log('merged results saved: ' + r.filePath + ' (' + m.merged.length + ' cars, field ' + m.cars + ')');
    return { message: 'Merged results saved: ' + path.basename(r.filePath) + '. Load the race weekend and use "Reapply saved results" in its practice.' };
  }
  // the race roster: a NEW .lst, a copy of the one the sessions used with only the + / - marks changed (byte for byte: latin1)
  async qualMergeRoster() {
    const m = this._merged(); if (!m) return { message: 'Add saved sessions to merge first.' };
    const d = this._qcDialog(); if (!d) return { message: 'No file dialog here.' };
    const ai = [...m.field].filter(e => !e.Car.IsPlayer);
    const noFile = ai.filter(e => !e.Car.File);
    const pick = await d.showOpenDialog({ title: "Pick the roster to copy (the series' list your sessions used)", properties: ['openFile'], filters: [{ name: 'NR2003 rosters', extensions: ['lst'] }] });
    if (pick.canceled || !pick.filePaths[0]) return { message: '' };
    const basePath = pick.filePaths[0];
    let text;
    try { text = fs.readFileSync(basePath, 'latin1'); } catch (e) { return { message: "Couldn't read the roster: " + e.message }; }
    const res = QC.roster(text, ai.map(e => e.Car.File));
    const folder = path.dirname(basePath);
    const missing = res.added.filter(f => !fs.existsSync(path.join(folder, f)));
    const out = await d.showSaveDialog({ title: 'Name the NEW race roster', defaultPath: path.join(folder, path.basename(basePath, path.extname(basePath)) + ' race.lst'), filters: [{ name: 'NR2003 rosters', extensions: ['lst'] }] });
    if (out.canceled || !out.filePath) return { message: '' };
    if (path.resolve(out.filePath).toLowerCase() === path.resolve(basePath).toLowerCase()) return { message: 'That is the roster being copied. Give the new roster its own name.' };
    try { fs.writeFileSync(out.filePath, res.text, 'latin1'); } catch (e) { return { message: "Couldn't write the roster: " + e.message }; }
    this.log('race roster written: ' + out.filePath + ' (copy of ' + path.basename(basePath) + ', ' + res.marked + ' AI cars +' + (res.added.length ? ', added: ' + res.added.join(' ') : '') + ')');
    return { message: `Race roster written: ${path.basename(out.filePath)} (${res.marked + res.added.length} AI cars in). In NR2003 pick it for the race weekend with at least ${m.field.size - (m.field.size > ai.length ? 1 : 0)} opponents, then reapply the merged results in practice.` +
      (res.added.length ? ' Added at the end: ' + res.added.join(', ') + '.' : '') + (missing.length ? ' Not in the roster\'s folder: ' + missing.slice(0, 6).join(', ') + (missing.length > 6 ? '...' : '') + '.' : '') +
      (noFile.length ? ' Left out (no .car file): ' + noFile.map(e => '#' + e.Car.Num).join(' ') + '.' : '') +
      ' (One car per driver rewrites the active roster at the race: switch it off for this roster.)' };
  }

  // the lane buttons: 1 = Lane 1 (give up your time), 2 = Lane 2 (keep it), 0 = done with the lanes
  qualLane(n) {
    let msg = 'Qualifying is not running.';
    if (this.qual && this.attached) { try { msg = this.qual.ChooseLane(n | 0); } catch (e) { if (!(e instanceof GameMemoryError)) throw e; } }
    return Object.assign(this.qualState(), { message: msg });
  }

  qualStart() { if (this.qual && this.attached) { try { this.qual.Start(); } catch (e) { if (!(e instanceof GameMemoryError)) throw e; } } return this.qualState(); }
  qualStop() { if (this.qual && this.attached) { try { this.qual.Stop(); } catch (e) { if (!(e instanceof GameMemoryError)) throw e; } } return this.qualState(); }

  // the AI cars that sit in the garage / pit boxes: [{ slot, number, name }]
  qualRoster() {
    if (!this.attached) return [];
    try { return Qualifying.Roster(this.gm).map(([slot, number, name]) => ({ slot, number, name })); } catch (e) { return []; }
  }

  // the choose cone, as the engine says it (RaceVision 1.2.0 reads the same lines from race_control.log for its cone cameras)
  coneState() {
    const c = this.cone;
    if (!c) return null;
    if (c.active && Date.now() - c.since > 150000) c.active = false;
    return { d: c.d, active: c.active, seq: c.seq };
  }
  log(msg) {
    const cm = /cars choose their lane at the cone, (-?[\d.]+) m from the line/.exec(msg);
    if (cm) this.cone = { d: Number(cm[1]), active: Number(cm[1]) >= 0, since: Date.now(), seq: ((this.cone && this.cone.seq) || 0) + 1 };
    else if (this.cone && /choose cone done|double file done/.test(msg)) this.cone.active = false;
    this.logTail.push(msg);
    if (this.logTail.length > LOG_TAIL) this.logTail.shift();
    journal.text('RC', msg);
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 2 * 1024 * 1024) fs.writeFileSync(this.logFile, fs.readFileSync(this.logFile, 'utf8').slice(-400 * 1024));
      fs.appendFileSync(this.logFile, msg + '\n');
    } catch (e) { /* logging must never break the engine */ }
    if (this.opts.log) this.opts.log('[racecontrol] ' + msg);
  }

  _writeState(text) {
    if (!this.statePath || !this.shadow.passthrough) return;                     // test mode: the hand-off file would describe a pit road we did not close
    try { fs.mkdirSync(path.dirname(this.statePath), { recursive: true }); fs.writeFileSync(this.statePath, text); } catch (e) { /* ignore */ }
  }

  // stage ends in laps from All In One NR2003's Stage Racing settings (the single place stages are set)
  _stageEnds(raceLength) {
    const sr = this.opts.getConfig().stageRacing;
    if (!sr || !sr.enabled || sr.stagesOff) return null;
    return breakpointsFromConfig(raceLength, sr);
  }

  _newEngine() {
    const e = new RaceEngine(new GameMem(this.mem), {
      logger: m => this.log(m), realClock: this.opts.realClock, writeState: t => this._writeState(t),
    });
    e.StageEnds = (len) => this._stageEnds(len);
    e.DoubleFileAtLearned = (d) => this._learn('doubleFileAt', d);
    e.PitEntryLearned = (d) => this._learn('pitEntry', d);
    e.PaceReleaseLearned = (d) => this._learn('paceRelease', d);
    e.PaceExitLearned = (s) => {
      const c = this.cfg();
      if (!this.track) return;
      c.tracks = c.tracks || {};
      c.tracks[this.track] = Object.assign({}, c.tracks[this.track], { paceExit: String(s) });
      this.opts.saveConfig();
    };
    e.GameFolder = () => (this._exePath() ? path.dirname(this._exePath()) : null);
    e.GameAlive = () => { try { return !!this.mem.isAlive(); } catch (e2) { return false; } };
    e.highBackupPath = path.join(this.opts.userData, 'raceline_backup.txt');
    e.PlayerChoosesLane = false;                              // the pause-the-game lane chooser is not part of the built-in version
    this.engine = e;
    this._applyOptions();
    return e;
  }

  _learn(key, v) {
    const c = this.cfg();
    if (!this.track) return;
    c.tracks = c.tracks || {};
    c.tracks[this.track] = Object.assign({}, c.tracks[this.track], { [key]: Math.round(v) });
    this.opts.saveConfig();
  }

  _applyOptions() {
    const e = this.engine; if (!e) return;
    const c = this.cfg();
    e.RaceBack = !!c.RaceBack; e.GreenWhiteCheckered = !!c.GreenWhiteCheckered;
    e.StageRacing = true;                                     // on/off and the laps come from All In One NR2003's stage settings
    e.StageThrowCaution = !!c.StageThrowCaution; e.StageRaceBack = !!c.StageRaceBack;
    e.PitsClosedFirstLap = !!c.PitsClosedFirstLap; e.OpenWhenPacked = !!c.OpenWhenPacked; e.OpenPitsToAll = !!c.OpenPitsToAll;
    e.HoldOneToGoForPits = !!c.HoldOneToGo; e.GhostOnPitRoad = !!c.GhostOnPitRoad; e.GhostWhilePacing = !!c.GhostWhilePacing;
    e.GateThroughOneToGo = true;
    e.OneStopPerCaution = c.OneStopPerCaution !== false;
    e.PaceCarWaits = c.PaceCarWaits !== false; e.LappedDropLow = c.LappedDropLow !== false; e.LappedHoldUntilPitsDone = c.LappedHoldUntilPitsDone !== false;
    e.HoldGreenIfSplit = !!c.HoldGreenIfSplit;
    e.LeadLapHighShare = Number.isFinite(Number(c.LeadLapHighShare)) ? Math.max(0, Math.min(1, Number(c.LeadLapHighShare))) : 0.7;
    e.PaceFixes = c.PaceFixes !== false; e.PaceLapFit = c.PaceLapFit !== false; e.PaceMatch = !!c.PaceMatch;
    e.WaveEarly = c.WaveEarly !== false; e.WaveAtLine = c.WaveAtLine !== false;
    e.StartPaceLaps = Math.max(1, Math.min(10, Number(c.StartPaceLaps) | 0 || 1)); e.StartPaceAddLaps = c.StartPaceAddLaps !== false;
    e.LeadLapHighPull = Number.isFinite(Number(c.LeadLapHighPull)) ? Math.max(0, Math.min(3, Number(c.LeadLapHighPull))) : 1.0;
    e.NoMechanicalCautions = !!c.NoMechanicalCautions;
    e.MinSpeedOn = c.MinSpeed !== false; e.MinSpeedPercent = Math.max(100, Math.min(200, Number(c.MinSpeedPercent) || 115)); e.MinSpeedLaps = Math.max(1, Math.min(10, c.MinSpeedLaps | 0 || 3)); e.MinSpeedPark = c.MinSpeedPark !== false;
    e.WaveAroundOn = !!c.WaveAround; e.LappedToBack = !!c.WaveAround; e.FreePassOn = !!c.FreePass;
    e.DoubleFile = !!c.DoubleFile; e.Cone = !!c.Cone; e.Untangle = !!c.Untangle;
    e.StageEarlyLaps = Math.max(0, c.StageEarlyLaps | 0);
    e.ConeRandom = !!c.ConeRandom; e.ConeLanes = ['inside', 'outside'].includes(c.ConeLanes) ? c.ConeLanes : 'both';
    e.ConeRanges = { giveUp: [c.GiveUpRowsMin, c.GiveUpRowsMax], front: [c.FrontRowsMin, c.FrontRowsMax], point: [c.ConePointMin, c.ConePointMax] };
    e.SetConeBase({ PreferredLane: Math.max(0, c.PreferredLane | 0), GiveUpRows: c.GiveUpRows | 0, FrontRows: c.FrontRows | 0, ConePoint: c.ConePoint > 0 ? c.ConePoint : NaN });
    e.EarlyLineup = c.EarlyLineup !== false; e.RestorePaceLap = c.RestorePaceLap !== false; e.ForgivePenalties = c.ForgivePenalties !== false;
    // RaceControl (Nov 2026): classic 2004 rules whenever NR2003 runs the cautions or Wave Around and Choose cone are both off; stock cautions
    // leaves the whole caution to NR2003 (only the Lucky Dog is given)
    const stock = !!c.StockCautions, classic = stock || (!c.WaveAround && !c.Cone);
    e.StockCautions = stock; e.Classic = classic;
    if (classic) e.PitsClosedFirstLap = e.OpenWhenPacked = e.OpenPitsToAll = false;
    if (stock) {
      e.RaceBack = e.StageRaceBack = true;
      e.StageRacing = e.StageThrowCaution = e.GreenWhiteCheckered = false;
      e.GhostOnPitRoad = e.GhostWhilePacing = false;
      e.WaveAroundOn = e.LappedToBack = e.DoubleFile = e.Cone = e.Untangle = false;
      e.HoldOneToGoForPits = e.HoldGreenIfSplit = e.PaceCarWaits = e.LappedDropLow = false;
      e.ForgivePenalties = false;
    }
    const t = this.track && c.tracks[this.track];
    e.PitEntry = t && t.pitEntry != null ? t.pitEntry : NaN;
    e.PaceReleaseAt = t && t.paceRelease != null ? t.paceRelease : NaN;
    if (t && t.paceExit) e.SetPaceExitSaved(t.paceExit);
    e.DoubleFileAt = t && t.doubleFileAt != null ? t.doubleFileAt : NaN;
  }

  _trackPitMerges(name) {
    try {
      const p = path.join(path.dirname(this._exePath()), 'tracks', name, 'track.ini');
      if (this._exePath() && fs.existsSync(p)) return RaceEngine.ReadPitMerges(p);
    } catch (e) { /* ignore */ }
    return [];
  }

  _tick() {
    try { this._tickInner(); this.error = ''; }
    catch (e) { this.error = String(e && e.message || e); this.log('error: ' + (e && e.stack || e)); }
  }

  // the graphics as web pages: on only while asked for
  _syncLive(cfg) {
    if (cfg.LivePage) this.live.start(Math.max(1024, cfg.LivePort | 0 || 8774), !!cfg.LiveLan); else if (this.live.server) this.live.stop();
  }

  // the choose cone board and caution panel for the overlay window and the web pages
  _gfx() {
    const c = this.cfg(), e = this.engine;
    if (!e) { this.gfxNow = null; return; }
    const coneUp = c.ShowBoard !== false ? this.coneModel.update(e.ConeBoard, e.flag, c.BoardScroll) : null;
    const cone = coneUp && !this._drawnElsewhere('cone') ? coneUp : null;
    const status = c.ShowCautionGfx !== false ? statusOf(e) : null;
    this.gfxNow = cone || status || coneUp ? { cone, coneUp, status, layout: { board: c.BoardPos || '', status: c.CautionPos || '' } } : null;
  }

  // what the graphics show right now (a sample for a few seconds after "Show a sample"); null = nothing
  gfxData() {
    const c = this.cfg();
    if (Date.now() < this.gfxSampleUntil) return { cone: this._sampleCone(), status: sampleStatus(), pit: samplePit(), layout: { board: c.BoardPos || '', status: c.CautionPos || '', pit: (this.opts.getConfig().aimod || {}).pitBoardPos || '' } };
    // AIMOD's pit board comes from the AIMOD service (the app hands it in)
    let x = null;
    try { x = this.opts.getExtraGfx ? this.opts.getExtraGfx() : null; } catch (e) { x = null; }
    if (!x || !(x.pit || x.riv || x.sub)) return this.gfxNow;
    const base = this.gfxNow || { cone: null, status: null, layout: { board: c.BoardPos || '', status: c.CautionPos || '' } };
    return Object.assign({}, base, { pit: x.pit || null, riv: x.riv || null, sub: x.sub || null, layout: Object.assign({}, base.layout, { pit: x.pos || '', riv: x.rivPos || '', sub: x.subPos || '' }) });
  }

  _sampleCone() { const m = new ConeBoardModel({ now: () => 0 }); return m.update(sampleCone(), 5); }

  gfxSample() { this.gfxSampleUntil = Date.now() + 15000; return true; }

  // ── the track map (RaceControl's MapTick): load the saved map, else borrow another app's and draw our own from the cars ──
  _mapTick() {
    const now = Date.now();
    if (now - this._lastMap < 100) return;
    this._lastMap = now;
    const e = this.engine, m = this.gm;
    if (!e || !m || m.U8(12500272) !== 2) return;
    const track = e.TrackName, len = m.F64(14339852);
    if (!track || !(len > 100.0) || !(len < 100000.0)) return;
    // the game names the new track before its lap length changes: a length that disagrees with the track.ini's is the last track's
    // (a map drawn with it is cut off at that length), so wait for the right one; and start again whenever the length changes
    if (track !== this._mapOfficialFor) {
      this._mapOfficialFor = track;
      try { this._mapOfficial = this._exePath() ? LapFmt.Official(path.join(path.dirname(this._exePath()), 'tracks', track, 'track.ini')) : 0.0; } catch (err) { this._mapOfficial = 0.0; }
    }
    const official = this._mapOfficial || 0;
    if (official > 0 && Math.abs(len - official) > official * 0.15) return;
    if (track !== this.mapTrack || Math.abs(len - (this.mapLen || 0)) > 1.0) { this.mapTrack = track; this.mapLen = len; this._loadMap(track, len); }
    if (!this.mapRec.Active) return;
    const map = this.mapRec.Sample(m, Math.min(m.I32(9932816), 64) - 1);
    if (!map) return;
    this.trackMap = map;
    let text;
    if (!this.statePath) text = 'not saved (tests)';
    else { try { map.Save(); text = 'saved to ' + TrackMap.PathFor(track); } catch (err) { text = 'could not save it: ' + err.message; } }
    this.log(`track map: drawn from ${this.mapRec.Cars} cars in ${Math.round((Date.now() - this.mapRec.Started.getTime()) / 1000)} s, ${this.mapRec.Note}; ${text}`);
  }

  _loadMap(track, len) {
    this.trackMap = TrackMap.Load(track);
    if (this.trackMap && Math.abs(this.trackMap.Length - len) > 5.0) {
      this.log(`track map: the saved map is for a ${Math.round(this.trackMap.Length)} m lap, this track is ${Math.round(len)} m - drawing it again`);
      this.trackMap = null;
    }
    if (this.trackMap && this.trackMap.Source === 'recorded') { this.mapRec.Stop(); return; }
    if (!this.trackMap) {
      const got = TrackMap.Import(track, len);
      if (got) { this.trackMap = got.map; this.log("track map: using another overlay app's map of this track until the cars have drawn RaceControl's own"); }
    }
    this.mapRec.Start(track, len);
  }

  _mapStatus() {
    if (!this.attached || !this.engine || !this.mapTrack) return 'Waiting for NR2003 and a session at a track.';
    const seen = this.mapRec.Active ? `${this.mapRec.Covered}/500 of the lap seen` : '';
    if (!this.trackMap) return 'No map yet - drawing it from the cars on track: ' + seen + '.';
    if (this.trackMap.Source === 'imported') return "Map from another overlay app; RaceControl draws its own as the cars run (" + seen + ').';
    return `${this.mapTrack}: drawn from the cars ${this.trackMap.Made}, ${Math.round(this.trackMap.Length)} m lap.`;
  }

  // the cars on track for the map window: [x, y] per slot (null = not shown); slot 1 (the pace car) first
  _mapCars() {
    const out = [];
    const m = this.gm;
    if (!m || !this.attached) return out;
    try {
      const last = Math.min(m.I32(9932816), 64) - 1;
      const order = [1];
      for (let i = 0; i <= last; i++) if (i !== 1) order.push(i);
      for (const i of order) {
        const show = m.U8(8025816 + i) === 1 && m.U8(7779164 + i) === 1 && m.U8(7781132 + i) !== 1;
        const a = 11323952 + i * 8724 + 6622;
        out.push(show ? [m.F32(a), m.F32(a + 4)] : null);
      }
    } catch (e) { if (!(e instanceof GameMemoryError)) throw e; }
    return out;
  }

  // everything the Track map window draws
  mapState() {
    const c = this.cfg(), e = this.engine, map = this.trackMap;
    return {
      status: this._mapStatus(), track: this.mapTrack, dark: true,
      map: map ? { length: map.Length, source: map.Source, made: map.Made, x: Array.from(map.X), y: Array.from(map.Y) } : null,
      marks: {
        cone: c.ConePoint > 0 ? Number(c.ConePoint) : null,
        pitEntry: e && Number.isFinite(e.PitEntry) ? e.PitEntry : null,
        doubleFile: e && Number.isFinite(e.DoubleFileAt) ? e.DoubleFileAt : null,
        pitExit: e && e.PitMerges && e.PitMerges.length > 0 ? e.PitMerges[0][0] : null,
      },
      cars: this._mapCars(),
    };
  }

  // a click on the map: the cone goes there
  mapSetCone(d) { this.setConfig({ ConePoint: Math.max(1, Math.min(10000, Math.round(Number(d) || 0))) }); return this.mapState(); }

  // "Draw it again": forget the saved map and record a new one from the cars
  mapRedraw() {
    if (this.mapTrack) {
      try { fs.unlinkSync(TrackMap.PathFor(this.mapTrack)); } catch (e) { /* not saved */ }
      this.trackMap = null;
      let len = 0;
      try { len = this.gm ? this.gm.F64(14339852) : 0; } catch (e) { len = 0; }
      this.mapRec.Start(this.mapTrack, len);
      this.log('track map: drawing ' + this.mapTrack + ' again from the cars on track');
    }
    return this.mapState();
  }

  _tickInner() {
    const cfg = this.cfg();
    this._syncLive(cfg);
    if (!cfg.enabled) { if (this.attached) { this._release(); this.attached = false; this.mem.detach(); } this.note = ''; return; }
    if (this.opts.externalRunning && this.opts.externalRunning()) {
      this.note = 'RaceControl.exe is running — close it, All In One NR2003\'s built-in RaceControl would fight it';
      if (this.engine) this._release();
      return;
    }
    this.note = '';
    if (!this.mem.attach()) { if (this.attached) { this.log('NR2003 closed'); journal.gameGone('RC'); this._release(); } this.attached = false; this.pid = 0; return; }
    if (this.mem.pid !== this.pid) {
      this.pid = this.mem.pid; this.attached = true; this._release();
      this.log(`attached to NR2003 (process ${this.pid})${this.shadow.passthrough ? '' : ' — read-only test mode'}`);
    }
    this.attached = true;
    if (!this.engine) this._newEngine();
    this.engine.Tick();
    this._qualTick();
    this._gfx();
    try { this._feedTick(); } catch (e) { /* the feed never stops the tick */ }
    try { this._mapTick(); } catch (e) { if (!(e instanceof GameMemoryError)) throw e; }
    if (this.engine.TrackName && this.engine.TrackName !== this.track) {
      this.track = this.engine.TrackName;
      this.engine.PitMerges = this._trackPitMerges(this.track);
      try { LapFmt.OfficialLen = this._exePath() ? LapFmt.Official(path.join(path.dirname(this._exePath()), 'tracks', this.track, 'track.ini')) : 0.0; } catch (e) { LapFmt.OfficialLen = 0.0; }
      this._applyOptions();
      this.log('track: ' + this.track);
    }
  }

  // stage ends as the engine currently has them (cautions may have brought some forward) — AIMOD plans to these
  applyEarlyStages(ends) { return this.engine && ends ? this.engine.ApplyEarly(ends) : ends; }

  // true while RaceControl itself is ending stages early on a caution (the display engine's own rule then stands down)
  earlyActive() { const c = this.cfg(); return !!(c.enabled && this.attached && this.engine && (c.StageEarlyLaps | 0) > 0); }

  getState() {
    const e = this.engine, c = this.cfg();
    return {
      config: c, enabled: c.enabled, dryRun: c.dryRun !== false, attached: this.attached, pid: this.pid, note: this.note, error: this.error,
      inRace: !!(e && e.InRace), flag: e ? e.Flag : null, lap: e ? e.Lap : null, track: this.track,
      pitsOpen: e ? e.pitsOpen : null, stageEnds: e ? e.StageEndsLine() : null,
      pendingWrites: { count: this.shadow.count },
      qual: this.qualState(),
      log: this.logTail.slice(-30),
    };
  }

  registerIpc({ ipcMain }) {
    ipcMain.handle('rc:get-state', () => this.getState());
    ipcMain.handle('rc:set-config', (e, patch) => { this.setConfig(patch); return this.getState(); });
    ipcMain.handle('rc:throw-caution', () => { if (this.engine) this.engine.ThrowCaution(); return true; });
    ipcMain.handle('rc:gfx-sample', () => this.gfxSample());
    ipcMain.handle('rc:qual-state', () => this.qualState());
    ipcMain.handle('rc:qual-start', () => this.qualStart());
    ipcMain.handle('rc:qual-stop', () => this.qualStop());
    ipcMain.handle('rc:qual-lane', (_e, n) => this.qualLane(n));
    ipcMain.handle('rc:map-state', () => this.mapState());
    ipcMain.handle('rc:map-cone', (_e, d) => this.mapSetCone(d));
    ipcMain.handle('rc:map-redraw', () => this.mapRedraw());
    ipcMain.handle('rc:qual-roster', () => this.qualRoster());
    ipcMain.handle('rc:qual-resume', () => this.qualResume());
    ipcMain.handle('rc:qual-practice-order', () => this.qualPracticeOrder());
    ipcMain.handle('rc:qual-keep-list', () => this.qualKeepList());
    ipcMain.handle('rc:qual-save-results', () => this.qualSaveResults());
    ipcMain.handle('rc:qual-reapply', () => this.qualReapply());
    ipcMain.handle('rc:qual-merge-add', () => this.qualMergeAdd());
    ipcMain.handle('rc:qual-merge-remove', (_e, i) => this.qualMergeRemove(i));
    ipcMain.handle('rc:qual-merge-move', (_e, i, by) => this.qualMergeMove(i, by));
    ipcMain.handle('rc:qual-merge-save', () => this.qualMergeSave());
    ipcMain.handle('rc:qual-merge-roster', () => this.qualMergeRoster());
    ipcMain.handle('rc:qual-open-results', () => { fs.mkdirSync(this._qcDir(), { recursive: true }); try { require('electron').shell.openPath(this._qcDir()); } catch (e) { /* no shell */ } return true; });
  }
}

module.exports = { RaceControlService, DEFAULTS };
