// pyvm ops — arithmetic, comparison, repr/str/format, containers and iteration.
'use strict';
const C = require('./core');
const { PyTuple, PyBytes, PyDict, PySet, PySlice, PyRange, PyObject, PyType, PyFunction, PyBound, PyModule, T, None, NotImplemented, DONE,
  raise, hk, eq, truthy, typeOf, lookupType, dictGet, dictSet, rangeLen, isNum, mroOf } = C;

const call = (f, args, kw) => C.callHookGet()(f, args || [], kw || null);
const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : (v instanceof PyObject && v.num !== undefined ? v.num : v));
const unwrapNum = (v, dunder) => (v instanceof PyObject && v.num !== undefined && lookupType(v.cls, dunder) === undefined ? v.num : v);

// ── repr / str ───────────────────────────────────────────────────────────────────────────────────────────────
function floatRepr(v) {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  const neg = v < 0;
  const [m, e] = Math.abs(v).toExponential().split('e');
  const D = m.replace('.', '');
  const exp = parseInt(e, 10);
  let s;
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) { const ip = D.slice(0, exp + 1).padEnd(exp + 1, '0'); const fp = D.slice(exp + 1); s = fp ? ip + '.' + fp : ip; }
    else s = '0.' + '0'.repeat(-exp - 1) + D;
  } else s = D[0] + (D.length > 1 ? '.' + D.slice(1) : '') + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  return (neg ? '-' : '') + s;
}

function intRepr(v) { return Math.abs(v) >= 1e21 ? BigInt(v).toString() : String(v); }

function strRepr(s) {
  let q = "'";
  if (s.includes("'") && !s.includes('"')) q = '"';
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === q || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n'; else if (ch === '\r') out += '\\r'; else if (ch === '\t') out += '\\t';
    else if (c < 32 || c === 127) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + q;
}

function repr(v) {
  if (v === null || v === undefined) return 'None';
  switch (typeof v) {
    case 'boolean': return v ? 'True' : 'False';
    case 'number': return Number.isInteger(v) ? intRepr(v) : floatRepr(v);
    case 'string': return strRepr(v);
    case 'function': return '<built-in function ' + (v.pyname || v.name || '?') + '>';
    default: break;
  }
  if (Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']';
  if (v instanceof PyTuple) return '(' + v.a.map(repr).join(', ') + (v.a.length === 1 ? ',' : '') + ')';
  if (v instanceof PyDict) return '{' + Array.from(v.m.values()).map(([k, x]) => repr(k) + ': ' + repr(x)).join(', ') + '}';
  if (v instanceof PySet) { const items = Array.from(v.m.values()).map(repr); return v.frozen ? 'frozenset({' + items.join(', ') + '})' : (items.length ? '{' + items.join(', ') + '}' : 'set()'); }
  if (v instanceof PyBytes) return "b'" + Array.from(v.b).map(b => (b >= 32 && b < 127 && b !== 39 && b !== 92) ? String.fromCharCode(b) : '\\x' + b.toString(16).padStart(2, '0')).join('') + "'";
  if (v instanceof PyObject) {
    const f = lookupType(v.cls, '__repr__');
    if (f !== undefined) return str(call(f, [v]));
    if (v.num !== undefined) return repr(v.num);
    if (C.isSubtype(v.cls, T.BaseException)) return v.cls.name + '(' + (v.d.get('args') || new PyTuple([])).a.map(repr).join(', ') + ')';
    return '<' + (v.cls.module || '__main__') + '.' + v.cls.name + ' object at 0x' + (C.idOf(v) * 16).toString(16).padStart(8, '0') + '>';
  }
  if (v instanceof PyType) return "<class '" + (v.builtin ? '' : (v.module ? v.module + '.' : '')) + v.name + "'>";
  if (v instanceof PyFunction) return '<function ' + v.qualname + ' at 0x' + (C.idOf(v) * 16).toString(16) + '>';
  if (v instanceof PyBound) return '<bound method ' + (v.fn.qualname || v.fn.name) + ' of ' + repr(v.self) + '>';
  if (v instanceof PyModule) return "<module '" + v.name + "'>";
  if (v instanceof PyRange) return 'range(' + v.start + ', ' + v.stop + (v.step !== 1 ? ', ' + v.step : '') + ')';
  if (v instanceof PySlice) return 'slice(' + repr(v.start) + ', ' + repr(v.stop) + ', ' + repr(v.step) + ')';
  if (v === NotImplemented) return 'NotImplemented';
  if (v === C.Ellipsis) return 'Ellipsis';
  return '<object>';
}

function str(v) {
  if (typeof v === 'string') return v;
  if (v instanceof PyObject) {
    const f = lookupType(v.cls, '__str__');
    if (f !== undefined) return call(f, [v]);
    if (C.isSubtype(v.cls, T.BaseException)) {
      const a = (v.d.get('args') || new PyTuple([])).a;
      if (a.length === 1 && C.isSubtype(v.cls, T.KeyError)) return repr(a[0]);
      return a.length === 0 ? '' : (a.length === 1 ? str(a[0]) : repr(new PyTuple(a)));
    }
  }
  return repr(v);
}

// ── format-spec mini language ────────────────────────────────────────────────────────────────────────────────
function addCommas(intStr, sep) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, sep); }

function toFixedExact(x, d) {
  // correct rounding of the exact binary value, ties to even (Python's behaviour)
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  if (!Number.isFinite(ax)) return String(ax);
  if (d > 100) d = 100;
  const long = ax.toFixed(Math.min(100, d + 40));
  const dot = long.indexOf('.');
  const keep = long.slice(0, dot + 1 + d);
  const rest = long.slice(dot + 1 + d);
  let digits = keep.replace('.', '');
  let up = false;
  if (rest.length) {
    const first = rest[0];
    if (first > '5') up = true;
    else if (first === '5') { const tail = rest.slice(1); if (/[1-9]/.test(tail)) up = true; else up = (digits.slice(-1) - 0) % 2 === 1; }
  }
  if (up) digits = (BigInt(digits) + 1n).toString().padStart(digits.length, '0');
  let s = d > 0 ? digits.slice(0, digits.length - d) + '.' + digits.slice(digits.length - d) : digits;
  if (s.startsWith('.')) s = '0' + s;
  return (neg ? '-' : '') + s;
}

function formatNumber(v, spec) {
  const m = /^(?:(.)?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/.exec(spec);
  if (!m) throw raise('ValueError', 'Invalid format specifier');
  let [, fill, align, sign, alt, zero, width, grouping, prec, type] = m;
  let x = num(v);
  const isInt = Number.isInteger(x);
  if (!type) type = (prec !== undefined || !isInt) ? (prec !== undefined ? 'g' : '') : 'd';
  let body, neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  const p = prec === undefined ? undefined : parseInt(prec, 10);
  switch (type) {
    case 'd': case 'n': body = String(Math.trunc(ax)); if (typeof x === 'number' && !isInt) throw raise('ValueError', "Unknown format code 'd' for object of type 'float'"); break;
    case 'f': case 'F': body = toFixedExact(ax, p === undefined ? 6 : p); break;
    case '%': body = toFixedExact(ax * 100, p === undefined ? 6 : p) + '%'; break;
    case 'e': case 'E': {
      body = ax.toExponential(p === undefined ? 6 : p).replace(/e([+-])(\d)$/, 'e$10$2');
      if (type === 'E') body = body.toUpperCase();
      break;
    }
    case 'g': case 'G': {
      const pp = p === undefined ? 6 : (p === 0 ? 1 : p);
      if (ax === 0) body = '0';
      else {
        const exp = Math.floor(Math.log10(ax));
        const e2 = parseInt(ax.toExponential(pp - 1).split('e')[1], 10);
        if (e2 < -4 || e2 >= pp) { body = ax.toExponential(pp - 1).replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2'); }
        else { body = ax.toFixed(Math.max(0, pp - 1 - e2)); if (body.includes('.') && !alt) body = body.replace(/\.?0+$/, ''); }
        void exp;
      }
      if (type === 'G') body = body.toUpperCase();
      break;
    }
    case '': body = isInt ? String(ax) : floatRepr(ax); break;
    case 'x': body = Math.trunc(ax).toString(16); if (alt) body = '0x' + body; break;
    case 'X': body = Math.trunc(ax).toString(16).toUpperCase(); if (alt) body = '0X' + body; break;
    case 'o': body = Math.trunc(ax).toString(8); break;
    case 'b': body = Math.trunc(ax).toString(2); break;
    case 'c': return String.fromCodePoint(x);
    default: throw raise('ValueError', "Unknown format code '" + type + "'");
  }
  if (grouping) { const [ip, ...rest] = body.split('.'); body = addCommas(ip, grouping) + (rest.length ? '.' + rest.join('.') : ''); }
  let signStr = neg ? '-' : (sign === '+' ? '+' : (sign === ' ' ? ' ' : ''));
  const w = width ? parseInt(width, 10) : 0;
  if (zero && !align) { fill = '0'; align = '='; }
  fill = fill || ' ';
  align = align || '>';
  const total = signStr.length + body.length;
  if (total >= w) return signStr + body;
  const padN = w - total;
  if (align === '<') return signStr + body + fill.repeat(padN);
  if (align === '>') return fill.repeat(padN) + signStr + body;
  if (align === '^') { const l = Math.floor(padN / 2); return fill.repeat(l) + signStr + body + fill.repeat(padN - l); }
  return signStr + fill.repeat(padN) + body;          // '='
}

function formatString(s, spec) {
  const m = /^(?:(.)?([<>=^]))?(\d+)?(?:\.(\d+))?s?$/.exec(spec);
  if (!m) throw raise('ValueError', 'Invalid format specifier');
  let [, fill, align, width, prec] = m;
  if (prec !== undefined) s = s.slice(0, parseInt(prec, 10));
  const w = width ? parseInt(width, 10) : 0;
  fill = fill || ' '; align = align || '<';
  if (s.length >= w) return s;
  const n = w - s.length;
  if (align === '<') return s + fill.repeat(n);
  if (align === '>' || align === '=') return fill.repeat(n) + s;
  const l = Math.floor(n / 2); return fill.repeat(l) + s + fill.repeat(n - l);
}

function format(v, spec) {
  spec = spec || '';
  if (typeof v === 'string') return spec ? formatString(v, spec) : v;
  if (isNum(v)) return spec ? formatNumber(v, spec) : (typeof v === 'boolean' ? repr(v) : repr(v));
  if (v instanceof PyObject) {
    const f = lookupType(v.cls, '__format__');
    if (f !== undefined) return str(call(f, [v, spec]));
  }
  return spec ? formatString(str(v), spec) : str(v);
}

// ── printf-style % formatting ─────────────────────────────────────────────────────────────────────────────────
function percentFormat(fmt, arg) {
  const args = arg instanceof PyTuple ? arg.a.slice() : [arg];
  let ai = 0;
  return fmt.replace(/%(?:\(([^)]*)\))?([#0\- +]*)(\*|\d+)?(?:\.(\*|\d+))?([diouxXeEfFgGcrsa%])/g, (all, key, flags, width, prec, conv) => {
    if (conv === '%') return '%';
    let v;
    if (key !== undefined) v = dictGet(arg, key); else v = args[ai++];
    let spec = '';
    if (flags.includes('-')) spec += '<'; else if (/^\d/.test(width || '') && flags.includes('0') && 'diouxXeEfFgG'.includes(conv)) spec += '0';
    const f = (flags.includes('+') ? '+' : (flags.includes(' ') ? ' ' : ''));
    let body;
    switch (conv) {
      case 'd': case 'i': case 'u': body = formatNumber(Math.trunc(num(v)), f + (prec ? '.' + prec : '') + 'd'); break;
      case 'x': case 'X': case 'o': body = formatNumber(Math.trunc(num(v)), (flags.includes('#') ? '#' : '') + conv); break;
      case 'e': case 'E': case 'f': case 'F': case 'g': case 'G': body = formatNumber(num(v), f + '.' + (prec === undefined ? '6' : prec) + conv); break;
      case 'c': body = typeof v === 'string' ? v : String.fromCodePoint(v); break;
      case 'r': case 'a': body = repr(v); break;
      default: body = str(v); if (prec !== undefined) body = body.slice(0, +prec);
    }
    const w = width ? parseInt(width, 10) : 0;
    if (body.length < w) body = flags.includes('-') ? body.padEnd(w) : (flags.includes('0') && conv !== 's' ? (body[0] === '-' || body[0] === '+' ? body[0] + body.slice(1).padStart(w - 1, '0') : body.padStart(w, '0')) : body.padStart(w));
    return body;
  });
}

// ── arithmetic ───────────────────────────────────────────────────────────────────────────────────────────────
function pyMod(a, b) {
  if (b === 0) throw raise('ZeroDivisionError', 'integer modulo by zero');
  let r = a % b;
  if (r !== 0 && (r < 0) !== (b < 0)) r += b;
  return r;
}
function pyFloorDiv(a, b) {
  if (b === 0) throw raise('ZeroDivisionError', 'integer division or modulo by zero');
  const m = pyMod(a, b);
  return Math.round((a - m) / b);
}

const NB = ['+', '&', '//', '<<', '@', '*', '%', '|', '**', '>>', '-', '/', '^'];
const DUNDER = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'truediv', '//': 'floordiv', '%': 'mod', '**': 'pow', '<<': 'lshift', '>>': 'rshift', '&': 'and', '|': 'or', '^': 'xor', '@': 'matmul' };

function binop(op, a, b, inplace) {
  a = unwrapNum(a, '__' + DUNDER[op] + '__'); b = unwrapNum(b, '__r' + DUNDER[op] + '__');
  const ta = typeof a, tb = typeof b;
  if ((ta === 'number' || ta === 'boolean') && (tb === 'number' || tb === 'boolean')) {
    const x = num(a), y = num(b);
    switch (op) {
      case '+': return x + y; case '-': return x - y; case '*': return x * y;
      case '/': if (y === 0) throw raise('ZeroDivisionError', 'division by zero'); return x / y;
      case '//': return pyFloorDiv(x, y);
      case '%': return pyMod(x, y);
      case '**': if (x === 0 && y < 0) throw raise('ZeroDivisionError', '0.0 cannot be raised to a negative power'); return Math.pow(x, y);
      case '<<': return Number(BigInt(x) << BigInt(y));
      case '>>': return Number(BigInt(x) >> BigInt(y));
      case '&': return Number(BigInt(x) & BigInt(y));
      case '|': return Number(BigInt(x) | BigInt(y));
      case '^': return Number(BigInt(x) ^ BigInt(y));
      default: break;
    }
  }
  if (ta === 'string') {
    if (op === '+' && tb === 'string') return a + b;
    if (op === '*' && (tb === 'number' || tb === 'boolean')) return b > 0 ? a.repeat(num(b)) : '';
    if (op === '%') return percentFormat(a, b);
  }
  if (tb === 'string' && op === '*' && (ta === 'number' || ta === 'boolean')) return a > 0 ? b.repeat(num(a)) : '';
  if (Array.isArray(a)) {
    if (op === '+' && Array.isArray(b)) { if (inplace) { a.push(...b); return a; } return a.concat(b); }
    if (inplace && op === '+') { const it = iter(b); let v; while ((v = it.next()) !== DONE) a.push(v); return a; }
    if (op === '*' && isNum(b)) { const out = []; for (let i = 0; i < num(b); i++) out.push(...a); if (inplace) { a.length = 0; a.push(...out); return a; } return out; }
  }
  if (isNum(a) && Array.isArray(b) && op === '*') { const out = []; for (let i = 0; i < num(a); i++) out.push(...b); return out; }
  if (a instanceof PyTuple) {
    if (op === '+' && b instanceof PyTuple) return new PyTuple(a.a.concat(b.a));
    if (op === '*' && isNum(b)) { const out = []; for (let i = 0; i < num(b); i++) out.push(...a.a); return new PyTuple(out); }
  }
  if (isNum(a) && b instanceof PyTuple && op === '*') { const out = []; for (let i = 0; i < num(a); i++) out.push(...b.a); return new PyTuple(out); }
  if (a instanceof PySet && b instanceof PySet) {
    const r = new PySet(a.frozen);
    if (op === '|') { for (const [k, v] of a.m) r.m.set(k, v); for (const [k, v] of b.m) r.m.set(k, v); if (inplace && !a.frozen) { a.m = r.m; return a; } return r; }
    if (op === '&') { for (const [k, v] of a.m) if (b.m.has(k)) r.m.set(k, v); if (inplace && !a.frozen) { a.m = r.m; return a; } return r; }
    if (op === '-') { for (const [k, v] of a.m) if (!b.m.has(k)) r.m.set(k, v); if (inplace && !a.frozen) { a.m = r.m; return a; } return r; }
    if (op === '^') { for (const [k, v] of a.m) if (!b.m.has(k)) r.m.set(k, v); for (const [k, v] of b.m) if (!a.m.has(k)) r.m.set(k, v); if (inplace && !a.frozen) { a.m = r.m; return a; } return r; }
  }
  if (a instanceof PyDict && b instanceof PyDict && op === '|') {
    const r = new PyDict(); for (const [k, [kk, v]] of a.m) r.m.set(k, [kk, v]); for (const [k, [kk, v]] of b.m) r.m.set(k, [kk, v]);
    if (inplace) { a.m = r.m; return a; } return r;
  }
  if (a instanceof PyBytes && b instanceof PyBytes && op === '+') { const r = new PyBytes(Buffer.concat([a.b, b.b])); if (a.mutable) r.mutable = true; return r; }
  if (op === '*' && a instanceof PyBytes && isNum(b)) return new PyBytes(num(b) > 0 ? Buffer.concat(Array.from({ length: num(b) }, () => a.b)) : Buffer.alloc(0));
  if (op === '*' && b instanceof PyBytes && isNum(a)) return new PyBytes(num(a) > 0 ? Buffer.concat(Array.from({ length: num(a) }, () => b.b)) : Buffer.alloc(0));
  // dunder protocol
  const dn = DUNDER[op];
  if (a instanceof PyObject) {
    let f = inplace ? lookupType(a.cls, '__i' + dn + '__') : undefined;
    if (f !== undefined) { const r = call(f, [a, b]); if (r !== NotImplemented) return r; }
    f = lookupType(a.cls, '__' + dn + '__');
    if (f !== undefined) { const r = call(f, [a, b]); if (r !== NotImplemented) return r; }
  }
  if (b instanceof PyObject) {
    const f = lookupType(b.cls, '__r' + dn + '__');
    if (f !== undefined) { const r = call(f, [b, a]); if (r !== NotImplemented) return r; }
  }
  throw raise('TypeError', `unsupported operand type(s) for ${op}: '${typeOf(a).name}' and '${typeOf(b).name}'`);
}

function unop(op, a) {
  if (op === 'not') return !truthy(a);
  a = unwrapNum(a, op === '-' ? '__neg__' : (op === '~' ? '__invert__' : '__pos__'));
  if (isNum(a)) return op === '-' ? -num(a) : (op === '~' ? ~num(a) : +num(a));
  if (a instanceof PyObject) {
    const f = lookupType(a.cls, op === '-' ? '__neg__' : (op === '~' ? '__invert__' : '__pos__'));
    if (f !== undefined) return call(f, [a]);
  }
  throw raise('TypeError', `bad operand type for unary ${op}: '${typeOf(a).name}'`);
}

// ── comparison ───────────────────────────────────────────────────────────────────────────────────────────────
const CMPD = { '<': '__lt__', '<=': '__le__', '>': '__gt__', '>=': '__ge__', '==': '__eq__', '!=': '__ne__' };
const REFL = { '<': '__gt__', '<=': '__ge__', '>': '__lt__', '>=': '__le__', '==': '__eq__', '!=': '__ne__' };

function lessThan(a, b) {
  return compare('<', a, b);
}

function seqCompare(op, x, y) {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (!eq(x[i], y[i])) return compare(op === '==' || op === '!=' ? op : op, x[i], y[i]);
  }
  const lx = x.length, ly = y.length;
  switch (op) { case '<': return lx < ly; case '<=': return lx <= ly; case '>': return lx > ly; case '>=': return lx >= ly; default: return false; }
}

function compare(op, a, b) {
  a = unwrapNum(a, CMPD[op]); b = unwrapNum(b, REFL[op]);
  const ta = typeof a, tb = typeof b;
  if ((ta === 'number' || ta === 'boolean') && (tb === 'number' || tb === 'boolean')) {
    const x = num(a), y = num(b);
    switch (op) { case '<': return x < y; case '<=': return x <= y; case '>': return x > y; case '>=': return x >= y; case '==': return x === y; default: return x !== y; }
  }
  if (ta === 'string' && tb === 'string') {
    switch (op) { case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b; case '==': return a === b; default: return a !== b; }
  }
  if (op === '==') return eq(a, b);
  if (op === '!=') return !eq(a, b);
  if ((a instanceof PyTuple && b instanceof PyTuple)) return seqCompare(op, a.a, b.a);
  if (Array.isArray(a) && Array.isArray(b)) return seqCompare(op, a, b);
  if (a instanceof PySet && b instanceof PySet) {
    const sub = (x, y) => Array.from(x.m.keys()).every(k => y.m.has(k));
    switch (op) { case '<=': return sub(a, b); case '<': return sub(a, b) && a.m.size < b.m.size; case '>=': return sub(b, a); default: return sub(b, a) && b.m.size < a.m.size; }
  }
  if (a instanceof PyObject) {
    const f = lookupType(a.cls, CMPD[op]);
    if (f !== undefined) { const r = call(f, [a, b]); if (r !== NotImplemented) return truthy(r); }
  }
  if (b instanceof PyObject) {
    const f = lookupType(b.cls, REFL[op]);
    if (f !== undefined) { const r = call(f, [b, a]); if (r !== NotImplemented) return truthy(r); }
  }
  throw raise('TypeError', `'${op}' not supported between instances of '${typeOf(a).name}' and '${typeOf(b).name}'`);
}

// ── slices / containers ──────────────────────────────────────────────────────────────────────────────────────
function sliceIdx(sl, n) {
  const step = sl.step === null ? 1 : num(sl.step);
  if (step === 0) throw raise('ValueError', 'slice step cannot be zero');
  const norm = (v, dflt, lo, hi) => { if (v === null) return dflt; let x = num(v); if (x < 0) x += n; return Math.min(Math.max(x, lo), hi); };
  let start, stop;
  if (step > 0) { start = norm(sl.start, 0, 0, n); stop = norm(sl.stop, n, 0, n); }
  else { start = norm(sl.start, n - 1, -1, n - 1); stop = norm(sl.stop, -1, -1, n - 1); }
  const idx = [];
  if (step > 0) for (let i = start; i < stop; i += step) idx.push(i); else for (let i = start; i > stop; i += step) idx.push(i);
  return idx;
}

function seqIndex(i, n, what) {
  i = num(i);
  if (!Number.isInteger(i)) throw raise('TypeError', what + ' indices must be integers or slices, not float');
  if (i < 0) i += n;
  if (i < 0 || i >= n) throw raise('IndexError', what + ' index out of range');
  return i;
}

function getitem(o, k) {
  if (Array.isArray(o)) {
    if (k instanceof PySlice) return sliceIdx(k, o.length).map(i => o[i]);
    return o[seqIndex(k, o.length, 'list')];
  }
  if (o instanceof PyTuple) {
    if (k instanceof PySlice) return new PyTuple(sliceIdx(k, o.a.length).map(i => o.a[i]));
    return o.a[seqIndex(k, o.a.length, 'tuple')];
  }
  if (o instanceof PyDict) {
    const e = o.m.get(hk(k));
    if (e !== undefined) return e[1];
    if (o.factory) { const v = call(o.factory, []); dictSet(o, k, v); return v; }
    if (o.isCounter) return 0;
    const f = lookupType(typeOf(o), '__missing__');
    if (f !== undefined) return call(f, [o, k]);
    throw new C.PyErr(Object.assign(C.newExc(T.KeyError, k), {}));
  }
  if (typeof o === 'string') {
    const cps = Array.from(o);
    if (k instanceof PySlice) return sliceIdx(k, cps.length).map(i => cps[i]).join('');
    return cps[seqIndex(k, cps.length, 'string')];
  }
  if (o instanceof PyBytes) {
    if (k instanceof PySlice) return new PyBytes(Buffer.from(sliceIdx(k, o.b.length).map(i => o.b[i])));
    return o.b[seqIndex(k, o.b.length, 'bytes')];
  }
  if (o instanceof PyRange) { const n = rangeLen(o); return o.start + o.step * seqIndex(k, n, 'range'); }
  if (o instanceof PyObject) {
    const f = lookupType(o.cls, '__getitem__');
    if (f !== undefined) return call(f, [o, k]);
  }
  if (o instanceof PyType) return o;               // list[int], dict[str, int] ...
  throw raise('TypeError', `'${typeOf(o).name}' object is not subscriptable`);
}

function setitem(o, k, v) {
  if (Array.isArray(o)) {
    if (k instanceof PySlice) {
      const idx = sliceIdx(k, o.length);
      const items = []; const it = iter(v); let x; while ((x = it.next()) !== DONE) items.push(x);
      if ((k.step === null || num(k.step) === 1)) {
        const start = idx.length ? idx[0] : (k.start === null ? 0 : Math.min(Math.max(num(k.start) < 0 ? num(k.start) + o.length : num(k.start), 0), o.length));
        o.splice(start, idx.length, ...items);
      } else idx.forEach((i, j) => { o[i] = items[j]; });
      return;
    }
    o[seqIndex(k, o.length, 'list assignment')] = v; return;
  }
  if (o instanceof PyDict) { dictSet(o, k, v); return; }
  if (o instanceof PyBytes && o.mutable) {
    if (k instanceof PySlice) {
      const idx = sliceIdx(k, o.b.length);
      const items = v instanceof PyBytes ? Array.from(v.b) : toList(v);
      if (k.step === null || num(k.step) === 1) {
        const start = idx.length ? idx[0] : (k.start === null ? 0 : Math.min(Math.max(num(k.start) < 0 ? num(k.start) + o.b.length : num(k.start), 0), o.b.length));
        o.b = Buffer.concat([o.b.subarray(0, start), Buffer.from(items), o.b.subarray(start + idx.length)]);
      } else idx.forEach((i, j) => { o.b[i] = items[j]; });
      return;
    }
    const n = num(v);
    if (!(n >= 0 && n < 256)) throw raise('ValueError', 'byte must be in range(0, 256)');
    o.b[seqIndex(k, o.b.length, 'bytearray')] = n; return;
  }
  if (o instanceof PyObject) {
    const f = lookupType(o.cls, '__setitem__');
    if (f !== undefined) { call(f, [o, k, v]); return; }
  }
  throw raise('TypeError', `'${typeOf(o).name}' object does not support item assignment`);
}

function delitem(o, k) {
  if (Array.isArray(o)) {
    if (k instanceof PySlice) { const idx = new Set(sliceIdx(k, o.length)); const keep = o.filter((_, i) => !idx.has(i)); o.length = 0; o.push(...keep); return; }
    o.splice(seqIndex(k, o.length, 'list assignment'), 1); return;
  }
  if (o instanceof PyDict) { if (!o.m.delete(hk(k))) throw new C.PyErr(C.newExc(T.KeyError, k)); return; }
  if (o instanceof PyObject) { const f = lookupType(o.cls, '__delitem__'); if (f !== undefined) { call(f, [o, k]); return; } }
  throw raise('TypeError', `'${typeOf(o).name}' object doesn't support item deletion`);
}

function len(o) {
  if (typeof o === 'string') { let n = 0; for (const _ of o) n++; return n; }
  if (Array.isArray(o)) return o.length;
  if (o instanceof PyTuple) return o.a.length;
  if (o instanceof PyDict || o instanceof PySet) return o.m.size;
  if (o instanceof PyBytes) return o.b.length;
  if (o instanceof PyRange) return rangeLen(o);
  if (o instanceof PyObject) { const f = lookupType(o.cls, '__len__'); if (f !== undefined) return call(f, [o]); }
  throw raise('TypeError', `object of type '${typeOf(o).name}' has no len()`);
}

function contains(c, x) {
  if (typeof c === 'string') { if (typeof x !== 'string') throw raise('TypeError', "'in <string>' requires string as left operand"); return c.includes(x); }
  if (Array.isArray(c)) return c.some(y => eq(y, x));
  if (c instanceof PyTuple) return c.a.some(y => eq(y, x));
  if (c instanceof PyDict) return c.m.has(hk(x));
  if (c instanceof PySet) return c.m.has(hk(x));
  if (c instanceof PyRange) { const n = num(x); if (!Number.isInteger(n)) return false; return c.step > 0 ? (n >= c.start && n < c.stop && (n - c.start) % c.step === 0) : (n <= c.start && n > c.stop && (c.start - n) % -c.step === 0); }
  if (c instanceof PyBytes) return typeof x === 'number' ? c.b.includes(x) : c.b.includes(x.b);
  if (c instanceof PyObject) {
    const f = lookupType(c.cls, '__contains__');
    if (f !== undefined) return truthy(call(f, [c, x]));
    const it = iter(c); let v; while ((v = it.next()) !== DONE) if (eq(v, x)) return true; return false;
  }
  throw raise('TypeError', `argument of type '${typeOf(c).name}' is not iterable`);
}

// ── iteration ────────────────────────────────────────────────────────────────────────────────────────────────
class ArrIter { constructor(a) { this.a = a; this.i = 0; } next() { return this.i < this.a.length ? this.a[this.i++] : DONE; } }
class FnIter { constructor(f) { this.f = f; } next() { return this.f(); } }

function iter(o) {
  if (Array.isArray(o)) return new ArrIter(o);
  if (o instanceof PyTuple) return new ArrIter(o.a);
  if (typeof o === 'string') return new ArrIter(Array.from(o));
  if (o instanceof PyDict) return new ArrIter(Array.from(o.m.values()).map(e => e[0]));
  if (o instanceof PySet) return new ArrIter(Array.from(o.m.values()));
  if (o instanceof PyBytes) return new ArrIter(Array.from(o.b));
  if (o instanceof PyRange) { let i = 0; const n = rangeLen(o); return new FnIter(() => (i < n ? o.start + o.step * i++ : DONE)); }
  if (o && typeof o.next === 'function' && !(o instanceof PyObject)) return o;
  if (o instanceof PyObject) {
    const f = lookupType(o.cls, '__iter__');
    if (f !== undefined) {
      const it = call(f, [o]);
      if (it instanceof PyObject) {
        const nx = lookupType(it.cls, '__next__');
        return new FnIter(() => {
          try { return call(nx, [it]); } catch (e) { if (e instanceof C.PyErr && C.isSubtype(e.exc.cls, T.StopIteration)) return DONE; throw e; }
        });
      }
      return iter(it);
    }
    const gi = lookupType(o.cls, '__getitem__');
    if (gi !== undefined) { let i = 0; return new FnIter(() => { try { return call(gi, [o, i++]); } catch (e) { if (e instanceof C.PyErr && C.isSubtype(e.exc.cls, T.IndexError)) return DONE; throw e; } }); }
  }
  throw raise('TypeError', `'${typeOf(o).name}' object is not iterable`);
}

function toList(o) {
  if (Array.isArray(o)) return o.slice();
  const out = []; const it = iter(o); let v; while ((v = it.next()) !== DONE) out.push(v); return out;
}

module.exports = {
  repr, str, format, floatRepr, percentFormat, binop, unop, compare, lessThan, NB, getitem, setitem, delitem, len, contains, iter, toList, sliceIdx,
  pyMod, pyFloorDiv, ArrIter, FnIter, toFixedExact, num, strRepr,
};
