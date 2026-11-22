// AIService — "AI Tweaks": the three AI EDITING trainer switches (crashing mode, AI pit in the second yellow lap,
// damage multiplier). AI pit planning is handled by the built-in AIMOD 2.1 engine or its bundled beta app.
//
// Off by default, and in read-only test mode by default: nothing is written to NR2003 until the user switches it
// on and turns test mode off. Everything it patches is put back when it is switched off or the app exits.
'use strict';
const fs = require('fs');
const path = require('path');
const gameExe = require('../gameexe');   // the game's process names (RaceLab's builds too)
const A = require('./addresses');
const { Win32Memory, ShadowMemory } = require('./memory');
const { AIEditing } = require('./aiedit');

const STEP_MS = 100;

const DEFAULTS = {
  enabled: false,
  dryRun: true,                 // read-only test mode: attach and compute, but never write to NR2003
  crashing: false,
  pitYellow: false,
  damage: null,                 // null = leave the game's value
};
// settings of the features AIMOD v2.0 replaced (pit strategy, stage-aware laps-left): dropped from saved configs
const REMOVED = ['stageAware', 'raceOnly', 'pitStrategy', 'aimodNop', 'lapsLeft', 'params', 'wsUrl'];

class AIService {
  // opts: { userData, getConfig, saveConfig, log, memory? (tests) }
  constructor(opts) {
    this.opts = opts;
    const baseLog = opts.log || (() => {});
    this._logFile = path.join(opts.userData, 'ai-strategy.log');
    this.log = (m) => {                              // console + a capped log file for troubleshooting
      baseLog(m);
      try {
        if (fs.existsSync(this._logFile) && fs.statSync(this._logFile).size > 512 * 1024) fs.writeFileSync(this._logFile, fs.readFileSync(this._logFile, 'utf8').slice(-100 * 1024));
        fs.appendFileSync(this._logFile, new Date().toISOString() + ' ' + m + '\n');
      } catch (e) { /* logging must never break the AI */ }
    };
    // follow the exe All In One NR2003 is configured to launch (NR2003.exe, NR2003_510.exe, a track-pack exe …)
    const exePath = () => this.opts.getConfig().nr2003_exe || '';
    const exeName = () => gameExe.names(this.opts.getConfig());
    this.shadow = new ShadowMemory(opts.memory || new Win32Memory(exeName, exePath));
    this.shadow.passthrough = this.cfg().dryRun === false;
    this.mem = this.shadow;
    this.edit = new AIEditing(this.mem, m => this.log(m));
    this.pid = 0;
    this.attached = false;
    this.build = { ok: null, notes: [] };
    this.error = '';
    this.timer = null;
  }

  // ── config ──────────────────────────────────────────────────────────────────
  cfg() {
    const c = this.opts.getConfig();
    c.ai = Object.assign({}, DEFAULTS, c.ai || {});
    for (const k of REMOVED) delete c.ai[k];
    return c.ai;
  }

  setConfig(patch) {
    const c = this.opts.getConfig();
    c.ai = Object.assign(this.cfg(), patch || {});
    this.opts.saveConfig();
    if (patch && 'enabled' in patch && !patch.enabled) this._release();
    if (patch && 'dryRun' in patch) {                    // switching between test mode and live: put everything back first
      this._release();
      this.shadow.clear();
      this.shadow.passthrough = c.ai.dryRun === false;
    }
    return c.ai;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  start() { this.timer = setInterval(() => this._step(), STEP_MS); }
  stop() {
    clearInterval(this.timer);
    this._release();
    this.mem.detach();
  }

  // Put NR2003 back the way we found it.
  _release() {
    try {
      if (this.attached && this.mem.isAlive()) this.edit.releaseAll();
    } catch (e) { this.log('[ai] release error: ' + e.message); }
    this.edit.reset();
  }

  // ── NR2003 build check ──────────────────────────────────────────────────────
  _verifyBuild() {
    const notes = [];
    let ok = true;
    const m = this.mem;
    const cr = m.readBytes(m.base + A.PATCH.CRASHING.rva, 3);
    if (!cr || ![A.PATCH.CRASHING.original, A.PATCH.CRASHING.on].includes(cr.toString('hex'))) { ok = false; notes.push('crashing-mode code differs from the supported NR2003.exe builds'); }
    const flag = m.readI32(m.base + A.GLOBAL.FLAG_STATE);
    if (flag === null) { ok = false; notes.push('cannot read the flag state'); }
    this.build = { ok, notes };
    this.log(`[ai] attached to NR2003.exe pid ${m.pid}; build check ${ok ? 'OK' : 'FAILED: ' + notes.join('; ')}`);
  }

  // ── one step (every 100 ms) ─────────────────────────────────────────────────
  _step() {
    try { this._stepInner(); this.error = ''; }
    catch (e) { this.error = String(e && e.message || e); this.log('[ai] step error: ' + (e && e.stack || e)); }
  }

  _stepInner() {
    const cfg = this.cfg();
    if (!cfg.enabled) { if (this.attached) { this._release(); this.attached = false; this.mem.detach(); } return; }

    if (!this.mem.attach()) {
      if (this.attached) { this.log('[ai] NR2003.exe went away'); this.edit.reset(); }
      this.attached = false; this.pid = 0;
      return;
    }
    if (this.mem.pid !== this.pid) {            // new process (first attach, or the game restarted)
      this.pid = this.mem.pid;
      this.attached = true;
      this.edit.reset();
      this._verifyBuild();
    }
    this.attached = true;
    if (!this.build.ok) return;                  // never write into a build we do not recognise

    if (!!cfg.crashing !== !!this.edit.crashing) this.edit.setCrashing(!!cfg.crashing);
    if (!!cfg.pitYellow !== !!this.edit.pitYellow) this.edit.setPitYellow(!!cfg.pitYellow);
    if (cfg.damage != null && Number.isFinite(cfg.damage)) { if (this.edit.readDamage() !== Math.fround(cfg.damage)) this.edit.setDamage(cfg.damage); }
    else if (this.edit.damageOriginal != null) this.edit.restoreDamage();
  }

  // ── state for the UI ────────────────────────────────────────────────────────
  getState() {
    return {
      enabled: this.cfg().enabled,
      dryRun: this.cfg().dryRun !== false,
      pendingWrites: { count: this.shadow.count, recent: this.shadow.recent.slice() },
      attached: this.attached, pid: this.pid, build: this.build,
      config: this.cfg(),
      edit: this.edit.status(),
      error: this.error,
    };
  }

  registerIpc({ ipcMain }) {
    const h = (name, fn) => ipcMain.handle('ai:' + name, async (e, ...a) => {
      try { return await fn(...a); } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
    h('get-state', () => this.getState());
    h('set-config', patch => { this.setConfig(patch); return { ok: true, state: this.getState() }; });
  }
}

module.exports = { AIService, DEFAULTS };
