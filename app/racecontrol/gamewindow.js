// Finds NR2003's window (the biggest visible top-level window of its process) so overlays can be placed over the game.
// Returns the CLIENT area in physical screen pixels, or null. Windows only; any failure just returns null.
'use strict';

let api = null;
function bind() {
  if (api) return api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const RECT = koffi.struct('QB_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const POINT = koffi.struct('QB_POINT', { x: 'int32', y: 'int32' });
  const EnumProc = koffi.proto('bool __stdcall QB_EnumProc(void *hwnd, intptr_t lparam)');
  api = {
    koffi, RECT, POINT, EnumProc,
    EnumWindows: user32.func('bool __stdcall EnumWindows(QB_EnumProc *cb, intptr_t lparam)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
    GetClientRect: user32.func('bool __stdcall GetClientRect(void *hwnd, _Out_ QB_RECT *r)'),
    ClientToScreen: user32.func('bool __stdcall ClientToScreen(void *hwnd, _Inout_ QB_POINT *p)'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *hwnd)'),
    MapVirtualKeyW: user32.func('uint32 __stdcall MapVirtualKeyW(uint32 code, uint32 type)'),
    keybd_event: user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)'),
  };
  return api;
}

// -> { left, top, width, height } (physical pixels) or null
function gameRect(pid) {
  if (!pid) return null;
  try {
    const a = bind();
    let best = null;
    const cb = a.koffi.register((hwnd) => {
      const p = [0];
      a.GetWindowThreadProcessId(hwnd, p);
      if (p[0] !== pid || !a.IsWindowVisible(hwnd) || a.IsIconic(hwnd)) return true;
      const r = {}; if (!a.GetClientRect(hwnd, r)) return true;
      const w = r.right - r.left, h = r.bottom - r.top;
      if (w > 200 && h > 200 && (!best || w * h > best.w * best.h)) {
        const pt = { x: 0, y: 0 }; a.ClientToScreen(hwnd, pt);
        best = { left: pt.x, top: pt.y, width: w, height: h, w, h };
      }
      return true;
    }, a.koffi.pointer(a.EnumProc));
    try { a.EnumWindows(cb, 0); } finally { a.koffi.unregister(cb); }
    return best ? { left: best.left, top: best.top, width: best.width, height: best.height } : null;
  } catch (e) { return null; }
}

// the game's biggest visible window handle (pointer), or null
function gameHwnd(pid) {
  if (!pid) return null;
  try {
    const a = bind();
    let best = null;
    const cb = a.koffi.register((hwnd) => {
      const p = [0];
      a.GetWindowThreadProcessId(hwnd, p);
      if (p[0] !== pid || !a.IsWindowVisible(hwnd)) return true;
      const r = {}; if (!a.GetClientRect(hwnd, r)) return true;
      const area = (r.right - r.left) * (r.bottom - r.top);
      if (area > 40000 && (!best || area > best.area)) best = { hwnd, area };
      return true;
    }, a.koffi.pointer(a.EnumProc));
    try { a.EnumWindows(cb, 0); } finally { a.koffi.unregister(cb); }
    return best ? best.hwnd : null;
  } catch (e) { return null; }
}

function vkOf(name) {
  const n = String(name || 'Pause').trim();
  if (/^pause$/i.test(n)) return 0x13;
  if (/^f([1-9]|1[0-2])$/i.test(n)) return 0x70 + parseInt(n.slice(1), 10) - 1;
  if (/^[a-z0-9]$/i.test(n)) return n.toUpperCase().charCodeAt(0);
  const named = { space: 0x20, enter: 0x0D, tab: 0x09, escape: 0x1B, esc: 0x1B, scrolllock: 0x91, home: 0x24, end: 0x23, insert: 0x2D, delete: 0x2E };
  return named[n.toLowerCase()] || 0x13;
}

// press a key in the game (what the player's own pause key does): the game window first, then the key by scan code like RaceControl 1.2.0
function pressKey(pid, keyName) {
  try {
    const a = bind();
    const hwnd = gameHwnd(pid);
    if (hwnd) a.SetForegroundWindow(hwnd);
    const vk = vkOf(keyName);
    const pause = vk === 0x13;
    const scan = pause ? 69 : a.MapVirtualKeyW(vk, 0);
    const ext = pause ? 1 : 0;
    a.keybd_event(vk, scan, 8 | ext, 0);
    return new Promise(resolve => setTimeout(() => { try { a.keybd_event(vk, scan, 8 | ext | 2, 0); } catch (e) { /* ignore */ } resolve(true); }, 60));
  } catch (e) { return Promise.resolve(false); }
}

function focusGame(pid) {
  try { const a = bind(); const h = gameHwnd(pid); if (h) a.SetForegroundWindow(h); } catch (e) { /* ignore */ }
}

module.exports = { gameRect, gameHwnd, pressKey, focusGame, vkOf };
