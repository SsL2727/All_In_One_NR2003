// pyvm attr — attribute access, calls, class construction and the builtin type method tables.
'use strict';
const C = require('./core');
const O = require('./ops');
const { PyTuple, PyBytes, PyDict, PySet, PySlice, PyRange, PyObject, PyType, PyFunction, PyBound, PyModule, PyProperty, PyStaticMethod, PyClassMethod, Cell,
  T, None, NotImplemented, DONE, PyErr, raise, hk, eq, truthy, typeOf, lookupType, dictGet, dictSet, mroOf, isInstance, isNum } = C;
const { repr, str, iter, toList, len: pyLen, compare, num } = O;

let runFunction = null;          // (fn, args, kw) -> value   (set by vm)
let runWithLocals = null;
const setRunner = (f, g) => { runFunction = f; runWithLocals = g; };

const nat = (name, fn) => { fn.pyname = name; return fn; };

// ── argument parsing for native functions ─────────────────────────────────────────────────────────────────────
function pargs(fname, args, kw, names, defaults) {
  const out = new Array(names.length);
  for (let i = 0; i < names.length; i++) out[i] = i < args.length ? args[i] : undefined;
  if (args.length > names.length) throw raise('TypeError', `${fname}() takes at most ${names.length} arguments (${args.length} given)`);
  if (kw) for (const [k, v] of kw) {
    const i = names.indexOf(k);
    if (i < 0) throw raise('TypeError', `${fname}() got an unexpected keyword argument '${k}'`);
    out[i] = v;
  }
  for (let i = 0; i < names.length; i++) if (out[i] === undefined) out[i] = defaults && defaults[i] !== undefined ? defaults[i] : undefined;
  return out;
}

// ── call ─────────────────────────────────────────────────────────────────────────────────────────────────────
function call(f, args, kw) {
  if (f instanceof PyFunction) return runFunction(f, args, kw);
  if (typeof f === 'function') return f(args, kw);
  if (f instanceof PyBound) return call(f.fn, [f.self, ...args], kw);
  if (f instanceof PyType) return callType(f, args, kw);
  if (f instanceof PyObject) {
    const c = lookupType(f.cls, '__call__');
    if (c !== undefined) return call(c, [f, ...args], kw);
  }
  if (f instanceof PyStaticMethod) return call(f.f, args, kw);
  throw raise('TypeError', `'${typeOf(f).name}' object is not callable`);
}
C.setCallHook(call);

function callType(cls, args, kw) {
  if (cls.ctor) return cls.ctor(args, kw, cls);
  // user class (or subclass of a builtin with a ctor)
  const nw = lookupType(cls, '__new__');
  let obj;
  if ((C.isSubtype(cls, T.int) || C.isSubtype(cls, T.float)) && (nw === undefined || nw.pyNativeNew)) {
    obj = new PyObject(cls);
    const isF = C.isSubtype(cls, T.float);
    const v0 = args.length ? args[0] : 0;
    obj.num = isF ? Number(O.num(v0)) : require('./builtins').toInt(v0, args[1]);
    const init0 = lookupType(cls, '__init__');
    if (init0 !== undefined) call(init0, [obj, ...args], kw);
    return obj;
  }
  if (nw !== undefined && !(nw && nw.pyNativeNew)) {
    const f = nw instanceof PyStaticMethod ? nw.f : nw;
    obj = call(f, [cls, ...args], kw);
    if (!(obj instanceof PyObject) || !C.isSubtype(obj.cls, cls)) return obj;
  } else {
    obj = new PyObject(cls);
    if (C.isSubtype(cls, T.BaseException)) obj.d.set('args', new PyTuple(args.slice()));
  }
  const init = lookupType(cls, '__init__');
  if (init !== undefined) {
    if (init.pyNativeInit) init(args, kw, obj);
    else { const r = call(init, [obj, ...args], kw); if (r !== None) throw raise('TypeError', '__init__() should return None'); }
  } else if (C.isSubtype(cls, T.BaseException)) { /* args already set */ }
  return obj;
}

// ── attribute access ─────────────────────────────────────────────────────────────────────────────────────────
function bindDescriptor(v, obj, cls) {
  if (v instanceof PyFunction) return obj === undefined ? v : new PyBound(v, obj);
  if (typeof v === 'function' && v.pyMethod) return obj === undefined ? v : new PyBound(v, obj);
  if (v instanceof PyProperty) return obj === undefined ? v : call(v.fget, [obj]);
  if (v instanceof PyStaticMethod) return v.f;
  if (v instanceof PyClassMethod) return new PyBound(v.f, cls);
  return v;
}

function getattrOpt(o, name) {
  // returns undefined when missing
  if (o instanceof PyObject) {
    const cls = o.cls;
    const tv = lookupType(cls, name);
    if (tv instanceof PyProperty) return tv.fget ? call(tv.fget, [o]) : undefined;
    const iv = o.d.get(name);
    if (iv !== undefined) return iv;
    if (tv !== undefined) return bindDescriptor(tv, o, cls);
    if (name === '__class__') return cls;
    if (name === '__dict__') return dictFromMap(o.d);
    if (C.isSubtype(cls, T.BaseException) && name === 'args') return new PyTuple([]);
    const ga = lookupType(cls, '__getattr__');
    if (ga !== undefined) return call(ga, [o, name]);
    return undefined;
  }
  if (o instanceof PyType) {
    if (name === '__name__') return o.name;
    if (name === '__qualname__') return o.qualname || o.name;
    if (name === '__module__') return o.module || (o.d.get('__module__')) || 'builtins';
    if (name === '__mro__') return new PyTuple(mroOf(o).slice());
    if (name === '__bases__') return new PyTuple(o.bases.slice());
    if (name === '__dict__') return dictFromMap(o.d);
    if (name === '__class__') return o.meta || T.type;
    for (const c of mroOf(o)) {
      const v = c.d.get(name);
      if (v !== undefined) return bindDescriptor(v, undefined, o);
    }
    const nm = typeMethod(o, name);
    if (nm !== undefined) return nm;
    return undefined;
  }
  if (o instanceof PyModule) { const v = o.d.get(name); if (v !== undefined) return v; if (name === '__name__') return o.name; if (name === '__dict__') return dictFromMap(o.d); const ga = o.d.get('__getattr__'); if (ga && !name.startsWith('__')) return call(ga, [name], null); return undefined; }
  if (o instanceof PyFunction) {
    switch (name) {
      case '__name__': return o.name; case '__qualname__': return o.qualname; case '__doc__': return o.doc;
      case '__defaults__': return o.defaults; case '__module__': return o.globals.get('__name__'); case '__code__': return o.code;
      default: { const v = o.d.get(name); return v; }
    }
  }
  if (o instanceof PyBound) {
    if (name === '__self__') return o.self; if (name === '__func__') return o.fn; if (name === '__name__') return o.fn.name;
    return getattrOpt(o.fn, name);
  }
  if (name === '__class__') return typeOf(o);
  if (name === '__name__' && typeof o === 'function') return o.pyname || o.name;
  if (o instanceof PyProperty) {
    if (name === 'setter') return nat('setter', ([f]) => new PyProperty(o.fget, f, o.fdel));
    if (name === 'getter') return nat('getter', ([f]) => new PyProperty(f, o.fset, o.fdel));
    if (name === 'deleter') return nat('deleter', ([f]) => new PyProperty(o.fget, o.fset, f));
    return undefined;
  }
  if (o instanceof PySlice) { if (name === 'start') return o.start; if (name === 'stop') return o.stop; if (name === 'step') return o.step; }
  if (o instanceof PyRange) { if (name === 'start') return o.start; if (name === 'stop') return o.stop; if (name === 'step') return o.step; }
  if (typeof o === 'number') { if (name === 'real') return o; if (name === 'imag') return 0; }
  if (o && o.__gen) return genMethod(o, name);
  return typeMethod(typeOf(o), name, o);
}

function dictFromMap(m) { const d = new PyDict(); for (const [k, v] of m) dictSet(d, k, v); return d; }

function getattr(o, name) {
  const v = getattrOpt(o, name);
  if (v === undefined) {
    const err = raise('AttributeError', `'${typeOf(o).name}' object has no attribute '${name}'`);
    if (o instanceof PyType) err.exc.d.set('args', new PyTuple([`type object '${o.name}' has no attribute '${name}'`]));
    if (o instanceof PyModule) err.exc.d.set('args', new PyTuple([`module '${o.name}' has no attribute '${name}'`]));
    throw err;
  }
  return v;
}

function setattr(o, name, v) {
  if (o instanceof PyObject) {
    const tv = lookupType(o.cls, name);
    if (tv instanceof PyProperty) { if (!tv.fset) throw raise('AttributeError', "can't set attribute"); call(tv.fset, [o, v]); return; }
    const sa = lookupType(o.cls, '__setattr__');
    if (sa !== undefined && !sa.pyNativeSetattr) { call(sa, [o, name, v]); return; }
    o.d.set(name, v); return;
  }
  if (o instanceof PyType) { o.d.set(name, v); return; }
  if (o instanceof PyModule) { o.d.set(name, v); return; }
  if (o instanceof PyFunction) { o.d.set(name, v); if (name === '__doc__') o.doc = v; return; }
  throw raise('AttributeError', `'${typeOf(o).name}' object has no attribute '${name}'`);
}

function delattr(o, name) {
  const m = o instanceof PyObject || o instanceof PyType || o instanceof PyModule ? o.d : null;
  if (!m || !m.delete(name)) throw raise('AttributeError', name);
}

// ── native method tables ─────────────────────────────────────────────────────────────────────────────────────
const M = { str: {}, list: {}, dict: {}, set: {}, tuple: {}, int: {}, float: {}, bytes: {}, range: {}, generator: {} };
function typeMethod(t, name, self) {
  if (t instanceof PyType && self === undefined) {
    // class-level access on builtin types: dict.fromkeys, str.join ... -> unbound natives
    const tab = M[t.name]; const impl = tab && tab[name];
    if (impl && impl.cls) return nat(name, (args, kw) => impl(t, args, kw));
    if (impl) return nat(name, (args, kw) => impl(args[0], args.slice(1), kw));
    return undefined;
  }
  let tn = t.name;
  if (tn === 'bool') tn = 'int';
  if (tn === 'frozenset') tn = 'set';
  if (tn === 'bytearray') tn = 'bytes';
  const tab = M[tn]; const impl = tab && tab[name];
  if (impl) return nat(name, (args, kw) => impl(self, args, kw));
  return undefined;
}
function genMethod(g, name) {
  const impl = M.generator[name];
  return impl ? nat(name, (args, kw) => impl(g, args, kw)) : undefined;
}

const S = M.str;
const strArg = (s, who) => { if (typeof s !== 'string') throw raise('TypeError', `${who} arg must be str`); return s; };
S.join = (s, [it]) => toList(it).map((x) => { if (typeof x !== 'string') throw raise('TypeError', `sequence item: expected str instance, ${typeOf(x).name} found`); return x; }).join(s);
S.split = (s, args, kw) => {
  let [sep, maxsplit] = pargs('split', args, kw, ['sep', 'maxsplit'], [null, -1]);
  maxsplit = num(maxsplit);
  if (sep === null || sep === undefined) {
    const parts = s.trim() === '' ? [] : s.trim().split(/\s+/);
    if (maxsplit >= 0 && parts.length > maxsplit + 1) { let t = s.replace(/^\s+/, ''); const out = []; for (let i = 0; i < maxsplit; i++) { const m = /\s+/.exec(t); if (!m) break; out.push(t.slice(0, m.index)); t = t.slice(m.index + m[0].length); } out.push(t); return out; }
    return parts;
  }
  if (sep === '') throw raise('ValueError', 'empty separator');
  const all = s.split(sep);
  if (maxsplit >= 0 && all.length > maxsplit + 1) return all.slice(0, maxsplit).concat([all.slice(maxsplit).join(sep)]);
  return all;
};
S.rsplit = (s, args, kw) => {
  const [sep, maxsplit] = pargs('rsplit', args, kw, ['sep', 'maxsplit'], [null, -1]);
  if (maxsplit < 0 || sep === null) return S.split(s, [sep, maxsplit]);
  const all = s.split(sep);
  if (all.length <= maxsplit + 1) return all;
  return [all.slice(0, all.length - maxsplit).join(sep)].concat(all.slice(all.length - maxsplit));
};
const stripSet = (chars) => (chars === null || chars === undefined ? null : new Set(Array.from(chars)));
S.strip = (s, [c]) => S.rstrip(S.lstrip(s, [c]), [c]);
S.lstrip = (s, [c]) => { const cs = stripSet(c); const a = Array.from(s); let i = 0; while (i < a.length && (cs ? cs.has(a[i]) : /\s/.test(a[i]))) i++; return a.slice(i).join(''); };
S.rstrip = (s, [c]) => { const cs = stripSet(c); const a = Array.from(s); let i = a.length; while (i > 0 && (cs ? cs.has(a[i - 1]) : /\s/.test(a[i - 1]))) i--; return a.slice(0, i).join(''); };
S.lower = (s) => s.toLowerCase(); S.upper = (s) => s.toUpperCase(); S.casefold = (s) => s.toLowerCase();
S.title = (s) => s.toLowerCase().replace(/(^|[^a-zA-Z])([a-z])/g, (m, a, b) => a + b.toUpperCase());
S.capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
S.swapcase = (s) => Array.from(s).map(ch => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('');
const tupOrOne = (x) => (x instanceof PyTuple ? x.a : [x]);
S.startswith = (s, [p, start, end]) => { const t = (start !== undefined || end !== undefined) ? s.slice(start === undefined ? 0 : start, end === undefined ? undefined : end) : s; return tupOrOne(p).some(x => t.startsWith(x)); };
S.endswith = (s, [p, start, end]) => { const t = (start !== undefined || end !== undefined) ? s.slice(start === undefined ? 0 : start, end === undefined ? undefined : end) : s; return tupOrOne(p).some(x => t.endsWith(x)); };
S.replace = (s, [a, b, cnt]) => { if (cnt === undefined || cnt < 0) return s.split(a).join(b); let out = s, n = 0, res = ''; let i; while (n < cnt && (i = out.indexOf(a)) >= 0) { res += out.slice(0, i) + b; out = out.slice(i + a.length); n++; if (a === '') break; } return res + out; };
S.find = (s, [x, st, en]) => { const i = s.slice(st || 0, en === undefined ? undefined : en).indexOf(x); return i < 0 ? -1 : i + (st || 0); };
S.rfind = (s, [x]) => s.lastIndexOf(x);
S.index = (s, args) => { const i = S.find(s, args); if (i < 0) throw raise('ValueError', 'substring not found'); return i; };
S.count = (s, [x]) => (x === '' ? s.length + 1 : s.split(x).length - 1);
S.isdigit = (s) => /^\d+$/.test(s); S.isdecimal = S.isdigit; S.isnumeric = S.isdigit;
S.isalpha = (s) => /^[A-Za-zÀ-ɏ]+$/.test(s); S.isalnum = (s) => /^[A-Za-z0-9À-ɏ]+$/.test(s);
S.isspace = (s) => /^\s+$/.test(s); S.isupper = (s) => s !== s.toLowerCase() && s === s.toUpperCase(); S.islower = (s) => s !== s.toUpperCase() && s === s.toLowerCase();
S.isprintable = (s) => !/[\x00-\x1f\x7f]/.test(s); S.isidentifier = (s) => /^[A-Za-z_]\w*$/.test(s);
S.zfill = (s, [n]) => { const neg = s[0] === '-' || s[0] === '+'; return neg ? s[0] + s.slice(1).padStart(n - 1, '0') : s.padStart(n, '0'); };
S.ljust = (s, [n, f]) => s.padEnd(n, f || ' '); S.rjust = (s, [n, f]) => s.padStart(n, f || ' ');
S.center = (s, [n, f]) => { f = f || ' '; if (s.length >= n) return s; const t = n - s.length; const l = Math.floor(t / 2) + (t & n & 1); return f.repeat(l) + s + f.repeat(t - l); };
S.partition = (s, [sep]) => { const i = s.indexOf(sep); return i < 0 ? new PyTuple([s, '', '']) : new PyTuple([s.slice(0, i), sep, s.slice(i + sep.length)]); };
S.rpartition = (s, [sep]) => { const i = s.lastIndexOf(sep); return i < 0 ? new PyTuple(['', '', s]) : new PyTuple([s.slice(0, i), sep, s.slice(i + sep.length)]); };
S.splitlines = (s, [keep]) => { const parts = s.split(/(\r\n|\n|\r)/); const out = []; for (let i = 0; i < parts.length; i += 2) { if (parts[i] === '' && i + 1 >= parts.length) break; out.push(parts[i] + (truthy(keep) ? (parts[i + 1] || '') : '')); } return out; };
S.encode = (s, [enc]) => new PyBytes(Buffer.from(s, (enc || 'utf-8').toLowerCase().replace('-', '') === 'utf8' ? 'utf8' : ((enc || '').toLowerCase().replace('-', '') === 'ascii' ? 'latin1' : 'utf8')));
S.removeprefix = (s, [p]) => (s.startsWith(p) ? s.slice(p.length) : s); S.removesuffix = (s, [p]) => (p && s.endsWith(p) ? s.slice(0, -p.length) : s);
S.expandtabs = (s, [n]) => s.replace(/\t/g, ' '.repeat(n === undefined ? 8 : n));
S.format = (s, args, kw) => {
  let auto = 0;
  return s.replace(/\{\{|\}\}|\{([^{}!:]*)(?:!([rsa]))?(?::([^{}]*))?\}/g, (m, field, conv, spec) => {
    if (m === '{{') return '{'; if (m === '}}') return '}';
    let v;
    if (field === '' || field === undefined) v = args[auto++];
    else {
      const parts = field.split(/\.|\[/);
      const head = parts.shift();
      v = /^\d+$/.test(head) ? args[+head] : (kw ? kw.get(head) : undefined);
      for (const p of parts) { v = /^\d+\]?$/.test(p) ? O.getitem(v, parseInt(p, 10)) : (p.endsWith(']') ? O.getitem(v, p.slice(0, -1)) : getattr(v, p)); }
    }
    if (conv === 'r') v = repr(v); else if (conv === 's') v = str(v);
    return O.format(v, spec || '');
  });
};
S.__len__ = (s) => pyLen(s);

const L = M.list;
L.append = (l, [x]) => { l.push(x); return None; };
L.extend = (l, [it]) => { const a = toList(it); for (const x of a) l.push(x); return None; };
L.insert = (l, [i, x]) => { i = num(i); if (i < 0) i = Math.max(0, l.length + i); l.splice(Math.min(i, l.length), 0, x); return None; };
L.pop = (l, [i]) => { if (!l.length) throw raise('IndexError', 'pop from empty list'); if (i === undefined) return l.pop(); const j = i < 0 ? i + l.length : i; if (j < 0 || j >= l.length) throw raise('IndexError', 'pop index out of range'); return l.splice(j, 1)[0]; };
L.remove = (l, [x]) => { const i = l.findIndex(y => eq(y, x)); if (i < 0) throw raise('ValueError', 'list.remove(x): x not in list'); l.splice(i, 1); return None; };
L.index = (l, [x, st]) => { const i = l.findIndex((y, k) => k >= (st || 0) && eq(y, x)); if (i < 0) throw raise('ValueError', `${repr(x)} is not in list`); return i; };
L.count = (l, [x]) => l.filter(y => eq(y, x)).length;
L.reverse = (l) => { l.reverse(); return None; };
L.copy = (l) => l.slice();
L.clear = (l) => { l.length = 0; return None; };
function sortList(l, key, reverse) {
  const keyed = l.map((v, i) => [key === null || key === undefined ? v : call(key, [v]), v, i]);
  keyed.sort((a, b) => { if (compare('<', a[0], b[0])) return reverse ? 1 : -1; if (compare('<', b[0], a[0])) return reverse ? -1 : 1; return a[2] - b[2]; });
  return keyed.map(k => k[1]);
}
L.sort = (l, args, kw) => { const [key, reverse] = pargs('sort', [], kw, ['key', 'reverse'], [null, false]); const s = sortList(l, key, truthy(reverse)); for (let i = 0; i < s.length; i++) l[i] = s[i]; return None; };
M.tuple.index = (t, [x]) => { const i = t.a.findIndex(y => eq(y, x)); if (i < 0) throw raise('ValueError', 'tuple.index(x): x not in tuple'); return i; };
M.tuple.count = (t, [x]) => t.a.filter(y => eq(y, x)).length;

const D = M.dict;
D.get = (d, [k, dflt]) => { const v = dictGet(d, k); return v === undefined ? (dflt === undefined ? None : dflt) : v; };
D.items = (d) => Array.from(d.m.values()).map(([k, v]) => new PyTuple([k, v]));
D.keys = (d) => Array.from(d.m.values()).map(e => e[0]);
D.values = (d) => Array.from(d.m.values()).map(e => e[1]);
D.setdefault = (d, [k, dflt]) => { const v = dictGet(d, k); if (v !== undefined) return v; const x = dflt === undefined ? None : dflt; dictSet(d, k, x); return x; };
D.update = (d, args, kw) => {
  if (args.length) { const o = args[0]; if (o instanceof PyDict) for (const [, [k, v]] of o.m) dictSet(d, k, v); else { const it = iter(o); let p; while ((p = it.next()) !== DONE) { const kv = toList(p); dictSet(d, kv[0], kv[1]); } } }
  if (kw) for (const [k, v] of kw) dictSet(d, k, v);
  return None;
};
D.pop = (d, [k, dflt]) => { const e = d.m.get(hk(k)); if (e === undefined) { if (dflt !== undefined) return dflt; throw new PyErr(C.newExc(T.KeyError, k)); } d.m.delete(hk(k)); return e[1]; };
D.popitem = (d) => { const ks = Array.from(d.m.keys()); if (!ks.length) throw raise('KeyError', 'popitem(): dictionary is empty'); const e = d.m.get(ks[ks.length - 1]); d.m.delete(ks[ks.length - 1]); return new PyTuple([e[0], e[1]]); };
D.clear = (d) => { d.m.clear(); return None; };
D.copy = (d) => { const r = new PyDict(); for (const [h, e] of d.m) r.m.set(h, [e[0], e[1]]); return r; };
D.fromkeys = (_t, [it, v]) => { const r = new PyDict(); for (const k of toList(it)) dictSet(r, k, v === undefined ? None : v); return r; };

D.fromkeys.cls = true;
const ST = M.set;
ST.add = (s, [x]) => { C.setAdd(s, x); return None; };
ST.discard = (s, [x]) => { s.m.delete(hk(x)); return None; };
ST.remove = (s, [x]) => { if (!s.m.delete(hk(x))) throw new PyErr(C.newExc(T.KeyError, x)); return None; };
ST.update = (s, args) => { for (const o of args) for (const x of toList(o)) C.setAdd(s, x); return None; };
ST.union = (s, args) => { const r = new PySet(s.frozen); for (const [h, v] of s.m) r.m.set(h, v); for (const o of args) for (const x of toList(o)) C.setAdd(r, x); return r; };
ST.intersection = (s, args) => { const r = new PySet(s.frozen); const o = args[0] instanceof PySet ? args[0] : (() => { const t = new PySet(); for (const x of toList(args[0])) C.setAdd(t, x); return t; })(); for (const [h, v] of s.m) if (o.m.has(h)) r.m.set(h, v); return r; };
ST.difference = (s, args) => { const r = new PySet(s.frozen); const o = new PySet(); for (const a of args) for (const x of toList(a)) C.setAdd(o, x); for (const [h, v] of s.m) if (!o.m.has(h)) r.m.set(h, v); return r; };
ST.symmetric_difference = (s, [o]) => O.binop('^', s, o);
ST.issubset = (s, [o]) => Array.from(s.m.keys()).every(h => (o instanceof PySet ? o.m.has(h) : toList(o).some(x => hk(x) === h)));
ST.issuperset = (s, [o]) => toList(o).every(x => s.m.has(hk(x)));
ST.isdisjoint = (s, [o]) => toList(o).every(x => !s.m.has(hk(x)));
ST.pop = (s) => { const k = s.m.keys().next(); if (k.done) throw raise('KeyError', 'pop from an empty set'); const v = s.m.get(k.value); s.m.delete(k.value); return v; };
ST.clear = (s) => { s.m.clear(); return None; };
ST.copy = (s) => { const r = new PySet(s.frozen); for (const [h, v] of s.m) r.m.set(h, v); return r; };

M.int.bit_length = (n) => (n === 0 ? 0 : Math.abs(Math.trunc(n)).toString(2).length);
M.int.to_bytes = (n, [len, order]) => { const b = Buffer.alloc(len); let x = BigInt(n); for (let i = 0; i < len; i++) { b[order === 'big' ? len - 1 - i : i] = Number(x & 0xffn); x >>= 8n; } return new PyBytes(b); };
M.int.is_integer = () => true;
M.int.__format__ = (n, [spec]) => O.format(O.num(n), spec);
M.int.__repr__ = (n) => O.repr(O.num(n));
M.int.__int__ = (n) => Math.trunc(O.num(n));
M.float.is_integer = (x) => Number.isInteger(x);
M.float.hex = (x) => x.toString(16);
M.bytes.decode = (b, [enc]) => b.b.toString((enc || 'utf-8').toLowerCase().replace('-', '') === 'utf8' ? 'utf8' : 'latin1');
M.bytes.hex = (b, [sep]) => (sep ? Array.from(b.b).map(x => x.toString(16).padStart(2, '0')).join(sep) : b.b.toString('hex'));
M.bytes.join = (b, [it]) => new PyBytes(Buffer.concat(toList(it).map((x, i) => { if (!(x instanceof PyBytes)) throw raise('TypeError', `sequence item ${i}: expected a bytes-like object, ${typeOf(x).name} found`); return i ? Buffer.concat([b.b, x.b]) : x.b; })));
M.bytes.startswith = (b, [p]) => b.b.subarray(0, p.b.length).equals(p.b);
M.bytes.split = (b, [sep]) => { const s = b.b.toString('latin1').split(sep.b.toString('latin1')); return s.map(x => new PyBytes(Buffer.from(x, 'latin1'))); };
M.bytes.strip = (b) => new PyBytes(Buffer.from(b.b.toString('latin1').trim(), 'latin1'));
M.bytes.fromhex = (_t, [h]) => new PyBytes(Buffer.from(h.replace(/\s+/g, ''), 'hex'));
M.bytes.fromhex.cls = true;
// bytearray (a PyBytes with .mutable): the buffer is replaced on growth, so every holder of the object sees the change
const needMutable = (b, n) => { if (!b.mutable) throw raise('AttributeError', `'bytes' object has no attribute '${n}'`); };
const bytesOf = (v) => (v instanceof PyBytes ? v.b : Buffer.from(toList(v)));
M.bytes.extend = (b, [it]) => { needMutable(b, 'extend'); b.b = Buffer.concat([b.b, bytesOf(it)]); return None; };
M.bytes.append = (b, [x]) => { needMutable(b, 'append'); b.b = Buffer.concat([b.b, Buffer.from([x & 0xff])]); return None; };
M.bytes.clear = (b) => { needMutable(b, 'clear'); b.b = Buffer.alloc(0); return None; };
M.bytes.copy = (b) => { needMutable(b, 'copy'); const c = new PyBytes(Buffer.from(b.b)); c.mutable = true; return c; };
M.range.index = (r, [x]) => (O.contains(r, x) ? (x - r.start) / r.step : (() => { throw raise('ValueError', 'not in range'); })());
M.range.count = (r, [x]) => (O.contains(r, x) ? 1 : 0);

// generators
M.generator.send = (g, [v]) => g.__send(v);
M.generator.close = (g) => { g.__close(); return None; };
M.generator.throw = (g, [e]) => g.__throw(e);

// ── class construction (__build_class__) ─────────────────────────────────────────────────────────────────────
function buildClass(args, kw) {
  const func = args[0], name = args[1];
  let bases = args.slice(2);
  let meta = null;
  const kwargs = [];
  if (kw) for (const [k, v] of kw) { if (k === 'metaclass') meta = v; else kwargs.push([k, v]); }
  if (!bases.length) bases = [T.object];
  const ns = new Map();
  ns.set('__module__', func.globals.get('__name__'));
  ns.set('__qualname__', name);
  const cell = runWithLocals(func, ns);
  const cls = new PyType(name, bases, ns, null);
  cls.module = ns.get('__module__'); cls.qualname = ns.get('__qualname__') || name;
  if (meta && meta !== T.type) cls.meta = meta instanceof PyType ? meta : null;
  cls.builtin = false;
  mroOf(cls);
  for (const b of bases) if (b.ctor && !cls.ctor && b.builtin && !C.isSubtype(cls, T.BaseException) && b !== T.object) cls.ctor = null;
  if (cell instanceof Cell) cell.v = cls;
  return cls;
}

module.exports = {
  setRunner, nat, pargs, call, callType, getattr, getattrOpt, setattr, delattr, buildClass, M, sortList, typeMethod, dictFromMap, bindDescriptor,
};
