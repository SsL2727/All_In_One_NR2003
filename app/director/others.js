// Other programs' overlay windows out of the way while a replay is on (RaceVision 1.2.0 hide_companion_overlays, racevision_tape.cpp).
// A ticker or track map from another app would sit on top of a replay. While a replay or a wipe is on, the visible overlay windows of the
// programs named in companion_apps (a part of the exe's path; blank = every other program) are hidden and moved far off screen, and put
// back where they were once back to live. Only windows without an owner and without a title bar (an app's own window has one) and - when
// no program is named - topmost ones (that is what an overlay is). Windows' own shell, NR2003 and All In One NR2003 itself are never touched
// (All In One NR2003's own broadcast widgets are hidden by main.js through Electron).
'use strict';

let K = null;
function bind() {
  if (K) return K;
  const koffi = require('koffi');
  const u32 = koffi.load('user32.dll'), k32 = koffi.load('kernel32.dll');
  const EnumProc = koffi.proto('__stdcall', 'RvEnumWindowsProc', 'bool', ['intptr_t', 'intptr_t']);
  const RECT = koffi.struct('RvRECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  K = {
    koffi, EnumProc, RECT,
    EnumWindows: u32.func('__stdcall', 'EnumWindows', 'bool', [koffi.pointer(EnumProc), 'intptr_t']),
    IsWindowVisible: u32.func('__stdcall', 'IsWindowVisible', 'bool', ['intptr_t']),
    IsWindow: u32.func('__stdcall', 'IsWindow', 'bool', ['intptr_t']),
    GetWindow: u32.func('__stdcall', 'GetWindow', 'intptr_t', ['intptr_t', 'uint32']),
    GetWindowLongW: u32.func('__stdcall', 'GetWindowLongW', 'int32', ['intptr_t', 'int32']),
    GetWindowThreadProcessId: u32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr_t', koffi.out(koffi.pointer('uint32'))]),
    GetWindowRect: u32.func('__stdcall', 'GetWindowRect', 'bool', ['intptr_t', koffi.out(koffi.pointer(RECT))]),
    SetWindowPos: u32.func('__stdcall', 'SetWindowPos', 'bool', ['intptr_t', 'intptr_t', 'int32', 'int32', 'int32', 'int32', 'uint32']),
    OpenProcess: k32.func('__stdcall', 'OpenProcess', 'intptr_t', ['uint32', 'bool', 'uint32']),
    CloseHandle: k32.func('__stdcall', 'CloseHandle', 'bool', ['intptr_t']),
    QueryFullProcessImageNameW: k32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['intptr_t', 'uint32', koffi.out(koffi.pointer('uint16_t', 1)), koffi.inout(koffi.pointer('uint32'))]),
  };
  return K;
}

const WS_CAPTION = 0x00C00000, WS_EX_TOPMOST = 0x8, GW_OWNER = 4, GWL_STYLE = -16, GWL_EXSTYLE = -20;
const SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40, SWP_HIDEWINDOW = 0x80, SWP_ASYNCWINDOWPOS = 0x4000;

// "a; b" -> does the (lower case) path contain one of them
function listHit(list, p) { return String(list || '').toLowerCase().split(';').map(s => s.trim()).filter(Boolean).some(t => p.includes(t)); }

class OtherOverlays {
  constructor(log) { this.log = log || (() => {}); this.hidden = []; this.on = false; this.guard = null; this.opts = { apps: '', keep: '' }; }

  _procWanted(pid, cache) {
    if (cache.has(pid)) return cache.get(pid);
    const k = bind();
    let want = false;
    const h = k.OpenProcess(0x1000, false, pid);
    if (h) {
      try {
        const buf = Buffer.alloc(1040), size = [520];
        if (k.QueryFullProcessImageNameW(h, 0, buf, size)) {
          const p = buf.toString('utf16le', 0, size[0] * 2).toLowerCase(), base = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
          const win = String(process.env.SystemRoot || process.env.windir || 'C:\\Windows').toLowerCase();
          const system = (win && p.startsWith(win)) || p.includes('\\windowsapps\\') || base === 'nr2003.exe';
          want = !system && !listHit(this.opts.keep, p) && (!String(this.opts.apps || '').trim() || listHit(this.opts.apps, p));
        }
      } finally { k.CloseHandle(h); }
    }
    cache.set(pid, want);
    return want;
  }
  // the overlay windows visible now
  _scan() {
    const k = bind(), cache = new Map(), found = [], me = process.pid, named = !!String(this.opts.apps || '').trim();
    const cb = k.koffi.register((h) => {
      try {
        if (!k.IsWindowVisible(h) || k.GetWindow(h, GW_OWNER)) return true;
        const st = k.GetWindowLongW(h, GWL_STYLE), ex = k.GetWindowLongW(h, GWL_EXSTYLE);
        if (st & WS_CAPTION) return true;                                       // the app's own window, not an overlay
        if (!named && !(ex & WS_EX_TOPMOST)) return true;
        const pid = [0]; k.GetWindowThreadProcessId(h, pid);
        if (pid[0] === me || !this._procWanted(pid[0], cache)) return true;
        const r = {}; k.GetWindowRect(h, r);
        if (r.right - r.left < 32 || r.bottom - r.top < 32) return true;         // helper windows
        found.push({ h, r });
      } catch (e) { /* that window went away */ }
      return true;
    }, k.koffi.pointer(k.EnumProc));
    try { k.EnumWindows(cb, 0); } finally { k.koffi.unregister(cb); }
    return found;
  }
  _hideWin(h) { bind().SetWindowPos(h, 0, -32000, -32000, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW | SWP_ASYNCWINDOWPOS); }
  // hide what is visible now that isn't yet hidden -> how many are hidden in all
  hide(opts) {
    this.opts = Object.assign({ apps: '', keep: '' }, opts || {});
    try {
      for (const w of this._scan()) {
        if (!this.hidden.some(x => x.h === w.h)) this.hidden.push({ h: w.h, x: w.r.left < -20000 ? 0 : w.r.left, y: w.r.left < -20000 ? 0 : w.r.top });
        this._hideWin(w.h);
      }
    } catch (e) { this.log('other overlays: ' + (e && e.message || e)); return this.hidden.length; }
    this.on = true;
    // the guard: anything hidden that is visible again or back on screen goes away again; new overlay windows too
    if (!this.guard) {
      let n = 0;
      this.guard = setInterval(() => {
        if (!this.on) return;
        const k = bind();
        for (const w of this.hidden) {
          try {
            if (!k.IsWindow(w.h)) continue;
            const r = {}; k.GetWindowRect(w.h, r);
            if (k.IsWindowVisible(w.h) || r.left > -20000) this._hideWin(w.h);
          } catch (e) { /* gone */ }
        }
        if (++n % 8 === 0) this.hide(this.opts);
      }, 50);
      if (this.guard.unref) this.guard.unref();
    }
    return this.hidden.length;
  }
  show() {
    this.on = false;
    if (this.guard) { clearInterval(this.guard); this.guard = null; }
    const k = this.hidden.length ? bind() : null;
    for (const w of this.hidden) {
      try { if (k.IsWindow(w.h)) k.SetWindowPos(w.h, 0, w.x, w.y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS); } catch (e) { /* gone */ }
    }
    const n = this.hidden.length;
    this.hidden = [];
    return n;
  }
}

module.exports = { OtherOverlays, listHit };
