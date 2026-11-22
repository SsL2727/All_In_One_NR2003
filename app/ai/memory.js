// Process-memory access for NR2003.exe.
//
//   Win32Memory — real backend (kernel32 through koffi, no native build step needed)
//   FakeMemory  — in-memory stand-in used by the tests and the dev harness
//
// Both expose the same small API so the AI logic never knows which it is talking to.
// Addresses are plain numbers (NR2003 is a 32-bit process; its image base is 0x400000).
'use strict';
const path = require('path');

const TH32CS_SNAPPROCESS = 0x2;
const TH32CS_SNAPMODULE = 0x8;
const TH32CS_SNAPMODULE32 = 0x10;
const PROCESS_VM_OPERATION = 0x8, PROCESS_VM_READ = 0x10, PROCESS_VM_WRITE = 0x20, PROCESS_QUERY_INFORMATION = 0x400;
const MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, MEM_RELEASE = 0x8000;
const PAGE_EXECUTE_READWRITE = 0x40;

// ── shared typed helpers (work on any backend that provides readBytes/writeBytes) ─
const typed = {
  readU8(a) { const b = this.readBytes(a, 1); return b ? b[0] : null; },
  readU16(a) { const b = this.readBytes(a, 2); return b ? b.readUInt16LE(0) : null; },
  readI32(a) { const b = this.readBytes(a, 4); return b ? b.readInt32LE(0) : null; },
  readU32(a) { const b = this.readBytes(a, 4); return b ? b.readUInt32LE(0) : null; },
  readF32(a) { const b = this.readBytes(a, 4); return b ? b.readFloatLE(0) : null; },
  readF64(a) { const b = this.readBytes(a, 8); return b ? b.readDoubleLE(0) : null; },
  readCString(a, n) {
    const b = this.readBytes(a, n);
    if (!b) return null;
    const z = b.indexOf(0);
    return b.toString('latin1', 0, z < 0 ? b.length : z);
  },
  writeU8(a, v) { return this.writeBytes(a, Buffer.from([v & 0xff])); },
  writeI32(a, v) { const b = Buffer.alloc(4); b.writeInt32LE(v | 0, 0); return this.writeBytes(a, b); },
  writeF32(a, v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return this.writeBytes(a, b); },
  writeF64(a, v) { const b = Buffer.alloc(8); b.writeDoubleLE(v, 0); return this.writeBytes(a, b); },
};

// ── Win32 backend ────────────────────────────────────────────────────────────
let _bindings = null;

class Win32Memory {
  // processName may be a string or a function returning one (All In One NR2003's configured exe can change at runtime);
  // preferredPath (string|function) picks the right instance when more than one copy is running.
  constructor(processName, preferredPath) {
    this._name = processName || 'NR2003.exe';
    this._preferredPath = preferredPath || null;
    this.pid = 0;
    this.handle = null;
    this.base = 0;
    this._k = null;
  }

  // one name or a list (the configured exe and RaceLab's game builds): the first one in the list that is running wins
  get processNames() { const n = typeof this._name === 'function' ? this._name() : this._name; return (Array.isArray(n) ? n : [n]).filter(Boolean).map(String); }
  get processName() { return this._exe || this.processNames[0] || 'NR2003.exe'; }
  get preferredPath() { return typeof this._preferredPath === 'function' ? this._preferredPath() : this._preferredPath; }

  _init() {
    if (this._k) return this._k;
    if (_bindings) return (this._k = _bindings);       // koffi type names are process-global: define once
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');
    const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
      dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32', th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32', cntThreads: 'uint32', th32ParentProcessID: 'uint32', pcPriClassBase: 'int32',
      dwFlags: 'uint32', szExeFile: koffi.array('char16_t', 260, 'String'),
    });
    const MODULEENTRY32W = koffi.struct('MODULEENTRY32W', {
      dwSize: 'uint32', th32ModuleID: 'uint32', th32ProcessID: 'uint32', GlblcntUsage: 'uint32', ProccntUsage: 'uint32',
      modBaseAddr: 'uintptr_t', modBaseSize: 'uint32', hModule: 'uintptr_t',
      szModule: koffi.array('char16_t', 256, 'String'), szExePath: koffi.array('char16_t', 260, 'String'),
    });
    this._k = {
      koffi, PROCESSENTRY32W, MODULEENTRY32W,
      CreateToolhelp32Snapshot: k32.func('void *CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
      Process32FirstW: k32.func('bool Process32FirstW(void *snap, _Inout_ PROCESSENTRY32W *entry)'),
      Process32NextW: k32.func('bool Process32NextW(void *snap, _Inout_ PROCESSENTRY32W *entry)'),
      Module32FirstW: k32.func('bool Module32FirstW(void *snap, _Inout_ MODULEENTRY32W *entry)'),
      Module32NextW: k32.func('bool Module32NextW(void *snap, _Inout_ MODULEENTRY32W *entry)'),
      OpenProcess: k32.func('void *OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      CloseHandle: k32.func('bool CloseHandle(void *h)'),
      ReadProcessMemory: k32.func('bool ReadProcessMemory(void *h, uintptr_t addr, _Out_ uint8_t *buf, size_t size, _Out_ size_t *read)'),
      WriteProcessMemory: k32.func('bool WriteProcessMemory(void *h, uintptr_t addr, uint8_t *buf, size_t size, _Out_ size_t *written)'),
      VirtualAllocEx: k32.func('uintptr_t VirtualAllocEx(void *h, uintptr_t addr, size_t size, uint32 type, uint32 protect)'),
      VirtualFreeEx: k32.func('bool VirtualFreeEx(void *h, uintptr_t addr, size_t size, uint32 type)'),
      VirtualProtectEx: k32.func('bool VirtualProtectEx(void *h, uintptr_t addr, size_t size, uint32 newProtect, _Out_ uint32 *old)'),
      CreateRemoteThread: k32.func('void *CreateRemoteThread(void *h, void *sa, size_t stack, uintptr_t start, void *param, uint32 flags, void *tid)'),
      WaitForSingleObject: k32.func('uint32 WaitForSingleObject(void *h, uint32 ms)'),
      FlushInstructionCache: k32.func('bool FlushInstructionCache(void *h, uintptr_t addr, size_t size)'),
      GetExitCodeProcess: k32.func('bool GetExitCodeProcess(void *h, _Out_ uint32 *code)'),
      QueryFullProcessImageNameW: k32.func('bool QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ uint16_t *buf, _Inout_ uint32 *size)'),
    };
    const MBI32 = koffi.struct('MBI32', { BaseAddress: 'uintptr_t', AllocationBase: 'uintptr_t', AllocationProtect: 'uint32', RegionSize: 'size_t', State: 'uint32', Protect: 'uint32', Type: 'uint32' });
    this._k.MBI32 = MBI32;
    this._k.VirtualQueryEx = k32.func('size_t VirtualQueryEx(void *h, uintptr_t a, _Out_ MBI32 *mbi, size_t len)');
    _bindings = this._k;
    return this._k;
  }

  _imagePath(pid) {
    const k = this._init();
    const h = k.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
    if (!h) return '';
    try {
      const buf = Buffer.alloc(1040);
      const size = [520];
      return k.QueryFullProcessImageNameW(h, 0, buf, size) ? buf.toString('utf16le', 0, size[0] * 2) : '';
    } finally { k.CloseHandle(h); }
  }

  // pid of the running process with this exe name (the one at preferredPath if several), or 0
  findPid() {
    const k = this._init();
    const snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (!snap) return 0;
    const want = this.processNames.map(n => n.toLowerCase());
    const hits = [];
    try {
      const e = { dwSize: k.koffi.sizeof(k.PROCESSENTRY32W) };
      let ok = k.Process32FirstW(snap, e);
      while (ok) {
        const r = want.indexOf(String(e.szExeFile).toLowerCase());
        if (r >= 0) hits.push({ pid: e.th32ProcessID, r, exe: String(e.szExeFile) });
        ok = k.Process32NextW(snap, e);
      }
    } finally { k.CloseHandle(snap); }
    if (!hits.length) return 0;
    const best = Math.min(...hits.map(h => h.r));
    const same = hits.filter(h => h.r === best);
    this._exe = same[0].exe;                       // the module base is looked up under the name that is running
    const found = same.map(h => h.pid);
    if (found.length > 1 && this.preferredPath) {
      const pref = path.normalize(String(this.preferredPath)).toLowerCase();
      const hit = found.find(pid => path.normalize(this._imagePath(pid)).toLowerCase() === pref);
      if (hit) return hit;
    }
    return found[0] || 0;
  }

  _moduleBase(pid) {
    const k = this._init();
    const snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (!snap) return 0;
    try {
      const e = { dwSize: k.koffi.sizeof(k.MODULEENTRY32W) };
      let ok = k.Module32FirstW(snap, e);
      while (ok) {
        if (String(e.szModule).toLowerCase() === this.processName.toLowerCase()) return Number(e.modBaseAddr);
        ok = k.Module32NextW(snap, e);
      }
    } finally { k.CloseHandle(snap); }
    return 0;
  }

  // true when attached (or already was). Re-attaches if the game restarted.
  attach() {
    const k = this._init();
    if (this.handle && this.isAlive()) return true;
    this.detach();
    const pid = this.findPid();
    if (!pid) return false;
    const h = k.OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION, false, pid);
    if (!h) return false;
    const base = this._moduleBase(pid);
    if (!base) { k.CloseHandle(h); return false; }
    this.handle = h; this.pid = pid; this.base = base;
    return true;
  }

  isAlive() {
    if (!this.handle) return false;
    const k = this._init();
    const code = [0];
    return k.GetExitCodeProcess(this.handle, code) && code[0] === 259; // STILL_ACTIVE
  }

  detach() {
    if (this.handle) { try { this._init().CloseHandle(this.handle); } catch (e) { /* ignore */ } }
    this.handle = null; this.pid = 0; this.base = 0;
  }

  readBytes(addr, n) {
    if (!this.handle) return null;
    const buf = Buffer.alloc(n);
    const got = [0];
    const ok = this._k.ReadProcessMemory(this.handle, addr, buf, n, got);
    return ok && got[0] === n ? buf : null;
  }

  writeBytes(addr, bytes) {
    if (!this.handle) return false;
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const k = this._k;
    const done = [0];
    let ok = k.WriteProcessMemory(this.handle, addr, b, b.length, done);
    if (!ok) {
      // code pages: make writable, write, restore
      const old = [0];
      if (k.VirtualProtectEx(this.handle, addr, b.length, PAGE_EXECUTE_READWRITE, old)) {
        ok = k.WriteProcessMemory(this.handle, addr, b, b.length, done);
        k.VirtualProtectEx(this.handle, addr, b.length, old[0], [0]);
      }
    }
    if (ok) k.FlushInstructionCache(this.handle, addr, b.length);
    return !!ok && done[0] === b.length;
  }

  alloc(size) {
    const a = this._k.VirtualAllocEx(this.handle, 0, size, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    return Number(a) || 0;
  }
  free(addr) { return this._k.VirtualFreeEx(this.handle, addr, 0, MEM_RELEASE); }

  // run a no-argument game function (callee pops 4 bytes: a thread start routine) in the game and wait for it: what RaceControl's pause / resume do
  callGame(fn) {
    const k = this._k;
    if (!this._stub) this._stub = this.alloc(64);
    if (!this._stub) return false;
    if (!this.writeBytes(this._stub, Buffer.from([0xB8, fn & 0xFF, (fn >>> 8) & 0xFF, (fn >>> 16) & 0xFF, (fn >>> 24) & 0xFF, 0xFF, 0xD0, 0xC2, 0x04, 0x00]))) return false;
    const th = k.CreateRemoteThread(this.handle, null, 0, this._stub, null, 0, null);
    if (!th) return false;
    k.WaitForSingleObject(th, 2000);
    k.CloseHandle(th);
    return true;
  }

  // committed, readable regions of the process in [start, end): [{ base, size }]
  regions(start, end) {
    const k = this._init(), out = [], len = k.koffi.sizeof(k.MBI32);
    let a = start;
    while (a < end) {
      const mbi = {};
      if (!k.VirtualQueryEx(this.handle, a, mbi, len)) break;
      const base = Number(mbi.BaseAddress), size = Number(mbi.RegionSize);
      if (mbi.State === MEM_COMMIT && !(mbi.Protect & 0x101)) out.push({ base, size });   // not PAGE_NOACCESS / PAGE_GUARD
      if (base + size <= a) break;
      a = base + size;
    }
    return out;
  }

  // every address in [start, end) where `pattern` occurs (aligned to `align`), at most `max`; reads each region in chunks
  findBytes(pattern, start, end, align = 4, max = 64) {
    const hits = [], CH = 0x100000;
    for (const r of this.regions(start, end)) {
      for (let off = 0; off < r.size; off += CH) {
        const n = Math.min(CH + pattern.length - 1, r.size - off);
        const b = this.readBytes(r.base + off, n);
        if (!b) continue;
        for (let i = b.indexOf(pattern); i >= 0; i = b.indexOf(pattern, i + 1)) {
          if (((r.base + off + i) % align) === 0 && i < CH) { hits.push(r.base + off + i); if (hits.length >= max) return hits; }
        }
      }
    }
    return hits;
  }

  // first match of a byte pattern in [start, start+length)
  scan(start, length, pattern) {
    const CH = 0x10000;
    for (let off = 0; off < length; off += CH - pattern.length) {
      const b = this.readBytes(start + off, Math.min(CH, length - off));
      if (!b) continue;
      const i = b.indexOf(pattern);
      if (i >= 0) return start + off + i;
    }
    return 0;
  }
}
Object.assign(Win32Memory.prototype, typed);

// ── Fake backend (tests / harness) ───────────────────────────────────────────
class FakeMemory {
  constructor(base) {
    this.base = base || 0x400000;
    this.pid = 4242;
    this.attached = true;
    this.pages = new Map();       // addr -> byte (sparse, simple and fast enough for tests)
    this.log = [];                // every successful write: { addr, bytes }
    this._next = 0x10000000;      // alloc cursor
    this.failReads = false;
  }
  attach() { return this.attached; }
  isAlive() { return this.attached; }
  detach() { this.attached = false; }
  readBytes(addr, n) {
    if (!this.attached || this.failReads) return null;
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = this.pages.get(addr + i) || 0;
    return b;
  }
  writeBytes(addr, bytes) {
    if (!this.attached) return false;
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    for (let i = 0; i < b.length; i++) this.pages.set(addr + i, b[i]);
    this.log.push({ addr, bytes: Buffer.from(b) });
    return true;
  }
  // silent setters for building scenarios (do not log)
  poke(addr, bytes) { const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); for (let i = 0; i < b.length; i++) this.pages.set(addr + i, b[i]); }
  pokeF32(a, v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); this.poke(a, b); }
  pokeF64(a, v) { const b = Buffer.alloc(8); b.writeDoubleLE(v, 0); this.poke(a, b); }
  pokeI32(a, v) { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); this.poke(a, b); }
  pokeStr(a, s, n) { const b = Buffer.alloc(n); b.write(s, 0, 'latin1'); this.poke(a, b); }
  alloc(size) { const a = this._next; this._next += (size + 0xfff) & ~0xfff; return a; }
  free() { return true; }
  scan(start, length, pattern) {
    const hay = this.readBytes(start, length);
    const i = hay.indexOf(pattern);
    return i >= 0 ? start + i : 0;
  }
  writesTo(addr, len) { return this.log.filter(w => w.addr < addr + (len || 1) && w.addr + w.bytes.length > addr); }
  regions(start, end) {            // contiguous blocks of poked memory (gaps over 4 KB split them)
    const a = [...this.pages.keys()].filter(x => x >= start && x < end).sort((x, y) => x - y), out = [];
    for (const x of a) { const r = out[out.length - 1]; if (r && x - (r.base + r.size) < 0x1000) r.size = x - r.base + 1; else out.push({ base: x, size: 1 }); }
    return out;
  }
  findBytes(pattern, start, end, align = 4, max = 64) {
    const hits = [];
    for (const r of this.regions(start, end)) {
      const b = this.readBytes(r.base, r.size);
      for (let i = b.indexOf(pattern); i >= 0; i = b.indexOf(pattern, i + 1)) { if ((r.base + i) % align === 0) { hits.push(r.base + i); if (hits.length >= max) return hits; } }
    }
    return hits;
  }
}
Object.assign(FakeMemory.prototype, typed);

// ── Read-only test mode ───────────────────────────────────────────────────────────
// Wraps a real backend: reads see the real process with our pending writes layered on top, but writes only go to
// the layer. The AI logic behaves exactly as if it were writing (so the UI shows what WOULD happen) while NR2003 is
// never modified. Flip `passthrough` to make writes real.
class ShadowMemory {
  constructor(real) {
    this.real = real;
    this.passthrough = false;
    this.tag = '';                      // who is writing, for the crash journal
    this.shadow = new Map();
    this.count = 0;
    this.recent = [];
    this._next = 0x70000000;
  }
  get base() { return this.real.base; }
  get pid() { return this.real.pid; }
  attach() { return this.real.attach(); }
  isAlive() { return this.real.isAlive(); }
  detach() { this.real.detach(); this.clear(); }
  clear() { this.shadow.clear(); this.count = 0; this.recent = []; }
  readBytes(addr, n) {
    const b = this.real.readBytes(addr, n);
    if (!b || !this.shadow.size) return b;
    for (let i = 0; i < n; i++) { const v = this.shadow.get(addr + i); if (v !== undefined) b[i] = v; }
    return b;
  }
  writeBytes(addr, bytes) {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (this.passthrough) {
      const ok = this.real.writeBytes(addr, b);
      if ((this._jn = (this._jn || 0) + 1) % (this.journalEvery || 1) === 0 || !ok) require('../crashjournal').journal.write(this.tag || '?', addr, b, ok);   // high-rate writers journal 1 in N
      return ok;
    }
    for (let i = 0; i < b.length; i++) this.shadow.set(addr + i, b[i]);
    this.count++;
    this.recent.push({ addr, hex: b.subarray(0, 16).toString('hex'), len: b.length });
    if (this.recent.length > 12) this.recent.shift();
    return true;
  }
  callGame(fn) { return this.passthrough && this.real.callGame ? this.real.callGame(fn) : false; }
  alloc(size) { if (this.passthrough) return this.real.alloc(size); const a = this._next; this._next += (size + 0xfff) & ~0xfff; return a; }
  free(a) { return this.passthrough ? this.real.free(a) : true; }
  scan(start, length, pattern) { return this.real.scan(start, length, pattern); }
  regions(start, end) { return this.real.regions(start, end); }
  findBytes(...a) { return this.real.findBytes(...a); }
}
Object.assign(ShadowMemory.prototype, typed);

module.exports = { Win32Memory, FakeMemory, ShadowMemory, typed };
