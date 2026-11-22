// FieldService — "one car per driver": keeps the roster NR2003 draws its AI field from free of drivers that appear twice (two paint
// schemes of the same driver), so a race can never have the same driver in two cars. The chosen roster (series\<series>\cars\<name>.lst)
// is rewritten before the race is set up: exactly one enabled car per driver (a different paint scheme each race if wanted), none for
// the driver you are racing as. The roster you had is put back when the setting is switched off or All In One NR2003 closes; if the game or you
// changed the file in the meantime, that newer version is kept as your roster.
'use strict';
const fs = require('fs');
const path = require('path');
const gameExe = require('../gameexe');   // the game's process names (RaceLab's builds too)
const { parseLst, serializeLst, readDriver, driverKey, planOnePerDriver, rosterPath, iniGet } = require('./roster');
const { Win32Memory } = require('../ai/memory');
const Entry = require('../season/entry');           // season mode's guaranteed starters (top N owners, chartered cars)

const TICK_MS = 3000;
const DRIVER_TABLE = 14711636, DRIVER_ENTRY = 175;          // NR2003's driver table of the loaded session (first name @0, last name @16)
const DEFAULTS = { onePerDriver: false, reroll: true };

class FieldService {
  // opts: { userData, getConfig, saveConfig, log, nrDir(), playerFolder(), guaranteed()? (season: { nums, charters, top, topN, track }), memory? (tests), rnd? }
  constructor(opts) {
    this.opts = opts;
    this.rnd = opts.rnd || Math.random;
    this.mem = opts.memory || new Win32Memory(() => this._exeName(), () => (opts.getConfig().nr2003_exe || ''));
    this.stateFile = path.join(opts.userData, 'field_state.json');
    this.state = this._loadState();
    this.report = null; this.error = ''; this.note = ''; this.ctx = null;
    this.wasRunning = false; this.wasInSession = false; this.timer = null; this.logTail = [];
  }

  _exeName() { return gameExe.names(this.opts.getConfig()); }
  cfg() { const c = this.opts.getConfig(); c.field = Object.assign({}, DEFAULTS, c.field || {}); return c.field; }
  log(m) { this.logTail.push(m); if (this.logTail.length > 40) this.logTail.shift(); if (this.opts.log) this.opts.log('[field] ' + m); }
  _loadState() { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (e) { return null; } }
  _saveState() { try { if (this.state) fs.writeFileSync(this.stateFile, JSON.stringify(this.state)); else fs.rmSync(this.stateFile, { force: true }); } catch (e) { /* ignore */ } }

  setConfig(p) {
    const c = this.cfg();
    if (p && 'onePerDriver' in p) c.onePerDriver = !!p.onePerDriver;
    if (p && 'reroll' in p) c.reroll = !!p.reroll;
    this.opts.saveConfig();
    if (this._wanted()) this.apply(true); else this.restore();
    return this.getState();
  }
  // the roster is ours to write: one car per driver, or season mode guarantees starters for the next race
  _seasonG() { try { const g = this.opts.guaranteed ? this.opts.guaranteed() : null; return g && g.nums && g.nums.length ? g : null; } catch (e) { return null; } }
  _wanted() { return !!(this.cfg().onePerDriver || this._seasonG()); }
  // the guaranteed starters with the places the race has: NumAI, and the track's max_starters less your car
  _guarantee(ctx) {
    const g = this._seasonG();
    if (!g) return null;
    const track = g.track || ctx.trackDir || '';
    let ms = 43;
    try { if (track) ms = Entry.maxStarters(fs.readFileSync(path.join(this.opts.nrDir(), 'tracks', track, 'track.ini'), 'latin1')); } catch (e) { ms = 43; }
    const slots = Math.max(1, Math.min(ctx.numAI > 0 ? ctx.numAI : 42, ms - 1));
    return Object.assign({}, g, { track, maxStarters: ms, slots });
  }

  start() {
    const c = this.cfg();
    if (this._wanted()) this.apply(true); else this.restore();      // also puts back a roster left changed by a crash
    this.timer = setInterval(() => this.tick(), TICK_MS); if (this.timer.unref) this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.restore(); try { this.mem.detach(); } catch (e) { /* ignore */ } }

  // the roster of the active series and who you race as
  context() {
    const nrDir = this.opts.nrDir && this.opts.nrDir(), pf = this.opts.playerFolder && this.opts.playerFolder();
    if (!nrDir) return { error: 'NR2003 is not set up yet (choose its folder on the main page)' };
    if (!pf) return { error: 'no player profile chosen on the main page' };
    let ini = '';
    try { ini = fs.readFileSync(path.join(nrDir, 'players', pf, 'player.ini'), 'latin1'); } catch (e) { return { error: 'cannot read player.ini of ' + pf }; }
    const series = iniGet(ini, 'Personal Information', 'series');
    if (!series) return { error: 'player.ini has no selected series' };
    const roster = iniGet(ini, series, 'SelectedRoster'), carFile = iniGet(ini, series, 'SelectedCarFile');
    const numAI = parseInt(iniGet(ini, 'Single Race', 'NumAI'), 10) || 0;
    if (!roster) return { error: `the series ${series} has no roster selected (pick one in NR2003's Opponent Manager); the game then uses every car`, series };
    const carsDir = path.join(nrDir, 'series', series, 'cars');
    const player = carFile ? readDriver(path.join(carsDir, carFile)) : null;
    return { series, roster, carsDir, lst: rosterPath(nrDir, series, roster), numAI, player, playerKey: driverKey(player), playerName: player ? `${player.first} ${player.last}`.trim() : '', trackDir: iniGet(ini, 'Single Race', 'TrackDir') };
  }

  // write the pool: one car per driver. -> true when a roster was written
  apply(reroll) {
    const ctx = this.ctx = this.context();
    this.error = ctx.error || ''; this.note = '';
    if (ctx.error) return false;
    let current;
    try { current = fs.readFileSync(ctx.lst, 'latin1'); } catch (e) { this.error = 'cannot read the roster ' + ctx.roster; return false; }
    const ours = this.state && this.state.path === ctx.lst && this.state.written === current;
    if (this.state && this.state.path !== ctx.lst) this.restoreState();                           // another roster was ours before: give it back
    const base = ours ? this.state.original : current;
    const one = this.cfg().onePerDriver, g = this._guarantee(ctx);
    let parsed = parseLst(base), plan = null, gr = null;
    if (one) { plan = planOnePerDriver(parsed, (f) => readDriver(path.join(ctx.carsDir, f)), { rnd: this.rnd, playerKey: ctx.playerKey }); parsed = plan.parsed; }
    // season mode: every guaranteed car stays in the pool, cut down to the places the race has (the rest drawn at random); fewer places
    // than guaranteed cars: the pool is the guaranteed cars only and the game picks among them
    if (g) {
      const r = Entry.planRoster(parsed.entries, (f) => { const d = readDriver(path.join(ctx.carsDir, f)); return d ? d.number : ''; },
        { guaranteed: g.nums, slots: g.slots, rnd: this.rnd, skipNum: ctx.player ? ctx.player.number : '' });
      parsed = { entries: r.entries, eol: parsed.eol }; gr = r.report;
    }
    const key = g ? JSON.stringify([g.nums, g.slots]) : '';
    const text = ours && !reroll && (this.state.key || '') === key ? current : serializeLst(parsed);          // reroll off: the cars picked earlier stay
    this.report = plan ? plan.report : null;
    this.guarantee = g ? Object.assign({}, g, { report: gr }) : null;
    if (one && ctx.numAI && plan.report.drivers < ctx.numAI) this.note = `only ${plan.report.drivers} different drivers are in this roster; the field you asked for is ${ctx.numAI} AI cars`;
    if (gr && gr.missing.length) this.note = (this.note ? this.note + '; ' : '') + `guaranteed but not in this roster: #${gr.missing.join(', #')}`;
    if (text !== current) {
      try { fs.writeFileSync(ctx.lst, text, 'latin1'); } catch (e) { this.error = 'cannot write the roster: ' + e.message; return false; }
      this.state = { path: ctx.lst, original: base, written: text, key }; this._saveState();
      if (plan) this.log(`${ctx.roster}: ${plan.report.drivers} drivers, one car each` + (plan.report.removed.length ? ` (${plan.report.removed.length} had more than one car)` : '') + (plan.report.playerRemoved.length ? `; none for ${ctx.playerName} (you)` : ''));
      if (gr) this.log(`${ctx.roster}: ${gr.locked.length} guaranteed car(s) in a pool of ${gr.pool} for ${gr.slots} AI places` + (g.track ? ` (${g.track}: ${g.maxStarters} starters)` : '') + (gr.chartersOnly ? ' - more guaranteed cars than places: the game picks among them' : ''));
      return true;
    }
    if (!ours || (this.state.key || '') !== key) { this.state = { path: ctx.lst, original: base, written: text, key }; this._saveState(); }
    return false;
  }

  // give the user's roster back (only if nobody changed the file since we wrote it)
  restoreState() {
    const s = this.state; if (!s) return;
    try { if (fs.readFileSync(s.path, 'latin1') === s.written) fs.writeFileSync(s.path, s.original, 'latin1'); } catch (e) { /* gone */ }
    this.state = null; this._saveState();
  }
  restore() { if (this.state) { this.restoreState(); this.log('roster put back as it was'); } this.report = null; this.note = ''; }

  _sessionLoaded() {
    try {
      if (!this.mem.attach()) return null;
      const b = this.mem.readBytes(DRIVER_TABLE, DRIVER_ENTRY * 2);
      return !!(b && b[16] !== 0);                                   // a last name in the first rows
    } catch (e) { return null; }
  }

  // a new race is set up from the roster after you come back to the menu / start the game: roll the paint schemes again then
  tick() {
    try {
      const c = this.cfg();
      if (!this._wanted()) { if (this.state) this.restore(); return; }
      const loaded = this._sessionLoaded(), running = loaded !== null;
      const back = (this.wasInSession && loaded === false) || (running && !this.wasRunning);
      this.wasRunning = running; if (loaded !== null) this.wasInSession = loaded;
      if (back) this.apply(c.reroll);
      else if (!this.state) this.apply(false);                       // the roster was swapped under us (series changed): follow it
      else {
        const ctx = this.context();
        if (ctx.error) return;
        const g = this._guarantee(ctx), key = g ? JSON.stringify([g.nums, g.slots]) : '';
        if (this.state.path !== ctx.lst || (this.state.key || '') !== key) this.apply(false);       // another roster, or who is guaranteed changed
      }
    } catch (e) { this.error = String(e && e.message || e); }
  }

  registerIpc({ ipcMain }) {
    ipcMain.handle('field:get-state', () => { if (!this.state) this.ctx = this.context(); return this.getState(); });
    ipcMain.handle('field:set-config', (e, p) => this.setConfig(p));
    ipcMain.handle('field:shuffle', () => { if (this._wanted()) this.apply(true); return this.getState(); });
  }

  getState() {
    const c = this.cfg(), ctx = this.ctx || this.context();
    return {
      config: c, error: this.error || (ctx && ctx.error) || '', note: this.note, series: ctx.series || '', roster: ctx.roster || '', player: ctx.playerName || '', numAI: ctx.numAI || 0,
      guarantee: this.guarantee ? { nums: this.guarantee.nums, charters: this.guarantee.charters, top: this.guarantee.top, topN: this.guarantee.topN, track: this.guarantee.track, maxStarters: this.guarantee.maxStarters, slots: this.guarantee.slots, report: this.guarantee.report, season: this.guarantee.season } : null,
      active: !!this.state, drivers: this.report ? this.report.drivers : 0, removed: this.report ? this.report.removed : [], playerRemoved: this.report ? this.report.playerRemoved.length : 0, log: this.logTail.slice(),
    };
  }
}

module.exports = { FieldService, DEFAULTS };
