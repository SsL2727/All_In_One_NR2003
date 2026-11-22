// AimodService — AIMOD v2.2.0 beta's pit strategy, crew chief brain and driver behavior running inside All In One NR2003.
//
// AIMOD's own modules (game memory layer, strategy engine, tire model, pit log, presets, wave log, pit crew) are loaded from
// app/aimod/bundle and run by All In One NR2003's Python VM (app/pyvm); app/aimod/glue/headless.py replaces AIMOD's tkinter window.
// Parity with CPython is checked by tools/aimod/*_compare.js (tests/pyvm.test.js).
//
// Off by default and in read-only test mode by default: the strategy runs against a shadow of NR2003's memory and nothing is
// written to the game until the user turns "Read-only test mode" off — same as the built-in RaceControl.
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const gameExe = require('../gameexe');   // the game's process names (RaceLab's builds too)
const { pathToFileURL } = require('url');
const { Win32Memory, ShadowMemory } = require('../ai/memory');
const { breakpointsFromConfig } = require('../stagebridge');
const { journal } = require('../crashjournal');

const TICK_MS = 150;                 // AIMOD's own tick
const BUNDLE = path.join(__dirname, 'bundle');
const LOG_TAIL = 80;
const PIT_PARKED_S = 60;             // a car on pit road longer than this (parked, wrecked) comes off the pit board
const BUNDLED_ART = ['AIMOD_v2.2.0-beta1', 'AIMOD_v2.1.0_beta1'].map(d => path.join(__dirname, '..', 'beta', 'aimod', d, 'art'));
// config.aimod key -> AIMOD glue setting (booleans, forwarded on start and on change)
const SETTING_KEYS = [['crewBrain', 'crew_brain'], ['forceStrategyOptions', 'force_22_options'], ['autoTeamsAllTracks', 'auto_teams_all_tracks'],
  ['ssShortPitRelax', 'ss_short_pit_relax'], ['keepCarZero', 'keep_car_zero'], ['crewBeta', 'crew_beta'], ['pitGate', 'pit_gate']];

const DEFAULTS = {
  enabled: false,
  dryRun: true,                      // read-only test mode
  // AIMOD's own patches (no game-planned stops, no 'car condition' stops, repairs on caution stops); legacy_pit_takeover is 2.1's AI pit
  // takeover (0x5201CA), kept on as All In One NR2003's default
  patches: ['legacy_pit_takeover', 'no_game_plan_stops', 'no_game_condition_stops', 'caution_repairs'],
  pitGate: true,                     // AIMOD (Nov 2026): in a race only AIMOD sends AI cars to pit road (a code hook at 0x52A1B0, memory only)
  crewBrain: true,                   // AIMOD 2.2 crew chief strategy brain (caution calls, pit window / era style bias)
  waveEra: 'auto',                   // crew chief's lapped-car calls: 'auto' (RaceControl's wave-around, else the stages), 'modern', 'classic'
  forceStrategyOptions: true,        // AIMOD 2.2 always plans with its 8 core strategy options on; off = the preset's own checkboxes
  autoTeamsAllTracks: false,         // live .car teams at every track (off = only Daytona/Talladega, as before)
  ssShortPitRelax: false,            // with the brain on, short-pit cars skip the superspeedway 15 % fuel hold
  keepCarZero: true,                 // a named car #0 stays in AIMOD (2.2's ghost-car fix only drops the blank slot)
  crewBeta: false,                   // AIMOD 2.2 beta: crew chief on phones (AIMOD's /crew/ API on 127.0.0.1:crewPort)
  crewPort: 8767,
  pitBoardArt: true,                 // pit board numbers / headshots / colours / series logo from AIMOD's art folder
  restoreOnExit: true,
  showPitBoard: true,                // AIMOD's pit board drawn over the game / as a web page (cars on pit road, stops just done, who stayed out)
  pitBoardHold: 12,                  // seconds a finished stop stays on the board
  pitBoardPos: '',                   // "x, y, scale" in 1080-high units
  secondStops: false,                // let a car that pitted under a caution come back in "to top off" (AIMOD's own behaviour; off = one stop per caution)
  modernSuperspeedway: true,          // use live car-file teams and team/OEM strategy at Daytona and Talladega
  imported: false,                   // presets / learned data copied from a standalone AIMOD folder
};
const REMOVED_PATCHES = ['pit_takeover', 'pit_takeover_extra', 'no_game_repair_stops'];   // gone from AIMOD 2.2's memory_map.PATCHES
const RENAMED_PATCHES = { pit_takeover: 'legacy_pit_takeover' };

// config.aimod.patches from All In One NR2003 <= AIMOD 2.1: 2.2 raises KeyError on a removed patch (and then applies none), so they are dropped;
// the old AI pit takeover carries on as legacy_pit_takeover. once = also add no_game_plan_stops (2.2's own one-time "patches_v37" rule)
function migratePatches(list, once) {
  const out = [];
  for (let k of Array.isArray(list) ? list : []) {
    k = RENAMED_PATCHES[k] || String(k);
    if (!REMOVED_PATCHES.includes(k) && !out.includes(k)) out.push(k);
  }
  if (once && !out.includes('no_game_plan_stops')) out.push('no_game_plan_stops');
  return out;
}

// pyvm value -> plain JSON-able
function makePlain(C) {
  const plain = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(plain);
    if (v instanceof C.PyTuple) return v.a.map(plain);
    if (v instanceof C.PyDict) { const o = {}; for (const [, [k, x]] of v.m) o[k instanceof C.PyObject && k.num !== undefined ? String(k.num) : String(k)] = plain(x); return o; }   // CarNo keys: the raw number
    if (v instanceof C.PyObject) { if (v.num !== undefined) return v.num; const o = {}; for (const [k, x] of v.d) if (!k.startsWith('_')) o[k] = plain(x); return o; }
    if (v instanceof C.PySet) return Array.from(v.m.values()).map(plain);
    return String(v);
  };
  return plain;
}

// The Python VM and AIMOD's modules are process-wide (modules keep their imports), so the memory natives always
// resolve to whichever service is active. A running app has exactly one.
let active = null;
let nativesApi = null;

class AimodService {
  // opts: { userData, getConfig, saveConfig, log, memory? (tests), externalRunning? () => bool, rcLogFile?, importDir? () => string }
  constructor(opts) {
    this.opts = opts;
    this.baseDir = path.join(opts.userData, 'aimod');
    this.shadow = new ShadowMemory(opts.memory || new Win32Memory(() => this._exeName(), () => this._exePath()));
    this.shadow.passthrough = this.cfg().dryRun === false;
    this.shadow.tag = 'AIMOD';
    this.py = null; this.h = null; this.plain = null;
    this.timer = null; this.attached = false; this.note = ''; this.error = '';
    this.status = {}; this.rows = []; this.events = []; this.logTail = [];
    this._fullAt = 0; this._boardAt = 0; this._teamSyncAt = 0; this.boardNow = null; this._errAt = 0;
    this._waveLogPath = opts.rcLogFile || '';
  }

  _exePath() { return this.opts.getConfig().nr2003_exe || ''; }
  _exeName() { return gameExe.names(this.opts.getConfig()); }

  cfg() {
    const c = this.opts.getConfig();
    const had = c.aimod;
    c.aimod = Object.assign({}, DEFAULTS, c.aimod || {});
    if (!c.aimod.patchesV22) {                         // once: settings saved by the AIMOD 2.1 port
      c.aimod.patches = migratePatches(had && had.patches !== undefined ? had.patches : DEFAULTS.patches, true);
      c.aimod.patchesV22 = true;
      try { this.opts.saveConfig(); } catch (e) { /* saved with the next change */ }
    }
    // AIMOD (Nov 2026)'s own one-time rules: 'car condition' stops off and the pit gate on (patches_v38), repairs on caution stops (patches_v39)
    if (!c.aimod.patchesV38 || !c.aimod.patchesV39) {
      const p = Array.isArray(c.aimod.patches) ? c.aimod.patches.slice() : [];
      if (!c.aimod.patchesV38) { if (!p.includes('no_game_condition_stops')) p.push('no_game_condition_stops'); c.aimod.pitGate = true; c.aimod.patchesV38 = true; }
      if (!c.aimod.patchesV39) { if (!p.includes('caution_repairs')) p.push('caution_repairs'); c.aimod.patchesV39 = true; }
      c.aimod.patches = p;
      try { this.opts.saveConfig(); } catch (e) { /* saved with the next change */ }
    }
    return c.aimod;
  }

  setConfig(patch) {
    const c = this.opts.getConfig();
    patch = Object.assign({}, patch || {});
    if ('patches' in patch) patch.patches = migratePatches(patch.patches, false);
    c.aimod = Object.assign(this.cfg(), patch);
    this.opts.saveConfig();
    if ('enabled' in patch || 'dryRun' in patch) {
      this._release();
      if ('dryRun' in patch) { this.shadow.clear(); this.shadow.passthrough = c.aimod.dryRun === false; }
    } else if (this.h && 'patches' in patch) this._call('set_setting', ['patches', patch.patches]);
    if (this.h && 'restoreOnExit' in patch) this._call('set_setting', ['restore_on_exit', !!patch.restoreOnExit]);
    if (this.h && 'secondStops' in patch) this._call('set_setting', ['second_stops', !!patch.secondStops]);
    if (this.h && 'modernSuperspeedway' in patch) this._call('set_modern_superspeedway', [patch.modernSuperspeedway !== false]);
    for (const [k, key] of SETTING_KEYS) if (this.h && k in patch) this._call('set_setting', [key, !!patch[k]]);
    if (this.h && 'waveEra' in patch) { this._eraKey = undefined; this._syncEra(); }
    if ('crewBeta' in patch || 'crewPort' in patch || 'enabled' in patch) this._syncCrewServer();
    if (this.h && 'pitBoardArt' in patch) this._call('set_art_roots', [c.aimod.pitBoardArt === false ? [] : this._artRoots()]);
    return c.aimod;
  }

  log(msg) {
    this.logTail.push(msg);
    if (this.logTail.length > LOG_TAIL) this.logTail.shift();
    journal.text('AIMOD', msg);
    if (this.opts.log) this.opts.log('[aimod] ' + msg);
  }

  // ── Python side ─────────────────────────────────────────────────────────────────────────────────────
  _ensureVm() {
    if (this.py) return this.py;
    const py = require('../pyvm');
    const natives = require('./natives');
    const codes = {};
    for (const f of fs.readdirSync(BUNDLE)) if (f.endsWith('.bin')) codes[f.slice(0, -4)] = fs.readFileSync(path.join(BUNDLE, f));
    py.registerBundle(codes);
    py.vm.logSink = (lvl, name, msg) => { if (lvl !== 'DEBUG') this.log(msg); };
    if (!nativesApi) {
      nativesApi = natives.install(() => active && active.shadow);
      nativesApi.setAlive(() => !!(active && active.shadow.isAlive()));
    }
    this.plain = makePlain(py.C);
    this.py = py;
    return py;
  }

  _toPy(v) {
    const { C } = this.py;
    if (Array.isArray(v)) return v.map(x => this._toPy(x));
    if (v && typeof v === 'object') { const d = new C.PyDict(); for (const [k, x] of Object.entries(v)) C.dictSet(d, k, this._toPy(x)); return d; }
    return v === undefined ? null : v;
  }

  _call(method, args) {
    const { A } = this.py;
    return A.call(A.getattr(this.h, method), (args || []).map(x => this._toPy(x)), null);
  }

  _headless() {
    if (this.h) return this.h;
    const py = this._ensureVm();
    active = this;
    fs.mkdirSync(this.baseDir, { recursive: true });
    this._maybeImport();
    const H = py.importModule('aimod.headless');
    const cfg = this.cfg();
    const settings = { patches: cfg.patches, restore_on_exit: cfg.restoreOnExit !== false, second_stops: !!cfg.secondStops,
      modern_superspeedway: cfg.modernSuperspeedway !== false, enabled: true };
    for (const [k, key] of SETTING_KEYS) settings[key] = cfg[k] === undefined ? !!DEFAULTS[k] : !!cfg[k];
    this.h = py.A.callType(py.A.getattr(H, 'Headless'), [this.baseDir, this._waveLogPath || null, this._toPy(settings)], null);
    this._eraKey = undefined;
    this._call('set_art_roots', [cfg.pitBoardArt === false ? [] : this._artRoots()]);
    if (this._seasonRivals !== undefined) this._call('set_season_rivals', [this._seasonRivals]);
    this.log('AIMOD pit strategy started' + (this.shadow.passthrough ? '' : ' — read-only test mode'));
    return this.h;
  }

  _syncWaveLog() {
    let next = this._waveLogPath;
    try { if (this.opts.getRcLogFile) next = this.opts.getRcLogFile() || next; } catch (e) { /* keep current source */ }
    if (!next || next === this._waveLogPath) return;
    this._waveLogPath = next;
    if (this.h) this._call('set_wave_log', [next]);
  }

  // AIMOD's art folders (art/series/<series>/numbers, headshots, colors.json; art/logos): the standalone folder it was imported from, the bundled 2.2 / 2.1 betas
  _artRoots() {
    const out = [];
    let dir = '';
    try { dir = this.opts.importDir ? this.opts.importDir() : ''; } catch (e) { dir = ''; }
    for (const d of [dir && path.join(dir, 'art'), ...BUNDLED_ART]) if (d && !out.includes(d) && fs.existsSync(path.join(d, 'series'))) out.push(d);
    return out;
  }

  // a pit board art path (relative to an art root) as a file URL for the graphics window
  _artUrl(rel) {
    if (!rel || typeof rel !== 'string' || rel.includes('..')) return null;
    const cache = this._artCache || (this._artCache = new Map());
    if (cache.has(rel)) return cache.get(rel);
    let url = null;
    for (const r of this._artRoots()) { const f = path.join(r, rel); if (fs.existsSync(f)) { url = pathToFileURL(f).href; break; } }
    if (cache.size > 500) cache.clear();
    cache.set(rel, url);
    return url;
  }

  // crew chief brain wave-around era: 'modern' / 'classic', or auto = the built-in RaceControl's WaveAround when it runs, else 2.2's own (stages)
  _waveEra() {
    const mode = this.cfg().waveEra || 'auto';
    if (mode === 'modern') return true;
    if (mode === 'classic') return false;
    const rc = this.opts.getConfig().raceControl;
    return rc && rc.enabled ? rc.WaveAround !== false : null;
  }

  _syncEra() {
    if (!this.h) return;
    const era = this._waveEra();
    if (era === this._eraKey) return;
    this._eraKey = era;
    this._call('set_wave_era', [era]);
  }

  // AIMOD 2.2 beta "crew chief on phones": the standalone app serves humancalls.Desk + crewview on 127.0.0.1 (/crew.json, /crew/<call>?...)
  // for a companion app; All In One NR2003 serves the same API from its built-in AIMOD while the crew beta is switched on
  _syncCrewServer() {
    const cfg = this.cfg();
    const want = cfg.enabled && cfg.crewBeta && this.timer && !this._external ? Math.max(1024, Number(cfg.crewPort) | 0 || 8767) : 0;
    if (this.crewServer && this.crewServer.port === want) return;
    if (this.crewServer) { try { this.crewServer.srv.close(); } catch (e) { /* ignore */ } this.crewServer = null; }
    if (!want) return;
    const srv = http.createServer((req, res) => this._crewHandle(req, res));
    srv.on('error', (e) => { this.log(`crew chief server could not start on port ${want} (is AIMOD.exe running?): ${e && e.message || e}`); if (this.crewServer && this.crewServer.srv === srv) this.crewServer = null; });
    srv.listen(want, '127.0.0.1', () => this.log(`crew chief on phones: AIMOD crew API on http://127.0.0.1:${want}/crew.json`));
    this.crewServer = { srv, port: want };
  }

  _crewHandle(req, res) {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(body); };
    const local = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(String(req.socket && req.socket.remoteAddress || ''));
    if (!local || !this.h || !this.cfg().crewBeta) return send(404, '{}');
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname.replace(/\/+$/, '');
    try {
      if (p === '/crew.json') return send(200, JSON.stringify(this.plain(this._call('crew_json')) || {}));
      if (p === '/pits') return send(200, JSON.stringify(this.boardNow || {}));
      if (p.startsWith('/crew/')) {
        const q = {};
        for (const [k, v] of u.searchParams) if (!(k in q)) q[k] = v;
        return send(200, JSON.stringify(this.crewCall(p.slice(6), q)));
      }
    } catch (e) { return send(500, JSON.stringify({ ok: false, error: String(e && e.message || e) })); }
    return send(404, '{}');
  }

  // one /crew/<what> call (claim, ping, release, plan, adjust, call) on AIMOD's Desk
  crewCall(what, q) {
    if (!this.h || !this.cfg().crewBeta) return { ok: false, error: 'crew chief beta is off' };
    return this.plain(this._call('crew_call', [String(what || ''), q || {}]));
  }

  // leave the game as we found it (patches restored, normal pit crew) and forget the instance
  _release() {
    if (this.h) {
      try { this._call('shutdown'); } catch (e) { this.log('shutdown: ' + (e && e.message || e)); }
      this.h = null;
    }
    this.attached = false; this.status = {}; this.rows = []; this.events = []; this.boardNow = null;
  }

  // bring presets and learned data over from a standalone AIMOD folder, once
  _maybeImport() {
    const cfg = this.cfg();
    if (cfg.imported) return;
    let dir = '';
    try { dir = this.opts.importDir ? this.opts.importDir() : ''; } catch (e) { dir = ''; }
    cfg.imported = true; this.opts.saveConfig();
    if (!dir || !fs.existsSync(dir)) return;
    try {
      const copyIfMissing = (from, to) => { if (fs.existsSync(from) && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); return true; } return false; };
      let n = 0;
      const pdir = path.join(dir, 'presets');
      if (fs.existsSync(pdir)) for (const f of fs.readdirSync(pdir)) if (copyIfMissing(path.join(pdir, f), path.join(this.baseDir, 'presets', f))) n++;
      copyIfMissing(path.join(dir, 'tire_models.json'), path.join(this.baseDir, 'tire_models.json'));
      const sp = path.join(dir, 'settings.json'), dst = path.join(this.baseDir, 'settings.json');
      if (fs.existsSync(sp) && !fs.existsSync(dst)) {
        const src = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const keep = {};
        for (const k of ['tank_by_track', 'teams_by_mod', 'team_rules_by_mod', 'make_names', 'make_names_by_series', 'pit_crew_by_mod', 'last_preset']) if (src[k] !== undefined) keep[k] = src[k];
        fs.writeFileSync(dst, JSON.stringify(keep, null, 4));
      }
      this.log(`imported ${n} preset(s) and learned data from ${dir}`);
    } catch (e) { this.log('import from the standalone AIMOD folder failed: ' + (e && e.message || e)); }
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────────────────────────────
  start() { this.timer = setInterval(() => this._tick(), TICK_MS); this._syncCrewServer(); }
  stop() { clearInterval(this.timer); this.timer = null; this._syncCrewServer(); this._release(); try { this.shadow.detach(); } catch (e) { /* ignore */ } }

  _tick() {
    try { this._tickInner(); this.error = ''; }
    catch (e) {
      this.error = String(e && (e.exc ? this.py.str(e.exc) : e.message) || e);
      const now = Date.now();
      if (now - this._errAt > 60000) { this._errAt = now; this.log('error: ' + this.error + (e && e.tb ? ' @ ' + e.tb.slice(0, 4).join(' < ') : '')); }
    }
  }

  _tickInner() {
    const cfg = this.cfg();
    if (!cfg.enabled) { if (this.h) { this._release(); this.shadow.detach(); } this.note = ''; this._syncCrewServer(); return; }
    if (this.opts.externalRunning && this.opts.externalRunning()) {
      this.note = 'AIMOD.exe is running — close it, All In One NR2003\'s built-in AIMOD would fight it';
      if (this.h) this._release();
      this._external = true; this._syncCrewServer();       // its own server owns the crew port
      return;
    }
    this.note = '';
    this._external = false; this._syncCrewServer();
    this._syncWaveLog();
    const h = this._headless();
    // RaceLab's allies / rivals run in the game: AIMOD's racing intensity & rivals stand aside (the pit strategy keeps running)
    let rl = false;
    try { rl = !!(this.opts.raceLabOwns && this.opts.raceLabOwns()); } catch (e) { rl = false; }
    if (rl !== this._rlAgg) { try { this._call('set_external_off', [rl]); this._rlAgg = rl; } catch (e) { /* the next tick */ } }
    if (rl) this.note = 'RaceLab runs its own allies and rivals in the game: racing intensity & rivals stand aside (pit strategy keeps running).';
    this._syncStages();
    this._syncEra();
    if (this.h) {
      let laneState = null;
      try { laneState = this.opts.getPitLaneState ? this.opts.getPitLaneState() : null; } catch (e) { laneState = null; }
      this._call('set_pit_lane_state', [laneState]);
      const now = Date.now();
      if (now - this._teamSyncAt >= 2000) {
        this._teamSyncAt = now;
        try {
          const rows = this.opts.getTeamRows ? this.opts.getTeamRows() : [];
          const groups = new Map();
          for (const row of rows || []) {
            if (!Number.isInteger(Number(row && row.slot)) || Number(row.slot) < 0 || Number(row.slot) >= 43) continue;
            const name = String(row && row.team || '').trim();
            const number = String(row && row.number || '').trim();
            if (!name || !/^\d+$/.test(number)) continue;
            const key = name.toLowerCase();
            if (!groups.has(key)) groups.set(key, { name, cars: new Set() });
            groups.get(key).cars.add(number);
          }
          const teams = Array.from(groups.values()).filter(t => t.cars.size > 1)
            .map(t => ({ name: t.name, cars: Array.from(t.cars) }));
          this._call('set_automatic_teams', [teams]);
        } catch (e) { /* team metadata is optional */ }
      }
    }
    const st = this.plain(this.py.A.call(this.py.A.getattr(h, 'tick'), [], null));
    if (this.attached && !st.attached) journal.gameGone('AIMOD');
    this.status = st; this.attached = !!st.attached;
    if (this.attached) {
      this.rows = this.plain(this._call('rows')).map(slimRow);
      const now = Date.now();
      if (now - this._fullAt > 2000) { this._fullAt = now; this.events = this.plain(this._call('recent_events', [40])).map(slimEvent); }
      if (cfg.showPitBoard !== false && now - this._boardAt >= 400) {
        this._boardAt = now;
        try { this.boardNow = this.plain(this._call('pit_board', [Number(cfg.pitBoardHold) > 0 ? Number(cfg.pitBoardHold) : 12])); } catch (e) { this.boardNow = null; }
      }
      // AIMOD's rivals card (racing intensity & rivals): the car on TV racing his rival close by
      // while RaceLab runs its allies / rivals, the card shows RaceLab's rival (else trusted ally) with AIMOD's card settings and car art
      if (rl && this.opts.raceLabCard) this.rivalNow = this._raceLabCard();
      else { try { this.rivalNow = this.plain(this._call('rival_onscreen')); } catch (e) { this.rivalNow = null; } }
    } else { this.rows = []; this.boardNow = null; this.rivalNow = null; }
    this._speech();
  }

  // the scanner radio / crew chief calls AIMOD's radio decided on this tick, for All In One NR2003's voice window to speak
  _speech() {
    if (!this.h || !this.opts.onSpeech) return;
    try {
      const out = this.plain(this._call('radio_drain'));
      if (out && out.length) this.opts.onSpeech(out);
    } catch (e) { /* the radio is optional */ }
  }

  // Share AIMOD's live pit plan with AI Enhanced so it can stage planned stops at the two superspeedways.
  getPitLanePlan() {
    const cfg = this.cfg();
    const track = String(this.status && this.status.track || '');
    const isDraftTrack = /daytona|talladega/i.test(track) && !/(road|roval|_rc\b|\brc\b)/i.test(track);
    let external = false;
    try { external = !!(this.opts.externalRunning && this.opts.externalRunning()); } catch (e) { external = true; }
    const active = !!(cfg.enabled && cfg.dryRun === false && this.shadow.passthrough && this.attached &&
      this.status && this.status.attached && isDraftTrack && !external);
    const cars = [];
    if (active) for (const row of this.rows) {
      const match = /^\s*LAP\s+(\d+)\b/i.exec(String(row && row.next_pit || ''));
      const idx = Number(row && row.idx), lap = Number(row && row.lap);
      if (!match || !Number.isInteger(idx) || !Number.isFinite(lap)) continue;
      const plannedLap = Number(match[1]);
      cars.push({ idx, lap, plannedLap, lapsToPit: plannedLap - lap });
    }
    return { active, track, cars };
  }

  // everything AIMOD draws over the game (the graphics window): the pit board and the rivals card; null = nothing
  // AIMOD 2.2's subtitle box: a line the radio's gate let through, said now by the voice window (number card, who speaks, what is said).
  // It stays up while said, at least MIN_READ_S + READ_PER_CHAR per letter, and LINGER after the voice stops (subtitle_overlay.py).
  setSubtitle(info) {
    if (!info || !info.text) return;
    const now = Date.now(), text = String(info.text), read = Math.max(2.2, text.length * 0.06) * 1000;
    const until = Math.max(info.end ? info.end + 900 : now + 60000, (info.start || now) + read);
    let art = { img: null, color: null };
    if (this.h && info.number != null) { try { art = this.plain(this._call('car_art', [info.number])) || art; } catch (e) { /* no art */ } }
    this.subNow = { number: info.number == null ? null : String(info.number), title: String(info.title || ''), text, until, img: this._artUrl(art.img), color: art.color || null };
  }
  _subtitleNow() {
    const s = this.subNow;
    if (!s || Date.now() > s.until) return null;
    const cfg = (this.radioConfig().subtitles) || {};
    if (!cfg.on) return null;
    return { sub: Object.assign({}, s, { opacity: cfg.opacity != null ? cfg.opacity : 0.95 }), subPos: [cfg.x != null ? cfg.x : 270, cfg.y != null ? cfg.y : 860, cfg.size || 1].join(', ') };
  }
  gfxExtra() {
    const b = this.pitBoardData();
    const r = this.rivalNow;
    const riv = r && (!r.cfg || r.cfg.on !== false) ? Object.assign({}, r, { car_img: this._artUrl(r.car_img), rival_img: this._artUrl(r.rival_img) }) : null;
    let sub = null;
    try { sub = this._subtitleNow(); } catch (e) { sub = null; }
    if (!b && !riv && !sub) return null;
    const cfg = (r && r.cfg) || {};
    return Object.assign({}, b || {}, riv ? { riv, rivPos: [cfg.x != null ? cfg.x : 40, cfg.y != null ? cfg.y : 160, cfg.size || 1].join(', ') } : {}, sub || {});
  }
  // RaceLab's card ({ car, rival, kind, level } from opts.raceLabCard) in AIMOD's rival_onscreen form: the card settings and each car's art
  _raceLabCard() {
    let c = null;
    try { c = this.opts.raceLabCard(); } catch (e) { c = null; }
    if (!c) return null;
    const now = Date.now();
    if (!this._rivCfg || now - this._rivCfgAt > 5000) { try { this._rivCfg = (this.rivalsState() || {}).indicator || {}; } catch (e) { this._rivCfg = this._rivCfg || {}; } this._rivCfgAt = now; }
    const out = Object.assign({}, c, { cfg: Object.assign({}, this._rivCfg) });
    if (!this._artCache || now - this._artCacheAt > 60000) { this._artCache = new Map(); this._artCacheAt = now; }
    for (const k of ['car', 'rival']) {
      let art = this._artCache.get(String(c[k]));
      if (art === undefined) { try { art = this.plain(this._call('car_art', [Number(c[k])])); } catch (e) { art = null; } this._artCache.set(String(c[k]), art); }
      out[k + '_img'] = art ? art.img || null : null; out[k + '_color'] = art ? art.color || null : null;
    }
    return out;
  }
  // season mode: the season's rivalries for a counted race (null = none), and the feuds of the race that just ended
  setSeasonRivals(list) {
    this._seasonRivals = Array.isArray(list) ? list.map(r => ({ a: Number(r.a), b: Number(r.b), level: Number(r.level) || 0, holder: r.holder == null ? null : Number(r.holder) })) : null;
    if (this.h) { try { this._call('set_season_rivals', [this._seasonRivals]); } catch (e) { this.log('season rivals: ' + e.message); } }
    return true;
  }
  raceRivals() { if (!this.h) return []; try { return this.plain(this._call('race_rivals')); } catch (e) { return []; } }
  // this race's feuds for the TV director (cached 2 s): [{ a, b, level, holder }]
  feudsNow() {
    const now = Date.now();
    if (this._feudsAt && now - this._feudsAt < 2000) return this._feuds || [];
    this._feudsAt = now;
    this._feuds = this.attached ? this.raceRivals().filter(f => f.level > 0) : [];
    return this._feuds;
  }
  // AIMOD's rivals list (per mod), the feuds of this race and the rivals card settings
  rivalsState() { return this.h ? this.plain(this._call('rivals_state')) : null; }
  setRivals(pairs) { return this.h ? this.plain(this._call('set_rivals', [Array.isArray(pairs) ? pairs.map(p => [Number(p[0]), Number(p[1])]) : []])) : null; }
  setRivalIndicator(patch) { return this.h ? this.plain(this._call('set_rival_indicator', [patch || {}])) : null; }

  // AIMOD's pit board for the graphics window and the web page: { pit, pos } or null while there is nothing on it
  pitBoardData() {
    const c = this.cfg();
    const b = withArt(this, this._dropParked(this.boardNow));
    if (!b || c.showPitBoard === false || !(b.stops && b.stops.length || b.coming_in && b.coming_in.length || b.stayed_out && b.stayed_out.length)) return null;
    return { pit: b, pos: c.pitBoardPos || '' };
  }

  // a car on pit road for more than PIT_PARKED_S (wrecked, parked in its stall, behind the wall) comes off the board; counted from when the
  // board first showed it on pit road, or AIMOD's own pit-road time if that is longer
  _dropParked(b) {
    if (!b || !Array.isArray(b.stops)) return b;
    const now = Date.now(), since = this._roadSince || (this._roadSince = new Map()), seen = new Set();
    const stops = b.stops.filter((s) => {
      if (s.state !== 'road') return true;
      const k = String(s.number);
      seen.add(k);
      if (!since.has(k)) since.set(k, now);
      const secs = Math.max((now - since.get(k)) / 1000, Number(s.road) || 0);
      return secs <= PIT_PARKED_S;
    });
    for (const k of [...since.keys()]) if (!seen.has(k)) since.delete(k);
    if (stops.length === b.stops.length) return b;
    const gone = b.stops.length - stops.length;
    return Object.assign({}, b, { stops, on_pit_road: Math.max(0, (Number(b.on_pit_road) || 0) - gone) });
  }

  // stages are set once, in All In One NR2003's Stage Racing window: AIMOD plans to those ends instead of the preset's
  // "Stages off" sends [] (no stage breaks, and the pre-stage era for AIMOD 2.2's crew chief); Stage Racing off sends null (the preset's stages)
  _syncStages() {
    const sr = this.opts.getConfig().stageRacing;
    const total = this.status && this.status.laps_total;
    let ends = null;
    if (sr && sr.enabled && sr.stagesOff) ends = [];
    else if (sr && sr.enabled && total > 0) { try { ends = breakpointsFromConfig(total, sr); if (this.opts.mapStageEnds) ends = this.opts.mapStageEnds(ends); } catch (e) { ends = null; } }
    const key = ends ? (ends.length ? ends.join(',') : 'off') : '';
    if (key === this._stageKey) return;
    this._stageKey = key;
    this._call('set_stage_ends', [ends]);
  }

  // ── UI API ──────────────────────────────────────────────────────────────────────────────────────────
  getState() {
    const c = this.cfg();
    return {
      config: c, enabled: c.enabled, dryRun: c.dryRun !== false, attached: this.attached, note: this.note, error: this.error,
      status: this.status, rows: this.rows, events: this.events, log: this.logTail.slice(-40),
      pendingWrites: { count: this.shadow.count },
    };
  }

  // parameters, presets and team data — fetched when the AIMOD page is open, not every tick
  getSetup() {
    if (!this.h) return { ready: false, params: null, presets: [], loaded: null };
    const p = this.plain;
    return {
      ready: true, params: p(this._call('params_dict')), presets: p(this._call('preset_names')), loaded: p(this._call('loaded_preset')),
      settings: p(this._call('public_settings')), learned: this.status.learned || null,
    };
  }

  setParams(values) { if (!this.h) return false; this._call('set_params', [values]); return true; }
  loadPreset(name) { return this.h ? !!this.plain(this._call('load_preset', [name])) : false; }
  savePreset(name) { if (!this.h) return false; this._call('save_preset', [name]); return true; }
  assignTrack(name) { if (!this.h) return false; this._call('assign_track', [name]); return true; }
  applyLearned() { if (!this.h) return false; this._call('apply_learned'); return true; }
  setSetting(key, value) { if (!this.h) return false; this._call('set_setting', [key, value]); return true; }
  setCrewModern(on) { if (!this.h) return false; this._call('set_crew_modern', [!!on]); return true; }
  clearSession() { if (!this.h) return false; this._call('clear_session', ['cleared by user']); return true; }
  // manufacturers & teams (AIMOD's Teams, Strategy rules and Name manufacturers dialogs) for the current series
  teamsState() { return this.h ? this.plain(this._call('teams_state')) : null; }
  setTeams(teams) { return this.h ? this.plain(this._call('set_teams', [Array.isArray(teams) ? teams : []])) : null; }
  setTeamRules(which, values) { return this.h ? this.plain(this._call('set_team_rules', [String(which), values || {}])) : null; }
  setMakeNames(names) {
    if (!this.h) return null;
    const list = (Array.isArray(names) ? names : []).map(x => String(x).trim()).filter(Boolean);
    if (list.length) this._call('set_setting', ['make_names', list]);
    return this.teamsState();
  }

  // the scanner radio (AIMOD 2.1 aimod.radio): its settings, and what it said lately
  radioState() {
    const h = this._headless();
    const p = this.plain;
    return { ready: !!h, options: p(this._call('radio_options')), config: p(this._call('radio_config')), lines: p(this._call('radio_lines', [60])) };
  }
  radioConfig() { return this.h ? this.plain(this._call('radio_config')) : {}; }
  radioHear(lines) { if (!this.h) return false; try { return !!this.plain(this._call('radio_hear', [lines])); } catch (e) { this.log('radio: ' + e.message); return false; } }
  setRadio(patch) {
    this._headless();
    const cfg = this.plain(this._call('set_radio', [patch || {}]));
    return cfg;
  }
  setGearbox(on, gears) { if (!this.h) return false; return this.plain(this._call('set_gearbox', [!!on, Number(gears) || 5])); }
  gearboxRestore() { if (!this.h) return false; return this.plain(this._call('gearbox_restore')); }
  radioTest() { this._headless(); this._call('radio_test'); this._speech(); return true; }

  registerIpc({ ipcMain }) {
    ipcMain.handle('aimod:get-state', () => this.getState());
    ipcMain.handle('aimod:get-setup', () => this.getSetup());
    ipcMain.handle('aimod:set-config', (e, patch) => { this.setConfig(patch); return this.getState(); });
    ipcMain.handle('aimod:set-params', (e, v) => this.setParams(v));
    ipcMain.handle('aimod:load-preset', (e, n) => this.loadPreset(n));
    ipcMain.handle('aimod:save-preset', (e, n) => this.savePreset(n));
    ipcMain.handle('aimod:assign-track', (e, n) => this.assignTrack(n));
    ipcMain.handle('aimod:apply-learned', () => this.applyLearned());
    ipcMain.handle('aimod:set-setting', (e, k, v) => this.setSetting(k, v));
    ipcMain.handle('aimod:set-crew-modern', (e, on) => this.setCrewModern(on));
    ipcMain.handle('aimod:clear-session', () => this.clearSession());
    ipcMain.handle('aimod:set-gearbox', (e, on, gears) => this.setGearbox(on, gears));
    ipcMain.handle('aimod:gearbox-restore', () => this.gearboxRestore());
    ipcMain.handle('aimod:radio-state', () => this.radioState());
    ipcMain.handle('aimod:radio-set', (e, patch) => this.setRadio(patch));
    ipcMain.handle('aimod:radio-test', () => this.radioTest());
    ipcMain.handle('aimod:radio-hear', (e, lines) => this.radioHear(lines));
    // AIMOD 2.2: the race results folder (an .html page and a .json per race)
    ipcMain.handle('aimod:open-results', async () => {
      let dir = '';
      try { dir = this.h ? String(this.plain(this._call('results_dir')) || '') : ''; } catch (e) { dir = ''; }
      if (!dir) return false;
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* exists */ }
      try { await require('electron').shell.openPath(dir); } catch (e) { return false; }
      return true;
    });
    ipcMain.handle('aimod:teams-state', () => this.teamsState());
    ipcMain.handle('aimod:set-teams', (e, t) => this.setTeams(t));
    ipcMain.handle('aimod:set-team-rules', (e, w, v) => this.setTeamRules(w, v));
    ipcMain.handle('aimod:set-make-names', (e, n) => this.setMakeNames(n));
    ipcMain.handle('aimod:rivals-state', () => this.rivalsState());
    ipcMain.handle('aimod:set-rivals', (e, p) => this.setRivals(p));
    ipcMain.handle('aimod:set-rival-indicator', (e, p) => this.setRivalIndicator(p));
  }
}

// AIMOD's board names art by path relative to its art folder; the graphics window gets file URLs (img_num / img_head / logo_url)
function withArt(svc, b) {
  if (!b || svc.cfg().pitBoardArt === false) return b;
  const add = (x) => (x && (x.number_img || x.headshot) ? Object.assign({}, x, { img_num: svc._artUrl(x.number_img), img_head: svc._artUrl(x.headshot) }) : x);
  const out = Object.assign({}, b);
  for (const k of ['stops', 'coming_in', 'stayed_out']) if (Array.isArray(b[k])) out[k] = b[k].map(add);
  if (b.logo) out.logo_url = svc._artUrl(b.logo);
  return out;
}

// the monitor columns All In One NR2003 shows (everything else on a CarRow stays inside AIMOD)
const ROW_KEYS = ['idx', 'pos', 'number', 'name', 'rating', 'out', 'lap', 'laps_down', 'gap', 'make', 'grip', 'wear_l', 'wear_r', 'prob_l', 'prob_r', 'damage', 'urgency', 'behavior',
  'fuel_state', 'fuel_laps', 'fuel_frac', 'fuel_real', 'green_laps', 'fuel_margin', 'pace_delta', 'falloff', 'tires_left', 'stops', 'last_pit', 'next_pit', 'status', 'kind',
  'black_flag', 'free_pass', 'waved', 'team', 'own_mileage', 'car_tank'];
function slimRow(r) { const o = {}; for (const k of ROW_KEYS) if (r && r[k] !== undefined) o[k] = r[k]; return o; }
const EVENT_KEYS = ['idx', 'number', 'name', 'lap', 'service', 'reason', 'green', 'stop_no', 'pos_in', 'pos_out', 'state', 'duration', 'box_time', 'road_time', 'note', 'fuel', 'caution_no', 'unrequested'];
function slimEvent(e) { const o = {}; for (const k of EVENT_KEYS) if (e && e[k] !== undefined) o[k] = e[k]; return o; }

module.exports = { AimodService, DEFAULTS, makePlain, migratePatches, REMOVED_PATCHES };
