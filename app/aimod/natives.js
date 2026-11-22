// Native replacements for the Windows-only modules AIMOD's game layer imports (pymem, ctypes.windll.kernel32), backed by
// All In One NR2003's memory layer (Win32Memory / ShadowMemory / FakeMemory). With these, AIMOD's own `Game` class reads and writes
// NR2003 unchanged.
'use strict';
const py = require('../pyvm');
const { C, A, std, vm } = py;
const { PyBytes, PyObject, PyTuple, T, None, raise, PyErr } = C;

// backend: () => memory object { attach(), base, pid, isAlive(), readBytes(addr,n), writeBytes(addr,buf), alloc(n), detach() }
function install(backend) {
  const { mkModule, nativeClass } = std;
  const mkErr = (name, base) => { const t = C.mkType(name, [base || T.Exception], false); delete T[name]; t.module = 'pymem.exception'; return t; };
  const MemReadErr = mkErr('MemoryReadError'), MemWriteErr = mkErr('MemoryWriteError'), NotFound = mkErr('ProcessNotFound');
  const rd = (self, addr, n) => {
    const b = self.mem.readBytes(addr, n);
    if (!b || b.length !== n) throw new PyErr(C.newExc(MemReadErr, 'Could not read memory at: ' + addr));
    return b;
  };
  const Pymem = nativeClass('Pymem', {
    __init__: ([self, name]) => {
      const mem = backend(String(name));
      if (!mem || !mem.attach()) throw new PyErr(C.newExc(NotFound, 'Could not find process: ' + name));
      self.mem = mem; self.d.set('process_handle', 0x1234); self.d.set('process_id', mem.pid || 0); self.d.set('base_address', mem.base);
      return None;
    },
    read_bytes: ([self, a, n]) => new PyBytes(Buffer.from(rd(self, a, n))),
    write_bytes: ([self, a, data, n]) => { const b = Buffer.from(data.b.subarray(0, n === undefined ? data.b.length : n)); if (!self.mem.writeBytes(a, b)) throw new PyErr(C.newExc(MemWriteErr, 'Could not write memory at: ' + a)); return None; },
    read_int: ([self, a]) => rd(self, a, 4).readInt32LE(0),
    read_uint: ([self, a]) => rd(self, a, 4).readUInt32LE(0),
    read_short: ([self, a]) => rd(self, a, 2).readInt16LE(0),
    read_ushort: ([self, a]) => rd(self, a, 2).readUInt16LE(0),
    read_uchar: ([self, a]) => rd(self, a, 1)[0],
    read_char: ([self, a]) => rd(self, a, 1).readInt8(0),
    read_bool: ([self, a]) => rd(self, a, 1)[0] !== 0,
    read_float: ([self, a]) => rd(self, a, 4).readFloatLE(0),
    read_double: ([self, a]) => rd(self, a, 8).readDoubleLE(0),
    write_int: ([self, a, v]) => { const b = Buffer.alloc(4); b.writeInt32LE(v); self.mem.writeBytes(a, b); return None; },
    write_uint: ([self, a, v]) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); self.mem.writeBytes(a, b); return None; },
    write_float: ([self, a, v]) => { const b = Buffer.alloc(4); b.writeFloatLE(v); self.mem.writeBytes(a, b); return None; },
    write_double: ([self, a, v]) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); self.mem.writeBytes(a, b); return None; },
    allocate: ([self, n]) => { const a = self.mem.alloc(n); if (!a) throw new PyErr(C.newExc(MemWriteErr, 'allocation failed')); return a; },
    close_process: ([self]) => { try { self.mem.detach(); } catch (e) { /* ignore */ } return None; },
  }, 'pymem');
  const ModuleInfo = nativeClass('MODULEINFO', {}, 'pymem');
  mkModule('pymem.exception', { MemoryReadError: MemReadErr, MemoryWriteError: MemWriteErr, ProcessNotFound: NotFound });
  const procMod = mkModule('pymem.process', {
    module_from_name: ([handle, name]) => { const o = new PyObject(ModuleInfo); const m = Pymem._last && Pymem._last.mem; o.d.set('lpBaseOfDll', (m && m.base) || 0x400000); return o; },
  });
  mkModule('pymem', { Pymem, process: procMod, exception: vm.modules.get('pymem.exception') });
  // keep the most recent Pymem so module_from_name can answer with its base
  const origInit = Pymem.d.get('__init__');
  Pymem.d.set('__init__', Object.assign((args, kw) => { const r = origInit(args, kw); Pymem._last = args[0]; return r; }, { pyMethod: true, pyname: '__init__' }));

  // ctypes: only what aimod.game needs for liveness (GetExitCodeProcess) plus inert stand-ins for the rest
  const CULong = nativeClass('c_ulong', { __init__: ([self, v]) => { self.d.set('value', v === undefined ? 0 : v); return None; } }, 'ctypes');
  const Kernel32 = nativeClass('Kernel32', {
    GetExitCodeProcess: ([self, handle, ref]) => { ref.d.set('value', backendAlive() ? 259 : 0); return 1; },
    // AIMOD's pit crew makes the page it patches writable first and puts the protection back; All In One NR2003's memory layer already writes through
    // read-only / executable pages on its own, so this only has to say "done" and hand back a plausible old protection (PAGE_EXECUTE_READ)
    VirtualProtectEx: ([self, handle, addr, size, prot, oldRef]) => { if (oldRef && oldRef.d) oldRef.d.set('value', 0x20); return 1; },
  }, 'ctypes');
  let aliveFn = () => true;
  const backendAlive = () => aliveFn();
  const windll = new PyObject(nativeClass('WinDLL', {}, 'ctypes')); windll.d.set('kernel32', new PyObject(Kernel32));
  const inert = (n) => nativeClass(n, { __init__: () => None }, 'ctypes');
  const wintypes = mkModule('ctypes.wintypes', { DWORD: CULong, HANDLE: inert('HANDLE'), BOOL: inert('BOOL'), LPVOID: inert('LPVOID') });
  mkModule('ctypes', {
    wintypes, c_ulong: CULong, c_long: inert('c_long'), c_size_t: inert('c_size_t'), c_void_p: inert('c_void_p'), c_wchar: inert('c_wchar'),
    byref: ([x]) => x, sizeof: () => 8, windll, create_unicode_buffer: () => None, Structure: C.tObject,
    __getattr__: ([a]) => inert(a),
  });
  return { setAlive: (f) => { aliveFn = f; }, Pymem };
}

module.exports = { install };
