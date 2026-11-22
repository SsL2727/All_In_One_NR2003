// RaceVisionService — RaceVision (the NR2003 TV director) managed from All In One NR2003.
//
// RaceVision.exe stays what it is (its director, camera hook and broadcast graphics are untouched); All In One NR2003
//   * finds it next to NR2003, launches it (Windows asks for administrator rights, as NR2003 does) and can start it with NR2003,
//   * runs it from an MPH-fixed copy (app/racevision/mphfix.js) so the on-board speed is the car's real speed in mph,
//   * shows its remote page inside All In One NR2003's window (field, shot list, cameras, every setting, presets),
//   * and adds extra options on top by driving its remote API (favourite drivers, overlays only in the race, stages in sync).
// Off by default: All In One NR2003 only watches and drives RaceVision while this is switched on.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ext = require('../extmods');
const ini = require('./ini');
const fix = require('./mphfix');
const { RaceVisionApi } = require('./api');
const { Extras, DEFAULTS: EXTRAS_DEFAULTS } = require('./extras');

const FIXED_NAME = 'RaceVision_mphfix.exe';
const SIDECAR = 'RaceVision_mphfix.json';
const POLL_MS = 1000;
const DEFAULTS = { enabled: false, useFixed: true, extras: Object.assign({}, EXTRAS_DEFAULTS) };

const randomKey = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 8; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };

class RaceVisionService {
  // opts: { getConfig, saveConfig, log, getStageEnds?, deps? (tests: { exec, execFile, runningNames, apiFactory, now }) }
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || (() => {});
    this.deps = opts.deps || {};
    this.timer = null;
    this.S = null; this.reachable = false; this.lastError = ''; this.lastIniAt = 0; this.iniVals = {};
    this.api = null;
    this.extras = new Extras({
      getConfig: () => this.cfg().extras, api: { focus: s => this._api().focus(s), set: (n, v) => this._api().set(n, v) },
      getStageEnds: () => (this.opts.getStageEnds ? this.opts.getStageEnds() : null), log: m => this.log(m), now: this.deps.now,
    });
    this.busy = false;
  }

  cfg() {
    const c = this.opts.getConfig();
    c.raceVision = Object.assign({}, DEFAULTS, c.raceVision || {});
    c.raceVision.extras = Object.assign({}, EXTRAS_DEFAULTS, c.raceVision.extras || {});
    return c.raceVision;
  }

  setConfig(patch) {
    const c = this.cfg();
    if (patch) {
      if (typeof patch.enabled === 'boolean') c.enabled = patch.enabled;
      if (typeof patch.useFixed === 'boolean') c.useFixed = patch.useFixed;
      if (patch.extras && typeof patch.extras === 'object') {
        const e = c.extras;
        for (const k of Object.keys(EXTRAS_DEFAULTS)) if (k in patch.extras) e[k] = patch.extras[k];
        if (!['off', 'events'].includes(e.favMode)) e.favMode = 'off';
        e.favGapSec = Math.max(5, Math.min(600, Number(e.favGapSec) || 40));
        e.favorites = String(e.favorites || '').replace(/[^0-9a-zA-Z,;#\s]/g, '').slice(0, 200);
        e.overlaysOnlyRace = !!e.overlaysOnlyRace; e.syncStages = !!e.syncStages;
      }
      this.opts.saveConfig();
      this.extras.reset();
    }
    return c;
  }

  // ── where things are ────────────────────────────────────────────────────────
  exePath() { return ext.findExe('raceVision', this.opts.getConfig()); }
  dir() { const e = this.exePath(); return e ? path.dirname(e) : ''; }
  iniPath() { const d = this.dir(); return d ? path.join(d, 'racevision.ini') : ''; }
  fixedPath() { const d = this.dir(); return d ? path.join(d, FIXED_NAME) : ''; }

  _names() { return (this.deps.runningNames || ((n, t) => ext.runningNames(undefined, Date.now(), t)))(null, 1500); }
  running() {
    const names = this._names();
    return names.has('racevision.exe') || names.has(FIXED_NAME.toLowerCase());
  }

  // ── the MPH-fixed copy ────────────────────────────────────────────────────────
  // -> { state: 'applied' | 'unsupported' | 'missing' | 'error' | 'off', path, reason }
  ensureFixed() {
    const exe = this.exePath();
    if (!exe) return { state: 'missing', path: '', reason: 'RaceVision.exe was not found' };
    const out = this.fixedPath(), side = path.join(path.dirname(exe), SIDECAR);
    try {
      const src = fs.readFileSync(exe);
      const sha = fix.sha1(src);
      try {
        const meta = JSON.parse(fs.readFileSync(side, 'utf8'));
        if (meta.sha1 === sha && fs.existsSync(out)) return { state: 'applied', path: out, reason: '' };
      } catch (e) { /* not made yet */ }
      const c = fix.check(src);
      if (!c.ok) return { state: 'unsupported', path: exe, reason: c.reason };
      const patched = fix.apply(src);
      fs.writeFileSync(out, patched);
      fs.writeFileSync(side, JSON.stringify({ sha1: sha, size: src.length, made: new Date().toISOString(), fix: 'classic on-board speed = true ground speed (mph)' }, null, 1));
      this.log(`[racevision] MPH-fixed copy written: ${out}`);
      return { state: 'applied', path: out, reason: '' };
    } catch (e) {
      return { state: 'error', path: exe, reason: e && e.message };
    }
  }

  fixStatus() {
    const exe = this.exePath();
    if (!exe) return { state: 'missing', reason: 'RaceVision.exe was not found' };
    if (!this.cfg().useFixed) return { state: 'off', reason: 'running the original exe' };
    try {
      const sha = fix.sha1(fs.readFileSync(exe));
      const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(exe), SIDECAR), 'utf8'));
      if (meta.sha1 === sha && fs.existsSync(this.fixedPath())) return { state: 'applied', reason: '' };
    } catch (e) { /* fall through */ }
    const c = fix.check(fs.readFileSync(exe));
    return c.ok ? { state: 'ready', reason: 'will be created when RaceVision is started from All In One NR2003' } : { state: 'unsupported', reason: c.reason };
  }

  // ── remote settings (RaceVision's phone remote is what All In One NR2003 talks to) ──────────────────────
  readIni() {
    const t = Date.now();
    if (t - this.lastIniAt > 3000) {
      this.lastIniAt = t;
      const v = ini.readFile(this.iniPath());
      this.iniVals = v;
    }
    return this.iniVals;
  }
  _api() {
    const v = this.readIni();
    const port = parseInt(v.remote_port, 10) || 8090, key = v.remote_key || '';
    if (!this.api || this.api.port !== port || this.api.key !== key) this.api = (this.deps.apiFactory || (o => new RaceVisionApi(o)))({ port, key });
    return this.api;
  }
  remoteUrl() {
    const v = this.readIni();
    return `http://127.0.0.1:${parseInt(v.remote_port, 10) || 8090}/?k=${encodeURIComponent(v.remote_key || '')}`;
  }
  // make sure the remote is on and has a pairing code (RaceVision reads racevision.ini when it starts)
  ensureRemote() {
    const p = this.iniPath();
    if (!p) return { ok: false, error: 'RaceVision was not found' };
    const v = ini.readFile(p), patch = {};
    if (v.remote !== '1') patch.remote = '1';
    if (!v.remote_key) patch.remote_key = randomKey();
    if (!v.remote_port) patch.remote_port = '8090';
    if (Object.keys(patch).length) { ini.updateFile(p, patch); this.lastIniAt = 0; return { ok: true, changed: Object.keys(patch) }; }
    return { ok: true, changed: [] };
  }

  // ── launch / stop ─────────────────────────────────────────────────────────────────────────────
  async launch() {
    const exe = this.exePath();
    if (!exe) return { ok: false, error: 'RaceVision.exe was not found. Put it next to NR2003 (a RaceVision folder) or browse to it.' };
    if (this.running()) return { ok: true, already: true };
    this.ensureRemote();
    let target = exe, fixNote = '';
    if (this.cfg().useFixed) {
      const f = this.ensureFixed();
      if (f.state === 'applied') target = f.path; else fixNote = f.reason;
    }
    const execFile = this.deps.execFile || cp.execFile;
    return new Promise(resolve => {
      execFile('powershell.exe', ext.launchArgs(target), { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
        ext.resetRunCache();
        if (err) {
          const text = String((stderr || err.message || '')).trim();
          resolve({ ok: false, error: /cancel/i.test(text) ? 'Windows asked for administrator rights and it was declined.' : (text.split(/\r?\n/)[0] || 'launch failed') });
        } else resolve({ ok: true, fixed: target !== exe, note: fixNote });
      });
    });
  }

  stop() {
    const exec = this.deps.execFile || cp.execFile;
    for (const n of ['RaceVision.exe', FIXED_NAME]) { try { exec('taskkill', ['/IM', n, '/F'], { windowsHide: true }, () => {}); } catch (e) { /* not running */ } }
    ext.resetRunCache();
    this.S = null; this.reachable = false;
    return { ok: true };
  }

  // ── polling + extras ────────────────────────────────────────────────────────────────────────────
  start() { this.timer = setInterval(() => this._poll(), POLL_MS); }
  stopService() { clearInterval(this.timer); }

  async _poll() {
    if (this.busy) return;
    const c = this.cfg();
    if (!c.enabled || !this.exePath()) { this.S = null; this.reachable = false; return; }
    this.busy = true;
    try {
      const S = await this._api().state();
      this.S = S; this.reachable = true; this.lastError = '';
      await this.extras.tick(S);
    } catch (e) {
      this.reachable = false; this.S = null;
      this.lastError = e && e.status === 403 ? 'RaceVision says this pairing code is not right (remote_key)' : '';
    } finally { this.busy = false; }
  }

  getState() {
    const S = this.S;
    return {
      config: this.cfg(), installed: !!this.exePath(), exe: this.exePath(), running: this.running(), reachable: this.reachable, error: this.lastError,
      fix: this.fixStatus(), remoteUrl: this.exePath() ? this.remoteUrl() : '',
      live: S ? { attached: !!S.attached, race: !!S.race, lap: S.lap, laps: S.laps, flag: S.flag, paused: !!S.paused, overlays: !!S.overlays, cam: S.cam, on: S.on ? { num: S.on.num, name: S.on.name, pos: S.on.pos, kind: S.on.kind, manual: !!S.on.manual } : null } : null,
    };
  }

  registerIpc({ ipcMain, shell }) {
    ipcMain.handle('rv:get-state', () => this.getState());
    ipcMain.handle('rv:set-config', (e, p) => { this.setConfig(p); return this.getState(); });
    ipcMain.handle('rv:launch', () => this.launch());
    ipcMain.handle('rv:stop', () => this.stop());
    ipcMain.handle('rv:ensure-remote', () => this.ensureRemote());
    ipcMain.handle('rv:open-folder', () => { const d = this.dir(); if (d && shell) shell.openPath(d); return !!d; });
    ipcMain.handle('rv:open-log', () => { const d = this.dir(); if (d && shell) shell.openPath(path.join(d, 'racevision.log')); return !!d; });
  }
}

module.exports = { RaceVisionService, DEFAULTS, FIXED_NAME };
