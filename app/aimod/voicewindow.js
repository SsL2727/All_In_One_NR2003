// Speaks AIMOD's scanner radio / crew chief lines: a hidden window that plays them with the system's voices (speechSynthesis).
// The radio (aimod.radio, running on the Python VM) decides what is said; this only plays it.
'use strict';
const path = require('path');

class RadioVoiceWindow {
  // deps: { BrowserWindow, ipcMain, getRadioConfig() -> object }
  constructor(deps) {
    this.d = deps; this.win = null; this.ready = false; this.pending = [];
    deps.ipcMain.on('radiovoice:ready', () => { this.ready = true; for (const p of this.pending.splice(0)) this._send(p); });
    deps.ipcMain.on('radiovoice:sub', (e, info) => { try { if (deps.onSubtitle) deps.onSubtitle(info); } catch (err) { /* no box */ } });
  }

  _open() {
    if (this.win && !this.win.isDestroyed()) return;
    this.ready = false;
    const win = new this.d.BrowserWindow({
      show: false, width: 200, height: 100, skipTaskbar: true, focusable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, '..', 'preload.js'), backgroundThrottling: false },
    });
    win.loadFile(path.join(__dirname, '..', 'radiovoice.html'));
    win.on('closed', () => { if (this.win === win) { this.win = null; this.ready = false; } });
    this.win = win;
  }

  _send(payload) { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('radiovoice:say', payload); }

  say(msgs) {
    if (!msgs || !msgs.length) return;
    this._open();
    const payload = { msgs, cfg: this.d.getRadioConfig() || {} };
    if (this.ready) this._send(payload); else this.pending.push(payload);
  }

  stop() { if (this.win && !this.win.isDestroyed()) this.win.close(); this.win = null; this.ready = false; this.pending = []; }
}

module.exports = { RadioVoiceWindow };
