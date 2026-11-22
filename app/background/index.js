// NR2003 in the background (NR2003 Background by NCRDesigns / MiaSquirtle, built in): the game keeps its video and sound going when its
// window loses focus, so overlays, OBS and the other All In One NR2003 windows can be clicked while the race runs on.
//
// Sound: NR2003 makes every DirectSound buffer at 0x6C3D30 with a DSBUFFERDESC whose flags come from one of three instructions,
//   0x6C3D57  mov dword [esp+38h], 000100A0h      C7 44 24 38 A0 00 01 00
//   0x6C3D6E  mov dword [esp+38h], 000300B0h      C7 44 24 38 B0 00 03 00
//   0x6C3D78  mov dword [esp+38h], 000100E0h      C7 44 24 38 E0 00 01 00
// and without DSBCAPS_GLOBALFOCUS (0x8000) DirectSound mutes a buffer while another window has the focus. The flag is set in the
// running game (the exe file is never changed), every other flag kept; a site that isn't these exact bytes is left alone. Like the
// original launcher, All In One NR2003 starts the game suspended, sets the flags and then lets it run, so every buffer has them; on a game
// that is already running only the sounds it makes from then on (the next session's) get them.
// Video: every 200 ms the game's window (class "PapyWin") is told it was clicked (WM_ACTIVATE, WA_CLICKACTIVE), so it never pauses its
// drawing. The game must run windowed (or borderless). As the original's notes say, this can upset a wheel or gamepad, so it is off
// unless asked for, and "sound only" sends no focus messages.
'use strict';

const SITES = [
  { addr: 0x6C3D57, flags: 0x000100A0 },
  { addr: 0x6C3D6E, flags: 0x000300B0 },
  { addr: 0x6C3D78, flags: 0x000100E0 },
];
const OPCODE = Buffer.from([0xC7, 0x44, 0x24, 0x38]);       // mov dword ptr [esp+38h], imm32
const GLOBALFOCUS = 0x8000;
const WM_ACTIVATE = 6, WA_CLICKACTIVE = 2, SMTO = 0x22 /* SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT */, CLASS = 'PapyWin', FOCUS_MS = 200;

// what is at one site: 'stock' (the game's own instruction), 'patched' (ours, already set) or 'other' (another version - left alone)
function siteState(bytes, site) {
  if (!bytes || bytes.length < 8 || !bytes.subarray(0, 4).equals(OPCODE)) return 'other';
  const v = bytes.readUInt32LE(4);
  if (v === site.flags) return 'stock';
  if (v === (site.flags | GLOBALFOCUS)) return 'patched';
  return 'other';
}

// sets the flag at the three sites of a game's memory (readBytes / writeBytes). All three are checked first: one that isn't the game's
// own instruction and nothing is written. -> { ok, written, msg }
function patchSound(mem) {
  const states = SITES.map(s => siteState(mem.readBytes(s.addr, 8), s));
  if (states.includes('other')) return { ok: false, written: 0, msg: "this NR2003.exe isn't the one NR2003 Background knows (the sound code is different) - nothing changed" };
  let written = 0;
  for (let i = 0; i < SITES.length; i++) {
    if (states[i] === 'patched') continue;
    const b = Buffer.alloc(4); b.writeUInt32LE((SITES[i].flags | GLOBALFOCUS) >>> 0);
    if (!mem.writeBytes(SITES[i].addr + 4, b)) return { ok: false, written, msg: "the game wouldn't take the sound flags" };
    written++;
  }
  const back = SITES.map(s => siteState(mem.readBytes(s.addr, 8), s));
  if (back.some(x => x !== 'patched')) return { ok: false, written, msg: "the sound flags didn't read back" };
  return { ok: true, written, msg: written ? 'background sound on (the exe file is unchanged)' : 'background sound was already on' };
}
// the game's own flags back (only where ours are)
function unpatchSound(mem) {
  let n = 0;
  for (const s of SITES) {
    if (siteState(mem.readBytes(s.addr, 8), s) !== 'patched') continue;
    const b = Buffer.alloc(4); b.writeUInt32LE(s.flags);
    if (mem.writeBytes(s.addr + 4, b)) n++;
  }
  return n;
}

// the same check on the exe file (before starting it): the three sites as the loader maps them
function checkExe(buf) {
  try {
    const pe = buf.readUInt32LE(0x3C);
    if (buf.readUInt32LE(pe) !== 0x4550 || buf.readUInt16LE(pe + 4) !== 0x14C) return { ok: false, msg: 'not a 32-bit Windows program' };
    const base = buf.readUInt32LE(pe + 24 + 28), nsec = buf.readUInt16LE(pe + 6), opt = buf.readUInt16LE(pe + 20);
    if (base !== 0x400000) return { ok: false, msg: 'unexpected image base' };
    const at = (va) => {
      for (let i = 0; i < nsec; i++) {
        const s = pe + 24 + opt + i * 40, vaddr = buf.readUInt32LE(s + 12), vsize = Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)), raw = buf.readUInt32LE(s + 20);
        if (va - base >= vaddr && va - base + 8 <= vaddr + vsize) return buf.subarray(raw + va - base - vaddr, raw + va - base - vaddr + 8);
      }
      return null;
    };
    const states = SITES.map(s => siteState(at(s.addr), s));
    return states.every(x => x === 'stock' || x === 'patched') ? { ok: true, msg: 'the three sound sites are the known ones' } : { ok: false, msg: "this NR2003.exe isn't the one NR2003 Background knows" };
  } catch (e) { return { ok: false, msg: 'could not read the exe: ' + e.message }; }
}

// ── Windows: starting the game suspended, finding its window, the focus message ──────────────────────────────────────────────
let W = null;
function win() {
  if (W) return W;
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll'), u32 = koffi.load('user32.dll');
  const STARTUPINFOW = koffi.struct('BG_STARTUPINFOW', {
    cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *', dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
    dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32', dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16',
    lpReserved2: 'void *', hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
  });
  const PROCESS_INFORMATION = koffi.struct('BG_PROCESS_INFORMATION', { hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32' });
  W = {
    koffi, STARTUPINFOW,
    CreateProcessW: k32.func('bool CreateProcessW(str16 app, str16 cmd, void *pa, void *ta, bool inherit, uint32 flags, void *env, str16 dir, BG_STARTUPINFOW *si, _Out_ BG_PROCESS_INFORMATION *pi)'),
    ResumeThread: k32.func('uint32 ResumeThread(void *h)'),
    TerminateProcess: k32.func('bool TerminateProcess(void *h, uint32 code)'),
    CloseHandle: k32.func('bool CloseHandle(void *h)'),
    ReadProcessMemory: k32.func('bool ReadProcessMemory(void *h, uintptr_t addr, _Out_ uint8_t *buf, size_t size, _Out_ size_t *read)'),
    WriteProcessMemory: k32.func('bool WriteProcessMemory(void *h, uintptr_t addr, uint8_t *buf, size_t size, _Out_ size_t *written)'),
    VirtualProtectEx: k32.func('bool VirtualProtectEx(void *h, uintptr_t addr, size_t size, uint32 newProtect, _Out_ uint32 *old)'),
    FlushInstructionCache: k32.func('bool FlushInstructionCache(void *h, uintptr_t addr, size_t size)'),
    FindWindowExW: u32.func('void *FindWindowExW(void *parent, void *after, str16 cls, str16 title)'),
    GetWindowThreadProcessId: u32.func('uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
    IsWindow: u32.func('bool IsWindow(void *hwnd)'),
    SendMessageTimeoutW: u32.func('uintptr_t SendMessageTimeoutW(void *hwnd, uint32 msg, uintptr_t w, intptr_t l, uint32 flags, uint32 ms, _Out_ uintptr_t *res)'),
  };
  return W;
}
// readBytes / writeBytes on a process handle (code pages made writable for the write, then put back)
function handleMemory(h) {
  const k = win();
  return {
    readBytes(addr, n) { const b = Buffer.alloc(n), got = [0]; return k.ReadProcessMemory(h, addr, b, n, got) && got[0] === n ? b : null; },
    writeBytes(addr, b) {
      const old = [0], done = [0];
      if (!k.VirtualProtectEx(h, addr, b.length, 0x40 /* PAGE_EXECUTE_READWRITE */, old)) return false;
      const ok = k.WriteProcessMemory(h, addr, b, b.length, done);
      k.VirtualProtectEx(h, addr, b.length, old[0], [0]);
      k.FlushInstructionCache(h, addr, b.length);
      return !!ok && done[0] === b.length;
    },
  };
}

class Background {
  // opts: { log, settings: () => ({ on, audioOnly }), memoryFor?: (pid) => mem (a running game, for the late patch) }
  constructor(opts = {}) {
    this.o = opts; this.log = opts.log || (() => {});
    this.timer = null; this.pid = 0; this.hwnd = null; this.sent = false; this.status = 'off'; this.soundPid = 0;
  }
  S() { const s = this.o.settings ? this.o.settings() : {}; return { on: !!(s && s.on), audioOnly: !!(s && s.audioOnly) }; }

  // starts NR2003 suspended, sets the sound flags, lets it run. -> { pid, sound: patchSound result } or throws
  launch(exe, cwd) {
    const k = win();
    const si = { cb: k.koffi.sizeof(k.STARTUPINFOW) }, pi = {};
    const cmd = '"' + exe + '"';
    if (!k.CreateProcessW(exe, cmd, null, null, false, 0x4 /* CREATE_SUSPENDED */, null, cwd, si, pi)) throw new Error("couldn't start NR2003 (run All In One NR2003 as administrator if Windows asks for it)");
    let sound;
    try { sound = patchSound(handleMemory(pi.hProcess)); } catch (e) { sound = { ok: false, written: 0, msg: e.message }; }
    if (k.ResumeThread(pi.hThread) === 0xFFFFFFFF) { k.TerminateProcess(pi.hProcess, 1); k.CloseHandle(pi.hThread); k.CloseHandle(pi.hProcess); throw new Error("couldn't resume NR2003"); }
    k.CloseHandle(pi.hThread); k.CloseHandle(pi.hProcess);
    this.log('NR2003 Background: started NR2003 (pid ' + pi.dwProcessId + '); ' + sound.msg);
    if (sound.ok) this.soundPid = pi.dwProcessId;
    this.watch(pi.dwProcessId);
    return { pid: pi.dwProcessId, sound };
  }

  // a game All In One NR2003 didn't start (or started the plain way): the flags now - only the sounds it makes from here on get them
  latePatch(pid, mem) {
    if (!pid || this.soundPid === pid || !mem) return null;
    let r; try { r = patchSound(mem); } catch (e) { r = { ok: false, written: 0, msg: e.message }; }
    this.soundPid = pid;
    this.log('NR2003 Background: ' + r.msg + (r.ok && r.written ? ' - sounds the game already made stay foreground-only until the next session' : ''));
    return r;
  }

  // the focus messages for the game with this pid (and the late sound patch when it wasn't started by us)
  watch(pid) {
    this.pid = pid; this.hwnd = null; this.sent = false;
    if (this.timer) return;
    this.timer = setInterval(() => { try { this._tick(); } catch (e) { /* the game went away mid-call */ } }, FOCUS_MS);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.pid = 0; this.hwnd = null; this.status = 'off'; }

  _findWindow(pid) {
    const k = win();
    let h = null;
    for (let i = 0; i < 64; i++) {
      h = k.FindWindowExW(null, h, CLASS, null);
      if (!h) return null;
      const p = [0]; k.GetWindowThreadProcessId(h, p);
      if (p[0] === pid) return h;
    }
    return null;
  }
  _tick() {
    const s = this.S();
    if (!s.on || !this.pid) { this.status = s.on ? 'waiting for NR2003' : 'off'; return; }
    if (s.audioOnly) { this.status = 'sound only'; return; }
    const k = win();
    if (!this.hwnd || !k.IsWindow(this.hwnd)) { this.hwnd = this._findWindow(this.pid); if (!this.hwnd) { this.status = 'waiting for the game window'; return; } }
    const res = [0];
    const ok = k.SendMessageTimeoutW(this.hwnd, WM_ACTIVATE, WA_CLICKACTIVE, 0, SMTO, 100, res);
    if (ok && !this.sent) { this.sent = true; this.log('NR2003 Background: game window found; it keeps drawing when another window has the focus'); }
    this.status = ok ? 'on' : 'the game window is not answering';
  }
  state() { const s = this.S(); return { on: s.on, audioOnly: s.audioOnly, status: this.status, pid: this.pid, sound: !!this.soundPid && this.soundPid === this.pid }; }
}

module.exports = { Background, SITES, GLOBALFOCUS, siteState, patchSound, unpatchSound, checkExe, WM_ACTIVATE, WA_CLICKACTIVE, CLASS };
