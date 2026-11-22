// pyvm — run CPython 3.12 bytecode (marshal data) inside All In One NR2003. Used for AIMOD's strategy logic.
'use strict';
const C = require('./core');
const { vm, execModule, callFunction } = require('./vm');
require('./builtins');
const std = require('./stdlib');
const A = require('./attr');
const O = require('./ops');
const { loads } = require('./marshal');
const { PyModule } = C;

// Register Python modules from marshalled code objects: { 'aimod.strategy': Buffer, ... }; package names are those that
// are prefixes of another module name (or listed in `packages`).
function registerBundle(codes, packages) {
  const pk = new Set(packages || []);
  for (const n of Object.keys(codes)) for (const m of Object.keys(codes)) if (m.startsWith(n + '.')) pk.add(n);
  const loaded = new Map();
  const prev = vm.moduleLoader;
  vm.moduleLoader = (name) => {
    if (!codes[name]) return prev ? prev(name) : null;
    if (loaded.has(name)) return loaded.get(name);
    const mod = new PyModule(name);
    mod.d.set('__name__', name);
    mod.d.set('__package__', pk.has(name) ? name : name.split('.').slice(0, -1).join('.'));
    if (pk.has(name)) mod.d.set('__path__', []);
    vm.modules.set(name, mod);
    loaded.set(name, mod);
    try { execModule(loads(codes[name]), mod); } catch (e) { vm.modules.delete(name); loaded.delete(name); throw e; }
    return mod;
  };
}

function importModule(name) {
  let m = vm.modules.get(name);
  if (m) return m;
  m = vm.moduleLoader ? vm.moduleLoader(name) : null;
  if (!m) throw new Error('No module named ' + name);
  return m;
}

// run a marshalled module body (tests): returns the module namespace
function runCode(buf, name) {
  const mod = new PyModule(name || '__main__');
  mod.d.set('__name__', name || '__main__');
  vm.modules.set(mod.name, mod);
  execModule(loads(buf), mod);
  return mod;
}

// call helpers for embedders
const pyCall = (f, args, kw) => A.call(f, args || [], kw ? new Map(Object.entries(kw)) : null);
const pyGet = (o, n) => A.getattr(o, n);

// plain JS -> Python value conversions
function toPy(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(toPy);
  if (typeof v === 'object') { if (v instanceof C.PyTuple || v instanceof C.PyDict || v instanceof C.PyObject || v instanceof C.PySet) return v; const d = new C.PyDict(); for (const [k, x] of Object.entries(v)) C.dictSet(d, k, toPy(x)); return d; }
  return v;
}
function toJs(v) {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(toJs);
  if (v instanceof C.PyTuple) return v.a.map(toJs);
  if (v instanceof C.PyDict) { const o = {}; for (const [, [k, x]] of v.m) o[typeof k === 'string' ? k : O.str(k)] = toJs(x); return o; }
  if (v instanceof C.PySet) return Array.from(v.m.values()).map(toJs);
  if (v instanceof C.PyObject) { const o = {}; for (const [k, x] of v.d) o[k] = toJs(x); return o; }
  if (v instanceof C.PyBytes) return v.b;
  return v;
}

module.exports = { vm, C, A, O, std, loads, registerBundle, importModule, runCode, pyCall, pyGet, toPy, toJs, callFunction, repr: O.repr, str: O.str };
