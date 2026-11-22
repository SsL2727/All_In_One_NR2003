// pyvm builtins — builtin functions, types and exceptions.
'use strict';
const C = require('./core');
const O = require('./ops');
const A = require('./attr');
const { vm, Generator } = require('./vm');
const { PyTuple, PyBytes, PyDict, PySet, PySlice, PyRange, PyObject, PyType, PyFunction, PyBound, PyModule, PyProperty, PyStaticMethod, PyClassMethod,
  T, None, NotImplemented, DONE, PyErr, raise, hk, eq, truthy, typeOf, dictSet, dictGet, isInstance, isNum, mroOf } = C;
const { repr, str, iter, toList, len, compare, num } = O;
const { nat, pargs, call } = A;

const B = vm.builtins;
const def = (name, fn) => { B.set(name, nat(name, fn)); };
const meth = (name, fn) => { fn.pyMethod = true; fn.pyname = name; return fn; };

// output sink (tests capture it)
vm.stdout = (s) => process.stdout.write(s);

def('print', (args, kw) => {
  const sep = kw && kw.has('sep') && kw.get('sep') !== None ? kw.get('sep') : ' ';
  const end = kw && kw.has('end') && kw.get('end') !== None ? kw.get('end') : '\n';
  const out = args.map(str).join(sep) + end;
  const file = kw && kw.get('file');
  if (file && file !== None) A.call(A.getattr(file, 'write'), [out], null); else vm.stdout(out);
  return None;
});
def('len', ([x]) => len(x));
def('repr', ([x]) => repr(x));
def('ascii', ([x]) => repr(x).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
def('abs', ([x]) => { if (isNum(x)) return Math.abs(num(x)); if (x instanceof PyObject) { const f = C.lookupType(x.cls, '__abs__'); if (f) return call(f, [x]); } throw raise('TypeError', 'bad operand type for abs()'); });
def('id', ([x]) => C.idOf(x === null || typeof x !== 'object' ? { v: x } : x));
def('hash', ([x]) => { const h = hk(x); let n = 0; for (let i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) | 0; return n; });
def('callable', ([x]) => typeof x === 'function' || x instanceof PyFunction || x instanceof PyBound || x instanceof PyType || (x instanceof PyObject && C.lookupType(x.cls, '__call__') !== undefined));
def('isinstance', ([v, t]) => isInstance(v, t));
def('issubclass', ([a, b]) => (b instanceof PyTuple ? b.a.some(x => C.isSubtype(a, x)) : C.isSubtype(a, b)));
def('hasattr', ([o, n]) => A.getattrOpt(o, n) !== undefined);
def('getattr', ([o, n, d]) => { const v = A.getattrOpt(o, n); if (v !== undefined) return v; if (d !== undefined) return d; return A.getattr(o, n); });
def('setattr', ([o, n, v]) => { A.setattr(o, n, v); return None; });
def('delattr', ([o, n]) => { A.delattr(o, n); return None; });
def('vars', ([o]) => A.dictFromMap(o instanceof PyModule || o instanceof PyObject || o instanceof PyType ? o.d : new Map()));
def('dir', ([o]) => { const s = new Set(); if (o instanceof PyObject) { for (const k of o.d.keys()) s.add(k); for (const c of mroOf(o.cls)) for (const k of c.d.keys()) s.add(k); } else if (o instanceof PyModule || o instanceof PyType) for (const k of o.d.keys()) s.add(k); return Array.from(s).sort(); });
def('globals', () => new PyDict());
def('locals', () => new PyDict());
def('id_', () => 0);
def('chr', ([n]) => String.fromCodePoint(num(n)));
def('ord', ([s]) => s.codePointAt(0));
def('hex', ([n]) => (n < 0 ? '-0x' + (-n).toString(16) : '0x' + n.toString(16)));
def('bin', ([n]) => (n < 0 ? '-0b' + (-n).toString(2) : '0b' + n.toString(2)));
def('oct', ([n]) => '0o' + n.toString(8));
def('format', ([v, spec]) => O.format(v, spec || ''));
def('divmod', ([a, b]) => new PyTuple([O.binop('//', a, b), O.binop('%', a, b)]));
def('pow', ([a, b, m]) => (m === undefined ? O.binop('**', a, b) : Number((BigInt(a) ** BigInt(b)) % BigInt(m))));
def('iter', ([o, sentinel]) => {
  if (sentinel === undefined) return iter(o);
  return new O.FnIter(() => { const v = call(o, [], null); return eq(v, sentinel) ? DONE : v; });
});
def('next', ([it, d]) => {
  const x = (it && typeof it.next === 'function' && !(it instanceof PyObject)) ? it.next() : iter(it).next();
  if (x === DONE) { if (d !== undefined) return d; throw new PyErr(C.newExc(T.StopIteration)); }
  return x;
});
def('sum', ([it, start], kw) => { let s = start === undefined ? (kw && kw.get('start')) || 0 : start; const i = iter(it); let v; while ((v = i.next()) !== DONE) s = O.binop('+', s, v); return s; });
def('any', ([it]) => { const i = iter(it); let v; while ((v = i.next()) !== DONE) if (truthy(v)) return true; return false; });
def('all', ([it]) => { const i = iter(it); let v; while ((v = i.next()) !== DONE) if (!truthy(v)) return false; return true; });
function minmax(name, pick) {
  def(name, (args, kw) => {
    const key = kw && kw.get('key'); const dflt = kw && kw.get('default');
    const items = args.length === 1 ? toList(args[0]) : args;
    if (!items.length) { if (dflt !== undefined) return dflt; throw raise('ValueError', name + '() arg is an empty sequence'); }
    let best = items[0], bk = key && key !== None ? call(key, [best]) : best;
    for (let i = 1; i < items.length; i++) { const k = key && key !== None ? call(key, [items[i]]) : items[i]; if (pick(k, bk)) { best = items[i]; bk = k; } }
    return best;
  });
}
minmax('min', (a, b) => compare('<', a, b));
minmax('max', (a, b) => compare('>', a, b));
def('sorted', ([it], kw) => A.sortList(toList(it), kw && kw.get('key'), truthy(kw && kw.get('reverse'))));
def('reversed', ([it]) => { const l = toList(it).reverse(); return new O.ArrIter(l); });
def('enumerate', ([it, start], kw) => { const s = start === undefined ? ((kw && kw.get('start')) || 0) : start; const i = iter(it); let n = s; return new O.FnIter(() => { const v = i.next(); return v === DONE ? DONE : new PyTuple([n++, v]); }); });
def('zip', (args, kw) => { const its = args.map(iter); return new O.FnIter(() => { if (!its.length) return DONE; const out = []; for (const i of its) { const v = i.next(); if (v === DONE) return DONE; out.push(v); } return new PyTuple(out); }); });
def('map', ([f, ...its]) => { const is = its.map(iter); return new O.FnIter(() => { const a = []; for (const i of is) { const v = i.next(); if (v === DONE) return DONE; a.push(v); } return call(f, a, null); }); });
def('filter', ([f, it]) => { const i = iter(it); return new O.FnIter(() => { for (;;) { const v = i.next(); if (v === DONE) return DONE; if (f === None ? truthy(v) : truthy(call(f, [v], null))) return v; } }); });
def('round', ([x, n]) => {
  x = num(x);
  if (n === undefined || n === None) { const fl = Math.floor(x), d = x - fl; if (d < 0.5) return fl; if (d > 0.5) return fl + 1; return fl % 2 === 0 ? fl : fl + 1; }
  if (!Number.isFinite(x)) return x;
  if (n >= 0) return parseFloat(O.toFixedExact(x, n));
  const p = Math.pow(10, -n); return Math.round(x / p) * p;
});
def('open', ([path, mode], kw) => require('./stdlib').openFile(path, mode || (kw && kw.get('mode')) || 'r', kw));
def('__import__', ([name, g, l, fromlist, level]) => require('./vm').importModule(name, g instanceof PyDict ? new Map() : new Map(), fromlist, level || 0));
def('__build_class__', (args, kw) => A.buildClass(args, kw));
def('super', () => { throw raise('RuntimeError', 'super(): no arguments (only zero-arg super() inside methods is supported)'); });

// ── types with constructors ──────────────────────────────────────────────────────────────────────────────────
const ctor = (t, fn) => { t.ctor = fn; B.set(t.name, t); };
function toInt(v, base) {
  if (typeof v === 'string') {
    const s = v.trim().replace(/_/g, '');
    const b = base === undefined ? 10 : base;
    const re = b === 10 ? /^[+-]?\d+$/ : /^[+-]?[0-9a-zA-Z]+$/;
    if (!re.test(s)) throw raise('ValueError', `invalid literal for int() with base ${b}: ${repr(v)}`);
    return parseInt(s, b);
  }
  if (isNum(v)) { const x = num(v); if (!Number.isFinite(x)) throw raise('OverflowError', 'cannot convert float infinity to integer'); return Math.trunc(x); }
  if (v instanceof PyObject && v.num !== undefined) return Math.trunc(v.num);
  if (v instanceof PyObject) { const f = C.lookupType(v.cls, '__int__'); if (f) return call(f, [v]); }
  throw raise('TypeError', `int() argument must be a string, a bytes-like object or a real number, not '${typeOf(v).name}'`);
}
ctor(T.int, ([v, base]) => (v === undefined ? 0 : toInt(v, base)));
ctor(T.float, ([v]) => {
  if (v === undefined) return 0.0;
  if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (s === 'inf' || s === '+inf' || s === 'infinity') return Infinity; if (s === '-inf' || s === '-infinity') return -Infinity; if (s === 'nan') return NaN; if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s.replace(/_/g, ''))) throw raise('ValueError', `could not convert string to float: ${repr(v)}`); return parseFloat(s); }
  if (isNum(v)) return num(v);
  if (v instanceof PyObject && v.num !== undefined) return v.num;
  if (v instanceof PyObject) { const f = C.lookupType(v.cls, '__float__'); if (f) return call(f, [v]); }
  throw raise('TypeError', `float() argument must be a string or a real number, not '${typeOf(v).name}'`);
});
ctor(T.bool, ([v]) => (v === undefined ? false : truthy(v)));
ctor(T.str, ([v]) => (v === undefined ? '' : str(v)));
ctor(T.list, ([it]) => (it === undefined ? [] : toList(it)));
ctor(T.tuple, ([it]) => new PyTuple(it === undefined ? [] : toList(it)));
ctor(T.set, ([it]) => { const s = new PySet(); if (it !== undefined) for (const x of toList(it)) C.setAdd(s, x); return s; });
ctor(T.frozenset, ([it]) => { const s = new PySet(true); if (it !== undefined) for (const x of toList(it)) C.setAdd(s, x); return s; });
ctor(T.dict, ([o], kw) => { const d = new PyDict(); if (o !== undefined) A.M.dict.update(d, [o], null); if (kw) for (const [k, v] of kw) dictSet(d, k, v); return d; });
ctor(T.bytes, ([v]) => new PyBytes(v === undefined ? Buffer.alloc(0) : (typeof v === 'number' ? Buffer.alloc(v) : (v instanceof PyBytes ? Buffer.from(v.b) : Buffer.from(toList(v))))));
ctor(T.bytearray, ([v]) => { const b = new PyBytes(v === undefined ? Buffer.alloc(0) : (typeof v === 'number' ? Buffer.alloc(v) : (v instanceof PyBytes ? Buffer.from(v.b) : Buffer.from(toList(v))))); b.mutable = true; return b; });
ctor(T.range, (a) => (a.length === 1 ? new PyRange(0, num(a[0]), 1) : new PyRange(num(a[0]), num(a[1]), a.length > 2 ? num(a[2]) : 1)));
ctor(T.slice, (a) => (a.length === 1 ? new PySlice(None, a[0], None) : new PySlice(a[0], a[1], a.length > 2 ? a[2] : None)));
ctor(T.object, () => new PyObject(T.object));
ctor(T.property, ([g, s, d]) => new PyProperty(g === None ? null : g, s === None ? null : s, d === None ? null : d));
ctor(T.staticmethod, ([f]) => new PyStaticMethod(f));
ctor(T.classmethod, ([f]) => new PyClassMethod(f));
ctor(T.type, (args, kw) => {
  if (args.length === 1) return typeOf(args[0]);
  const [name, bases, ns] = args;
  const m = new Map(); for (const [, [k, v]] of ns.m) m.set(k, v);
  const t = new PyType(name, bases.a.length ? bases.a : [T.object], m, null); t.builtin = false; t.module = m.get('__module__') || '__main__'; mroOf(t); return t;
});
T.object.d.set('__init__', meth('__init__', () => None));
T.object.d.set('__new__', Object.assign(meth('__new__', ([cls]) => { const o = new PyObject(cls); if (C.isSubtype(cls, T.BaseException)) o.d.set('args', new PyTuple([])); return o; }), { pyNativeNew: true }));
T.object.d.set('__eq__', undefined); T.object.d.delete('__eq__');
T.object.d.set('__setattr__', Object.assign(meth('__setattr__', ([o, n, v]) => { o.d.set(n, v); return None; }), { pyNativeSetattr: true }));
T.object.d.set('__getattribute__', meth('__getattribute__', ([o, n]) => A.getattr(o, n)));
T.object.d.set('__hash__', undefined); T.object.d.delete('__hash__');
T.object.d.set('__str__', undefined); T.object.d.delete('__str__');
T.BaseException.d.set('__init__', meth('__init__', ([self, ...a]) => { self.d.set('args', new PyTuple(a)); return None; }));
T.BaseException.d.set('with_traceback', meth('with_traceback', ([self]) => self));
// the common exception attributes
T.StopIteration.d.set('value', None);
for (const n of Object.keys(T)) if (T[n] && T[n].mro && C.isSubtype(T[n], T.BaseException)) B.set(n, T[n]);
B.set('IOError', T.OSError); B.set('EnvironmentError', T.OSError);
B.set('object', T.object); B.set('NotImplemented', NotImplemented); B.set('Ellipsis', C.Ellipsis);
B.set('__name__', 'builtins');
for (const n of ['int', 'float', 'str', 'bool', 'list', 'tuple', 'set', 'frozenset', 'dict', 'bytes', 'bytearray', 'range', 'slice', 'type', 'property', 'staticmethod', 'classmethod']) B.set(n, T[n]);
for (const [n, t] of [['enumerate', T.iterator], ['zip', T.iterator], ['map', T.iterator], ['filter', T.iterator]]) void n, void t;
// attributes for the builtin function / exception objects
A.M.dict.__class_getitem__ = (d) => d;

module.exports = { toInt, meth };
