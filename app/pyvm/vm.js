// pyvm — CPython 3.12 bytecode interpreter.
'use strict';
const C = require('./core');
const O = require('./ops');
const A = require('./attr');
const { OP } = require('./opcodes');
const { PyTuple, PyBytes, PyDict, PySet, PySlice, PyObject, PyType, PyFunction, PyBound, PyModule, Cell, T, None, DONE, PyErr, raise, truthy, dictSet, dictGet, mroOf } = C;
const { CodeObj } = require('./marshal');

const NULL = { __null: true };
const CMP = ['<', '<=', '==', '!=', '>', '>='];
const vm = { ops: 0, opLimit: 0, builtins: new Map(), modules: new Map(), moduleLoader: null, curExc: null, trace: null };

class Frame {
  constructor(code, globals, locals, fn) {
    this.code = code; this.globals = globals; this.locals = locals; this.fn = fn;
    this.f = new Array(code.nlocals).fill(undefined);
    this.stack = []; this.ip = 0; this.kwnames = null; this.gen = null;
  }
}

class Generator {
  constructor(frame) { this.frame = frame; this.started = false; this.done = false; this.running = false; this.__gen = true; this.retval = None; }
  next() {
    if (this.done) return DONE;
    return this.__resume(None);
  }
  __resume(sent, throwExc) {
    if (this.running) throw raise('ValueError', 'generator already executing');
    if (this.done) { if (throwExc) throw new PyErr(throwExc); throw new PyErr(C.newExc(T.StopIteration)); }
    const fr = this.frame;
    this.running = true;
    try {
      if (!this.started) { this.started = true; if (sent !== None && !throwExc) throw raise('TypeError', "can't send non-None value to a just-started generator"); }
      if (throwExc) fr.throwIn = throwExc; else fr.stack.push(sent);
      const r = runFrame(fr);
      if (fr.yielded) { fr.yielded = false; return r; }
      this.done = true; this.retval = r;
      return DONE;
    } catch (e) { this.done = true; throw e; } finally { this.running = false; }
  }
  __send(v) { const r = this.__resume(v); if (r === DONE) throw new PyErr(C.newExc(T.StopIteration, this.retval)); return r; }
  __throw(e) { const exc = e instanceof PyType ? A.callType(e, [], null) : e; const r = this.__resume(None, exc); if (r === DONE) throw new PyErr(C.newExc(T.StopIteration, this.retval)); return r; }
  __close() { this.done = true; }
}

function findHandler(frame, off) {
  for (const h of frame.code.excEntries) if (off >= h.start && off < h.end) return h;
  return null;
}

function excMatches(exc, typ) {
  if (typ instanceof PyTuple) return typ.a.some(t => excMatches(exc, t));
  if (!(typ instanceof PyType)) throw raise('TypeError', 'catching classes that do not inherit from BaseException is not allowed');
  return C.isSubtype(exc.cls, typ);
}

function getLoader(name) { return vm.moduleLoader ? vm.moduleLoader(name) : null; }

function importModule(name, globals, fromlist, level) {
  let full = name;
  if (level > 0) {
    const pkgName = String((globals && globals.get('__package__')) || '');
    const parts = pkgName ? pkgName.split('.') : [];
    const base = parts.slice(0, Math.max(0, parts.length - (level - 1)));
    full = base.join('.') + (name ? (base.length ? '.' : '') + name : '');
  }
  const load = (n) => {
    let m = vm.modules.get(n);
    if (m) return m;
    m = getLoader(n);
    if (!m) throw new PyErr(C.newExc(T.ModuleNotFoundError, `No module named '${n}'`));
    return m;
  };
  const chain = full.split('.');
  let mod;
  for (let i = 1; i <= chain.length; i++) { mod = load(chain.slice(0, i).join('.')); if (i > 1) { const parent = vm.modules.get(chain.slice(0, i - 1).join('.')); if (parent) parent.d.set(chain[i - 1], mod); } }
  const hasFrom = fromlist && (fromlist instanceof PyTuple ? fromlist.a.length : 0);
  if (hasFrom) {
    for (const n of fromlist.a) {
      if (n !== '*' && !mod.d.has(n)) { const sub = full + '.' + n; const m2 = vm.modules.get(sub) || getLoader(sub); if (m2) mod.d.set(n, m2); }
    }
    return mod;
  }
  return level > 0 && !name ? mod : load(chain[0]);
}

function bindArgs(fn, frame, args, kw) {
  const code = fn.code, f = frame.f;
  const npos = code.argcount, nkw = code.kwonly, nargs = args.length;
  const hasVar = code.flags & 4, hasKw = code.flags & 8;
  const n = nargs < npos ? nargs : npos;
  for (let i = 0; i < n; i++) f[i] = args[i];
  let idx = npos + nkw;
  if (hasVar) { f[idx++] = new PyTuple(nargs > npos ? args.slice(npos) : []); }
  else if (nargs > npos) throw raise('TypeError', `${fn.name}() takes ${npos} positional argument${npos === 1 ? '' : 's'} but ${nargs} ${nargs === 1 ? 'was' : 'were'} given`);
  let kwd = null;
  if (hasKw) { kwd = new PyDict(); f[idx] = kwd; }
  if (kw) {
    const names = code.localsplusnames;
    for (const [k, v] of kw) {
      let i = -1;
      for (let j = 0; j < npos + nkw; j++) if (names[j] === k) { i = j; break; }
      if (i >= 0 && i >= code.posonly) { if (f[i] !== undefined) throw raise('TypeError', `${fn.name}() got multiple values for argument '${k}'`); f[i] = v; }
      else if (kwd) dictSet(kwd, k, v);
      else throw raise('TypeError', `${fn.name}() got an unexpected keyword argument '${k}'`);
    }
  }
  if (n < npos) {
    const defs = fn.defaults ? fn.defaults.a : [];
    const first = npos - defs.length;
    for (let i = n; i < npos; i++) {
      if (f[i] !== undefined) continue;
      if (i >= first) f[i] = defs[i - first];
      else throw raise('TypeError', `${fn.name}() missing 1 required positional argument: '${code.localsplusnames[i]}'`);
    }
  }
  if (nkw) {
    for (let i = npos; i < npos + nkw; i++) {
      if (f[i] !== undefined) continue;
      const d = fn.kwdefaults ? dictGet(fn.kwdefaults, code.localsplusnames[i]) : undefined;
      if (d === undefined) throw raise('TypeError', `${fn.name}() missing required keyword-only argument: '${code.localsplusnames[i]}'`);
      f[i] = d;
    }
  }
}

function callFunction(fn, args, kw) {
  const frame = new Frame(fn.code, fn.globals, null, fn);
  bindArgs(fn, frame, args, kw);
  if (fn.code.isGen) {
    // skip RETURN_GENERATOR: execution starts after it (POP_TOP consumes the first sent None)
    let i = 0; while (i < fn.code.ops.length && fn.code.ops[i] !== OP.RETURN_GENERATOR) i++;
    frame.ip = i + 1;
    // generator frames keep running state; the cells for arguments are created by MAKE_CELL in the prologue
    const prologue = [];
    for (let k = 0; k < i; k++) prologue.push(k);
    runPrologue(frame, i);
    return new Generator(frame);
  }
  return runFrame(frame);
}

function runPrologue(frame, upto) {
  // MAKE_CELL / COPY_FREE_VARS before RETURN_GENERATOR
  const code = frame.code;
  for (let k = 0; k < upto; k++) {
    const op = code.ops[k], arg = code.args[k];
    if (op === OP.MAKE_CELL) frame.f[arg] = new Cell(frame.f[arg]);
    else if (op === OP.COPY_FREE_VARS) { const cl = frame.fn.closure || []; for (let i = 0; i < arg; i++) frame.f[code.nlocals - arg + i] = cl[i]; }
  }
}

function runWithLocals(fn, ns) {
  const frame = new Frame(fn.code, fn.globals, ns, fn);
  return runFrame(frame);
}

A.setRunner(callFunction, runWithLocals);

function loadAttrMethod(stack, obj, name) {
  if (obj instanceof PyObject) {
    const tv = C.lookupType(obj.cls, name);
    if (tv instanceof PyFunction && !obj.d.has(name)) { stack.push(tv, obj); return; }
  }
  stack.push(NULL, A.getattr(obj, name));
}

function superLookup(cls, self, name) {
  const t = self instanceof PyType ? self : C.typeOf(self);
  const mro = mroOf(t);
  const i = mro.indexOf(cls);
  for (let k = i + 1; k < mro.length; k++) {
    const v = mro[k].d.get(name);
    if (v !== undefined) return [v, mro[k]];
  }
  return [undefined, null];
}

function runFrame(frame) {
  const code = frame.code, ops = code.ops, args = code.args, tgt = code.tgt, consts = code.consts, names = code.names;
  const stack = frame.stack, f = frame.f;
  let ip = frame.ip;
  const g = frame.globals;
  for (;;) {
    try {
      if (frame.throwIn) { const e = frame.throwIn; frame.throwIn = null; throw new PyErr(e); }
      for (;;) {
        frame.ip = ip;
        const op = ops[ip], arg = args[ip];
        ip++;
        if (vm.opLimit && ++vm.ops > vm.opLimit) throw new Error('pyvm op limit hit in ' + code.qualname + ' at instruction ' + (ip - 1) + ' (' + require('./opcodes').NAMES[op] + ') stack ' + stack.length);
        switch (op) {
          case OP.RESUME: case OP.NOP: case OP.CACHE: case OP.EXTENDED_ARG: break;
          case OP.POP_TOP: stack.pop(); break;
          case OP.PUSH_NULL: stack.push(NULL); break;
          case OP.COPY: stack.push(stack[stack.length - arg]); break;
          case OP.SWAP: { const i = stack.length - arg, j = stack.length - 1; const t = stack[i]; stack[i] = stack[j]; stack[j] = t; break; }
          case OP.END_FOR: stack.pop(); stack.pop(); break;
          case OP.LOAD_CONST: stack.push(consts[arg]); break;
          case OP.LOAD_FAST: case OP.LOAD_FAST_CHECK: {
            const v = f[arg];
            if (v === undefined) throw raise('UnboundLocalError', `cannot access local variable '${code.localsplusnames[arg]}' where it is not associated with a value`);
            stack.push(v); break;
          }
          case OP.LOAD_FAST_AND_CLEAR: stack.push(f[arg]); f[arg] = undefined; break;
          case OP.STORE_FAST: f[arg] = stack.pop(); break;
          case OP.DELETE_FAST: f[arg] = undefined; break;
          case OP.MAKE_CELL: f[arg] = new Cell(f[arg]); break;
          case OP.COPY_FREE_VARS: { const cl = frame.fn.closure || []; for (let i = 0; i < arg; i++) f[code.nlocals - arg + i] = cl[i]; break; }
          case OP.LOAD_CLOSURE: stack.push(f[arg]); break;
          case OP.LOAD_DEREF: {
            const c = f[arg];
            if (c.v === undefined) throw raise('NameError', `free variable '${code.localsplusnames[arg]}' referenced before assignment in enclosing scope`);
            stack.push(c.v); break;
          }
          case OP.STORE_DEREF: f[arg].v = stack.pop(); break;
          case OP.DELETE_DEREF: f[arg].v = undefined; break;
          case OP.LOAD_FROM_DICT_OR_DEREF: {
            const d = stack.pop(); const nm = code.localsplusnames[arg];
            const v = d instanceof Map ? d.get(nm) : undefined;
            stack.push(v !== undefined ? v : f[arg].v); break;
          }
          case OP.LOAD_NAME: {
            const nm = names[arg];
            let v = frame.locals ? frame.locals.get(nm) : undefined;
            if (v === undefined) v = g.get(nm);
            if (v === undefined) v = vm.builtins.get(nm);
            if (v === undefined) throw raise('NameError', `name '${nm}' is not defined`);
            stack.push(v); break;
          }
          case OP.STORE_NAME: (frame.locals || g).set(names[arg], stack.pop()); break;
          case OP.DELETE_NAME: (frame.locals || g).delete(names[arg]); break;
          case OP.LOAD_LOCALS: stack.push(frame.locals || g); break;
          case OP.LOAD_GLOBAL: {
            const nm = names[arg >> 1];
            let v = g.get(nm);
            if (v === undefined) v = vm.builtins.get(nm);
            if (v === undefined) throw raise('NameError', `name '${nm}' is not defined`);
            if (arg & 1) stack.push(NULL);
            stack.push(v); break;
          }
          case OP.STORE_GLOBAL: g.set(names[arg], stack.pop()); break;
          case OP.LOAD_ATTR: {
            const nm = names[arg >> 1], obj = stack.pop();
            if (arg & 1) loadAttrMethod(stack, obj, nm); else stack.push(A.getattr(obj, nm));
            break;
          }
          case OP.LOAD_SUPER_ATTR: {
            const self = stack.pop(), cls = stack.pop(); stack.pop();
            const nm = names[arg >> 2];
            const [v, owner] = superLookup(cls, self, nm);
            if (v === undefined) throw raise('AttributeError', `'super' object has no attribute '${nm}'`);
            if (arg & 1) {
              if (v instanceof PyFunction || (typeof v === 'function' && v.pyMethod)) stack.push(v, self); else stack.push(NULL, A.bindDescriptor(v, self instanceof PyType ? undefined : self, self instanceof PyType ? self : C.typeOf(self)));
            } else stack.push(A.bindDescriptor(v, self instanceof PyType ? undefined : self, self instanceof PyType ? self : C.typeOf(self)));
            void owner; break;
          }
          case OP.STORE_ATTR: { const obj = stack.pop(), v = stack.pop(); A.setattr(obj, names[arg], v); break; }
          case OP.DELETE_ATTR: A.delattr(stack.pop(), names[arg]); break;
          case OP.BINARY_OP: {
            const b = stack.pop(), a = stack.pop();
            const inplace = arg >= 13;
            stack.push(O.binop(O.NB[inplace ? arg - 13 : arg], a, b, inplace)); break;
          }
          case OP.COMPARE_OP: { const b = stack.pop(), a = stack.pop(); stack.push(O.compare(CMP[arg >> 4], a, b)); break; }
          case OP.IS_OP: { const b = stack.pop(), a = stack.pop(); stack.push(arg ? a !== b : a === b); break; }
          case OP.CONTAINS_OP: { const b = stack.pop(), a = stack.pop(); const r = O.contains(b, a); stack.push(arg ? !r : r); break; }
          case OP.UNARY_NEGATIVE: stack.push(O.unop('-', stack.pop())); break;
          case OP.UNARY_NOT: stack.push(!truthy(stack.pop())); break;
          case OP.UNARY_INVERT: stack.push(O.unop('~', stack.pop())); break;
          case OP.BINARY_SUBSCR: { const k = stack.pop(), o = stack.pop(); stack.push(O.getitem(o, k)); break; }
          case OP.STORE_SUBSCR: { const k = stack.pop(), o = stack.pop(), v = stack.pop(); O.setitem(o, k, v); break; }
          case OP.DELETE_SUBSCR: { const k = stack.pop(), o = stack.pop(); O.delitem(o, k); break; }
          case OP.BINARY_SLICE: { const hi = stack.pop(), lo = stack.pop(), o = stack.pop(); stack.push(O.getitem(o, new PySlice(lo, hi, None))); break; }
          case OP.STORE_SLICE: { const hi = stack.pop(), lo = stack.pop(), o = stack.pop(), v = stack.pop(); O.setitem(o, new PySlice(lo, hi, None), v); break; }
          case OP.BUILD_SLICE: { const step = arg === 3 ? stack.pop() : None; const hi = stack.pop(), lo = stack.pop(); stack.push(new PySlice(lo, hi, step)); break; }
          case OP.BUILD_TUPLE: stack.push(new PyTuple(arg ? stack.splice(stack.length - arg, arg) : [])); break;
          case OP.BUILD_LIST: stack.push(arg ? stack.splice(stack.length - arg, arg) : []); break;
          case OP.BUILD_SET: { const s = new PySet(); for (const x of (arg ? stack.splice(stack.length - arg, arg) : [])) C.setAdd(s, x); stack.push(s); break; }
          case OP.BUILD_MAP: { const d = new PyDict(); const it = arg ? stack.splice(stack.length - 2 * arg, 2 * arg) : []; for (let i = 0; i < it.length; i += 2) dictSet(d, it[i], it[i + 1]); stack.push(d); break; }
          case OP.BUILD_CONST_KEY_MAP: { const keys = stack.pop().a; const vals = stack.splice(stack.length - arg, arg); const d = new PyDict(); for (let i = 0; i < arg; i++) dictSet(d, keys[i], vals[i]); stack.push(d); break; }
          case OP.BUILD_STRING: stack.push(arg ? stack.splice(stack.length - arg, arg).join('') : ''); break;
          case OP.LIST_APPEND: { const v = stack.pop(); stack[stack.length - arg].push(v); break; }
          case OP.LIST_EXTEND: { const v = stack.pop(); const l = stack[stack.length - arg]; for (const x of O.toList(v)) l.push(x); break; }
          case OP.SET_ADD: { const v = stack.pop(); C.setAdd(stack[stack.length - arg], v); break; }
          case OP.SET_UPDATE: { const v = stack.pop(); for (const x of O.toList(v)) C.setAdd(stack[stack.length - arg], x); break; }
          case OP.MAP_ADD: { const v = stack.pop(), k = stack.pop(); dictSet(stack[stack.length - arg], k, v); break; }
          case OP.DICT_UPDATE: case OP.DICT_MERGE: {
            const v = stack.pop(); const d = stack[stack.length - arg];
            if (v instanceof PyDict) for (const [, [k, x]] of v.m) dictSet(d, k, x); else { const keys = A.call(A.getattr(v, 'keys'), [], null); for (const k of O.toList(keys)) dictSet(d, k, O.getitem(v, k)); }
            break;
          }
          case OP.UNPACK_SEQUENCE: {
            const seq = stack.pop(); const items = seq instanceof PyTuple ? seq.a : O.toList(seq);
            if (items.length !== arg) throw raise('ValueError', items.length < arg ? `not enough values to unpack (expected ${arg}, got ${items.length})` : `too many values to unpack (expected ${arg})`);
            for (let i = arg - 1; i >= 0; i--) stack.push(items[i]); break;
          }
          case OP.UNPACK_EX: {
            const before = arg & 0xff, after = arg >> 8; const items = O.toList(stack.pop());
            if (items.length < before + after) throw raise('ValueError', `not enough values to unpack (expected at least ${before + after}, got ${items.length})`);
            const mid = items.slice(before, items.length - after);
            const out = [...items.slice(0, before), mid, ...items.slice(items.length - after)];
            for (let i = out.length - 1; i >= 0; i--) stack.push(out[i]); break;
          }
          case OP.FORMAT_VALUE: {
            const spec = (arg & 4) ? stack.pop() : '';
            let v = stack.pop();
            const conv = arg & 3;
            if (conv === 1) v = O.str(v); else if (conv === 2 || conv === 3) v = O.repr(v);
            stack.push(O.format(v, spec)); break;
          }
          case OP.GET_ITER: stack.push(O.iter(stack.pop())); break;
          case OP.FOR_ITER: {
            const v = stack[stack.length - 1].next();
            if (v === DONE) { stack.pop(); ip = code.tgt[ip - 1] + 1; } else stack.push(v);
            break;
          }
          case OP.JUMP_FORWARD: case OP.JUMP_BACKWARD: case OP.JUMP_BACKWARD_NO_INTERRUPT: ip = tgt[ip - 1]; break;
          case OP.POP_JUMP_IF_FALSE: if (!truthy(stack.pop())) ip = tgt[ip - 1]; break;
          case OP.POP_JUMP_IF_TRUE: if (truthy(stack.pop())) ip = tgt[ip - 1]; break;
          case OP.POP_JUMP_IF_NONE: if (stack.pop() === null) ip = tgt[ip - 1]; break;
          case OP.POP_JUMP_IF_NOT_NONE: if (stack.pop() !== null) ip = tgt[ip - 1]; break;
          case OP.RETURN_VALUE: return stack.pop();
          case OP.RETURN_CONST: return consts[arg];
          case OP.KW_NAMES: frame.kwnames = consts[arg].a; break;
          case OP.CALL: {
            const kn = frame.kwnames; frame.kwnames = null;
            const raw = arg ? stack.splice(stack.length - arg, arg) : [];
            const a = stack.pop(), b = stack.pop();
            let fn, cargs;
            if (b === NULL) { fn = a; cargs = raw; } else { fn = b; cargs = [a, ...raw]; }
            let kw = null;
            if (kn) { kw = new Map(); const nk = kn.length; for (let i = 0; i < nk; i++) kw.set(kn[i], cargs[cargs.length - nk + i]); cargs = cargs.slice(0, cargs.length - nk); }
            stack.push(A.call(fn, cargs, kw)); break;
          }
          case OP.CALL_FUNCTION_EX: {
            let kw = null;
            if (arg & 1) { const d = stack.pop(); kw = new Map(); if (d instanceof PyDict) for (const [, [k, v]] of d.m) kw.set(k, v); }
            const a = stack.pop(); const fn = stack.pop(); if (stack.length && stack[stack.length - 1] === NULL) stack.pop();
            stack.push(A.call(fn, O.toList(a), kw)); break;
          }
          case OP.MAKE_FUNCTION: {
            const co = stack.pop();
            const fn = new PyFunction(co, g, co.name);
            if (arg & 8) fn.closure = stack.pop().a;
            if (arg & 4) stack.pop();
            if (arg & 2) fn.kwdefaults = stack.pop();
            if (arg & 1) fn.defaults = stack.pop();
            fn.doc = co.consts.length && typeof co.consts[0] === 'string' && false ? co.consts[0] : null;
            stack.push(fn); break;
          }
          case OP.LOAD_BUILD_CLASS: stack.push(vm.builtins.get('__build_class__')); break;
          case OP.SETUP_ANNOTATIONS: { const ns = frame.locals || g; if (!ns.has('__annotations__')) ns.set('__annotations__', new PyDict()); break; }
          case OP.IMPORT_NAME: {
            const fromlist = stack.pop(), level = stack.pop();
            stack.push(importModule(names[arg], g, fromlist, level)); break;
          }
          case OP.IMPORT_FROM: {
            const mod = stack[stack.length - 1]; const nm = names[arg];
            let v = A.getattrOpt(mod, nm);
            if (v === undefined && mod instanceof PyModule) { const m2 = vm.modules.get(mod.name + '.' + nm) || getLoader(mod.name + '.' + nm); if (m2) v = m2; }
            if (v === undefined) throw new PyErr(C.newExc(T.ImportError, `cannot import name '${nm}' from '${mod.name}'`));
            stack.push(v); break;
          }
          case OP.LOAD_ASSERTION_ERROR: stack.push(T.AssertionError); break;
          case OP.RAISE_VARARGS: {
            if (arg === 0) { if (!vm.curExc) throw raise('RuntimeError', 'No active exception to reraise'); throw new PyErr(vm.curExc); }
            let cause; if (arg === 2) cause = stack.pop();
            let exc = stack.pop();
            if (exc instanceof PyType) exc = A.callType(exc, [], null);
            if (!(exc instanceof PyObject)) throw raise('TypeError', 'exceptions must derive from BaseException');
            if (cause !== undefined) exc.d.set('__cause__', cause);
            throw new PyErr(exc);
          }
          case OP.RERAISE: { const exc = stack.pop(); if (arg) stack.pop(); throw new PyErr(exc); }
          case OP.PUSH_EXC_INFO: { const v = stack.pop(); stack.push(vm.curExc); stack.push(v); vm.curExc = v; break; }
          case OP.POP_EXCEPT: vm.curExc = stack.pop(); break;
          case OP.CHECK_EXC_MATCH: { const right = stack.pop(); const left = stack[stack.length - 1]; stack.push(excMatches(left, right)); break; }
          case OP.BEFORE_WITH: {
            const mgr = stack.pop();
            const exit = A.getattr(mgr, '__exit__'); const enter = A.getattr(mgr, '__enter__');
            stack.push(exit); stack.push(A.call(enter, [], null)); break;
          }
          case OP.WITH_EXCEPT_START: {
            const exc = stack[stack.length - 1]; const exit = stack[stack.length - 4];
            stack.push(A.call(exit, [exc.cls, exc, None], null)); break;
          }
          case OP.CALL_INTRINSIC_1: {
            const v = stack.pop();
            switch (arg) {
              case 3: stack.push(v instanceof PyObject && C.isSubtype(v.cls, T.StopIteration) ? C.newExc(T.RuntimeError, 'generator raised StopIteration') : v); break;
              case 5: stack.push(O.num(v)); break;
              case 6: stack.push(new PyTuple(v)); break;
              default: throw new Error('CALL_INTRINSIC_1 ' + arg);
            }
            break;
          }
          case OP.RETURN_GENERATOR: break;
          case OP.YIELD_VALUE: { frame.yielded = true; frame.ip = ip; return stack.pop(); }
          case OP.GET_LEN: stack.push(O.len(stack[stack.length - 1])); break;
          default: throw new Error('pyvm: unimplemented opcode ' + require('./opcodes').NAMES[op] + ' in ' + code.qualname);
        }
      }
    } catch (e0) {
      const e = e0 instanceof PyErr ? e0 : osError(e0);
      if (!(e instanceof PyErr)) throw e0;
      const off = code.offs[frame.ip];
      const h = findHandler(frame, off);
      if (!h) { if (vm.trace) (e.tb || (e.tb = [])).push(code.qualname + ':' + frame.ip); throw e; }
      stack.length = h.depth;
      if (h.lasti) stack.push(off);
      stack.push(e.exc);
      ip = code.byOff.get(h.target);
    }
  }
}

// Node file-system errors become the Python OSError family so `except OSError` / FileNotFoundError in the interpreted code works.
const ERRNO = { ENOENT: [2, 'FileNotFoundError', 'No such file or directory'], EACCES: [13, 'PermissionError', 'Permission denied'], EPERM: [1, 'PermissionError', 'Operation not permitted'],
  EEXIST: [17, 'FileExistsError', 'File exists'], ENOTDIR: [20, 'NotADirectoryError', 'Not a directory'], EISDIR: [21, 'IsADirectoryError', 'Is a directory'], EBUSY: [16, 'OSError', 'Device or resource busy'] };
function osError(e) {
  if (!e || typeof e.code !== 'string' || !ERRNO[e.code]) return null;
  const [no, type, text] = ERRNO[e.code];
  const x = new PyErr(C.newExc(C.T[type], `[Errno ${no}] ${text}` + (e.path ? `: '${e.path}'` : '')));
  x.exc.d.set('errno', no);
  if (e.path) x.exc.d.set('filename', e.path);
  return x;
}

function execModule(code, mod) {
  const fn = new PyFunction(code, mod.d, '<module>');
  return runFrame(new Frame(code, mod.d, mod.d, fn));
}

module.exports = { vm, NULL, Frame, Generator, runFrame, callFunction, execModule, importModule };
