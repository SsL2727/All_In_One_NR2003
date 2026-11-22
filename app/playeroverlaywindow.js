// The player's qualifying overlay over the game (RaceControl 1.2.0's banner, broadcast panel and ready card): one transparent, always-on-top
// window laid over NR2003's window, drawn by playeroverlay.html from what the RaceControl service builds. It is click-through except over the
// ready card (the page tells us when the pointer is on it). "Place the banner" / "Place the box" open it draggable with a sample: drag, mouse
// wheel to size, Enter / double click to save, Esc to cancel. NR2003 has to run windowed or borderless for any overlay to show above it.
'use strict';
const path = require('path');
const { gameRect } = require('./racecontrol/gamewindow');
// a rect setBounds will take: whole numbers, at least 1x1
function intRect(r) {
  const n = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
  return { x: n(r.x, 0), y: n(r.y, 0), width: Math.max(1, n(r.width, 1)), height: Math.max(1, n(r.height, 1)) };
}
const { sampleBroadcast } = require('./racecontrol/qualbox');

class PlayerOverlayWindow {
  // deps: { BrowserWindow, screen, ipcMain, getService() -> RaceControlService|null, log }
  constructor(deps) {
    this.d = deps;
    this.win = null; this.key = ''; this.timer = null; this.ready = false; this.pending = null; this.placing = null;
    const { ipcMain } = deps;
    ipcMain.on('pov:ready', () => { this.ready = true; if (this.pending) this._send(this.pending); });
    ipcMain.on('pov:hover', (e, over) => { if (this.win && !this.win.isDestroyed() && !this.placing) this.win.setIgnoreMouseEvents(!over, { forward: true }); });
    ipcMain.on('pov:resume', () => { const svc = this.d.getService(); if (svc) svc.qualResume(); });
    ipcMain.on('pov:save', (e, which, layout) => this._finishPlacing(which, layout));
    ipcMain.on('pov:cancel', () => this._finishPlacing(null));
  }

  start() { this.timer = setInterval(() => this._tick(), 120); }
  stop() { clearInterval(this.timer); this._close(); }

  _area() {
    const svc = this.d.getService();
    const pid = svc && svc.attached ? svc.pid : 0;
    const r = gameRect(pid);
    if (r) {
      // whole pixels: at 125% / 150% display scaling screenToDipRect gives fractions, and setBounds throws on them
      try { const dip = this.d.screen.screenToDipRect(null, r); if (dip && dip.width > 0) return intRect(dip); } catch (e) { /* fall through */ }
      return intRect(r);
    }
    const b = this.d.screen.getPrimaryDisplay().bounds;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  _open(edit) {
    if (this.win && !this.win.isDestroyed()) return;
    const a = this._area();
    this.ready = false; this.key = '';
    const win = new this.d.BrowserWindow({
      x: a.x, y: a.y, width: a.width, height: a.height, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
      resizable: false, focusable: !!edit, show: false, hasShadow: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (!edit) win.setIgnoreMouseEvents(true, { forward: true });
    win.loadFile(path.join(__dirname, 'playeroverlay.html'), edit ? { query: { edit } } : undefined);
    win.once('ready-to-show', () => { if (!win.isDestroyed()) edit ? win.show() : win.showInactive(); });
    win.on('closed', () => { if (this.win === win) { this.win = null; this.ready = false; this.placing = null; } });
    this.win = win;
  }

  _close() { if (this.win && !this.win.isDestroyed()) this.win.close(); this.win = null; this.ready = false; this.key = ''; this.placing = null; }

  _send(data) { if (this.win && !this.win.isDestroyed() && this.ready) this.win.webContents.send('pov:data', data); else this.pending = data; }

  _tick() {
    if (this.placing) return;
    const svc = this.d.getService();
    const data = svc && svc.cfg().enabled ? svc.overlayData() : null;
    if (!data) { if (this.win) this._close(); return; }
    if (!this.win || this.win.isDestroyed()) this._open(null);
    const a = this._area(), b = this.win.getBounds();
    if (Math.abs(b.x - a.x) > 1 || Math.abs(b.y - a.y) > 1 || b.width !== a.width || b.height !== a.height) { try { this.win.setBounds(intRect(a)); } catch (e) { /* a bad rect must never take the app down */ } }
    const key = JSON.stringify(data);
    if (key !== this.key) { this.key = key; this._send(data); }
  }

  // "Place the banner" / "Place the box" (which = 'banner' | 'broad')
  place(which) {
    if (this.placing) { if (this.win && !this.win.isDestroyed()) this.win.focus(); return; }
    this._close();
    this.placing = which;
    this._open(which);
    const svc = this.d.getService();
    const c = svc ? svc.cfg() : {};
    const sample = which === 'banner'
      ? { text: 'YOUR RUN: GO NOW - out lap, then 1 timed lap', kind: 1, timer: 'AT THE GREEN IN|0:42', urgent: false }
      : sampleBroadcast();
    this._send({ layouts: { banner: c.PlayerBanner || {}, broad: c.QualBox || {}, card: c.ResumeCard || {} }, sample });
  }

  _finishPlacing(which, layout) {
    if (!this.placing) return;
    const was = this.placing;
    if (which && layout) {
      const svc = this.d.getService();
      if (svc) svc.setConfig(which === 'banner' ? { PlayerBanner: layout } : { QualBox: layout });
      this.d.log && this.d.log(`[playeroverlay] ${was === 'banner' ? 'banner' : 'broadcast panel'} placed, size ${Math.round(layout.scale * 100)}%`);
    }
    this._close();
  }
}

module.exports = { PlayerOverlayWindow };
