// RaceControl's broadcast graphics over the game: one transparent, click-through, always-on-top window laid over NR2003's window
// (or the primary display when the game is not found), drawn by rcgfx.html from what the RaceControl service builds (the choose cone
// board and the caution panel). NR2003 has to run windowed or borderless for any overlay to show above it.
'use strict';
const path = require('path');
const { gameRect } = require('./racecontrol/gamewindow');
// a rect setBounds will take: whole numbers, at least 1x1
function intRect(r) {
  const n = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
  return { x: n(r.x, 0), y: n(r.y, 0), width: Math.max(1, n(r.width, 1)), height: Math.max(1, n(r.height, 1)) };
}

class RcGfxWindow {
  // deps: { BrowserWindow, screen, ipcMain, getService() -> RaceControlService|null, log }
  constructor(deps) {
    this.d = deps;
    this.win = null; this.key = ''; this.timer = null; this.ready = false; this.pending = null;
    deps.ipcMain.on('rcgfx:ready', () => { this.ready = true; if (this.pending) this._send(this.pending); });
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

  _open() {
    if (this.win && !this.win.isDestroyed()) return;
    const a = this._area();
    this.ready = false; this.key = '';
    const win = new this.d.BrowserWindow({
      x: a.x, y: a.y, width: a.width, height: a.height, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
      resizable: false, focusable: false, show: false, hasShadow: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(__dirname, 'rcgfx.html'));
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
    win.on('closed', () => { if (this.win === win) { this.win = null; this.ready = false; } });
    this.win = win;
  }

  _close() { if (this.win && !this.win.isDestroyed()) this.win.close(); this.win = null; this.ready = false; this.key = ''; }

  _send(data) { if (this.win && !this.win.isDestroyed() && this.ready) this.win.webContents.send('rcgfx:data', data); else this.pending = data; }

  _tick() {
    const svc = this.d.getService();
    const data = svc ? svc.gfxData() : null;
    if (!data) { if (this.win) this._close(); return; }
    if (!this.win || this.win.isDestroyed()) this._open();
    const a = this._area(), b = this.win.getBounds();
    if (Math.abs(b.x - a.x) > 1 || Math.abs(b.y - a.y) > 1 || b.width !== a.width || b.height !== a.height) { try { this.win.setBounds(intRect(a)); } catch (e) { /* a bad rect must never take the app down */ } }
    const key = JSON.stringify(data);
    if (key !== this.key) { this.key = key; this._send(data); }
    this._front();
  }

  // AIMOD 2.2's pit board re-raises itself (SetWindowPos HWND_TOPMOST) at most every 2 s, or the game can cover it after a focus change
  _front(now = Date.now()) {
    if (!this.win || this.win.isDestroyed() || now - (this._frontAt || 0) < 2000) return false;
    this._frontAt = now;
    try { this.win.moveTop(); } catch (e) { return false; }
    return true;
  }
}

module.exports = { RcGfxWindow };
