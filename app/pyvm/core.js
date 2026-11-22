// pyvm core — Python object model for the CPython 3.12 bytecode interpreter in JS.
// Values: None=null, bool=true/false, int and float=JS number, str=JS string, bytes=PyBytes, tuple=PyTuple, list=Array,
// dict=PyDict, set/frozenset=PySet, everything else is a PyObject / PyType / PyFunction / native function.
'use strict';

class PyTuple { constructor(a) { this.a = a; } }
class PyBytes { constructor(b) { this.b = b; } }
class PyDict { constructor() { this.m = new Map(); } }          // hash key -> [key, value]
class PySet { constructor(frozen) { this.m = new Map(); this.frozen = !!frozen; } }   // hash key -> value
class PySlice { constructor(start, stop, step) { this.start = start; this.stop = stop; this.step = step; } }
class PyRange { constructor(start, stop, step) { this.start = start; this.stop = stop; this.step = step; } }
class Cell { constructor(v) { this.v = v; } }
class PyType {
  constructor(name, bases, d, meta) {
    this.name = name; this.bases = bases || []; this.d = d || new Map(); this.meta = meta || null;
    this.mro = null; this.builtin = false; this.ctor = null;
  }
}
class PyObject { constructor(cls) { this.cls = cls; this.d = new Map(); } }
class PyFunction {
  constructor(code, globals, name) {
    this.code = code; this.globals = globals; this.name = name || code.name; this.qualname = code.qualname;
    this.defaults = null; this.kwdefaults = null; this.closure = null; this.d = new Map(); this.doc = null;
  }
}
class PyBound { constructor(fn, self) { this.fn = fn; this.self = self; } }
class PyModule { constructor(name) { this.name = name; this.d = new Map(); } }
class PyProperty { constructor(fget, fset, fdel) { this.fget = fget; this.fset = fset; this.fdel = fdel; } }
class PyStaticMethod { constructor(f) { this.f = f; } }
class PyClassMethod { constructor(f) { this.f = f; } }
class PyCellHolder { }
const None = null;
const NotImplemented = { __notimpl: true };
const Ellipsis = { __ellipsis: true };
const DONE = Symbol('done');

class PyErr extends Error {
  constructor(exc) { super('python exception'); this.exc = exc; }
}

// ── type objects ─────────────────────────────────────────────────────────────────────────────────────────────
function mroOf(t) {
  if (t.mro) return t.mro;
  // C3 linearization
  const seqs = t.bases.map(b => mroOf(b).slice());
  seqs.push(t.bases.slice());
  const out = [t];
  for (;;) {
    const nz = seqs.filter(s => s.length);
    if (!nz.length) break;
    let cand = null;
    for (const s of nz) {
      const c = s[0];
      if (!nz.some(o => o.indexOf(c) > 0)) { cand = c; break; }
    }
    if (!cand) throw new Error('cannot create a consistent MRO for ' + t.name);
    out.push(cand);
    for (const s of seqs) if (s[0] === cand) s.shift();
  }
  t.mro = out;
  return out;
}

const T = {};                 // builtin types by name
function mkType(name, bases, builtin) {
  const t = new PyType(name, bases || [], new Map(), null);
  t.builtin = builtin !== false;
  T[name] = t;
  return t;
}
const tObject = mkType('object', []);
for (const n of ['type', 'int', 'float', 'str', 'bytes', 'list', 'tuple', 'dict', 'set', 'frozenset', 'NoneType', 'function', 'method',
  'builtin_function_or_method', 'range', 'slice', 'module', 'property', 'staticmethod', 'classmethod', 'generator', 'cell', 'ellipsis',
  'NotImplementedType', 'iterator', 'bytearray']) mkType(n, [tObject]);
mkType('bool', [T.int]);

const excNames = {
  BaseException: null, Exception: 'BaseException', SystemExit: 'BaseException', KeyboardInterrupt: 'BaseException', GeneratorExit: 'BaseException',
  StopIteration: 'Exception', ArithmeticError: 'Exception', ZeroDivisionError: 'ArithmeticError', OverflowError: 'ArithmeticError', FloatingPointError: 'ArithmeticError',
  LookupError: 'Exception', KeyError: 'LookupError', IndexError: 'LookupError', ValueError: 'Exception', TypeError: 'Exception',
  AttributeError: 'Exception', NameError: 'Exception', UnboundLocalError: 'NameError', RuntimeError: 'Exception', NotImplementedError: 'RuntimeError',
  RecursionError: 'RuntimeError', AssertionError: 'Exception', ImportError: 'Exception', ModuleNotFoundError: 'ImportError',
  OSError: 'Exception', FileNotFoundError: 'OSError', PermissionError: 'OSError', FileExistsError: 'OSError', NotADirectoryError: 'OSError', IsADirectoryError: 'OSError',
  EOFError: 'Exception', MemoryError: 'Exception', UnicodeError: 'ValueError', UnicodeDecodeError: 'UnicodeError', UnicodeEncodeError: 'UnicodeError',
  Warning: 'Exception', DeprecationWarning: 'Warning', UserWarning: 'Warning', RuntimeWarning: 'Warning',
};
for (const [n, p] of Object.entries(excNames)) mkType(n, [p ? T[p] : tObject]);
T.IOError = T.OSError; T.EnvironmentError = T.OSError;
for (const [n, t] of Object.entries(T)) { t.module = 'builtins'; mroOf(t); }

function typeOf(v) {
  if (v === null) return T.NoneType;
  switch (typeof v) {
    case 'number': return T.float === undefined ? T.int : (Number.isInteger(v) ? T.int : T.float);
    case 'boolean': return T.bool;
    case 'string': return T.str;
    case 'function': return T.builtin_function_or_method;
    case 'undefined': return T.NoneType;
    default: break;
  }
  if (v instanceof PyObject) return v.cls;
  if (Array.isArray(v)) return T.list;
  if (v instanceof PyTuple) return T.tuple;
  if (v instanceof PyDict) return T.dict;
  if (v instanceof PySet) return v.frozen ? T.frozenset : T.set;
  if (v instanceof PyBytes) return v.mutable ? T.bytearray : T.bytes;
  if (v instanceof PyFunction) return T.function;
  if (v instanceof PyBound) return T.method;
  if (v instanceof PyType) return v.meta || T.type;
  if (v instanceof PyModule) return T.module;
  if (v instanceof PyRange) return T.range;
  if (v instanceof PySlice) return T.slice;
  if (v instanceof PyProperty) return T.property;
  if (v instanceof PyStaticMethod) return T.staticmethod;
  if (v instanceof PyClassMethod) return T.classmethod;
  if (v === NotImplemented) return T.NotImplementedType;
  if (v === Ellipsis) return T.ellipsis;
  if (v instanceof Cell) return T.cell;
  if (v && typeof v.next === 'function') return T.iterator;
  return tObject;
}

function isSubtype(t, base) { return mroOf(t).includes(base); }
function isInstance(v, t) {
  if (t instanceof PyTuple) return t.a.some(x => isInstance(v, x));
  if (!(t instanceof PyType)) throw raise('TypeError', 'isinstance() arg 2 must be a type or tuple of types');
  if (t === T.int && typeof v === 'boolean') return true;
  if (t === T.float && typeof v === 'number') return true;
  if (t === T.int && typeof v === 'number') return Number.isInteger(v);
  if (t === tObject) return true;
  return isSubtype(typeOf(v), t);
}

// ── exceptions ───────────────────────────────────────────────────────────────────────────────────────────────
function newExc(type, msg) {
  const o = new PyObject(type);
  o.d.set('args', new PyTuple(msg === undefined ? [] : [msg]));
  return o;
}
function raise(typeName, msg) { return new PyErr(newExc(T[typeName] || T.Exception, msg)); }

// ── hashing / equality ───────────────────────────────────────────────────────────────────────────────────────
let idCounter = 1;
const ids = new WeakMap();
function idOf(o) { let i = ids.get(o); if (!i) { i = idCounter++; ids.set(o, i); } return i; }

let callHook = null;            // set by vm: (fn, args, kw) -> value
const setCallHook = (f) => { callHook = f; };

function lookupType(t, name) {
  for (const c of mroOf(t)) { const v = c.d.get(name); if (v !== undefined) return v; }
  return undefined;
}

function hk(v) {
  switch (typeof v) {
    case 'number': return 'n' + v;
    case 'boolean': return v ? 'n1' : 'n0';
    case 'string': return 's' + v;
    default: break;
  }
  if (v === null) return 'N';
  if (v instanceof PyTuple) return 't(' + v.a.map(hk).join(',') + ')';
  if (v instanceof PyBytes) return 'b' + v.b.toString('hex');
  if (v instanceof PySet && v.frozen) return 'f(' + Array.from(v.m.keys()).sort().join(',') + ')';
  if (v instanceof PyObject) {
    if (v.num !== undefined && lookupType(v.cls, '__hash__') === undefined) return 'n' + v.num;
    const h = lookupType(v.cls, '__hash__');
    if (h !== undefined && h !== null) return 'h' + hk(callHook(h, [v], null));
    if (h === null) throw raise('TypeError', 'unhashable type: ' + v.cls.name);
    if (lookupType(v.cls, '__eq__') !== undefined) throw raise('TypeError', 'unhashable type: ' + v.cls.name);
    return 'o' + idOf(v);
  }
  if (Array.isArray(v)) throw raise('TypeError', "unhashable type: 'list'");
  if (v instanceof PyDict) throw raise('TypeError', "unhashable type: 'dict'");
  if (v instanceof PySet) throw raise('TypeError', "unhashable type: 'set'");
  return 'o' + idOf(v);
}

const isNum = (v) => typeof v === 'number' || typeof v === 'boolean';
function eq(a, b) {
  if (a === b) return true;
  if (a instanceof PyObject && a.num !== undefined && lookupType(a.cls, '__eq__') === undefined) a = a.num;
  if (b instanceof PyObject && b.num !== undefined && lookupType(b.cls, '__eq__') === undefined) b = b.num;
  if (a === b) return true;
  const ta = typeof a;
  if (isNum(a) && isNum(b)) return Number(a) === Number(b);
  if (ta === 'string' || typeof b === 'string') return false;
  if (a === null || b === null) return false;
  if (a instanceof PyTuple && b instanceof PyTuple) return a.a.length === b.a.length && a.a.every((x, i) => eq(x, b.a[i]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (a instanceof PyDict && b instanceof PyDict) {
    if (a.m.size !== b.m.size) return false;
    for (const [k, [, v]] of a.m) { const o = b.m.get(k); if (!o || !eq(v, o[1])) return false; }
    return true;
  }
  if (a instanceof PySet && b instanceof PySet) {
    if (a.m.size !== b.m.size) return false;
    for (const k of a.m.keys()) if (!b.m.has(k)) return false;
    return true;
  }
  if (a instanceof PyBytes && b instanceof PyBytes) return a.b.equals(b.b);
  if (a instanceof PyObject) {
    const f = lookupType(a.cls, '__eq__');
    if (f !== undefined) { const r = callHook(f, [a, b], null); if (r !== NotImplemented) return truthy(r); }
  }
  if (b instanceof PyObject) {
    const f = lookupType(b.cls, '__eq__');
    if (f !== undefined) { const r = callHook(f, [b, a], null); if (r !== NotImplemented) return truthy(r); }
  }
  return false;
}

function truthy(v) {
  if (v === null || v === undefined) return false;
  switch (typeof v) { case 'boolean': return v; case 'number': return v !== 0; case 'string': return v.length > 0; default: break; }
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof PyTuple) return v.a.length > 0;
  if (v instanceof PyDict) return v.m.size > 0;
  if (v instanceof PySet) return v.m.size > 0;
  if (v instanceof PyBytes) return v.b.length > 0;
  if (v instanceof PyRange) return rangeLen(v) > 0;
  if (v instanceof PyObject) {
    if (v.num !== undefined && lookupType(v.cls, '__bool__') === undefined) return v.num !== 0;
    let f = lookupType(v.cls, '__bool__');
    if (f !== undefined) return truthy(callHook(f, [v], null));
    f = lookupType(v.cls, '__len__');
    if (f !== undefined) return truthy(callHook(f, [v], null));
  }
  return true;
}

function rangeLen(r) {
  if (r.step > 0) return Math.max(0, Math.ceil((r.stop - r.start) / r.step));
  return Math.max(0, Math.ceil((r.start - r.stop) / -r.step));
}

// ── dict / set helpers ───────────────────────────────────────────────────────────────────────────────────────
const dictGet = (d, k) => { const e = d.m.get(hk(k)); return e === undefined ? undefined : e[1]; };
const dictSet = (d, k, v) => { const h = hk(k); const e = d.m.get(h); if (e) e[1] = v; else d.m.set(h, [k, v]); };
const dictDel = (d, k) => d.m.delete(hk(k));
const dictFromPairs = (pairs) => { const d = new PyDict(); for (const [k, v] of pairs) dictSet(d, k, v); return d; };
const setAdd = (s, v) => { s.m.set(hk(v), v); };
const strDict = (obj) => { const d = new PyDict(); for (const [k, v] of Object.entries(obj)) dictSet(d, k, v); return d; };

module.exports = {
  PyTuple, PyBytes, PyDict, PySet, PySlice, PyRange, Cell, PyType, PyObject, PyFunction, PyBound, PyModule, PyProperty, PyStaticMethod, PyClassMethod,
  None, NotImplemented, Ellipsis, DONE, PyErr, T, tObject, mkType, mroOf, typeOf, isSubtype, isInstance, newExc, raise, idOf, hk, eq, truthy, rangeLen,
  lookupType, setCallHook, dictGet, dictSet, dictDel, dictFromPairs, setAdd, strDict, isNum, callHookGet: () => callHook,
};
