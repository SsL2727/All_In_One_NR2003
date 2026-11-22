// AiEnhancedService — the Environment tab of AI Enhanced v0_2_1b (base/lane grip + Rubber Buildup), built into All In One NR2003, plus
// what AI Enhanced does not have: random rubber settings inside limits you choose, and a preset that loads by itself for each track.
//
// What it does to the game (and only when "Read-only test mode" is off): it scales two driver-stat bytes of every AI car
// (car block + 0x8F and + 0x93) by the grip factor for where that car is on the track — exactly the bytes AI Enhanced scales — and puts
// the originals back when switched off. The game rewrites those bytes about every 18 ms, so they are re-applied every few ms.
// Special Modes and Awareness are ported from AI Enhanced and run here when enabled.
//
// Can run alongside AI Enhanced.exe, with independent priority choices for stats, race lines and INI settings.
'use strict';
const fs = require('fs');
const path = require('path');
const gameExe = require('../gameexe');   // the game's process names (RaceLab's builds too)
const { Win32Memory, ShadowMemory } = require('../ai/memory');
const { journal } = require('../crashjournal');
const { Environment, scaleByte, NCARS } = require('./environment');
const { findLines, applyGameRecs, writeLapLines, restoreLapLines, parseLapFile, buildLapFile, lineScale, scaleRec, fuzzyRec, NAMES: LINE_NAMES } = require('./lines');
const { PlayerEffects } = require('./player');
const { findBounds, rows11, writeRows11, writeDrafting, restoreDrafting, restoreBounds, scaleFor } = require('./bounds');
const { PresetStore } = require('./presets');
const { IniFiles } = require('./inifiles');
const { AieHost } = require('./host');
const { Modules, DEFAULT_OPTS: MODULE_DEFAULTS, KEYS: MODULE_KEYS, BOUNDS, MG_DEFAULT } = require('./modules');
const { TeamTable } = require('./teams');
const { blendRace } = require('./awareness');
const LapTriggers = require('./triggers');

const TICK_MS = 2;                    // the service loop; with the original AI Enhanced running and All In One NR2003 first, its values are re-asserted this often
const AIE_TICK_MS = 25;              // AI Enhanced's own tick (sleep_until, 25 ms): cars read, factors worked out, every byte and line written once
const PACE = 1;                      // RaceControl's pace car index (AI Enhanced's caution test reads it)
const SLOW_MS = 500;                 // track name, session
const LOG_TAIL = 60;
const PIT_LANE_CELL = 3.0;            // lap-line points are spaced at 3 m, as in AI Enhanced MultiGroove

const A = {
  TrackName: 0x8c6080, BaseDir: 0xf78868, SessionByte: 0x73bab8,
  CarBlock: 0xacca30, Ocd: 0x2214, Dlong: 11330202, Dlat: 11330230, VelX: 0x19EA, VelZ: 0x19EE,
  StatBase: 0xad25bd, StatEng: 0x8b, StatLo: 0x8f, StatHi: 0x93, Laps: 11325312,
};

const DEFAULTS = {
  enabled: false,
  dryRun: true,                                    // read-only test mode
  autoPreset: true,                                // load the preset chosen for a track when that track loads
  trackPresets: {},                                // track folder name (lower case) -> preset id ('' = none)
  envGrip: { base: 1, maxrace: 1, minrace: 1 },
  rubber: { active: false, rate: 1, gripMult: 1.05 },
  random: { enabled: false, rateMin: 0.5, rateMax: 2, gripMin: 1.02, gripMax: 1.10, rollEachSession: false },
  applyLapData: false,                             // also write a preset's lap lines into the game (they can differ from the track's own files: the Michigan preset puts minrace up to 7 m further out in the turns)
  priority: { stats: 'steelfire', raceLine: 'steelfire', ini: 'steelfire' },
  host: { enabled: false, exe: '' },               // start the original AI Enhanced.exe (minimized) with NR2003 instead of the built-in copy
  modules: { sideDraft: { enabled: false, opts: {} }, tandem: { enabled: false, opts: {} }, longRun: { enabled: false, opts: {} }, multigroove: Object.assign({ enabled: false }, MG_DEFAULT), awareness: { enabled: false, opts: {} }, selfSpins: { enabled: false, opts: {} } },   // Special Modes that are built in
  triggers: { enabled: false, items: [] },
  ini: {},                                         // INI Files tab: papy_ai parameter name -> value to hold in the game
};

const round2 = (x) => Math.round(x * 100) / 100;
const cloneJson = (v) => JSON.parse(JSON.stringify(v));
function cloneLapSource(src) {
  if (!src) return null;
  const out = {};
  for (const n of ['race', 'minrace', 'maxrace']) {
    const l = src[n]; if (l && l.rec) out[n] = { count: l.count, length: l.length, rec: Float32Array.from(l.rec) };
  }
  if (!Object.keys(out).length) return null;
  if (src.version !== undefined) out.version = src.version;
  if (src.scale !== undefined) out.scale = src.scale;
  return out;
}
const pitLaneFamily = (track) => {
  const s = String(track || '').toLowerCase();
  if (/(road|roval|_rc\b|\brc\b)/.test(s)) return '';
  if (s.includes('talladega')) return 'talladega';
  if (s.includes('daytona')) return 'daytona';
  return '';
};

// Brake for Wrecks: f0 (the line's speed) = min(f0, cap) at the points the wreck check marked. buf: a line as the game holds it (28 bytes a point).
// -> { lo, hi } the first and last record that changed, or null
function capBuffer(buf, w) {
  const n = Math.min(Math.floor(buf.length / 28), w.caps.length);
  let lo = Infinity, hi = -1;
  for (let p = 0; p < n; p++) {
    if (!w.apply[p]) continue;
    const cap = w.caps[p];
    if (cap < buf.readFloatLE(p * 28)) { buf.writeFloatLE(cap, p * 28); if (p < lo) lo = p; if (p > hi) hi = p; }
  }
  return hi >= 0 ? { lo, hi } : null;
}

function mergeModules(cur) {
  const out = {};
  for (const k of Object.keys(DEFAULTS.modules)) {
    const c = (cur && cur[k]) || {};
    if (k === 'multigroove') out[k] = { enabled: !!c.enabled, left: BOUNDS.includes(c.left) ? c.left : MG_DEFAULT.left, right: BOUNDS.includes(c.right) ? c.right : MG_DEFAULT.right, spaceCars: c.spaceCars === undefined ? MG_DEFAULT.spaceCars : !!c.spaceCars, pauseForPlayer: c.pauseForPlayer === undefined ? MG_DEFAULT.pauseForPlayer : !!c.pauseForPlayer, spread: Number.isFinite(c.spread) && c.spread >= 0.1 ? Math.min(1, c.spread) : MG_DEFAULT.spread };       // under 10% every car would run the middle line: not a setting, a mistake
    else {
      const opts = {}, src = c.opts && typeof c.opts === 'object' ? c.opts : {};
      for (const key of MODULE_KEYS[k] || []) {
        const value = src[key], def = MODULE_DEFAULTS[k] && MODULE_DEFAULTS[k][key];
        if (typeof def === 'boolean' && typeof value === 'boolean') opts[key] = value;
        else if (typeof def === 'number' && Number.isFinite(value)) opts[key] = value;
      }
      out[k] = { enabled: !!c.enabled, opts };
    }
  }
  return out;
}

function patchModules(current, patch) {
  const out = mergeModules(current), p = patch && typeof patch === 'object' ? patch : {};
  for (const [key, value] of Object.entries(p)) {
    if (!Object.prototype.hasOwnProperty.call(out, key) || !value || typeof value !== 'object') continue;
    if (value.reset) { out[key] = mergeModules({})[key]; continue; }
    if ('enabled' in value) out[key].enabled = !!value.enabled;
    if (key === 'multigroove') {
      if (BOUNDS.includes(value.left)) out[key].left = value.left;
      if (BOUNDS.includes(value.right)) out[key].right = value.right;
      if ('spaceCars' in value) out[key].spaceCars = !!value.spaceCars;
      if ('pauseForPlayer' in value) out[key].pauseForPlayer = !!value.pauseForPlayer;
      if (Number.isFinite(value.spread)) out[key].spread = Math.min(1, Math.max(0.1, value.spread));
      continue;
    }
    if (value.opts && typeof value.opts === 'object') for (const [name, v] of Object.entries(value.opts)) {
      if (!(MODULE_KEYS[key] || []).includes(name)) continue;
      const def = MODULE_DEFAULTS[key] && MODULE_DEFAULTS[key][name];
      if ((typeof def === 'boolean' && typeof v === 'boolean') || (typeof def === 'number' && Number.isFinite(v))) out[key].opts[name] = v;
    }
  }
  return out;
}

function moduleWarnings(modules, hasLines) {
  const m = modules || {}, out = [];
  if (m.multigroove && m.multigroove.enabled && m.tandem && m.tandem.enabled) out.push('MultiGroove and Tandem Drafting cannot run together; MultiGroove has priority.');
  if (m.multigroove && m.multigroove.enabled && m.sideDraft && m.sideDraft.enabled && Number(m.sideDraft.opts && m.sideDraft.opts.slideAmount) > 0.5) out.push('MultiGroove with Side Drafting slide above 0.5 can make cars slide across grooves.');
  if (m.tandem && m.tandem.enabled && m.sideDraft && m.sideDraft.enabled) out.push('Tandem Drafting with Side Drafting is unstable unless Grip Mult Car Behind is set to 1.0.');
  if (!hasLines && ((m.awareness && m.awareness.enabled) || (m.selfSpins && m.selfSpins.enabled))) out.push('Awareness and Self Spins need the track lap lines to load before they can run.');
  return out;
}

class AiEnhancedService {
  // opts: { userData, getConfig, saveConfig, log, memory? (tests), externalRunning? () => bool, tracksDir? (name) => path, rnd? }
  constructor(opts) {
    this.opts = opts;
    this.shadow = new ShadowMemory(opts.memory || new Win32Memory(() => this._exeName(), () => this._exePath()));
    this.shadow.passthrough = this.cfg().dryRun === false;
    this.shadow.tag = 'AIE';
    this.shadow.journalEvery = 50;
    this.presets = new PresetStore(path.join(opts.userData, 'aie', 'presets'));
    this.env = new Environment();
    this.inif = new IniFiles(this.shadow);
    this.teams = new TeamTable({ log: (m) => this.log(m) });
    this.modules = new Modules();
    this.player = new PlayerEffects();
    this.host =opts.runningNames ? new AieHost({ getHost: () => this.cfg().host, runningNames: () => opts.runningNames(), log: (m) => this.log(m) }) : null;
    this.rnd = opts.rnd || Math.random;
    this.timer = null;
    this.logTail = [];
    this.reset();
  }

  reset() {
    this.attached = false; this.note = ''; this.error = '';
    this.track = ''; this.trackDir = ''; this.session = 0;
    this.lines = null; this.linesState = 'idle'; this.linesError = ''; this.linesTries = 0; this._linesAt = 0; this._scanning = false;
    this.orig = []; this.last = []; this.cars = new Array(NCARS).fill(null); this.factors = null;
    this.rolled = null; this.activePreset = null; this.presetNote = '';
    this._slowAt = 0; this._aieDue = 0; this._carsT = 0; this._lastSession = 0; this.touched = 0; this.caution = false; this._cautionPut = false;
    this.player.reset(); this.playerWritten = false;
    this.teams.reset(); this.modules.reset(); this.activeModules = []; this.tweaks = null; this.mgMin = null; this.mgMax = null; this._brakeSpans = null;
    this.pitLaneStatus = { active: false, track: '', staged: [], due: [], ready: [], waiting: [] };
    this.triggerRuntime = null; this.triggerBaseline = null; this.triggerStatus = { enabled: false, state: 'off', lap: 0, raceLaps: 0, fired: [] };
    this.randomTriggerFolders = new Map();
    this.draftingBounds = null;
    this.env.setLines(null);
    this.applyConfig();
  }

  _exePath() { return this.opts.getConfig().nr2003_exe || ''; }
  _exeName() { return gameExe.names(this.opts.getConfig()); }

  cfg() {
    const c = this.opts.getConfig();
    const cur = c.aie || {};
    c.aie = Object.assign({}, DEFAULTS, cur, {
      envGrip: Object.assign({}, DEFAULTS.envGrip, cur.envGrip),
      rubber: Object.assign({}, DEFAULTS.rubber, cur.rubber),
      random: Object.assign({}, DEFAULTS.random, cur.random),
      priority: Object.assign({}, DEFAULTS.priority, cur.priority),
      trackPresets: Object.assign({}, cur.trackPresets),
      ini: Object.assign({}, cur.ini),
      modules: mergeModules(cur.modules),
      host: Object.assign({}, DEFAULTS.host, cur.host),
      triggers: { enabled: !!(cur.triggers && cur.triggers.enabled), items: (Array.isArray(cur.triggers && cur.triggers.items) ? cur.triggers.items : []).map(LapTriggers.normalize) },
      iniFromPreset: Array.isArray(cur.iniFromPreset) ? cur.iniFromPreset.filter(k => typeof k === 'string') : [],
    });
    if (c.aie.modules.multigroove.enabled && c.aie.modules.tandem.enabled) {
      c.aie.modules.tandem.enabled = false;
      this.compatWarning = 'MultiGroove and Tandem Drafting cannot run together; MultiGroove has priority, so Tandem Drafting was turned off.';
    }
    c.aie.host.enabled = false; c.aie.enabled = false;      // All In One NR2003 uses the original AI Enhanced, not the built-in engine                  // All In One NR2003 never starts the original exe
    if (!c.aie.host.exe && !this._hostLooked) {       // the original exe is usually in the game folder
      this._hostLooked = true;
      try { const d = path.dirname(c.nr2003_exe || ''); const f = fs.readdirSync(d).find(n => /^ai enhanced.*\.exe$/i.test(n)); if (f) c.aie.host.exe = path.join(d, f); } catch (e) { /* not there */ }
    }
    if (!c.aie.mgMigrated2) {      // one-time: restore AI Enhanced's original MultiGroove bounds
      c.aie.mgMigrated2 = true;
      const g = c.aie.modules.multigroove;
      g.left = MG_DEFAULT.left; g.right = MG_DEFAULT.right; g.spread = MG_DEFAULT.spread;
    }
    if (!c.aie.mgMigrated3) {      // one-time: AI Enhanced does not pause MultiGroove for you (its pause is the pace-car caution test)
      c.aie.mgMigrated3 = true;
      c.aie.modules.multigroove.pauseForPlayer = false;
    }
    return c.aie;
  }

  log(msg) {
    this.logTail.push(msg);
    if (this.logTail.length > LOG_TAIL) this.logTail.shift();
    journal.text('AIE', msg);
    try {      // kept on disk so a problem in a race can be read afterwards
      const f = path.join(this.opts.userData, 'aie.log');
      try { if (fs.statSync(f).size > 400000) fs.renameSync(f, f + '.old'); } catch (e) { /* new file */ }
      fs.appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n');
    } catch (e) { /* ignore */ }
    if (this.opts.log) this.opts.log('[aie] ' + msg);
  }

  // the Environment settings in effect: the user's, with the random roll replacing rate and grip multiplier while random is on
  applyConfig() {
    const c = this.cfg();
    const r = Object.assign({}, c.rubber);
    if (c.random.enabled && this.rolled) { r.rate = this.rolled.rate; r.gripMult = this.rolled.gripMult; }
    this.env.setSettings({ envGrip: c.envGrip, rubber: r });
  }

  setConfig(patch) {
    const c = this.cfg();
    const p = patch || {};
    for (const k of ['enabled', 'dryRun', 'autoPreset', 'applyLapData']) if (k in p) c[k] = !!p[k];
    if ('applyLapData' in p && !c.applyLapData && this.lines) { try { if (this.attached && this.shadow.passthrough) restoreLapLines(this.shadow, this.lines); } catch (e) { /* game gone */ } this.lapLines = null; this.lapSliders = null; this.lapTargets = null; this.lapNote = ''; }
    if ('applyLapData' in p && c.applyLapData && this.activePreset) this.applyPreset(this.activePreset.id, 'lap lines switched on');
    if (p.host && typeof p.host === 'object') { if ('enabled' in p.host) c.host.enabled = !!p.host.enabled; if (typeof p.host.exe === 'string') c.host.exe = p.host.exe; }
    if (p.priority && typeof p.priority === 'object') for (const k of ['stats', 'raceLine', 'ini']) if (['steelfire', 'original'].includes(p.priority[k])) c.priority[k] = p.priority[k];
    for (const k of ['envGrip', 'rubber', 'random']) if (p[k] && typeof p[k] === 'object') Object.assign(c[k], p[k]);
    if (p.trackPresets && typeof p.trackPresets === 'object') Object.assign(c.trackPresets, p.trackPresets);
    if (p.modules && typeof p.modules === 'object') c.modules = patchModules(c.modules, p.modules);
    if (p.triggers && typeof p.triggers === 'object') {
      if ('enabled' in p.triggers) c.triggers.enabled = !!p.triggers.enabled;
      if (Array.isArray(p.triggers.items)) c.triggers.items = p.triggers.items.map(LapTriggers.normalize);
      if (Array.isArray(p.triggers.items) && this.triggerRuntime) {
        const fired = new Set(this.triggerRuntime.scheduled.filter(t => t.fired).map(t => t.id));
        this.triggerRuntime.scheduled = LapTriggers.schedule(c.triggers.items, this.triggerRuntime.raceLaps, this.rnd).map(t => ({ ...t, fired: fired.has(t.id) }));
      }
    }
    if (c.modules.multigroove.enabled && c.modules.tandem.enabled) {
      c.modules.tandem.enabled = false;
      this.compatWarning = 'MultiGroove and Tandem Drafting cannot run together; MultiGroove has priority, so Tandem Drafting was turned off.';
    } else if (p.modules) this.compatWarning = '';
    if (p.ini && typeof p.ini === 'object') {
      for (const [k, v] of Object.entries(p.ini)) {
        if (!IniFiles.known(k)) continue;
        if (c.iniFromPreset) c.iniFromPreset = c.iniFromPreset.filter(x => x !== k);       // set by hand now: kept from track to track
        if (v === null || v === '' || !Number.isFinite(Number(v))) { delete c.ini[k]; if (this.attached) this.inif.release(k); } else c.ini[k] = Number(v);
      }
    }
    this.opts.getConfig().aie = c;
    this.opts.saveConfig();
    if ('dryRun' in p) { this._restoreBytes(); this._restoreIni(); this.shadow.clear(); this.shadow.passthrough = c.dryRun === false; }
    if ('enabled' in p && !c.enabled) { if (this.triggerRuntime) { this._restoreTriggerBaseline('AI Enhanced disabled'); this.triggerRuntime = null; this.triggerBaseline = null; } this._restoreBytes(); this._restoreIni(); this.shadow.clear(); }
    if (p.random && c.random.enabled && !this.rolled) this.roll('random switched on');
    this.applyConfig();
    return c;
  }

  // ── random rubber ────────────────────────────────────────────────────────────────────────────────
  roll(why) {
    const r = this.cfg().random;
    const pick = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b); return round2(lo + this.rnd() * (hi - lo)); };
    this.rolled = { rate: Math.max(0, pick(r.rateMin, r.rateMax)), gripMult: Math.max(0.01, pick(r.gripMin, r.gripMax)) };
    this.log(`random rubber (${why || 'rolled'}): rubbering rate ${this.rolled.rate}, grip multiplier at max rubber ${this.rolled.gripMult}`);
    this.applyConfig();
    return this.rolled;
  }

  // ── presets ───────────────────────────────────────────────────────────────────────────────────────
  applyPreset(id, why) {
    const e = this.presets.get(id);
    if (!e) return false;
    const s = require('./presets').summarize(e.preset);
    const c = this.cfg();
    if (s.resetDefaults) {
      c.envGrip = Object.assign({}, DEFAULTS.envGrip); c.rubber = Object.assign({}, DEFAULTS.rubber);
      c.ini = {}; c.modules = mergeModules({});
      if (this.lines) { try { if (this.attached && this.shadow.passthrough) restoreLapLines(this.shadow, this.lines); } catch (e) { /* game gone */ } }
      this.lapLines = null; this.lapSliders = null; this.lapTargets = null; this.lapNote = '';
      this._restoreIni();
    }
    if (s.envGrip) Object.assign(c.envGrip, s.envGrip);
    if (s.rubber) Object.assign(c.rubber, s.rubber);
    if (s.iniSettings) { Object.assign(c.ini, s.iniSettings); c.iniFromPreset = [...new Set([...(c.iniFromPreset || []), ...Object.keys(s.iniSettings)])]; }
    if (s.modules) c.modules = patchModules(c.modules, s.modules);
    if (c.modules.multigroove.enabled && c.modules.tandem.enabled) {
      c.modules.tandem.enabled = false;
      this.compatWarning = 'MultiGroove and Tandem Drafting cannot run together; MultiGroove has priority, so Tandem Drafting was turned off.';
    } else this.compatWarning = '';
    this.opts.saveConfig();
    if (s.lapLines || s.lapSliders) { this.lapLines = s.lapLines || null; this.lapSliders = s.lapLines ? null : s.lapSliders; this.lapTargets = null; }
    if ((s.lapLines || s.lapSliders) && c.applyLapData) this._applyLapLines();
    if (s.cleanRubber) this.env.clearRubber();
    this.activePreset = { id: e.id, name: e.name, why: why || 'chosen', applied: Object.keys(s).filter(k => ['envGrip', 'rubber', 'iniSettings', 'modules', 'resetDefaults'].includes(k) || ((k === 'lapLines' || k === 'lapSliders') && c.applyLapData)), needsAiEnhanced: s.needsAiEnhanced };
    this.presetNote = s.needsAiEnhanced.length ? `select in the original AI Enhanced for: ${s.needsAiEnhanced.join(', ')}` : '';
    this.log(`preset "${e.name}" (${why || 'chosen'}): ${this.activePreset.applied.join(' + ') || 'no environment settings in it'}`);
    this.modules.reset();
    this.applyConfig();
    return true;
  }

  setTrackPreset(track, id) {
    const c = this.cfg();
    c.trackPresets[String(track).toLowerCase()] = id || '';
    this.opts.saveConfig();
    if (String(track).toLowerCase() === String(this.track).toLowerCase() && id) this.applyPreset(id, 'chosen for this track');
    return true;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────────
  start() { this.timer = setInterval(() => this._tick(), TICK_MS); if (this.timer.unref) this.timer.unref(); }
  stop() { clearInterval(this.timer); try { if (this.host) this.host.stop(); } catch (e) { /* ignore */ } if (this.triggerRuntime) { this._restoreTriggerBaseline('All In One NR2003 stopped'); this.triggerRuntime = null; this.triggerBaseline = null; } this._restoreBytes(); this._restoreIni(); try { this.shadow.detach(); } catch (e) { /* ignore */ } }

  _tick() {
    try { this._tickInner(); this.error = ''; }
    catch (e) {
      this.error = String(e && e.message || e);
      const now = Date.now();
      if (now - (this._errAt || 0) > 60000) { this._errAt = now; this.log('error: ' + this.error); }
    }
  }

  _tickInner() {
    const cfg = this.cfg();
    if (this.host) try { this.host.tick(); } catch (e) { /* ignore */ }
    if (!cfg.enabled) { this.note = ''; this.originalAieRunning = false; if (this.attached) { this._restoreBytes(); this._restoreIni(); this.shadow.detach(); this.attached = false; } return; }
    this.originalAieRunning = !!(this.opts.externalRunning && this.opts.externalRunning());
    this.note = this.originalAieRunning
      ? `Original AI Enhanced is running. Priority — stats: ${cfg.priority.stats}; race lines: ${cfg.priority.raceLine}; INI: ${cfg.priority.ini}.` : '';
    const m = this.shadow;
    const was = this.attached;
    this.attached = !!m.attach();
    if (!this.attached) { if (was) { journal.gameGone('AIE'); this._forgetGame(); } return; }
    const now = Date.now();
    if (now - this._slowAt >= SLOW_MS) { this._slowAt = now; this._slow(); try { this._lapKeep(); } catch (e) { /* game gone */ } }
    if (!this.track || !this.session) { this._restoreBytes(); return; }
    if (!this.lines) { this._wantLines(now); return; }
    if (this.boundsState === 'missing' && (this._boundsTries || 0) < 5 && now >= (this._boundsAt || 0) && !this._scanning) this._retryBounds();
    // AI Enhanced's tick: every 25 ms (on a fixed deadline) the cars are read, the factors worked out, and every byte, the player's constants and
    // the race line written once. The game puts its own stat bytes back about every 18 ms, so like AI Enhanced's they hold only part of the time.
    if (now >= this._aieDue) {
      this._aieDue = Math.max(this._aieDue + AIE_TICK_MS, now - AIE_TICK_MS);
      this._readCars(now);
      if (this.factors) { this._writeBytes(); this._writePlayer(); }
      this._multigroove();
    } else if (this.originalAieRunning) {               // the original exe is running too and All In One NR2003 comes first: put our values back after it writes
      if (cfg.priority.stats === 'steelfire' && this.factors) this._writeBytes(false);
      if (cfg.priority.raceLine === 'steelfire') this._multigroove();
    }
  }

  _forgetGame() { this.player.reset(); this.playerWritten = false; if (this.triggerRuntime) { this._restoreTriggerBaseline('NR2003 disconnected'); this.triggerRuntime = null; this.triggerBaseline = null; } this.track = ''; this.session = 0; this.lines = null; this.bounds = null; this.draftingBounds = null; this.boundsState = 'idle'; this.linesState = 'idle'; this.env.setLines(null); this.orig = []; this.last = []; this.factors = null; this.teams.reset(); this.mgMin = null; this.mgMax = null; this._brakeSpans = null; }

  // AIMOD plans the stop; AI Enhanced stages the car on maxrace.lp and moves nearby traffic to the outside.
  _pitLaneData() {
    const cfg = this.cfg();
    let plan = null;
    try { plan = this.opts.getPitLanePlan ? this.opts.getPitLanePlan() : null; } catch (e) { plan = null; }
    const family = pitLaneFamily(plan && plan.track);
    const sameTrack = !!family && family === pitLaneFamily(this.track);
    const active = !!(plan && plan.active && cfg.enabled && cfg.dryRun === false && this.shadow.passthrough && family &&
      !(this.originalAieRunning && cfg.priority.raceLine === 'original'));
    if (!active) return { active: false, track: this.track || '', staged: [], due: [], ready: [], waiting: [], paints: [] };

    const L = this.lines;
    const lineCount = sameTrack && L ? Math.min(L.race.count, L.minrace.count, L.maxrace.count) : 0;
    const paintCount = this.bounds ? Math.min(lineCount, this.bounds.count) : 0;
    const pitters = new Map(), staged = [], due = [], ready = [], waiting = [];
    for (const item of plan.cars || []) {
      const idx = Number(item && item.idx), lapsToPit = Number(item && item.lapsToPit);
      const slot = idx - 2;
      if (!Number.isInteger(idx) || slot < 0 || slot >= NCARS - 1 || !Number.isFinite(lapsToPit) || lapsToPit > 2) continue;
      staged.push(idx);
      if (lapsToPit <= 1) due.push(idx);  // one lap of margin for AIMOD's slower lap-counter refresh
      const car = this.cars[slot];
      if (!this.attached || !car || !Number.isFinite(car.dlong) || !Number.isFinite(car.dlat)) { waiting.push(idx); continue; }
      const p = lineCount ? Math.min(lineCount - 1, Math.max(0, Math.ceil(car.dlong / PIT_LANE_CELL))) : -1;
      const maxLat = p >= 0 ? L.maxrace.rec[p * 7 + 3] : null;
      const minLat = p >= 0 ? L.minrace.rec[p * 7 + 3] : null;
      if (maxLat !== null && minLat !== null && Number.isFinite(maxLat) && Number.isFinite(minLat)) {
        const tolerance = Math.min(3.0, Math.max(1.5, Math.abs(maxLat - minLat) * 0.3));
        if (Math.abs(car.dlat - maxLat) <= tolerance) ready.push(idx);
        else waiting.push(idx);
      } else waiting.push(idx);
      pitters.set(slot, { idx, car });
    }

    const paints = [];
    if (paintCount && this.bounds && sameTrack) {
      const length = this.trackLen > 0 ? this.trackLen : (L.race.len || 0);
      const wrap = (d) => {
        if (length > 0) { if (d > length * 0.5) d -= length; if (d < -length * 0.5) d += length; }
        return d;
      };
      const lanePoint = (line, dlong) => {
        const p = Math.min(line.count - 1, Math.max(0, Math.ceil(dlong / PIT_LANE_CELL)));
        return { p, lat: line.rec[p * 7 + 3] };
      };
      const laneAt = (lane, dlong) => {
        const line = lane === 'maxrace' ? L.maxrace : lane === 'minrace' ? L.minrace : null;
        if (line) return lanePoint(line, dlong);
        const a = lanePoint(L.minrace, dlong), b = lanePoint(L.maxrace, dlong);
        return { p: a.p, lat: (a.lat + b.lat) * 0.5 };
      };
      const hasRoom = (slot, lane) => {
        const car = this.cars[slot];
        const target = laneAt(lane, car.dlong).lat;
        if (!Number.isFinite(target) || Math.abs(target - car.dlat) <= 2.5) return false;
        const mergeDirection = Math.sign(target - car.dlat);
        const lo = Math.min(target, car.dlat), hi = Math.max(target, car.dlat);
        for (let otherSlot = 0; otherSlot < NCARS - 1; otherSlot++) {
          if (otherSlot === slot) continue;
          const other = this.cars[otherSlot];
          if (!other || !Number.isFinite(other.dlong) || !Number.isFinite(other.dlat)) continue;
          const gap = Math.abs(wrap(other.dlong - car.dlong));
          if (lane === 'maxrace') {
            // Maxrace is the inside line. Only a car on the inside/left and
            // immediately alongside can prevent this merge; traffic to the
            // right or farther ahead/behind must not hold it out of the lane.
            const towardInside = (other.dlat - car.dlat) * mergeDirection;
            const leftSideClearance = Math.max(8, Math.min(12, Math.max(car.speed || 0, other.speed || 0) * 0.12));
            if (towardInside > 0 && gap <= leftSideClearance) return false;
            continue;
          }
          if (other.speed <= 0.05) continue;
          // Keep enough room for a controlled lane change without letting a
          // whole drafting pack block the pit lane for hundreds of metres.
          const clearance = Math.max(10, Math.min(18, Math.max(car.speed || 0, other.speed || 0) * 0.2));
          if (gap > clearance) continue;
          const otherTarget = laneAt(lane, other.dlong).lat;
          if (Number.isFinite(otherTarget) && Math.abs(other.dlat - otherTarget) <= 3.2) return false;
          // Do not cut across a car already alongside in the lane-change corridor.
          if (other.dlat > lo + 2.4 && other.dlat < hi - 2.4) return false;
        }
        return true;
      };
      const chosen = new Map();
      const add = (slot, lane, priority, distance = 0) => {
        const car = this.cars[slot];
        if (!car || !Number.isFinite(car.dlong)) return;
        if (!hasRoom(slot, lane)) return;
        const center = Math.ceil(car.dlong / PIT_LANE_CELL);
        const radius = 12;                 // ease lane changes in and out over 36 m instead of snapping in 9 m
        for (let d = -radius; d <= radius; d++) {
          const point = center + d;
          if (point < 0 || point >= paintCount) continue;
          const prev = chosen.get(point);
          const strength = Math.max(0, 1 - Math.abs(d) / radius);
          if (!prev || priority > prev.priority || (priority === prev.priority && (strength > prev.strength || (strength === prev.strength && distance < prev.distance)))) {
            chosen.set(point, { point, lane, priority, distance, strength });
          }
        }
      };
      for (const [slot] of pitters) add(slot, 'maxrace', 3);
      if (pitters.size) for (let slot = 0; slot < NCARS - 1; slot++) {
        const car = this.cars[slot];
        if (!car || !Number.isFinite(car.dlong) || car.speed <= 0.05 || pitters.has(slot)) continue;
        let nearest = Infinity;
        for (const p of pitters.values()) nearest = Math.min(nearest, Math.abs(wrap(car.dlong - p.car.dlong)));
        if (nearest <= 30) add(slot, 'minrace', 2, nearest);       // nearest traffic yields only when the outside lane is clear
        else if (nearest <= 78) add(slot, 'middle', 1, nearest);  // farther traffic eases toward the middle when clear
      }
      for (const op of chosen.values()) {
        const rec = new Float32Array(7), base = op.point * 7;
        for (let k = 0; k < 7; k++) {
          const mn = L.minrace.rec[base + k], mx = L.maxrace.rec[base + k];
          const target = op.lane === 'maxrace' ? mx : op.lane === 'minrace' ? mn : (mn + mx) * 0.5;
          const original = L.race.rec[base + k];
          rec[k] = original + (target - original) * op.strength;
        }
        if (Number.isFinite(rec[3])) paints.push({ point: op.point, rec });
      }
    }
    staged.sort((a, b) => a - b); due.sort((a, b) => a - b); ready.sort((a, b) => a - b); waiting.sort((a, b) => a - b);
    return { active: true, track: this.track, staged, due, ready, waiting, paints };
  }

  getPitLaneState() {
    const state = this._pitLaneData();
    this.pitLaneStatus = { active: state.active, track: state.track, staged: state.staged, due: state.due, ready: state.ready, waiting: state.waiting };
    return this.pitLaneStatus;
  }

  // Live car-file metadata shared with AIMOD. Read only; AIMOD may need the rows even when
  // the All In One NR2003 AI Enhanced effects are switched off.
  getTeamRows() {
    const alreadyAttached = this.attached;
    if (!alreadyAttached && !this.shadow.attach()) { this.teams.reset(); return []; }
    try {
      const name = this.shadow.readCString(A.TrackName, 64) || '';
      const session = this.shadow.readU8(A.SessionByte) || 0;
      if (!name || !session) { this.teams.reset(); return []; }
      const exe = this._exePath();
      this.teams.refresh(this.shadow, this.shadow.readCString(A.BaseDir, 260) || (exe ? path.dirname(exe) : ''));
      return this.teams.rows().filter((row) => row.slot < 43);
    } finally {
      if (!alreadyAttached) this.shadow.detach();
    }
  }

  // MultiGroove: rewrite the game's race line every tick (the game puts its own back about every frame, like the stat bytes)
  _mgCompute() {        // preserve All In One NR2003's pit approach painting and wreck braking on the race line
    const L = this.lines;
    this.mgBuf = null; this.mgMode = ''; this.mgMin = null; this.mgMax = null;
    const cfg = this.cfg();
    if (L && this.originalAieRunning && cfg.priority.raceLine === 'original') {
      this._mgRestore();
      if (this.lapLines) { try { restoreLapLines(this.shadow, L); } catch (e) { /* game gone */ } this.lapLines = null; this.lapTargets = null; }
      this._originalRaceYielded = true;
      this.pitLaneStatus = { active: false, track: this.track, staged: [], due: [], ready: [], waiting: [] };
      return;
    }
    if (this._originalRaceYielded) {
      this._originalRaceYielded = false;
      if (cfg.applyLapData && this.activePreset) {
        const entry = this.presets.get(this.activePreset.id);
        const preset = entry && require('./presets').summarize(entry.preset);
        if (preset && (preset.lapLines || preset.lapSliders)) { this.lapLines = preset.lapLines || null; this.lapSliders = preset.lapLines ? null : preset.lapSliders; this.lapTargets = null; this._applyLapLines(); }
      }
    }
    const pitLane = this._pitLaneData();
    this.pitLaneStatus = { active: pitLane.active, track: pitLane.track, staged: pitLane.staged, due: pitLane.due, ready: pitLane.ready, waiting: pitLane.waiting };
    if (!L) return;
    let buf = null;
    const tw = this.tweaks;
    const brake = tw && tw.brake && tw.brake.count > 0 ? tw.brake : null;
    if (tw && tw.mg && tw.mg.write && !(this.opts.raceLineOwner && this.opts.raceLineOwner())) {
      buf = Buffer.from(L.race.orig);
      tw.mg.write.copy(buf, 0, 0, Math.min(tw.mg.write.length, buf.length));
    }
    if (tw && (tw.blends.length || tw.nudges.length || tw.sets.length)) {
      buf = Buffer.from(buf || L.race.orig);
      const n = Math.floor(buf.length / 28);
      for (const b of tw.blends) { const bound = L[b.bound]; if (bound && bound.rec) blendRace(buf, bound.rec, Math.min(n, bound.count), b); }
      for (const t of tw.nudges) if (t.point >= 0 && t.point < n) buf.writeFloatLE(buf.readFloatLE(t.point * 28 + 8) + t.delta, t.point * 28 + 8);
      for (const t of tw.sets) if (t.point >= 0 && t.point < n) buf.writeFloatLE(t.value, t.point * 28 + 8);
    }
    if (pitLane.paints.length) {
      buf = Buffer.from(buf || L.race.orig);
      for (const p of pitLane.paints) for (let k = 0; k < 7; k++) buf.writeFloatLE(p.rec[k], p.point * 28 + k * 4);
    }
    if (brake) {                      // Brake for Wrecks: the speed of the race line and of both bound lines is cut in front of a slow car
      buf = Buffer.from(buf || L.race.orig);
      capBuffer(buf, brake);
      this.mgMin = { buf: Buffer.from(L.minrace.orig), span: null }; this.mgMin.span = capBuffer(this.mgMin.buf, brake);
      this.mgMax = { buf: Buffer.from(L.maxrace.orig), span: null }; this.mgMax.span = capBuffer(this.mgMax.buf, brake);
    }
    if (!buf && L.race.applied) buf = Buffer.from(L.race.orig);
    this.mgBuf = buf; this.mgRows = null;
    if (buf && this.bounds) {        // the AI's lane limits are stored relative to the race line: work them out again for the moved line
      const rec = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
      const recOf = (m, line) => (m ? { rec: new Float32Array(m.buf.buffer.slice(m.buf.byteOffset, m.buf.byteOffset + m.buf.length)) } : line);
      this.mgRows = rows11({ rec }, recOf(this.mgMin, L.minrace), recOf(this.mgMax, L.maxrace), Math.min(this.bounds.count, Math.floor(rec.length / 7)), this.boundsScale || 1);
    } else if (buf) { this.mgBuf = null; this.mgMin = null; this.mgMax = null; }      // no table, no painting: moving the line alone would carry the AI's limits into the wall
  }

  _multigroove() {      // every tick: put the line in the game again
    const L = this.lines;
    if (this.opts.raceLineOwner && this.opts.raceLineOwner()) {     // Superspeedway Lines is painting: it writes the line, on top of ours (raceLineBase)
      if (L && this.shadow.passthrough && this.attached) this._writeBrakeLines(L);
      this._mgDirty = false;
      return;
    }
    if (!L || !this.mgBuf) { this._mgRestore(); return; }
    this.mgWrites = (this.mgWrites || 0) + 1;
    if (this.shadow.passthrough) {
      this.shadow.writeBytes(L.race.addr, this.mgBuf);
      this._writeBrakeLines(L);
      if (this.mgRows) writeRows11(this.shadow, this.bounds, this.mgRows);
    }
    this._mgDirty = true;
  }

  // our version of the race line (pit approach painting, wreck braking), for Superspeedway Lines to paint its grooves on; null = the game's own
  raceLineBase() { return this.mgBuf || null; }

  // the braked minrace / maxrace lines: only the records that changed are written, and the ones braked before but not now are put back
  _writeBrakeLines(L) {
    const spans = this._brakeSpans || (this._brakeSpans = { minrace: null, maxrace: null });
    for (const [name, m] of [['minrace', this.mgMin], ['maxrace', this.mgMax]]) {
      const line = L[name], old = spans[name], cur = m && m.span;
      if (!old && !cur) continue;
      const lo = Math.min(old ? old.lo : Infinity, cur ? cur.lo : Infinity), hi = Math.max(old ? old.hi : -1, cur ? cur.hi : -1);
      const src = m ? m.buf : line.orig;
      this.shadow.writeBytes(line.addr + lo * 28, src.subarray(lo * 28, (hi + 1) * 28));
      spans[name] = cur ? { lo: cur.lo, hi: cur.hi } : null;
    }
  }

  _mgRestore() {
    const spans = this._brakeSpans;
    if (spans && this.lines) {
      this.mgMin = null; this.mgMax = null;
      try { if (this.shadow.passthrough && this.attached) this._writeBrakeLines(this.lines); } catch (e) { /* game gone */ }
      this._brakeSpans = null;
    }
    if (!this._mgDirty || !this.lines) { this._mgDirty = false; return; }
    this._mgDirty = false;
    try { if (this.shadow.passthrough && this.attached) { this.shadow.writeBytes(this.lines.race.addr, this.lines.race.orig); if (this.bounds) restoreBounds(this.shadow, this.bounds); } } catch (e) { /* game gone */ }
  }

  // the lap lines of the loaded preset go into the game (once the lines have been found); minrace / maxrace are put in again every second,
  // the race line with every tick (the game keeps putting its own back)
  // AI Enhanced's lap-line apply (Apply All Tabs -> FUN_0044c220 for race, maxrace and minrace): the base lines are the preset's (lap data
  // version 2 is stored at strength 100 / modifier 1; older data is read as saved at 100 % with today's ai_line_modifier) or else the game's
  // own at track load, all at that canonical scale. Each line's lateral (the base's, a slider blend between base lines, or the editor's) goes
  // through the fuzzy writer, then to today's opponent strength / ai_line_modifier scale. Only the points are written, not the length.
  // the three base lines at canonical scale (strength 100, modifier 1), n points each: the preset's / editor's where it has one that fits,
  // else the game's own (as built at track load). -> { base: { minrace, race, maxrace }, notes, now (today's scale), mod }
  _lapBase(n) {
    const L = this.lines;
    const mod = this.shadow.readF32(0x74b110), now = lineScale(this.shadow.readU8(0x745044), mod);
    const notes = [], base = {};
    const own = (name) => scaleRec(Float32Array.from((L[name].orig0 ? L[name].orig0.rec : L[name].rec).subarray(0, n * 7)), n, this.linesScale || now, true);
    for (const name of LINE_NAMES) {
      const src = this.lapLines && this.lapLines[name];
      if (!src) { base[name] = own(name); continue; }
      if (src.count !== L[name].count || (L[name].len > 0 && Math.abs(src.length - L[name].len) / L[name].len > 0.15)) {
        notes.push(`${name}: the preset's line (${src.count} points) does not fit this track (${L[name].count}) - the game's own kept`); base[name] = own(name); continue;
      }
      const rec = Float32Array.from(src.rec.subarray(0, n * 7));
      if (this.lapLines.scale === 'game') scaleRec(rec, n, now, true);                          // lines held at today's scale
      else if (!(this.lapLines.version >= 2)) scaleRec(rec, n, lineScale(100, mod), true);       // legacy lap data
      base[name] = rec;
    }
    return { base, notes, now, mod };
  }

  // each line's lateral: the editor's, else a slider blend (FUN_00451e50: 0 = maxrace, 50 = race, 100 = minrace, straight between neighbours),
  // else the base line's own
  _lapTargetLat(name, base, n) {
    const t = this.lapTargets && this.lapTargets[name];
    if (t && t.length >= n) return Float32Array.from(t.slice(0, n));
    const lat = new Float32Array(n);
    if (this.lapSliders) {
      const v = Math.max(0, Math.min(100, Number(Object.assign({ race: 50, minrace: 100, maxrace: 0 }, this.lapSliders)[name]))), low = v < 50;
      const A = low ? base.maxrace : base.race, B = low ? base.race : base.minrace, k = Math.fround(low ? v * 2 / 100 : (v - 50) * 2 / 100);
      for (let p = 0; p < n; p++) lat[p] = A[p * 7 + 3] + (B[p * 7 + 3] - A[p * 7 + 3]) * k;
    } else for (let p = 0; p < n; p++) lat[p] = base[name][p * 7 + 3];
    return lat;
  }

  _applyLapLines() {
    const L = this.lines;
    if (!L || (!this.lapLines && !this.lapSliders && !this.lapTargets)) return;
    const n = Math.min(L.race.count, L.minrace.count, L.maxrace.count);
    const { base, notes, now } = this._lapBase(n);
    const recs = {};
    for (const name of LINE_NAMES) {
      const out = scaleRec(fuzzyRec(this._lapTargetLat(name, base, n), base, n), n, now);
      const full = Float32Array.from(L[name].orig0 ? L[name].orig0.rec : L[name].rec);      // a line with more points than the others keeps its own tail
      full.set(out.subarray(0, Math.min(out.length, full.length)));
      recs[name] = full;
    }
    const r = applyGameRecs(L, recs);
    this.lapNote = [...r, ...notes].join('; ');
    this._painted = this._painted || {};
    for (const nm of r) { const ln = L[nm]; if (ln && ln.applied && ln.lat) { const a = (this._painted[nm] = this._painted[nm] || []); a.push({ count: ln.count, lat: Float32Array.from(ln.lat) }); if (a.length > 6) a.shift(); } }
    this.log('lap lines written the AI Enhanced way (fuzzy, weighted bounds, ' + (now.x === 1 && now.y === 1 ? 'strength 100' : `scale ${now.x.toFixed(4)} / ${now.y.toFixed(4)}`) + '): ' + (r.join(', ') || 'none') + (notes.length ? ' - ' + notes.join('; ') : ''));
    if (this.shadow.passthrough && this.attached) try { writeLapLines(this.shadow, L); } catch (e) { /* game gone */ }
    this.env.setLines({ race: L.race, minrace: L.minrace, maxrace: L.maxrace });
  }

  _lapKeep() {
    const L = this.lines;
    if (!L || !(L.minrace.applied || L.maxrace.applied) || !this.shadow.passthrough) return;
    for (const n of ['minrace', 'maxrace']) if (L[n].applied) this.shadow.writeBytes(L[n].addr, L[n].orig);
  }

  _restoreIni() { try { if (this.attached) this.inif.restore(); } catch (e) { /* game gone */ } }

  _slow() {
    const m = this.shadow;
    const cfg = this.cfg();
    const eff = Object.assign({}, cfg.ini);
    const auto = new Set();
    const tandem = cfg.modules.tandem;
    if (tandem.enabled && tandem.opts.optimizeIni !== false) {
      const optimized = { ai_drafting_distance: 0, yaw_accel_k1: 1, yaw_accel_k2: 1, ai_dlat_pad: 1.1, ai_drag_modifier: 1.15 };
      Object.assign(eff, optimized);
      for (const k of Object.keys(optimized)) auto.add(k);
    }
    // ai_drafting_distance from the INI tab, a preset or Tandem's Optimize INI also goes into every bounds row (AI Enhanced's FUN_0044e120)
    const rowDraft = 'ai_drafting_distance' in eff ? Number(eff.ai_drafting_distance) : null;
    const mg = cfg.modules.multigroove;
    if (mg.enabled && mg.spaceCars) {           // MultiGroove's Spread Cars (FUN_00417680): the two global INI values only, put back when it is off.
      // AI Enhanced applies modes after the INI tab, so they win over a preset's INI values; a value you set by hand afterwards wins over them
      for (const [k, v] of [['ai_drafting_distance', 4], ['ai_dlat_pad', 3]]) if (!(k in cfg.ini) || cfg.iniFromPreset.includes(k)) { eff[k] = v; auto.add(k); }
    }
    this.effIni = Object.assign({}, eff);
    if (this.playerWritten) {                   // your car's constants are written: ai_grip_modifier / ai_drag_modifier are theirs (bases from here)
      for (const k of ['ai_grip_modifier', 'ai_drag_modifier']) { delete eff[k]; this.inif.release(k); auto.delete(k); }
    }
    if (this.originalAieRunning && cfg.priority.ini === 'original') {
      this._restoreIni();
      for (const k of this._autoIni || []) this.inif.release(k);
      this._autoIni = new Set();
    }
    for (const k of this._autoIni || []) if (!auto.has(k) && !(k in eff)) this.inif.release(k);
    this._autoIni = auto;
    if (!(this.originalAieRunning && cfg.priority.ini === 'original') && Object.keys(eff).length) this.iniWritten = this.inif.apply(eff);
    this.trackLen = m.readF32(0xbddf2c) || 0; this.raceUnits = m.readU8(0x8c60d0) || 0;
    this.boundsScale = scaleFor(m.readU8(0x745044), m.readF32(0x74b110));      // opponent strength scales the speed terms of the bound rows
    const name = m.readCString(A.TrackName, 64) || '';
    const session = m.readU8(A.SessionByte) || 0;
    if (name !== this.track) this._onTrack(name);
    const originalIniOwns = this.originalAieRunning && cfg.priority.ini === 'original';
    if (this.draftingBounds && this.draftingBounds !== this.bounds) {
      try { if (this.shadow.passthrough) restoreDrafting(this.shadow, this.draftingBounds); } catch (e) { /* game gone */ }
      this.draftingBounds = null;
    }
    if (this.bounds && !originalIniOwns && rowDraft !== null && Number.isFinite(rowDraft) && this.shadow.passthrough) {
      writeDrafting(this.shadow, this.bounds, rowDraft);
      this.draftingBounds = this.bounds;
    } else if (this.draftingBounds) {
      try { if (this.shadow.passthrough) restoreDrafting(this.shadow, this.draftingBounds); } catch (e) { /* game gone */ }
      this.draftingBounds = null;
    }
    if (name && session) { try { const exe = this._exePath(); this.teams.refresh(m, m.readCString(A.BaseDir, 260) || (exe ? path.dirname(exe) : '')); } catch (e) { /* car info is optional */ } }
    if (this.lines && !this._linesStillThere()) this._linesLost('the game reloaded its lap lines');
    if (session !== this._lastSession) {
      if (this._lastSession === 0 && session !== 0 && this.cfg().random.enabled && this.cfg().random.rollEachSession) this.roll('new session');
      this._lastSession = session;
    }
    this.session = session;
    this._runLapTriggers(name, session);
  }

  _captureTriggerBaseline() {
    const c = this.cfg();
    return {
      envGrip: cloneJson(c.envGrip), rubber: cloneJson(c.rubber), ini: cloneJson(c.ini), modules: cloneJson(c.modules),
      applyLapData: !!c.applyLapData, lapLines: cloneLapSource(this.lapLines), lapSliders: this.lapSliders ? cloneJson(this.lapSliders) : null, lapTargets: this.lapTargets ? cloneJson(this.lapTargets) : null,
      activePreset: this.activePreset ? cloneJson(this.activePreset) : null,
      grid: this.env.grid ? { w: this.env.grid.w, h: this.env.grid.h, off: this.env.grid.off, data: Array.from(this.env.grid.data) } : null,
    };
  }

  _restoreTriggerBaseline(reason = 'trigger reset') {
    const b = this.triggerBaseline;
    if (!b) return false;
    const c = this.cfg();
    Object.assign(c.envGrip, b.envGrip); Object.assign(c.rubber, b.rubber); c.ini = cloneJson(b.ini); c.modules = mergeModules(b.modules); c.applyLapData = b.applyLapData;
    this.lapLines = cloneLapSource(b.lapLines); this.lapSliders = b.lapSliders ? cloneJson(b.lapSliders) : null; this.lapTargets = b.lapTargets ? cloneJson(b.lapTargets) : null; this.activePreset = b.activePreset ? cloneJson(b.activePreset) : null;
    if (this.lines && !this.lapLines && !this.lapSliders && !this.lapTargets && this.lines.race.orig0) {
      try { if (this.attached && this.shadow.passthrough) restoreLapLines(this.shadow, this.lines); } catch (e) { /* game can be closing */ }
    } else if (this.lines && c.applyLapData && (this.lapLines || this.lapSliders || this.lapTargets)) this._applyLapLines();
    this.modules.reset(); this.applyConfig();
    if (b.grid && this.env.grid && b.grid.w === this.env.grid.w && b.grid.h === this.env.grid.h) this.env.grid.data.set(b.grid.data);
    this.opts.getConfig().aie = c; this.opts.saveConfig();
    this.log(`${reason}: restored the pre-race AI settings`);
    return true;
  }

  _runLapTriggers(track, session) {
    const c = this.cfg(), m = this.shadow;
    if (!c.triggers.enabled) {
      if (this.triggerRuntime) this._restoreTriggerBaseline('lap triggers disabled');
      this.triggerRuntime = null; this.triggerBaseline = null;
      this.triggerStatus = { enabled: false, state: 'off', lap: 0, raceLaps: 0, fired: [] };
      return;
    }
    const addr = require('../racecontrol/addr');
    const sim = m.readU8(addr.SimState), nSessions = m.readU8(addr.NumSessions) || 0, sessionNum = m.readU8(addr.SessionNum);
    const raceSession = (sim === 2 || sim === 3) && nSessions > 0 && sessionNum !== null && sessionNum + 1 === nSessions;
    const lengthAddr = nSessions === 2 ? addr.RaceLengthQuickRace : addr.RaceLength;
    const raceLaps = m.readU16(lengthAddr) || 0, lap = Math.max(1, (m.readI32(addr.LapsComplete) || 0) + 1), flag = m.readU8(addr.FlagState);
    if (!raceSession || !raceLaps || !track) {
      this.triggerStatus = { enabled: true, state: 'waiting for a race', lap, raceLaps, fired: [] };
      return;
    }
    const key = `${track.toLowerCase()}|${session}|${raceLaps}|${sessionNum}`;
    if (!this.triggerRuntime || this.triggerRuntime.key !== key) {
      this.triggerBaseline = this._captureTriggerBaseline();
      const scheduled = LapTriggers.schedule(c.triggers.items, raceLaps, this.rnd);
      this.triggerRuntime = { key, raceLaps, scheduled, caution: false, pendingRestart: null, startedAtLap: lap };
      this.log(`lap triggers armed for ${raceLaps} laps at lap ${lap}`);
    }
    const rt = this.triggerRuntime, caution = flag !== null && flag >= 1 && flag <= 6;
    const fire = (items, why) => {
      let applied = false;
      for (const t of items) {
        const presetId = t.randomPreset ? this._randomTriggerPreset(t) : t.presetId;
        if (!presetId) { this.log(`lap trigger ${LapTriggers.label(t, t.fireLap)} has no matching preset; skipped`); continue; }
        if (this.applyPreset(presetId, why)) { applied = true; this.log(`lap trigger applied: ${this.activePreset ? this.activePreset.name : t.presetName || presetId}`); }
        else this.log(`lap trigger preset not found: ${t.presetName || presetId}`);
      }
      return applied;
    };
    const dueNow = () => rt.scheduled.filter(t => t.fireLap !== null && !t.fired && t.fireLap <= lap);
    const markDue = (items) => items.forEach(t => { t.fired = true; });
    if (caution && !rt.caution) {
      rt.caution = true; rt.pendingRestart = null;
      fire(c.triggers.items.filter(t => t.type === 'yellow'), 'yellow trigger');
      this.log('yellow lap triggers active');
    } else if (!caution && rt.caution) {
      rt.caution = false; rt.pendingRestart = { lap };
      this.log('yellow ended; waiting for the first full green lap before restart triggers');
    }
    if (!caution && rt.pendingRestart && lap > rt.pendingRestart.lap + 1) {
      this._restoreTriggerBaseline('restart');
      const due = dueNow(); markDue(due); if (due.length) fire([due[due.length - 1]], 'scheduled trigger after yellow');
      fire(c.triggers.items.filter(t => t.type === 'restart'), 'restart trigger');
      rt.pendingRestart = null;
    } else if (!caution && !rt.pendingRestart) {
      const due = dueNow(); markDue(due);
      if (due.length) fire([due[due.length - 1]], 'lap trigger');
    }
    this.triggerStatus = { enabled: true, state: caution ? 'yellow' : (rt.pendingRestart ? 'waiting for restart lap' : 'armed'), lap, raceLaps,
      fired: rt.scheduled.filter(t => t.fired).map(t => ({ id: t.id, label: LapTriggers.label(t, t.fireLap), fireLap: t.fireLap })) };
  }

  _randomTriggerPreset(trigger) {
    let ids = (trigger.presetIds || []).filter(id => this.presets.get(id));
    if (!ids.length && trigger.folderPath) {
      const folder = path.resolve(trigger.folderPath);
      if (!this.randomTriggerFolders.has(folder)) {
        const found = [];
        try {
          for (const f of fs.readdirSync(folder).filter(n => /\.(nrpreset|json)$/i.test(n)).sort()) {
            try { const raw = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) found.push(this.presets.saveNew(path.basename(f).replace(/\.(nrpreset|json)$/i, ''), raw)); } catch (e) { /* skip malformed files */ }
          }
        } catch (e) { this.log(`random preset folder unavailable: ${e.message}`); }
        this.randomTriggerFolders.set(folder, found);
      }
      ids = this.randomTriggerFolders.get(folder).filter(id => this.presets.get(id));
    }
    if (!ids.length) { this.log('random preset trigger has no usable presets in its folder'); return ''; }
    return ids[Math.min(ids.length - 1, Math.floor(this.rnd() * ids.length))];
  }

  // AI Enhanced's Lap File Editor works on its base lines (canonical scale) and a lateral per shown line; speeds show in MPH at today's
  // opponent strength and ai_line_modifier (canonical speed x scale x 80.52984). Sliders run 0 (maxrace) .. 1 (minrace).
  getEditorState() {
    if (!this.lines) return { ready: false, track: this.track, error: this.linesError || 'Wait for NR2003 to load the track lap lines.' };
    const L = this.lines, n = Math.min(L.race.count, L.minrace.count, L.maxrace.count);
    const { base, now } = this._lapBase(n);
    const col = (rec, k) => Array.from({ length: n }, (_, p) => rec[p * 7 + k]);
    const out = { base: {}, lat: {} };
    for (const name of LINE_NAMES) { out.base[name] = { lat: col(base[name], 3), f0: col(base[name], 0), f2: col(base[name], 2) }; out.lat[name] = Array.from(this._lapTargetLat(name, base, n)); }
    const sl = Object.assign({ race: 50, minrace: 100, maxrace: 0 }, this.lapSliders || {});
    return {
      ready: true, track: this.track, n, mph: now.x * 80.52984, dryRun: this.cfg().dryRun !== false, attached: this.attached,
      sliders: { minrace: sl.minrace / 100, race: sl.race / 100, maxrace: sl.maxrace / 100 }, rubber: !!(this.env.grid && this.env.rubber && this.env.rubber.active), ...out,
    };
  }

  // the Rubber Buildup grid for the editor's heat map: cell x = lap point, cell y = 1 m of lateral from off
  getEditorRubber() { const g = this.env.grid; return g ? { w: g.w, h: g.h, off: g.off, data: Array.from(g.data) } : null; }

  // "Save && Close": the edited base speeds and the three lines' laterals become the lap data in effect (AI Enhanced's stored lines), written
  // the AI Enhanced way. edit: { base: { name: { f0: [n] } }, lat: { name: [n] }, sliders: { name: 0..1 } }
  applyEditor(edit) {
    if (!this.lines) throw new Error('Track lines are not ready.');
    const L = this.lines, n = Math.min(L.race.count, L.minrace.count, L.maxrace.count);
    const { base } = this._lapBase(n);
    const lapLines = { version: 2 }, targets = {};
    for (const name of LINE_NAMES) {
      const f0 = edit && edit.base && edit.base[name] && edit.base[name].f0, lat = edit && edit.lat && edit.lat[name];
      if (!Array.isArray(f0) || !Array.isArray(lat) || f0.length !== n || lat.length !== n) throw new Error('The edited point count does not match this track.');
      const rec = Float32Array.from(base[name]);
      for (let p = 0; p < n; p++) {
        const v = Number(f0[p]), x = Number(lat[p]);
        if (!Number.isFinite(v) || v < 0 || !Number.isFinite(x) || Math.abs(x) > 200) throw new Error(`Invalid edit at point ${p + 1} of ${name}.`);
        rec[p * 7] = v;
      }
      lapLines[name] = { count: L[name].count, length: L[name].len, rec: L[name].count === n ? rec : Float32Array.from({ length: L[name].count * 7 }, (_, i) => (i < n * 7 ? rec[i] : (L[name].orig0 ? L[name].orig0.rec : L[name].rec)[i])) };
      targets[name] = lat.map(Number);
    }
    const s = edit.sliders || {};
    this.lapLines = lapLines; this.lapTargets = targets;
    this.lapSliders = { race: Math.round(Number(s.race ?? 0.5) * 100), minrace: Math.round(Number(s.minrace ?? 1) * 100), maxrace: Math.round(Number(s.maxrace ?? 0) * 100) };
    const c = this.cfg(); c.applyLapData = true; this.opts.getConfig().aie = c; this.opts.saveConfig();
    this._applyLapLines();
    this.log(`lap editor: Save && Close (${n} points per line)`);
    return this.getEditorState();
  }

  // Load Lap File: a .lp's lateral becomes that line's (its other fields come from the base lines, as AI Enhanced writes it)
  async importEditorLine(dialog, name) {
    if (!dialog || !this.lines || !LINE_NAMES.includes(name)) return null;
    const r = await dialog.showOpenDialog({ title: `Load ${name}.lp`, filters: [{ name: 'NR2003 lap line', extensions: ['lp'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const parsed = parseLapFile(fs.readFileSync(r.filePaths[0]));
    const L = this.lines, n = Math.min(L.race.count, L.minrace.count, L.maxrace.count);
    if (!parsed || parsed.count < n) throw new Error('That lap file does not have the current track point count.');
    const { base } = this._lapBase(n);
    const targets = {};
    for (const k of LINE_NAMES) targets[k] = Array.from(this._lapTargetLat(k, base, n));
    targets[name] = Array.from(parsed.lat.subarray(0, n));
    this.lapTargets = targets;
    const c = this.cfg(); c.applyLapData = true; this.opts.getConfig().aie = c; this.opts.saveConfig();
    this._applyLapLines();
    this.log(`Load Lap File: ${path.basename(r.filePaths[0])} into ${name}`);
    return this.getEditorState();
  }

  async exportEditorLine(dialog, name) {
    if (!dialog || !this.lines || !LINE_NAMES.includes(name)) return false;
    const record = this.lines[name];                                                       // the line as the game has it now
    const r = await dialog.showSaveDialog({ title: `Save ${name}.lp`, defaultPath: path.join(this.trackDir || '', `${name}.lp`), filters: [{ name: 'NR2003 lap line', extensions: ['lp'] }] });
    if (r.canceled || !r.filePath) return false;
    const file = path.extname(r.filePath) ? r.filePath : r.filePath + '.lp';
    fs.writeFileSync(file, buildLapFile(record));
    return { ok: true, file };
  }

  // the game builds new lap lines (at other addresses) when you leave a race and start again; minrace is never written by us, so it tells
  _linesStillThere() {
    try {
      const l = this.lines.minrace, n = Math.min(l.count, 73);        // the lateral column (never changed by us; Brake for Wrecks cuts the speed column of this line)
      const cur = this.shadow.readBytes(l.addr, n * 28);
      if (!cur) return false;
      for (let i = 0; i < n; i++) if (cur.readFloatLE(i * 28 + 12) !== l.orig.readFloatLE(i * 28 + 12)) return false;
      return true;
    } catch (e) { return true; }
  }

  // the game's memory still holds our paint (the race line, and minrace / maxrace from a preset): put the game's own lines back, so the next
  // scan finds them and the next session does not start from a painted line
  _unpaint() {
    try {
      if (!this.lines || !this.shadow.passthrough || !this.attached || !this._linesStillThere()) return;
      this.shadow.writeBytes(this.lines.race.addr, this.lines.race.orig);
      restoreLapLines(this.shadow, this.lines);
    } catch (e) { /* game gone */ }
  }

  _linesLost(why) {
    this._unpaint();     // same memory, new session: put our paint back so the lines can be found again
    try { if (this.draftingBounds && this.shadow.passthrough && this.attached) restoreDrafting(this.shadow, this.draftingBounds); } catch (e) { /* game gone */ }
    this.draftingBounds = null;
    this.log('lap lines lost (' + why + ') - looking again');
    this.lines = null; this.bounds = null; this.boundsState = 'idle'; this.linesState = 'waiting'; this.linesTries = 0; this._linesAt = Date.now() + 1500; this._mgDirty = false; this.mgBuf = null; this.mgMode = '';
    this.env.setLines(null);
  }

  _onTrack(name) {
    if (this.triggerRuntime) { this._restoreTriggerBaseline('track changed'); this.triggerRuntime = null; this.triggerBaseline = null; }
    try { if (this.draftingBounds && this.shadow.passthrough && this.attached) restoreDrafting(this.shadow, this.draftingBounds); } catch (e) { /* game gone */ }
    this.draftingBounds = null;
    this._unpaint();
    this._restorePlayer(); this.player.reset();          // AI Enhanced caches your car's constants again at every track load
    // the game reads papy_ai.ini / track.ini again for the new track, so (as with AI Enhanced) INI values a preset set do not carry over to it
    const cc = this.cfg();
    if (cc.iniFromPreset && cc.iniFromPreset.length) {
      for (const k of cc.iniFromPreset) { delete cc.ini[k]; try { if (this.attached) this.inif.release(k); } catch (e) { /* game gone */ } }
      cc.iniFromPreset = []; this.opts.getConfig().aie = cc; this.opts.saveConfig();
    }
    this.modules.reset(); this.activeModules = []; this.tweaks = null;
    this.track = name; this.lapLines = null; this.lapSliders = null; this.lapTargets = null; this.lapNote = '';
    this.lines = null; this.bounds = null; this.boundsState = 'idle'; this.linesState = name ? 'waiting' : 'idle'; this.linesError = ''; this.linesTries = 0; this._linesAt = 0;
    this.env.setLines(null);
    this.orig = []; this.last = []; this.factors = null;
    if (!name) { this.trackDir = ''; return; }
    const base = this.shadow.readCString(A.BaseDir, 260) || '';
    this.trackDir = this.opts.tracksDir ? this.opts.tracksDir(name, base) : path.join(base, 'tracks', name);
    this.log(`track: ${name}`);
    const c = this.cfg();
    if (c.random.enabled) this.roll('new track');
    const e = this.presets.forTrack(name, c.trackPresets, c.autoPreset);
    if (e) this.applyPreset(e.id, 'loaded for this track');
    else { this.activePreset = null; this.presetNote = ''; }
  }

  // the game's lap lines show up some seconds after the session starts; scan for them in the background and retry
  _wantLines(now) {
    if (this._scanning || now < this._linesAt) return;
    this._scanning = true; this.linesState = 'scanning';
    const track = this.track;
    const t0 = Date.now();
    findLines(this.shadow, this.trackDir, { extra: this._painted }).then((r) => {
      this._scanning = false;
      if (track !== this.track) return;
      if (r.error) {
        this.linesState = 'waiting'; this.linesError = r.error; this.linesTries++;
        this._linesAt = Date.now() + Math.min(60000, 5000 * this.linesTries);
        if (this.linesTries === 1 || this.linesTries % 6 === 0) this.log('lap lines: ' + r.error);
        return;
      }
      this.lines = r; this.linesState = 'found'; this.linesError = ''; this.mgState = null; this.lapNote = '';
      // the strength / ai_line_modifier the game built these lines at ("[track load] lap files loaded by the game at opponent strength N")
      const mod0 = this.inif.base.has('ai_line_modifier') ? this.inif.base.get('ai_line_modifier') : this.shadow.readF32(0x74b110);
      this.linesScale = lineScale(this.shadow.readU8(0x745044), mod0);
      this.bounds = null; this.boundsState = 'scanning'; this._boundsTries = 0; this._boundsAt = 0;
      this.env.setLines({ race: r.race, minrace: r.minrace, maxrace: r.maxrace });
      const g = this.env.grid;
      this.log(`lap lines found in ${Date.now() - t0} ms (${r.race.count} points); rubber grid ${g ? g.w + ' x ' + g.h : 'none'}`);
      const t1 = Date.now();
      return findBounds(this.shadow, r, this.boundsScale || 1).then((b) => {
        if (track !== this.track || this.lines !== r) return;
        this.bounds = b; this.boundsState = b ? 'found' : 'missing';
        this._boundsTries = b ? 0 : (this._boundsTries || 0) + 1; this._boundsAt = Date.now() + 8000 * this._boundsTries;
        this.log(b ? `track bounds table found in ${Date.now() - t1} ms (${b.count} rows at 0x${b.addr.toString(16)})` : 'track bounds table NOT found - MultiGroove stays off (it needs it to keep the AI lane limits where they are)');
        this._applyLapLines();
        this.applyConfig();
      });
    }).catch((e) => { this._scanning = false; this.linesState = 'waiting'; this.linesError = String(e && e.message || e); this._linesAt = Date.now() + 15000; });
  }

  // the track bounds table can be built a little after the lap lines: look again some times (8, 16, 24 ... s apart) before giving up
  _retryBounds() {
    const track = this.track, r = this.lines;
    this._scanning = true; this.boundsState = 'scanning';
    const t1 = Date.now();
    findBounds(this.shadow, r, this.boundsScale || 1).then((b) => {
      this._scanning = false;
      if (track !== this.track || this.lines !== r) return;
      this.bounds = b; this.boundsState = b ? 'found' : 'missing';
      this._boundsTries = b ? 0 : (this._boundsTries || 0) + 1; this._boundsAt = Date.now() + 8000 * this._boundsTries;
      if (b) { this.log(`track bounds table found on retry in ${Date.now() - t1} ms (${b.count} rows at 0x${b.addr.toString(16)})`); this.applyConfig(); }
      else if (this._boundsTries >= 5) this.log('track bounds table still NOT found after 5 more tries');
    }).catch(() => { this._scanning = false; this.boundsState = 'missing'; this._boundsTries = (this._boundsTries || 0) + 1; this._boundsAt = Date.now() + 15000; });
  }

  _readCars(now) {
    const m = this.shadow;
    const dt = this._carsT ? Math.min(0.25, Math.max(0, (now - this._carsT) / 1000)) : 0;
    this._carsT = now;
    // AI Enhanced's slot k (0..42, the ones whose stat bytes are written) is RaceControl's car k + 2 (0 = you, 1 = the pace car). Its 44th
    // slot, the player, is the record two before the first one (0xC087E8 = 0xC08E40 - 2 x 0x32C): RaceControl's car 0, you
    for (let i = 0; i < NCARS; i++) {
      const rc = i < NCARS - 1 ? i + 2 : 0;
      const b = A.CarBlock + rc * A.Ocd;
      const dlong = m.readF32(A.Dlong + rc * A.Ocd), dlat = m.readF32(A.Dlat + rc * A.Ocd);
      const vx = m.readF32(b + A.VelX), vz = m.readF32(b + A.VelZ);
      const speed = Math.hypot(vx || 0, vz || 0);
      this.cars[i] = dlong === null ? null : { valid: true, dlong, dlat, speed, laps: m.readU16 ? m.readU16(A.Laps + rc * A.Ocd) : 0, moving: speed > 0.05 };
    }
    const E = this.env.step(this.cars, dt, { layRubber: this.session !== 3 });
    const mcfg = this.cfg().modules;
    // AI Enhanced's caution (FUN_0044d3e0, tested only while a race-line mode is on): the pace car is on the racing surface. Then the race-line
    // modes stand still and the game's line goes back; the grip / power modes keep running.
    const caution = !!((mcfg.multigroove.enabled || mcfg.awareness.enabled || mcfg.selfSpins.enabled) && this.lines && this._paceOnTrack());
    this.caution = caution;
    const mods = this.modules.step(mcfg, this.cars, {
      trackLen: this.trackLen, raceUnits: this.raceUnits, lines: this.lines, hasBounds: !!this.bounds, teams: this.teams,
      now, rnd: this.rnd, brakeScale: 36, caution,
    });
    this.activeModules = mods.active;
    this.awarenessStatus = caution
      ? { running: false, status: { mode: 0, modeTicks: 0, attackTicks: 0, attackCool: 0, wrecks: 0, chain: 0 } }
      : { running: !!(mcfg.awareness.enabled && this.lines), status: this.modules.aw.status };
    this.tweaks = caution ? { nudges: [], sets: [], blends: [], brake: null, bound: null, mg: null } : mods;
    this._mgCompute();
    this.factors = E.map((e, i) => ({ f0: mods.f[i].f0, f1: e.f1 * mods.f[i].f1, f2: e.f2 * mods.f[i].f2 }));
  }

  // AI Enhanced's caution test: the pace car's lateral strictly between minrace and maxrace at its point (ceil(dlong / 3), kept inside minrace)
  _paceOnTrack() {
    const L = this.lines, m = this.shadow;
    const dlong = m.readF32(A.Dlong + PACE * A.Ocd), dlat = m.readF32(A.Dlat + PACE * A.Ocd);
    if (dlong === null || dlat === null || !L.minrace.count) return false;
    let p = Math.ceil(dlong / 3);
    if (!(p <= L.minrace.count - 1)) p = L.minrace.count - 1;
    if (!(p >= 0)) p = 0;
    if (p >= L.maxrace.count) return false;
    const a = L.minrace.rec[p * 7 + 3], b = L.maxrace.rec[p * 7 + 3];
    return Math.min(a, b) < dlat && dlat < Math.max(a, b);
  }

  // scale each car's stat bytes (+0x8B engine, +0x8F / +0x93 chassis) to round(orig * factor); the game's own value is whatever differs from
  // what we last wrote
  _writeBytes() {
    const m = this.shadow, f = this.factors;
    if (this.originalAieRunning && this.cfg().priority.stats === 'original') { this._restoreStatBytes(); return; }
    let touched = 0;
    const OFF = [A.StatEng, A.StatLo, A.StatHi];
    for (let i = 0; i < NCARS - 1; i++) {
      const s = A.StatBase + i * A.Ocd;
      const cur = OFF.map(o => m.readU8(s + o));
      if (cur[0] === null) continue;
      const o = this.orig[i] || (this.orig[i] = [0, 0, 0]), l = this.last[i] || (this.last[i] = [null, null, null]);
      const fac = [f[i].f0, f[i].f1, f[i].f2];
      for (let k = 0; k < 3; k++) {
        if (cur[k] === 0) { l[k] = null; o[k] = 0; continue; }          // no such car
        if (l[k] === null || cur[k] !== l[k]) o[k] = cur[k];             // the game's value (it rewrites these every ~18 ms)
        const target = scaleByte(o[k], fac[k]);
        if (target !== cur[k]) { m.writeBytes(s + OFF[k], [target]); l[k] = target; touched++; }      // (AI Enhanced writes all; an equal byte needs none)
        else l[k] = (target === o[k]) ? null : target;
      }
    }
    this.touched = touched;
  }

  // AI Enhanced's slot 43, you: physics constants scaled by your slot's factors (player.js). The INI tab's ai_grip_modifier / ai_drag_modifier
  // are the bases these keep the AI on (AI Enhanced's own cache follows what its INI tab applied)
  _playerBases() { const e = this.effIni || {}; return { drag: e.ai_drag_modifier, gripMod: e.ai_grip_modifier }; }
  _writePlayer() {
    if (!this.factors) return;
    if (this.originalAieRunning && this.cfg().priority.stats === 'original') { this._restorePlayer(); return; }
    if (!this.player.cache && !this.player.capture(this.shadow)) return;
    const f = this.factors[NCARS - 1];
    if (f && this.player.write(this.shadow, f.f0, f.f1, this._playerBases())) this.playerWritten = true;
  }
  _restorePlayer() {
    if (!this.playerWritten) return;
    try { if (this.attached) this.player.restore(this.shadow, this._playerBases()); } catch (e) { /* game gone */ }
    this.playerWritten = false;
  }

  _restoreBytes() {
    this._mgRestore();
    try { if (this.draftingBounds && this.attached && this.shadow.passthrough) restoreDrafting(this.shadow, this.draftingBounds); } catch (e) { /* game gone */ }
    this.draftingBounds = null;
    try { if (this.attached && this.lines && this.shadow.passthrough) restoreLapLines(this.shadow, this.lines); } catch (e) { /* game gone */ }
    this._restoreStatBytes();
    this._restorePlayer();
  }

  _restoreStatBytes() {
    if (!this.attached || !this.last.length) { this.last = []; this.orig = []; return; }
    const m = this.shadow, OFF = [A.StatEng, A.StatLo, A.StatHi];
    try {
      for (let i = 0; i < this.last.length; i++) {
        const l = this.last[i], o = this.orig[i];
        if (!l || !o) continue;
        const s = A.StatBase + i * A.Ocd;
        for (let k = 0; k < 3; k++) {
          if (l[k] === null || !o[k]) continue;
          const a = s + OFF[k];
          if (m.readU8(a) === l[k]) m.writeBytes(a, [o[k]]);
        }
      }
    } catch (e) { /* game gone */ }
    this.last = []; this.orig = [];
  }

  getState() {
    const c = this.cfg();
    const g = this.env.grid;
    let rubberCells = 0, rubberMax = 0;
    if (g) { for (let i = 0; i < g.data.length; i += 7) { const v = g.data[i]; if (v > 0) { rubberCells++; if (v > rubberMax) rubberMax = v; } } }
    return {
      config: c, enabled: c.enabled, dryRun: c.dryRun !== false, attached: this.attached, note: this.note, error: this.error,
      track: this.track, session: this.session, lines: { state: this.linesState, error: this.linesError, points: this.lines ? this.lines.race.count : 0 },
      grid: g ? { w: g.w, h: g.h } : null, rubber: { cells: rubberCells * 7, max: rubberMax },
      effective: { envGrip: this.env.env, rubber: this.env.rubber }, modulesActive: this.activeModules || [], moduleDefaults: MODULE_DEFAULTS,
      warnings: [this.compatWarning, ...moduleWarnings(c.modules, !!this.lines)].filter(Boolean),
      awareness: Object.assign({ running: false, status: {} }, this.awarenessStatus || {}), boundsState: this.boundsState || 'idle', hostNote: this.host ? this.host.note : '', rolled: this.rolled,
      raceTriggers: Object.assign({ enabled: false, state: 'off', lap: 0, raceLaps: 0, fired: [] }, this.triggerStatus),
      preset: this.activePreset, presetNote: this.presetNote, carsTouched: this.touched,
      trackPreset: this.presets.forTrack(this.track, c.trackPresets, c.autoPreset)?.id || '',
      pendingWrites: { count: this.shadow.count, recent: this.shadow.recent.slice(-4) }, log: this.logTail.slice(-30),
      originalAieRunning: !!this.originalAieRunning,
      pitLane: this.getPitLaneState(),
    };
  }

  listPresets() { return this.presets.list(); }
  savePreset(name) {
    const c = this.cfg();
    const preset = {
      description: 'Saved from All In One NR2003 AI Enhanced.',
      lap_data_version: 2, opponent_strength: 100,
      env_grip: { base: c.envGrip.base, maxrace: c.envGrip.maxrace, minrace: c.envGrip.minrace },
      rubber_buildup: { active: !!c.rubber.active, rate: c.rubber.rate, grip_mult: c.rubber.gripMult },
      settings: Object.assign({}, c.ini),
      special_modes: {
        side_draft_active: c.modules.sideDraft.enabled, side_draft_opts: Object.assign({}, c.modules.sideDraft.opts),
        tandem_active: c.modules.tandem.enabled, tandem_opts: Object.assign({}, c.modules.tandem.opts),
        long_run_spread_active: c.modules.longRun.enabled, long_run_spread_opts: Object.assign({}, c.modules.longRun.opts),
        awareness_active: c.modules.awareness.enabled, awareness_opts: Object.assign({}, c.modules.awareness.opts),
        self_spins_active: c.modules.selfSpins.enabled, self_spins_opts: Object.assign({}, c.modules.selfSpins.opts),
      },
      multigroove: { enabled: c.modules.multigroove.enabled, left_bound: c.modules.multigroove.left, right_bound: c.modules.multigroove.right, space_cars: c.modules.multigroove.spaceCars },
    };
    if (this.lines) {
      preset.lap_lines = {};
      for (const n of ['race', 'minrace', 'maxrace']) {
        const line = this.lines[n], rec = line && line.rec;
        if (line && rec && rec.length === line.count * 7) preset.lap_lines[n] = { count: line.count, length: line.len, data: Buffer.from(rec.buffer, rec.byteOffset, rec.byteLength).toString('base64') };
      }
      if (!Object.keys(preset.lap_lines).length) delete preset.lap_lines;
    }
    const id = this.presets.saveNew(name, preset);
    this.log(`saved user preset "${name}"`);
    return id;
  }
  iniList() { return this.attached ? this.inif.list().map(r => ({ name: r.name, confirmed: r.confirmed, value: r.value, base: r.base, override: this.cfg().ini[r.name] })) : require('./inifiles').PARAMS.map(p => ({ name: p.name, confirmed: !!p.confirmed, override: this.cfg().ini[p.name] })); }

  async saveRaceFile(dialog, deepCopy = true) {
    if (!dialog) return false;
    const r = await dialog.showSaveDialog({ title: 'Save AI Enhanced race triggers', defaultPath: path.join(this.trackDir || this.opts.userData, 'race.nrrace'), filters: [{ name: 'AI Enhanced race file', extensions: ['nrrace', 'json'] }] });
    if (r.canceled || !r.filePath) return false;
    const items = this.cfg().triggers.items.map(t => ({ ...t, presetIds: [...(t.presetIds || [])] }));
    if (deepCopy) for (const t of items) if (t.randomPreset && t.folderPath && !t.presetIds.length) {
      const folder = path.resolve(t.folderPath);
      if (this.randomTriggerFolders.has(folder)) t.presetIds = this.randomTriggerFolders.get(folder).slice();
      else {
        const ids = [];
        try { for (const f of fs.readdirSync(folder).filter(n => /\.(nrpreset|json)$/i.test(n)).sort()) {
          try { const raw = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) ids.push(this.presets.saveNew(path.basename(f).replace(/\.(nrpreset|json)$/i, ''), raw)); } catch (e) { /* omit invalid files */ }
        } } catch (e) { this.log(`could not embed random preset folder: ${e.message}`); }
        this.randomTriggerFolders.set(folder, ids); t.presetIds = ids;
      }
    }
    const out = LapTriggers.toRaceFile(items, this.presets, !!deepCopy);
    fs.writeFileSync(r.filePath, JSON.stringify(out, null, 2), 'utf8');
    return { ok: true, file: r.filePath };
  }

  async chooseTriggerFolder(dialog) {
    if (!dialog) return '';
    const r = await dialog.showOpenDialog({ title: 'Choose a folder of AI Enhanced presets', properties: ['openDirectory'] });
    return !r.canceled && r.filePaths[0] ? r.filePaths[0] : '';
  }

  async loadRaceFile(dialog) {
    if (!dialog) return null;
    const r = await dialog.showOpenDialog({ title: 'Load AI Enhanced race triggers', filters: [{ name: 'AI Enhanced race file', extensions: ['nrrace', 'json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')), raceDir = path.dirname(r.filePaths[0]);
    const items = LapTriggers.fromRaceFile(parsed, this.presets, (preset, name) => this.presets.saveNew(name, preset), (ref, isFolder) => {
      const resolved = path.isAbsolute(ref) ? ref : path.resolve(raceDir, ref);
      if (isFolder) return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : '';
      return fs.existsSync(resolved) ? this.presets.importFile(resolved) : '';
    });
    const c = this.cfg(); c.triggers.items = items; this.opts.getConfig().aie = c; this.opts.saveConfig();
    return this.getState();
  }

  registerIpc({ ipcMain, dialog }) {
    ipcMain.handle('aie:get-state', () => this.getState());
    ipcMain.handle('aie:set-config', (e, patch) => { this.setConfig(patch); return this.getState(); });
    ipcMain.handle('aie:presets', () => this.listPresets());
    ipcMain.handle('aie:save-preset', (e, name) => this.savePreset(name));
    ipcMain.handle('aie:restore-builtins', () => this.presets.restoreBuiltins());
    ipcMain.handle('aie:triggers-save', async (e, deep) => this.saveRaceFile(dialog, deep));
    ipcMain.handle('aie:triggers-load', async () => this.loadRaceFile(dialog));
    ipcMain.handle('aie:triggers-folder', async () => this.chooseTriggerFolder(dialog));
    ipcMain.handle('aie:editor-state', () => this.getEditorState());
    ipcMain.handle('aie:editor-apply', (e, edit) => this.applyEditor(edit));
    ipcMain.handle('aie:editor-rubber', () => this.getEditorRubber());
    ipcMain.handle('aie:editor-load-line', async (e, name) => this.importEditorLine(dialog, name));
    ipcMain.handle('aie:editor-save-line', async (e, name) => this.exportEditorLine(dialog, name));
    ipcMain.handle('aie:ini-list', () => this.iniList());
    ipcMain.handle('aie:apply-preset', (e, id) => this.applyPreset(id, 'chosen'));
    ipcMain.handle('aie:set-track-preset', (e, track, id) => this.setTrackPreset(track, id));
    ipcMain.handle('aie:roll', () => { this.roll('re-roll'); return this.getState(); });
    ipcMain.handle('aie:clean-rubber', () => { this.env.clearRubber(); this.log('rubber cleared from the track'); return true; });
    ipcMain.handle('aie:import-preset', async () => {
      if (!dialog) return null;
      const r = await dialog.showOpenDialog({ title: 'Import an AI Enhanced preset', filters: [{ name: 'AI Enhanced presets', extensions: ['nrpreset', 'json'] }], properties: ['openFile', 'multiSelect'] });
      if (r.canceled) return [];
      const ids = [];
      for (const f of r.filePaths) { try { ids.push(this.presets.importFile(f)); } catch (e) { this.log(`could not import ${f}: ${e.message}`); } }
      return ids;
    });
  }
}

module.exports = { AiEnhancedService, DEFAULTS, A };
