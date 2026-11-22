// The qualifying timing box over the game: a transparent, click-through, always-on-top window placed on NR2003's window
// (fractions of the game window + a size factor, like RaceControl's board layout), drawn by qualbox.html from the data the
// RaceControl service builds. "Place the box" opens it draggable with a sample: drag, mouse wheel to size, Enter / double
// click to save, Esc to cancel. NR2003 has to run windowed or borderless for any overlay to show above it.
'use strict';
const path = require('path');
const { gameRect } = require('./racecontrol/gamewindow');
// a rect setBounds will take: whole numbers, at least 1x1
function intRect(r) {
  const n = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
  return { x: n(r.x, 0), y: n(r.y, 0), width: Math.max(1, n(r.width, 1)), height: Math.max(1, n(r.height, 1)) };
}
const { sampleBox } = require('./racecontrol/qualbox');

const W = 420, H = 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class QualBoxWindow {
  // deps: { BrowserWindow, screen, ipcMain, getService() -> RaceControlService|null, saveLayout(layout), log }
  constructor(deps) {
    this.d = deps;
    this.win = null; this.placing = false; this.key = ''; this.timer = null; this.ready = false; this.pending = null;
    this.edit = null;                       // layout while placing
    const { ipcMain } = deps;
    ipcMain.on('qualbox:ready', () => { this.ready = true; if (this.pending) this._send(this.pending); });
    ipcMain.on('qualbox:move', (e, dx, dy) => { if (this.placing && this.win) { const b = this.win.getBounds(); this.win.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height }); } });
    ipcMain.on('qualbox:wheel', (e, dir) => { if (this.placing && this.edit) { this.edit.scale = clamp(this.edit.scale + (dir > 0 ? 0.05 : -0.05), 0.4, 2.5); this._resize(true); } });
    ipcMain.on('qualbox:save', () => this._finishPlacing(true));
    ipcMain.on('qualbox:cancel', () => this._finishPlacing(false));
  }

  start() { this.timer = setInterval(() => this._tick(), 120); }
  stop() { clearInterval(this.timer); this._close(); }

  // the game window in DIPs, or the primary display
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

  _layout() {
    const svc = this.d.getService();
    const l = (svc && svc.cfg().QualBox) || {};
    return { x: typeof l.x === 'number' ? l.x : NaN, y: typeof l.y === 'number' ? l.y : NaN, scale: l.scale > 0.2 && l.scale < 3 ? l.scale : 1 };
  }

  _geometry(layout) {
    const a = this._area();
    const s = clamp(a.height / 1080 * 1.2 * layout.scale, 0.3, 3);
    const w = Math.round(W * s), h = Math.round(H * s);
    let x = Number.isNaN(layout.x) ? a.x + Math.max(8, Math.round(a.width / 50)) : a.x + Math.round(layout.x * a.width);
    let y = Number.isNaN(layout.y) ? a.y + Math.round(a.height * 0.8) : a.y + Math.round(layout.y * a.height);
    const disp = this.d.screen.getDisplayNearestPoint({ x: a.x + 10, y: a.y + 10 }).bounds;
    x = Math.max(disp.x - w + 40, Math.min(disp.x + disp.width - 40, x));
    y = Math.max(disp.y, Math.min(disp.y + disp.height - 40, y));
    return { x, y, width: w, height: h, area: a };
  }

  _open(edit) {
    if (this.win && !this.win.isDestroyed()) return;
    const g = this._geometry(edit ? this.edit : this._layout());
    this.ready = false; this.key = '';
    const win = new this.d.BrowserWindow({
      x: g.x, y: g.y, width: g.width, height: g.height, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
      resizable: false, focusable: !!edit, show: false, hasShadow: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (!edit) win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(__dirname, 'qualbox.html'), edit ? { query: { edit: '1' } } : undefined);
    win.once('ready-to-show', () => { if (!win.isDestroyed()) edit ? win.show() : win.showInactive(); });
    win.on('closed', () => { if (this.win === win) { this.win = null; this.ready = false; if (this.placing) { this.placing = false; this.edit = null; } } });
    this.win = win;
  }

  _close() { if (this.win && !this.win.isDestroyed()) this.win.close(); this.win = null; this.ready = false; this.key = ''; }

  _send(data) { if (this.win && !this.win.isDestroyed() && this.ready) this.win.webContents.send('qualbox:data', data); else this.pending = data; }

  _resize(edit) {
    if (!this.win || this.win.isDestroyed()) return;
    const cur = this.win.getBounds();
    const a = this._area();
    const s = clamp(a.height / 1080 * 1.2 * (edit ? this.edit.scale : this._layout().scale), 0.3, 3);
    this.win.setBounds({ x: cur.x, y: cur.y, width: Math.round(W * s), height: Math.round(H * s) });
  }

  _tick() {
    if (this.placing) return;
    const svc = this.d.getService();
    const data = svc && svc.cfg().enabled ? svc.qualBoxData() : null;
    if (!data) { if (this.win) this._close(); return; }
    if (!this.win || this.win.isDestroyed()) this._open(false);
    // follow the game window / layout changes
    const g = this._geometry(this._layout());
    const b = this.win.getBounds();
    if (Math.abs(b.x - g.x) > 1 || Math.abs(b.y - g.y) > 1 || b.width !== g.width || b.height !== g.height) { try { this.win.setBounds(intRect(g)); } catch (e) { /* a bad rect must never take the app down */ } }
    const key = JSON.stringify(data);
    if (key !== this.key) { this.key = key; this._send(data); }
  }

  // "Place the box": a draggable sample (live data while a session is running)
  place() {
    if (this.placing) { if (this.win && !this.win.isDestroyed()) this.win.focus(); return; }
    this._close();
    this.placing = true;
    this.edit = this._layout();
    this._open(true);
    const svc = this.d.getService();
    this._send((svc && svc.qualBoxData()) || sampleBox());
  }

  _finishPlacing(save) {
    if (!this.placing) return;
    if (save && this.win && !this.win.isDestroyed()) {
      const a = this._area(), b = this.win.getBounds();
      this.d.saveLayout({ x: (b.x - a.x) / a.width, y: (b.y - a.y) / a.height, scale: this.edit.scale });
      this.d.log && this.d.log(`[qualbox] timing box placed, size ${Math.round(this.edit.scale * 100)}%`);
    }
    this.placing = false; this.edit = null;
    this._close();
  }
}

module.exports = { QualBoxWindow };
