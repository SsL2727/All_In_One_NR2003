// DirectorService — RaceVision's TV director built into All In One NR2003 (no RaceVision.exe).
//
// Reads the field from NR2003, decides who is on TV and which camera shows them (director.js) and drives the game's camera
// (camera.js, same hook RaceVision installs). Off by default; "Read-only test mode" shows what it would do without touching the game.
// Never runs next to RaceVision.exe (both would drive the camera).
'use strict';
const fs = require('fs');
const path = require('path');
const gameExe = require('../gameexe');   // the game's process names (RaceLab's builds too)
const { Win32Memory, ShadowMemory } = require('../ai/memory');
const { journal } = require('../crashjournal');
const { Camera } = require('./camera');
const { readField, rank } = require('./field');
const { Director } = require('./director');
const { TrackMap } = require('../racecontrol/trackmap');
const S = require('./settings');
const { Remote } = require('./remote');
const { Overlays } = require('./overlays');
const { ArtLibrary } = require('./art');
const { CameraLibrary } = require('./camlib');
const { CameraEffects } = require('./camera_effects');
const { TvCameras } = require('./tvcams');
const { Timeline } = require('./timeline');
const { CrashLog, ReplayController } = require('./replay');
const { Tape } = require('./tape');
const { DynCams } = require('./dyncam');
const { CameraSets } = require('./camsets');

const TICK_MS = 250;
const LOG_TAIL = 60;
const DEFAULTS = {
  enabled: false, dryRun: true,
  enabledCams: S.ALL_CAMS.filter(c => c !== 9),      // which cameras the director may use
  settings: {},                                      // overrides of settings.DEFAULTS (racevision.ini keys)
  favourites: '',                                    // car numbers the tour prefers
  startWithGame: true,
  remoteKey: '',                                     // pairing code in the phone link (made on first use)
};

class DirectorService {
  // opts: { getConfig, saveConfig, log, memory? (tests), externalRunning? () => bool, now? () => seconds }
  constructor(opts) {
    this.opts = opts;
    this.shadow = new ShadowMemory(opts.memory || new Win32Memory(() => this._exeName(), () => this._exePath()));
    this.shadow.passthrough = this.cfg().dryRun === false;
    this.shadow.tag = 'TV';
    this.now = opts.now || (() => Date.now() / 1000);
    this.cam = new Camera(this.shadow, (m) => this.log(m));
    this.lib = new CameraLibrary(this.shadow, () => this.cfg().settings, (m) => this.log(m));
    this.effects = new CameraEffects(this.shadow, (m) => this.log(m));
    this.tvcams = new TvCameras(this.shadow);
    this.timeline = new Timeline({ userData: opts.userData, dir: opts.timelineDir, tvcams: this.tvcams });
    this.crashes = new CrashLog(() => this.resolved(), { log: (m) => this.log(m), mem: this.shadow });
    this.replayState = { phase: 'idle', text: '' };
    this.replay = new ReplayController({ cam: this.cam, mem: this.shadow, S: () => this.resolved(), crashes: this.crashes, log: (m) => this.log(m), onState: (s) => { this.replayState = s; }, pauseDirector: () => {},
      wipe: opts.wipe ? (kind, sub) => this._wipe(kind, sub) : null });
    // the tape transport (RaceVision 1.2.0): NR2003's own replay controls for the app and the phone
    this.tape = new Tape({ mem: this.shadow, cam: this.cam, crashes: this.crashes, replay: this.replay, S: () => this.resolved(), log: (m) => this.log(m),
      ready: () => this._tapeReady(), focus: () => { const c = this.dir.cur; return c && c.slot >= 0 ? c.slot : this.cam.focusSlot(); },
      replayCam: () => this._replayCams(this.resolved().cam_replay)[0], wipe: opts.wipe ? (kind, sub) => this._wipe(kind, sub) : null });
    this._wipeBusy = 0; this._othersHidden = false; this._othersOffAt = 0;
    this._lastG = 0; this._wasInCar = false; this._qualWas = false;
    this.dir = new Director(this.resolved(), { favourites: () => this._favs(), rnd: opts.rnd, rivalOf: (a, b) => this._rivalOf(a, b) });
    this.timer = null; this.logTail = [];
    this.remote = new Remote(this, () => this._key());
    this.art = new ArtLibrary({ roots: () => [...(opts.seriesDirs ? opts.seriesDirs() : []), ...String(this.resolved().art_folders || '').split(';').map(x => x.trim()).filter(Boolean)] });
    this.ov = new Overlays(); this.overlay = { on: false }; this.crowdSeen = 0; this.crowdAt = {}; this.prevGreen = null;
    this.attached = false; this.note = ''; this.error = ''; this.hook = ''; this.field = null; this.lastAct = null; this.t0 = null; this.lastCamBytes = null;
    this.pendingCut = null; this.cutStatus = { waiting: false, reason: '', remaining: 0 }; this.activeLibCam = 0;
    // dynamic cameras and camera sets (RaceVision, Nov 2026)
    this.dyn = new DynCams({ mem: this.shadow, cam: this.cam, settings: () => this.resolved(), log: (m) => this.log(m), rnd: opts.rnd, learnedDir: opts.learnedDir, mapFor: opts.mapFor,
      pitEntryFor: opts.pitEntryFor || ((t) => { const rc = (this.opts.getConfig() || {}).raceControl, v = rc && rc.tracks && rc.tracks[t] ? rc.tracks[t].pitEntry : null; return v == null ? null : Number(v); }) });
    this.camsets = new CameraSets({ mem: this.shadow, log: (m) => this.log(m), gameDir: () => this._gameDir(), root: () => String(this.resolved().camsets_dir || '').trim(), programData: opts.programData,
      seriesKey: () => this._artSeriesId() || 'default' });
    this._lastTickT = null;
    this._layoutsInit();          // RaceVision 2.0: overlay layouts
  }
  _gameDir() { const g = String(this.resolved().game_dir || '').trim(); return g || (this._exePath() ? path.dirname(this._exePath()) : ''); }

  _exePath() { return this.opts.getConfig().nr2003_exe || ''; }
  _exeName() { return gameExe.names(this.opts.getConfig()); }

  cfg() {
    const c = this.opts.getConfig();
    const cur = c.director || {};
    c.director = Object.assign({}, DEFAULTS, cur, { settings: Object.assign({}, cur.settings), enabledCams: Array.isArray(cur.enabledCams) ? cur.enabledCams : DEFAULTS.enabledCams.slice() });
    return c.director;
  }
  resolved() { const c = this.cfg(); return S.resolve(c.settings, c.enabledCams); }
  _key() { const c = this.cfg(); if (!c.remoteKey) { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let k = ''; for (let i = 0; i < 8; i++) k += a[Math.floor(Math.random() * a.length)]; c.remoteKey = k; this.opts.getConfig().director = c; this.opts.saveConfig(); } return c.remoteKey; }
  newRemoteKey() { const c = this.cfg(), a = 'abcdefghjkmnpqrstuvwxyz23456789'; let k = ''; for (let i = 0; i < 8; i++) k += a[Math.floor(Math.random() * a.length)]; c.remoteKey = k; this.opts.getConfig().director = c; this.opts.saveConfig(); return k; }
  _favs() { return S.list(this.cfg().favourites).map(Number).filter(Boolean); }
  // rivalries (opts.rivals: () => [{ a, b, level, holder }] - AIMOD's this race, else the season's), looked up by car number; cached 2 s
  _rivalMap() {
    const now = Date.now();
    if (this._rivAt && now - this._rivAt < 2000) return this._riv;
    this._rivAt = now; this._riv = new Map();
    let list = [];
    try { list = (this.opts.rivals && this.opts.rivals()) || []; } catch (e) { list = []; }
    const n = (v) => String(parseInt(v, 10));
    for (const r of list) {
      if (!(r.level > 0)) continue;
      const a = n(r.a), b = n(r.b);
      for (const [x, y] of [[a, b], [b, a]]) {
        if (!this._riv.has(x)) this._riv.set(x, []);
        this._riv.get(x).push({ other: y, level: r.level, holder: r.holder == null ? null : n(r.holder) });
      }
    }
    return this._riv;
  }
  _rivalOf(a, b) { const l = this._rivalMap().get(String(parseInt(a, 10))) || []; return l.find(x => x.other === String(parseInt(b, 10))) || null; }
  // allies (opts.allies: () => [{ a, b, trusted, team }] - RaceLab's, while it runs), looked up by car number; cached 2 s
  _allyMap() {
    const now = Date.now();
    if (this._allyAt && now - this._allyAt < 2000) return this._ally;
    this._allyAt = now; this._ally = new Map();
    let list = [];
    try { list = (this.opts.allies && this.opts.allies()) || []; } catch (e) { list = []; }
    const n = (v) => String(parseInt(v, 10));
    for (const r of list) {
      const a = n(r.a), b = n(r.b);
      for (const [x, y] of [[a, b], [b, a]]) {
        if (!this._ally.has(x)) this._ally.set(x, []);
        this._ally.get(x).push({ other: y, trusted: !!r.trusted, team: !!r.team });
      }
    }
    return this._ally;
  }
  _allyOf(a, b) { const l = this._allyMap().get(String(parseInt(a, 10))) || []; return l.find(x => x.other === String(parseInt(b, 10))) || null; }

  log(msg) {
    this.logTail.push(msg); if (this.logTail.length > LOG_TAIL) this.logTail.shift();
    journal.text('TV', msg);
    if (this.opts.logFile) try {      // kept on disk so a race can be read afterwards (the crash journal is only written when the game closes first)
      const f = this.opts.logFile;
      try { if (fs.statSync(f).size > 400000) fs.renameSync(f, f + '.old'); } catch (e) { /* new file */ }
      fs.appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n');
    } catch (e) { /* ignore */ }
    if (this.opts.log) this.opts.log('[tv] ' + msg);
  }

  setConfig(patch) {
    const c = this.cfg(), p = patch || {};
    for (const k of ['enabled', 'dryRun', 'startWithGame']) if (k in p) c[k] = !!p[k];
    if (Array.isArray(p.enabledCams)) c.enabledCams = [...new Set(p.enabledCams.map(Number).filter(n => n >= 1 && n <= 21))].sort((a, b) => a - b);
    if (typeof p.favourites === 'string') c.favourites = p.favourites.replace(/[^0-9,;\s]/g, '').slice(0, 200);
    if (p.settings && typeof p.settings === 'object') for (const [k, v] of Object.entries(p.settings)) { if (k in S.DEFAULTS || S.DYNAMIC_KEY.test(k)) { if (v === null) delete c.settings[k]; else c.settings[k] = v; } }
    this.opts.getConfig().director = c;
    this.opts.saveConfig();
    if ('dryRun' in p) { this._release(); this.shadow.clear(); this.shadow.passthrough = c.dryRun === false; }
    if ('enabled' in p && !c.enabled) this._release();
    this.dir.setSettings(this.resolved());
    if (p.settings && Object.keys(p.settings).some(k => ['drone_distance', 'drone_top_mph', 'drone_hover_m', 'drone_quiet'].includes(k)) && this.activeLibCam >= 22) this._applyCameraFeatures(this.activeLibCam, this.resolved());
    return c;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────
  start() { this.timer = setInterval(() => this._tick(), TICK_MS); if (this.timer.unref) this.timer.unref(); }
  stop() { clearInterval(this.timer); this.remote.stop(); this._release(); try { this.shadow.detach(); } catch (e) { /* ignore */ } }

  _syncRemote() {
    const c = this.cfg(), R = this.resolved();
    if (c.enabled && R.remote) { if (!this.opts.noRemote) this.remote.start(R.remote_port || 8090); } else this.remote.stop();
  }

  _release() { try { this._hideOthers(false); } catch (e) { /* ignore */ } try { this.dyn.release(); } catch (e) { /* ignore */ } try { this.replay.cancel(); this.effects.uninstall(); this.lib.restore(); if (this.cam.hooked) this.cam.uninstall(); } catch (e) { /* ignore */ } this.pendingCut = null; this.activeLibCam = 0; this.cutStatus = { waiting: false, reason: '', remaining: 0 }; this.hook = ''; this.attached = false; }

  _tick() {
    try { this._tickInner(); this.error = ''; }
    catch (e) { this.error = String(e && e.message || e); const n = Date.now(); if (n - (this._errAt || 0) > 60000) { this._errAt = n; this.log('error: ' + this.error); } }
  }

  _tickInner() {
    const c = this.cfg();
    this._syncRemote();
    if (!c.enabled) { if (this.attached) { this._release(); this.shadow.detach(); } this.note = ''; return; }
    if (this.opts.externalRunning && this.opts.externalRunning()) { this.note = 'RaceVision.exe is running — close it, both would drive the camera'; if (this.attached || this.cam.hooked || this.effects.angleCave || this.effects.lensCave) this._release(); return; }
    this.note = '';
    const was = this.attached;
    this.attached = !!this.shadow.attach();
    if (!this.attached) { if (was) { journal.gameGone('TV'); this.dyn.gameGone(); this.camsets.gameGone(); this.tvcams.len = 0; this.cam.hooked = false; this.hook = ''; this.effects.abandon(); this.lib.orig.clear(); this.lib.touched = null; this.timeline.reset(); this.dir.reset(); } return; }
    if (this.t0 === null) this.t0 = this.now();
    const t = this.now() - this.t0;
    const f = readField(this.shadow, t);
    if (!f) return;
    rank(f);
    // the places-gained graphic counts from the game's own scoring (by car number), not the director's distance order
    const gp = this.opts.gamePositions ? this.opts.gamePositions() : null;
    if (gp) f.gamePos = gp;
    this.field = f; this._fieldAt = Date.now();
    this.effects.refresh();
    if (!this.cam.hooked && this.resolved().camera_call) this._hook();
    const driving = this._replayTick(f) || this.tape.manual;
    this.tape.tick();
    if (!this.cam.replaying()) this.tape.markTick(this.shadow.readU32(0xB8E586), f.order && f.order[0] ? f.order[0].laps : 0, !!f.green);
    this._othersTick();
    this.dyn.observe(f, this.dir.events);
    const dt = this._lastTickT === null ? 0 : Math.max(0, Math.min(2, f.t - this._lastTickT)); this._lastTickT = f.t;
    if (this.dyn.active && (driving || this.replay.active)) this.dyn.end('a replay', f);
    // the choose cone: a dynamic camera at the cone while the cars pick their lane (Race Control says where it is)
    if (this.opts.coneFor && !this.dyn.active) { try { this.dyn.coneTick(f, this.opts.coneFor(), driving || this.replay.active || !this.shadow.passthrough || !this.cam.hooked || this.cam.foreign); } catch (e) { /* no cone */ } }
    const act = this.dir.update(f);
    let dynEnded = '';
    if (this.dyn.active) {
      dynEnded = this.dyn.tick(f, dt);
      // the director wants another car (or a crash): the dynamic camera gives way; the same car's follow cameras wait for it
      if (!dynEnded && act && (act.slot !== this.dyn.active.slot || (act.kind === 'incident' && this.dyn.active.role !== 'crash'))) dynEnded = this.dyn.end('replaced', f);
    }
    if (act && !driving && !this.replay.active) {
      if (this.dyn.active) { /* keeps the dynamic camera */ }
      else if (this._dynOffer(act, f)) { /* a dynamic camera took the shot */ }
      else this._apply(act);
    } else if (dynEnded && !driving && !this.replay.active && this.dir.cur && this.dir.cur.cam > 0) this._apply({ cam: this.dir.cur.cam, slot: this.dir.cur.slot, why: 'after the dynamic camera', kind: this.dir.cur.kind });
    else if (this.pendingCut && !driving && !this.replay.active) this._apply(this.pendingCut.act, this.pendingCut.at);
    this.timeline.observe(f, this.dir.state(), this.cam.current(), this.cutStatus);
    this._overlays(f, t);
  }

  // broadcast graphics + crowd sounds for the overlay window
  _overlays(f, t) {
    const R = this.resolved();
    const rp = this.replayState && this.replayState.phase !== 'idle' ? this.replayState : null;
    const ds = this.dir.state();
    // during a replay the overlays follow the replay's car (the tag; the dash when the angle is in-car) unless replay_overlays is off
    const ov = rp && rp.phase === 'playing' && R.replay_overlays && rp.slot >= 0 ? Object.assign({}, ds, { cur: { kind: 'replay', slot: rp.slot, cam: this.cam.current(), since: t } }) : ds;
    this.ov.rivalOf = (a, b) => this._rivalOf(a, b);
    this.ov.rivalsOf = (num) => this._rivalMap().get(String(parseInt(num, 10))) || [];
    this.ov.allyOf = (a, b) => this._allyOf(a, b);
    this.ov.alliesOf = (num) => this._allyMap().get(String(parseInt(num, 10))) || [];
    const o = this.ov.compute(ov, f, R, this.cam.current(), t);
    // each graphic's own switch (their RaceVision 2.0 layout panels follow these too)
    if (!+R.tag_on) o.tag = null;
    if (!+R.battle_on) o.battle = null;
    if (!+R.dash_on) o.dash = null;
    if (rp && R.replay_banner) {
      const carText = rp.phase === 'playing' && rp.num ? ` · #${rp.num}${rp.name ? ' ' + rp.name : ''}` : '';
      o.replay = { text: rp.text + carText, phase: rp.phase, angle: rp.angle, angles: rp.angles, liveIn: rp.liveIn || 0 };
      o.on = true;
    }
    o.crowd = this._crowd(f, R, t);
    this._attachArt(o, f, R);
    if (R.dash_art_colors && o.dash && o.dash.art && o.dash.art.color) {
      o.accent = o.dash.art.color;
      o.accent2 = o.dash.art.color;
      const rgb = parseColor(o.dash.art.color);
      if (rgb) {
        const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
        const lifted = Math.max(0, (0.12 - luminance) * 255);
        o.plateFrom = colorHex(rgb.map(v => Math.min(255, Math.round(v + lifted))));
        o.plateTo = colorHex(rgb.map(v => Math.round(v * 0.35)));
      }
    }
    o.crowdVolume = R.crowd_volume; o.crowdFolder = R.crowd_folder; o.layout = { battle: R.overlay_battle || '', tag: R.overlay_tag || '', onboard: R.overlay_onboard || '', gain: R.overlay_gain || '', replay: R.overlay_replay || '' };
    try { this._layoutOverlay(o, f, R, t, rp); } catch (e) { o.lay = null; }       // RaceVision 2.0 layouts (director/service_layouts.js)
    // RaceVision 2.0: the overlays step aside while a wipe runs (they come back with the cut)
    if (this._wipeBusy > 0) { o.tag = null; o.battle = null; o.dash = null; o.gain = null; if (o.lay) o.lay.panels.forEach(p => { p.on = false; }); }
    this.overlay = o;
    if (this.opts.onOverlay) this.opts.onOverlay(o);
  }

  // number card, headshot, manufacturer and colour for every driver the graphics show
  _attachArt(o, f, R) {
    if (!o.on) return;
    const tickerSeries = String(this.opts.getConfig().series || '');
    const hasTickerSeries = tickerSeries !== '' && tickerSeries.toLowerCase() !== 'default';
    const series = hasTickerSeries ? tickerSeries : R.art_series;
    const s = this.art.pick(f.order.map(c => c.num), series, hasTickerSeries);
    o.series = s ? s.id : '';
    const put = (x) => { if (x) { x.art = ArtLibrary.art(s, x.num); if (x.art.nameOv && x.art.nameOv.last) { x.last = x.art.nameOv.last; if (x.name !== undefined) x.name = `${x.art.nameOv.first || ''} ${x.art.nameOv.last}`.trim(); } } };
    put(o.tag); put(o.dash); put(o.gain);
    if (o.battle) { put(o.battle.a); put(o.battle.b); }
  }

  _crowd(f, R, t) {
    const out = [];
    if (!R.crowd) return out;
    const push = (kind, num) => {
      if (!R.crowd_events.has(kind) || t - (this.crowdAt[kind] || -1e9) < R.crowd_cooldown) return;
      this.crowdAt[kind] = t; out.push({ kind, fav: R.crowd_favourites.includes(String(num)) });
    };
    for (const e of this.dir.events) {
      if (e.t <= this.crowdSeen) continue;
      const c = f.order.find(x => x.slot === e.slot);
      if (e.kind === 'incident') push('crash', c && c.num);
      else if (e.kind === 'pass' && c && c.pos <= R.crowd_pass_depth) push(c.pos === 1 ? 'lead' : 'pass', c.num);
    }
    this.crowdSeen = f.t;
    if (f.green && this.prevGreen === false) push('restart', f.order[0] && f.order[0].num);
    this.prevGreen = f.green;
    return out;
  }

  _hook() {
    if (this._hookTry && Date.now() - this._hookTry < 5000) return;
    this._hookTry = Date.now();
    this.hook = this.cam.install();
    this.log('camera hook: ' + this.hook + (this.shadow.passthrough ? '' : ' (read-only test: nothing written)'));
  }

  _apply(act, pendingAt) {
    const R = this.resolved();
    if (act.slot !== undefined && act.slot >= 0 && !this.cam.slotValid(act.slot)) return;
    const want = act.cam > 0 ? act.cam : this.cam.current();
    const started = pendingAt === undefined ? (this.field ? this.field.t : 0) : pendingAt;
    if (pendingAt === undefined) this.pendingCut = { act, at: started };
    const gate = this._tvCutGate(act, want, R);
    const elapsed = Math.max(0, (this.field ? this.field.t : started) - started);
    if (gate && elapsed < R.tv_cut_wait) {
      this.cutStatus = { waiting: true, reason: gate.reason, remaining: Math.max(0, R.tv_cut_wait - elapsed) };
      return false;
    }
    if (gate) this.log(`TV camera cut: cut anyway after ${elapsed.toFixed(1)}s (${gate.reason})`);
    this.pendingCut = null; this.cutStatus = { waiting: false, reason: '', remaining: 0 };
    this.activeLibCam = want;
    const real = this.lib.activate(want, act.slot !== undefined && act.slot >= 0 ? act.slot : this.cam.focusSlot());     // library cameras: write the tune, show the base camera
    this._applyCameraFeatures(want, R);
    const ok = this.cam.set(real, act.slot, { call: !!R.camera_call });
    if (ok) {
      this.lastAct = Object.assign({ at: this.field ? this.field.t : 0 }, act);
      this.timeline.cut(this.field, act, act.cam);
      this.log(`TV: #${this._num(act.slot)} on camera ${act.cam} (${act.why})`);
    }
    return !!ok;
  }
  _tvCutGate(act, targetCam, R) {
    if (!(R.tv_cut_gap > 0) || !this.field || !this.field.order) return null;
    const groupOf = id => { const d = this.lib.def(id), b = d ? d.base : id; return b >= 19 && b <= 21 ? b - 19 : -1; };
    const fromGroup = groupOf(this.cam.current()), toGroup = groupOf(targetCam);
    if (fromGroup < 0 && toGroup < 0) return null;
    const timing = (slot, group) => group < 0 ? null : this.tvcams.timing(this.field.cars.find(c => c.slot === slot), group, this.field.trackLen);
    const from = timing(this.cam.focusSlot(), fromGroup), to = timing(act.slot, toGroup);
    if (from && from.since_s < R.tv_cut_gap) return { reason: `current TV${from.group + 1} camera ${from.n} took over ${from.since_s.toFixed(1)}s ago` };
    if (to && to.next_s < R.tv_cut_gap) return { reason: `target TV${to.group + 1} camera ${to.next_n} takes over in ${to.next_s.toFixed(1)}s` };
    return null;
  }
  // a director cut a dynamic camera can take: the library's camera is put back first, the shot is logged as the pit camera it uses
  _dynOffer(act, f) {
    if (!this.dyn.on() || (act.slot !== undefined && act.slot >= 0 && !this.cam.slotValid(act.slot))) return false;
    try { this.lib.restore(); } catch (e) { /* nothing to put back */ }
    this._applyCameraFeatures(17);
    if (!this.dyn.offer(act, f, { pitPhase: this.dir.pitPhase })) return false;
    const sh = this.dyn.active;
    this.activeLibCam = sh.base.cam; this.pendingCut = null; this.cutStatus = { waiting: false, reason: '', remaining: 0 };
    this.lastAct = Object.assign({ at: f.t }, act, { cam: sh.base.cam, why: (act.why || act.kind) + ' (dynamic: ' + sh.t.label + ')' });
    this.timeline.cut(f, this.lastAct, sh.base.cam);
    return true;
  }
  dynTest() {
    const f = this.field;
    if (!this.attached || !f) return { error: "NR2003 isn't running" };
    if (!this.cam.hooked && this.resolved().camera_call) this._hook();
    try { this.lib.restore(); } catch (e) { /* nothing to put back */ }
    const slot = this.cam.focusSlot() >= 0 ? this.cam.focusSlot() : (f.order[0] ? f.order[0].slot : -1);
    const r = this.dyn.test(f, slot);
    if (r.ok) this.activeLibCam = this.dyn.active.base.cam;
    return r;
  }
  dynStatus() { return this.dyn.status(); }
  dynForget() { return { ok: this.dyn.forget() }; }
  dynRate(up) { return this.dyn.rate(!!up); }
  // camera sets: the page's state, and using / saving / putting back a set
  camsetsState(track, series) {
    const f = this.field;
    const st = this.camsets.state({ track, liveTrack: this.attached && f ? f.track : '', attached: this.attached });
    if (series && series !== st.series) { st.series = series; try { st.seriesSets = this.camsets.list('series', series); } catch (e) { st.seriesError = e.message; } }
    return st;
  }
  // the art series the director is showing (the key the car-camera mod pick is remembered under)
  _artSeriesId() {
    const f = this.field, R = this.resolved(), ticker = String(this.opts.getConfig().series || '');
    const strict = ticker !== '' && ticker.toLowerCase() !== 'default';
    const s = this.art.pick(f ? f.order.map(c => c.num) : [], strict ? ticker : R.art_series, strict);
    return s ? s.id : '';
  }
  camsetsSeries(name) { try { return { ok: true, series: this.camsets.chooseSeries(this._artSeriesId() || 'default', name) }; } catch (e) { return { error: e.message }; } }
  camsetsApply(kind, who, name, live, save) {
    if (live && this.dyn.active) this.dyn.end('camera set', this.field);
    if (live && kind === 'track') this.dyn.orig.clear();         // the pit cameras are the set's now
    const r = this.camsets.apply(kind, who, name, { live: !!live, save: !!save, liveTrack: this.attached && this.field ? this.field.track : '' });
    if (r.live === 'done' && kind === 'track') this.tvcams.len = 0;   // read the new TV tables again
    return r;
  }
  // the preview page's data: the set's cameras on the track map, and RaceVision's dynamic camera templates / what is learned there
  camsetsPreview(track, name) {
    if (!track || !name) return { error: 'track and name?' };
    let map = null;
    try { map = this.opts.mapFor ? this.opts.mapFor(track) : TrackMap.Load(track); } catch (e) { map = null; }
    try {
      const p = this.camsets.preview(track, name, map, { liveTrack: this.attached && this.field ? this.field.track : '' });
      p.dyn = this.dyn.previewInfo(track);
      return p;
    } catch (e) { return { error: e.message }; }
  }
  async openPreview(shell, track, name) {
    const c = this.cfg(), port = Math.max(1024, Math.min(65535, Number(c.settings.remote_port) || 8090));
    this.setConfig({ settings: { remote: 1, remote_port: port } });
    this.remote.start(port);
    if (!shell || !shell.openExternal) return false;
    await shell.openExternal(`http://127.0.0.1:${port}/preview?k=${encodeURIComponent(this._key())}&track=${encodeURIComponent(track || '')}&name=${encodeURIComponent(name || '')}`);
    return true;
  }
  _applyCameraFeatures(id, R = this.resolved(), tuneOverride) {
    const def = this.lib.def(id), base = def ? def.base : id;
    const tune = Array.isArray(tuneOverride) ? tuneOverride : (this.lib.tuneOf(id) || []);
    if (base === 1 && tune.length >= 3 && !this.cam.inCar()) {
      this.effects.setAngles(tune[3] || 0, tune[4] || 0, tune[5] || 0);
      this.effects.setLens(tune[6] || 0);
    } else {
      this.effects.setAngles(0, 0, 0); this.effects.setLens(0);
    }
    this.effects.setDrone(base === 16 && id >= 22, R);
  }
  _num(slot) { const c = this.field && this.field.cars.find(x => x.slot === slot); return c ? c.num : slot; }

  // ── controls (UI / phone remote) ──────────────────────────────────────────────────────────────
  focus(slot) { const t = this.field ? this.field.t : 0; const a = this.dir.manual(slot, undefined, t); this._apply(Object.assign(a, { cam: this.cam.current() })); return true; }
  camera(cam) { const t = this.field ? this.field.t : 0; const a = this.dir.manual(undefined, cam, t); this._apply(a); return true; }
  auto() { this.dir.auto(); return true; }
  pause(on) { this.dir.pause(on); return true; }

  // ── UI API ──────────────────────────────────────────────────────────────────────────────────────
  getState() {
    const c = this.cfg(), f = this.field;
    return {
      config: c, enabled: c.enabled, dryRun: c.dryRun !== false, attached: this.attached, note: this.note, error: this.error, hook: this.hook,
      hookAlive: this.cam.hooked ? this.cam.alive() : null, camera: this.attached ? this.cam.current() : null, focus: this.attached ? this.cam.focusSlot() : -1,
      enabledCams: c.enabledCams, remote: { urls: this.remote.urls(), error: this.remote.error, key: c.enabled ? this._key() : '' },
      overlay: this.overlay, director: this.dir.state(), last: this.lastAct, cameras: S.CAMERAS, settings: S.resolveForUi ? S.resolveForUi(c) : this._uiSettings(c),
      field: f ? f.order.slice(0, 44).map(x => ({ slot: x.slot, pos: x.pos, num: x.num, name: x.name, laps: x.laps, speed: x.speed, pit: x.pit, gap: x.gapAheadS, x: x.x, y: x.y })) : [],
      flag: f ? f.flag : -1, green: f ? f.green : false, trackLen: f ? f.trackLen : 0,
      library: this.lib.list(), crashes: this.crashes.list().slice(-30), replay: this.replayState, replayHooked: this.cam.hooked && !this.cam.foreign, presets: this.presetNames(),
      cutStatus: this.cutStatus, map: this.timeline.map(f ? f.trackLen : 0), timeline: { events: this.timeline.events.slice(-200), samples: this.timeline.samples.slice(-120), files: this.timeline.files() },
      pendingWrites: { count: this.shadow.count, recent: this.shadow.recent.slice(-3) }, log: this.logTail.slice(-30),
    };
  }
  _uiSettings(c) { const o = {}; for (const k of Object.keys(S.DEFAULTS)) o[k] = c.settings[k] !== undefined ? c.settings[k] : S.DEFAULTS[k]; return o; }

  directorLive() {
    const f = this.field, d = this.dir.state(), cur = d.cur;
    const R = this.resolved(), ticker = String(this.opts.getConfig().series || '');
    const strictSeries = ticker !== '' && ticker.toLowerCase() !== 'default';
    const artSeries = this.art.pick(f ? f.order.map(c => c.num) : [], strictSeries ? ticker : R.art_series, strictSeries);
    return {
      attached: this.attached, t: f ? f.t : 0, track: f ? f.track : '', lap: f && f.order[0] ? f.order[0].laps : 0,
      flag: f ? f.flag : -1, green: !!(f && f.green), paused: d.paused, replay: this.replayState,
      car: cur ? cur.slot : -1, kind: cur ? cur.kind : '', cam: this.cam.current(), waiting: this.cutStatus.waiting,
      why: this.lastAct ? this.lastAct.why : '', trackLen: f ? f.trackLen : 0,
      cars: f ? f.order.map(c => [c.slot, c.num, c.name, c.x, c.y, c.pit ? 1 : 0, c.pos]) : [],
      map: this.timeline.map(f ? f.trackLen : 0), series: artSeries ? artSeries.id : '', logo: !!(artSeries && artSeries.logo),
      samples: this.timeline.samples.slice(-120), timeline: { samples: this.timeline.samples.slice(-120) },
      dynOn: this.dyn.on(), dyn: this.dyn.live(),
    };
  }
  directorEvents(from = -Infinity) { return this.timeline.events.filter(e => Number(e.t) >= Number(from)); }
  directorAt(t) { return this.timeline.at(Number(t)); }
  directorFiles() { return this.timeline.files(); }
  directorFile(name) { return this.timeline.readFile(name); }
  artImage(series, kind, number) { return this.art.imagePath(series, kind, number); }
  async openDirectorView(shell) {
    const c = this.cfg(), port = Math.max(1024, Math.min(65535, Number(c.settings.remote_port) || 8090));
    this.setConfig({ settings: { remote: 1, remote_port: port } });
    this.remote.start(port);
    if (!shell || !shell.openExternal) return false;
    await shell.openExternal(`http://127.0.0.1:${port}/director?k=${encodeURIComponent(this._key())}`);
    return true;
  }

  // RaceVision 2.0: the overlay layout editor (layouts, the screen view, presets for the whole screen) in the browser
  async openOverlayEditor(shell) {
    const c = this.cfg(), port = Math.max(1024, Math.min(65535, Number(c.settings.remote_port) || 8090));
    this.setConfig({ settings: { remote: 1, remote_port: port } });
    this.remote.start(port);
    if (!shell || !shell.openExternal) return false;
    await shell.openExternal(`http://127.0.0.1:${port}/overlays?k=${encodeURIComponent(this._key())}`);
    return true;
  }

  registerIpc({ ipcMain, shell }) {
    ipcMain.handle('tv:open-overlay-editor', () => this.openOverlayEditor(shell));
    ipcMain.handle('tv:get-state', () => this.getState());
    ipcMain.handle('tv:set-config', (e, p) => { this.setConfig(p); return this.getState(); });
    ipcMain.handle('tv:focus', (e, slot) => this.focus(slot));
    ipcMain.handle('tv:camera', (e, cam) => this.camera(cam));
    ipcMain.handle('tv:auto', () => this.auto());
    ipcMain.handle('tv:pause', (e, on) => this.pause(on));
    ipcMain.handle('tv:replay-now', () => this.replayNow());
    ipcMain.handle('tv:replay-crash', (e, id) => this.replayCrash(id));
    ipcMain.handle('tv:replay-reel', () => this.reel());
    ipcMain.handle('tv:replay-live', () => this.replayLive());
    ipcMain.handle('tv:tape', () => this.tapeState());
    ipcMain.handle('tv:tape-ctl', (e, q) => this.tapeCtl(q));
    ipcMain.handle('tv:cam-describe', (e, cam) => this.camDescribe(cam));
    ipcMain.handle('tv:cam-adjust', (e, cam, tune) => this.camAdjust(cam, tune));
    ipcMain.handle('tv:cam-save', (e, cam, tune) => this.camSave(cam, tune));
    ipcMain.handle('tv:cam-new', (e, base, name, tune) => this.camNew(base, name, tune));
    ipcMain.handle('tv:cam-delete', (e, id) => this.camDelete(id));
    ipcMain.handle('tv:cam-label', (e, id, name) => this.camLabel(id, name));
    ipcMain.handle('tv:cam-order', (e, list) => this.camOrder(list));
    ipcMain.handle('tv:cam-hide', (e, id, on) => this.camHide(id, on));
    ipcMain.handle('tv:preset-apply', (e, name) => this.applyPreset(name));
    ipcMain.handle('tv:open-director-view', () => this.openDirectorView(shell));
    ipcMain.handle('tv:new-remote-key', () => this.newRemoteKey());
    ipcMain.handle('tv:dyn-status', () => this.dynStatus());
    ipcMain.handle('tv:dyn-test', () => this.dynTest());
    ipcMain.handle('tv:dyn-forget', () => this.dynForget());
    ipcMain.handle('tv:dyn-rate', (e, up) => this.dynRate(up));
    ipcMain.handle('tv:camsets', (e, track, series) => this.camsetsState(track, series));
    ipcMain.handle('tv:camsets-preview', (e, track, name) => this.openPreview(shell, track, name));
    ipcMain.handle('tv:camsets-series', (e, name) => this.camsetsSeries(name));
    ipcMain.handle('tv:camsets-apply', (e, kind, who, name, live, save) => { try { return this.camsetsApply(kind, who, name, live, save); } catch (x) { return { error: x.message }; } });
  }
}

function parseColor(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
function colorHex(rgb) { return '#' + rgb.map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join(''); }

require('./service_ext').install(DirectorService);
require('./service_layouts').install(DirectorService);

module.exports = { DirectorService, DEFAULTS };
