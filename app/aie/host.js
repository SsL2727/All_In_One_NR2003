// "Run the original AI Enhanced": starts the real AI Enhanced.exe (minimized) whenever NR2003 is running. All In One NR2003's environment
// layer continues to run and reapplies its values after the original executable. Closes it again when NR2003 closes.
'use strict';
const path = require('path');
const { spawn, execFile } = require('child_process');

const rx = /^ai enhanced.*\.exe$/;

class AieHost {
  // opts: { getHost: () => { enabled, exe }, runningNames: () => Set<lowercase exe names>, log }
  constructor(opts) { this.opts = opts; this.started = false; this.lastTry = 0; this.note = ''; }

  tick(now = Date.now()) {
    const h = this.opts.getHost();
    const names = this.opts.runningNames();
    const aie = [...names].find(n => rx.test(n));
    const game = names.has('nr2003.exe');
    if (!h.enabled) { this.note = ''; return; }
    if (!h.exe) { this.note = 'choose where AI Enhanced.exe is'; return; }
    if (game && !aie && now - this.lastTry > 15000) {
      this.lastTry = now;
      try {
        spawn('cmd.exe', ['/c', 'start', '/min', '""', h.exe], { cwd: path.dirname(h.exe), detached: true, stdio: 'ignore', windowsHide: true }).unref();
        this.started = true; this.note = 'started ' + path.basename(h.exe);
        if (this.opts.log) this.opts.log('started the original ' + path.basename(h.exe) + ' (minimized)');
      } catch (e) { this.note = 'could not start it: ' + e.message; }
    }
    if (!game && aie && this.started) this.stop(aie);
    if (aie) this.note = 'the original ' + aie + ' is running';
  }

  stop(name) {
    const h = this.opts.getHost();
    const exe = name || (h.exe ? path.basename(h.exe) : '');
    if (!this.started || !exe) return;
    this.started = false;
    try { execFile('taskkill', ['/IM', exe, '/F'], () => {}); } catch (e) { /* ignore */ }
    if (this.opts.log) this.opts.log('closed ' + exe + ' (NR2003 closed)');
  }
}

module.exports = { AieHost };
