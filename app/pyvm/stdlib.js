// pyvm stdlib — the subset of the Python standard library AIMOD's logic modules use.
'use strict';
const MONO0 = require('os').uptime() - performance.now() / 1000;      // like CPython: monotonic() counts from system boot, not process start
const fs = require('fs');
const nodePath = require('path');
const C = require('./core');
const O = require('./ops');
const A = require('./attr');
const { vm } = require('./vm');
const { meth } = require('./builtins');
const { PyTuple, PyBytes, PyDict, PySet, PyObject, PyType, PyFunction, PyBound, PyModule, T, None, DONE, PyErr, raise, hk, eq, truthy, typeOf, dictSet, dictGet,
  mroOf, mkType, tObject } = C;
const { repr, str, iter, toList, len, num } = O;
const { nat, pargs, call } = A;

const fn = (name, f) => nat(name, f);
function mkModule(name, members) {
  const m = new PyModule(name);
  for (const [k, v] of Object.entries(members)) m.d.set(k, typeof v === 'function' && !v.pyname ? nat(k, v) : v);
  m.d.set('__name__', name);
  vm.modules.set(name, m);
  return m;
}
function nativeClass(name, methods, mod) {
  const t = mkType(name, [tObject], false);
  t.builtin = false; t.module = mod || 'builtins';
  delete T[name];
  for (const [k, f] of Object.entries(methods)) { f.pyMethod = true; f.pyname = k; t.d.set(k, f); }
  mroOf(t);
  return t;
}
const noop = () => None;

// ── math ─────────────────────────────────────────────────────────────────────────────────────────────────────
const f1 = (g) => ([x]) => g(num(x));
mkModule('math', {
  pi: Math.PI, e: Math.E, inf: Infinity, nan: NaN, tau: 2 * Math.PI,
  floor: f1(Math.floor), ceil: f1(Math.ceil), sqrt: ([x]) => { if (num(x) < 0) throw raise('ValueError', 'math domain error'); return Math.sqrt(num(x)); },
  exp: f1(Math.exp), log: ([x, b]) => { if (num(x) <= 0) throw raise('ValueError', 'math domain error'); return b === undefined ? Math.log(num(x)) : Math.log(num(x)) / Math.log(num(b)); },
  log10: f1(Math.log10), log2: f1(Math.log2), sin: f1(Math.sin), cos: f1(Math.cos), tan: f1(Math.tan), tanh: f1(Math.tanh), atan: f1(Math.atan),
  asin: f1(Math.asin), acos: f1(Math.acos), sinh: f1(Math.sinh), cosh: f1(Math.cosh),
  atan2: ([y, x]) => Math.atan2(num(y), num(x)), fabs: f1(Math.abs), trunc: f1(Math.trunc), isnan: f1(Number.isNaN), isinf: ([x]) => Math.abs(num(x)) === Infinity,
  isfinite: f1(Number.isFinite), hypot: (a) => Math.hypot(...a.map(num)), pow: ([a, b]) => Math.pow(num(a), num(b)),
  copysign: ([a, b]) => Math.sign(num(b)) * Math.abs(num(a)), radians: f1((x) => x * Math.PI / 180), degrees: f1((x) => x * 180 / Math.PI),
  fsum: ([it]) => { let s = 0; for (const x of toList(it)) s += num(x); return s; }, fmod: ([a, b]) => num(a) % num(b),
  isclose: ([a, b], kw) => { const rt = kw && kw.get('rel_tol') !== undefined ? kw.get('rel_tol') : 1e-9; const at = kw && kw.get('abs_tol') || 0; return Math.abs(a - b) <= Math.max(rt * Math.max(Math.abs(a), Math.abs(b)), at); },
  gcd: ([a, b]) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; }, prod: ([it]) => toList(it).reduce((a, b) => a * b, 1),
});

// ── statistics ───────────────────────────────────────────────────────────────────────────────────────────────
const numsOf = (it) => toList(it).map(num);
const stMean = (a) => { if (!a.length) throw raise('StatisticsError', 'mean requires at least one data point'); return a.reduce((x, y) => x + y, 0) / a.length; };
const stVar = (a, mu, ddof) => a.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (a.length - ddof);
mkModule('statistics', {
  median: ([it]) => { const a = numsOf(it).sort((x, y) => x - y); if (!a.length) throw new PyErr(C.newExc(T.ValueError, 'no median for empty data')); const n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; },
  median_low: ([it]) => { const a = numsOf(it).sort((x, y) => x - y); return a[Math.floor((a.length - 1) / 2)]; },
  median_high: ([it]) => { const a = numsOf(it).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; },
  mean: ([it]) => stMean(numsOf(it)), fmean: ([it]) => stMean(numsOf(it)),
  stdev: ([it]) => { const a = numsOf(it); if (a.length < 2) throw raise('ValueError', 'stdev requires at least two data points'); return Math.sqrt(stVar(a, stMean(a), 1)); },
  pstdev: ([it]) => { const a = numsOf(it); return Math.sqrt(stVar(a, stMean(a), 0)); },
  variance: ([it]) => { const a = numsOf(it); return stVar(a, stMean(a), 1); }, pvariance: ([it]) => { const a = numsOf(it); return stVar(a, stMean(a), 0); },
  StatisticsError: (() => { const t = mkType('StatisticsError', [T.ValueError], false); t.module = 'statistics'; return t; })(),
});
T.StatisticsError = vm.modules.get('statistics').d.get('StatisticsError');

// ── time ─────────────────────────────────────────────────────────────────────────────────────────────────────
const p2 = (n) => String(n).padStart(2, '0');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function structTime(d) { return new PyTuple([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), (d.getDay() + 6) % 7, 1, -1]); }
function strftime(fmt, t) {
  const a = t.a;
  const d = new Date(a[0], a[1] - 1, a[2], a[3], a[4], a[5]);
  return fmt.replace(/%([a-zA-Z%])/g, (m, c) => {
    switch (c) {
      case 'Y': return String(a[0]); case 'y': return p2(a[0] % 100); case 'm': return p2(a[1]); case 'd': return p2(a[2]); case 'H': return p2(a[3]);
      case 'M': return p2(a[4]); case 'S': return p2(a[5]); case 'I': return p2(a[3] % 12 || 12); case 'p': return a[3] < 12 ? 'AM' : 'PM';
      case 'A': return DAYS[d.getDay()]; case 'a': return DAYS[d.getDay()].slice(0, 3); case 'B': return MONTHS[a[1] - 1]; case 'b': return MONTHS[a[1] - 1].slice(0, 3);
      case 'j': return String(Math.floor((d - new Date(a[0], 0, 0)) / 864e5)).padStart(3, '0'); case 'f': return '000000'; case '%': return '%';
      default: return m;
    }
  });
}
mkModule('time', {
  time: () => Date.now() / 1000, monotonic: () => MONO0 + performance.now() / 1000, perf_counter: () => performance.now() / 1000, sleep: noop,
  localtime: ([t]) => structTime(t === undefined || t === None ? new Date() : new Date(num(t) * 1000)), gmtime: ([t]) => { const d = t === undefined ? new Date() : new Date(num(t) * 1000); return new PyTuple([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), (d.getUTCDay() + 6) % 7, 1, 0]); },
  strftime: ([f, t]) => strftime(f, t === undefined ? structTime(new Date()) : t),
  time_ns: () => Date.now() * 1e6, process_time: () => process.cpuUsage().user / 1e6,
});

// ── datetime (what AIMOD's aggression trace uses: datetime.datetime.now() and its strftime / f-string format) ─────────────────
const dtOf = (self) => self.jsDate || new Date();
const DateTimeT = nativeClass('datetime', {
  now: (args) => { const o = new PyObject(DateTimeT); o.jsDate = new Date(); return o; },     // (called on the class: no self)
  strftime: ([self, f]) => strftime(f, structTime(dtOf(self))),
  __format__: ([self, spec]) => (spec ? strftime(spec, structTime(dtOf(self))) : strftime('%Y-%m-%d %H:%M:%S', structTime(dtOf(self)))),
  __str__: ([self]) => strftime('%Y-%m-%d %H:%M:%S', structTime(dtOf(self))),
  isoformat: ([self]) => strftime('%Y-%m-%dT%H:%M:%S', structTime(dtOf(self))),
  timestamp: ([self]) => dtOf(self).getTime() / 1000,
}, 'datetime');
mkModule('datetime', { datetime: DateTimeT });

// ── random (bit-exact MT19937 as in CPython) ─────────────────────────────────────────────────────────────────
class MT {
  constructor() { this.mt = new Uint32Array(624); this.i = 625; this.gaussNext = null; }
  initGenrand(s) {
    const mt = this.mt; mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) { const prev = mt[i - 1] ^ (mt[i - 1] >>> 30); mt[i] = (Math.imul(1812433253, prev) + i) >>> 0; }
    this.i = 624;
  }
  initByArray(key) {
    this.initGenrand(19650218);
    const mt = this.mt; let i = 1, j = 0;
    for (let k = Math.max(624, key.length); k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++; j++; if (i >= 624) { mt[0] = mt[623]; i = 1; } if (j >= key.length) j = 0;
    }
    for (let k = 623; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++; if (i >= 624) { mt[0] = mt[623]; i = 1; }
    }
    mt[0] = 0x80000000; this.i = 624;
  }
  seed(a) {
    if (a === None || a === undefined) a = Math.floor(Math.random() * 2 ** 52);
    let n = BigInt(Math.abs(Math.trunc(num(a))));
    const key = []; if (n === 0n) key.push(0);
    while (n > 0n) { key.push(Number(n & 0xffffffffn)); n >>= 32n; }
    this.initByArray(key); this.gaussNext = null;
  }
  u32() {
    const mt = this.mt;
    if (this.i >= 624) {
      let kk = 0, y;
      for (; kk < 624 - 397; kk++) { y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff); mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0); }
      for (; kk < 623; kk++) { y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff); mt[kk] = mt[kk + (397 - 624)] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0); }
      y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff); mt[623] = mt[396] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
      this.i = 0;
    }
    let y = mt[this.i++];
    y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
    return y >>> 0;
  }
  random() { const a = this.u32() >>> 5, b = this.u32() >>> 6; return (a * 67108864 + b) / 9007199254740992; }
  getrandbits(k) {
    if (k <= 32) return this.u32() >>> (32 - k);
    let v = 0n; let words = Math.ceil(k / 32); let rem = k;
    for (let w = 0; w < words; w++) { let r = this.u32(); if (rem < 32) r >>>= 32 - rem; v |= BigInt(r) << BigInt(32 * w); rem -= 32; }
    return Number(v);
  }
  below(n) {
    if (n <= 0) throw raise('ValueError', 'empty range for randrange()');
    const k = n.toString(2).length; let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }
}
const mtOf = (self) => { if (!self.mt) { self.mt = new MT(); self.mt.seed(None); } return self.mt; };
const rndMethods = {
  __init__: ([self, seed]) => { self.mt = new MT(); self.mt.seed(seed === undefined ? None : seed); return None; },
  seed: ([self, a]) => { mtOf(self).seed(a === undefined ? None : a); return None; },
  random: ([self]) => mtOf(self).random(),
  getrandbits: ([self, k]) => mtOf(self).getrandbits(k),
  randrange: ([self, a, b, s]) => { if (b === undefined) return mtOf(self).below(a); const step = s === undefined ? 1 : s; const w = b - a; if (step === 1) return a + mtOf(self).below(w); const n = step > 0 ? Math.ceil(w / step) : Math.ceil(w / step); return a + step * mtOf(self).below(n); },
  randint: ([self, a, b]) => a + mtOf(self).below(b - a + 1),
  choice: ([self, seq]) => { const l = toList(seq); if (!l.length) throw raise('IndexError', 'Cannot choose from an empty sequence'); return l[mtOf(self).below(l.length)]; },
  uniform: ([self, a, b]) => a + (b - a) * mtOf(self).random(),
  shuffle: ([self, x]) => { for (let i = x.length - 1; i >= 1; i--) { const j = mtOf(self).below(i + 1); [x[i], x[j]] = [x[j], x[i]]; } return None; },
  sample: ([self, pop, k]) => {
    const p = toList(pop), n = p.length; const r = new Array(k);
    let setsize = 21; if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) { const pool = p.slice(); for (let i = 0; i < k; i++) { const j = mtOf(self).below(n - i); r[i] = pool[j]; pool[j] = pool[n - i - 1]; } }
    else { const sel = new Set(); for (let i = 0; i < k; i++) { let j = mtOf(self).below(n); while (sel.has(j)) j = mtOf(self).below(n); sel.add(j); r[i] = p[j]; } }
    return r;
  },
  gauss: ([self, mu, sigma]) => {
    const m = mtOf(self); let z = m.gaussNext; m.gaussNext = null;
    if (z === null) { const x2pi = m.random() * 2 * Math.PI; const g2rad = Math.sqrt(-2.0 * Math.log(1.0 - m.random())); z = Math.cos(x2pi) * g2rad; m.gaussNext = Math.sin(x2pi) * g2rad; }
    return mu + z * sigma;
  },
  triangular: ([self, low, high, mode]) => { const u = mtOf(self).random(); const lo = low === undefined ? 0 : low, hi = high === undefined ? 1 : high; let c = mode === undefined || mode === None ? 0.5 : (mode - lo) / (hi - lo); if (u > c) return hi + (lo - hi) * Math.sqrt((1 - u) * (1 - c)) * 1; return lo + (hi - lo) * Math.sqrt(u * c); },
};
const RandomT = nativeClass('Random', rndMethods, 'random');
const defRnd = new PyObject(RandomT);
// SystemRandom (AIMOD's rivals seed per race): the same methods, seeded from the OS's secure random source (seed() is ignored, as in CPython)
const SystemRandomT = nativeClass('SystemRandom', Object.assign({}, rndMethods, {
  __init__: ([self]) => { self.mt = new MT(); self.mt.seed(require('crypto').randomBytes(4).readUInt32LE(0)); return None; },
  seed: () => None,
}), 'random');
const randMod = { Random: RandomT, SystemRandom: SystemRandomT };
for (const k of Object.keys(rndMethods)) if (k !== '__init__') randMod[k] = nat(k, (args, kw) => rndMethods[k]([defRnd, ...args], kw));
mkModule('random', randMod);

// ── struct ───────────────────────────────────────────────────────────────────────────────────────────────────
function structParse(fmt) {
  let i = 0, le = true, native = true;
  if ('<>!=@'.includes(fmt[0])) { le = fmt[0] !== '>' && fmt[0] !== '!'; native = fmt[0] === '@'; i = 1; }
  const items = [];
  const re = /(\d*)([xcbB?hHiIlLqQnNefdsp])/g; re.lastIndex = i;
  let m; let off = 0;
  const SZ = { x: 1, c: 1, b: 1, B: 1, '?': 1, h: 2, H: 2, i: 4, I: 4, l: native ? 4 : 4, L: 4, q: 8, Q: 8, e: 2, f: 4, d: 8, s: 1, p: 1, n: 8, N: 8 };
  while ((m = re.exec(fmt)) !== null) {
    const cnt = m[1] === '' ? 1 : parseInt(m[1], 10), c = m[2], sz = SZ[c];
    if (native && sz > 1 && c !== 's' && c !== 'p') off = Math.ceil(off / sz) * sz;
    items.push({ c, cnt, sz, off });
    off += (c === 's' || c === 'p') ? cnt : sz * cnt;
  }
  if (native && items.length) off = Math.ceil(off / Math.max(...items.filter(x => x.c !== 's').map(x => x.sz), 1)) * Math.max(...items.filter(x => x.c !== 's').map(x => x.sz), 1);
  return { items, le, size: off };
}
function structUnpack(fmt, buf, offset) {
  const p = structParse(fmt); const out = [];
  if (buf.length - offset < p.size) throw new PyErr(C.newExc(vm.modules.get('struct').d.get('error'), `unpack requires a buffer of ${p.size} bytes`));
  for (const it of p.items) {
    const at = offset + it.off;
    if (it.c === 's' || it.c === 'p') { out.push(new PyBytes(Buffer.from(buf.subarray(at, at + it.cnt)))); continue; }
    if (it.c === 'x') continue;
    for (let k = 0; k < it.cnt; k++) {
      const o = at + k * it.sz;
      switch (it.c) {
        case 'c': out.push(new PyBytes(Buffer.from([buf[o]]))); break;
        case 'b': out.push(buf.readInt8(o)); break; case 'B': out.push(buf[o]); break; case '?': out.push(buf[o] !== 0); break;
        case 'h': out.push(p.le ? buf.readInt16LE(o) : buf.readInt16BE(o)); break; case 'H': out.push(p.le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)); break;
        case 'i': case 'l': out.push(p.le ? buf.readInt32LE(o) : buf.readInt32BE(o)); break; case 'I': case 'L': out.push(p.le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)); break;
        case 'q': case 'n': out.push(Number(p.le ? buf.readBigInt64LE(o) : buf.readBigInt64BE(o))); break; case 'Q': case 'N': out.push(Number(p.le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o))); break;
        case 'f': out.push(p.le ? buf.readFloatLE(o) : buf.readFloatBE(o)); break; case 'd': out.push(p.le ? buf.readDoubleLE(o) : buf.readDoubleBE(o)); break;
        default: throw raise('ValueError', 'bad char in struct format');
      }
    }
  }
  return new PyTuple(out);
}
function structPack(fmt, vals) {
  const p = structParse(fmt); const buf = Buffer.alloc(p.size); let vi = 0;
  for (const it of p.items) {
    const at = it.off;
    if (it.c === 's' || it.c === 'p') { const v = vals[vi++]; v.b.copy(buf, at, 0, it.cnt); continue; }
    if (it.c === 'x') continue;
    for (let k = 0; k < it.cnt; k++) {
      const o = at + k * it.sz; const v = vals[vi++];
      switch (it.c) {
        case 'c': buf[o] = v.b[0]; break;
        case 'b': buf.writeInt8(num(v), o); break; case 'B': buf[o] = num(v); break; case '?': buf[o] = truthy(v) ? 1 : 0; break;
        case 'h': p.le ? buf.writeInt16LE(num(v), o) : buf.writeInt16BE(num(v), o); break; case 'H': p.le ? buf.writeUInt16LE(num(v), o) : buf.writeUInt16BE(num(v), o); break;
        case 'i': case 'l': p.le ? buf.writeInt32LE(num(v), o) : buf.writeInt32BE(num(v), o); break; case 'I': case 'L': p.le ? buf.writeUInt32LE(num(v) >>> 0, o) : buf.writeUInt32BE(num(v) >>> 0, o); break;
        case 'q': case 'n': p.le ? buf.writeBigInt64LE(BigInt(Math.trunc(num(v))), o) : buf.writeBigInt64BE(BigInt(Math.trunc(num(v))), o); break;
        case 'Q': case 'N': p.le ? buf.writeBigUInt64LE(BigInt(Math.trunc(num(v))), o) : buf.writeBigUInt64BE(BigInt(Math.trunc(num(v))), o); break;
        case 'f': p.le ? buf.writeFloatLE(num(v), o) : buf.writeFloatBE(num(v), o); break; case 'd': p.le ? buf.writeDoubleLE(num(v), o) : buf.writeDoubleBE(num(v), o); break;
        default: throw raise('ValueError', 'bad char in struct format');
      }
    }
  }
  return buf;
}
const structErr = mkType('error', [T.Exception], false); delete T.error; structErr.module = 'struct';
mkModule('struct', {
  error: structErr,
  pack: ([f, ...v]) => new PyBytes(structPack(f, v)),
  unpack: ([f, b]) => structUnpack(f, b.b, 0),
  unpack_from: ([f, b, off], kw) => structUnpack(f, b.b, off === undefined ? (kw && kw.get('offset')) || 0 : off),
  pack_into: ([f, b, off, ...v]) => { structPack(f, v).copy(b.b, off); return None; },
  calcsize: ([f]) => structParse(f).size,
  iter_unpack: ([f, b]) => { const p = structParse(f); const out = []; for (let o = 0; o + p.size <= b.b.length; o += p.size) out.push(structUnpack(f, b.b, o)); return new O.ArrIter(out); },
});

// ── os / os.path ─────────────────────────────────────────────────────────────────────────────────────────────
const pathMod = mkModule('os.path', {
  join: (a) => nodePath.win32.join(...a.map(String)), exists: ([p]) => fs.existsSync(p), isdir: ([p]) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } },
  isfile: ([p]) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }, dirname: ([p]) => nodePath.win32.dirname(p), basename: ([p]) => nodePath.win32.basename(p),
  splitext: ([p]) => { const e = nodePath.win32.extname(p); return new PyTuple([e ? p.slice(0, -e.length) : p, e]); }, abspath: ([p]) => nodePath.win32.resolve(p),
  normpath: ([p]) => nodePath.win32.normalize(p), normcase: ([p]) => p.replace(/\//g, '\\').toLowerCase(), expanduser: ([p]) => p.replace(/^~/, process.env.USERPROFILE || ''),
  getmtime: ([p]) => fs.statSync(p).mtimeMs / 1000, getsize: ([p]) => fs.statSync(p).size, split: ([p]) => new PyTuple([nodePath.win32.dirname(p), nodePath.win32.basename(p)]),
  relpath: ([p, s]) => nodePath.win32.relative(s || process.cwd(), p), isabs: ([p]) => nodePath.win32.isAbsolute(p), sep: '\\',
});
const environ = new PyDict(); for (const [k, v] of Object.entries(process.env)) dictSet(environ, k, v);
mkModule('os', {
  path: pathMod, environ, sep: '\\', name: 'nt', linesep: '\r\n',
  makedirs: ([p], kw) => { fs.mkdirSync(p, { recursive: true }); return None; }, listdir: ([p]) => fs.readdirSync(p === undefined ? '.' : p),
  getenv: ([k, d]) => (process.env[k] !== undefined ? process.env[k] : (d === undefined ? None : d)), getcwd: () => process.cwd(),
  urandom: ([n]) => new PyBytes(require('crypto').randomBytes(n)), remove: ([p]) => { fs.unlinkSync(p); return None; }, rename: ([a, b]) => { fs.renameSync(a, b); return None; },
  replace: ([a, b]) => { fs.renameSync(a, b); return None; }, getpid: () => process.pid, stat: ([p]) => { const s = fs.statSync(p); return A.dictFromMap(new Map([['st_mtime', s.mtimeMs / 1000], ['st_size', s.size]])); },
  fspath: ([p]) => p, walk: () => new O.ArrIter([]),
});
vm.modules.get('os').d.set('path', pathMod);

// ── io / open ────────────────────────────────────────────────────────────────────────────────────────────────
function mkFile(path, mode) {
  const binary = mode.includes('b');
  const write = mode.includes('w') || mode.includes('a') || mode.includes('+') || mode.includes('x');
  const f = { path, binary, mode, pos: 0, chunks: [], data: null, closed: false, write };
  if (!write || mode.includes('+')) { if (mode.includes('r') || mode.includes('+')) { if (!fs.existsSync(path) && !mode.includes('w')) throw new PyErr(C.newExc(T.FileNotFoundError, `[Errno 2] No such file or directory: '${path}'`)); } }
  if (mode.includes('r')) f.data = fs.readFileSync(path);
  if (mode.includes('a') && fs.existsSync(path)) f.prefix = fs.readFileSync(path);
  if (mode.includes('w') || mode.includes('a')) { try { fs.mkdirSync(nodePath.dirname(path), { recursive: true }); } catch (e) { /* ignore */ } }
  return f;
}
const flush = (f) => { if (f.write && !f.closed) { const parts = f.chunks.map(c => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c)); const body = Buffer.concat(parts); fs.writeFileSync(f.path, f.prefix ? Buffer.concat([f.prefix, body]) : body); } };
const FileT = nativeClass('FileIO', {
  read: ([self, n]) => { const f = self.f; const rest = f.data.subarray(f.pos); const take = n === undefined || n < 0 ? rest : rest.subarray(0, n); f.pos += take.length; return f.binary ? new PyBytes(Buffer.from(take)) : take.toString('utf8'); },
  readline: ([self]) => { const f = self.f; if (f.pos >= f.data.length) return f.binary ? new PyBytes(Buffer.alloc(0)) : ''; let e = f.data.indexOf(10, f.pos); e = e < 0 ? f.data.length : e + 1; const s = f.data.subarray(f.pos, e); f.pos = e; return f.binary ? new PyBytes(Buffer.from(s)) : s.toString('utf8'); },
  readlines: ([self]) => { const out = []; for (;;) { const l = FileT.d.get('readline')([self]); if (!(l instanceof PyBytes ? l.b.length : l.length)) break; out.push(l); } return out; },
  write: ([self, s]) => { self.f.chunks.push(s instanceof PyBytes ? s.b : s); if (self.f.chunks.length > 512) { /* keep memory modest */ } return typeof s === 'string' ? s.length : s.b.length; },
  flush: ([self]) => { flush(self.f); return None; }, close: ([self]) => { flush(self.f); self.f.closed = true; return None; },
  seek: ([self, p]) => { self.f.pos = p; return p; }, tell: ([self]) => self.f.pos, fileno: () => 3, isatty: () => false,
  __enter__: ([self]) => self, __exit__: ([self]) => { flush(self.f); self.f.closed = true; return false; },
  __iter__: ([self]) => { const o = new PyObject(FileIterT); o.f = self; return o; },
}, 'io');
const FileIterT = nativeClass('FileIter', { __next__: ([self]) => { const l = FileT.d.get('readline')([self.f]); if (!(l instanceof PyBytes ? l.b.length : l.length)) throw new PyErr(C.newExc(T.StopIteration)); return l; }, __iter__: ([self]) => self }, 'io');
function openFile(path, mode, kw) {
  const o = new PyObject(FileT); o.f = mkFile(String(path), String(mode)); return o;
}
mkModule('io', {
  StringIO: nativeClass('StringIO', {
    __init__: ([self, v]) => { self.buf = v === undefined ? '' : v; self.pos = 0; return None; }, write: ([self, s]) => { self.buf += s; return s.length; },
    getvalue: ([self]) => self.buf, read: ([self]) => { const r = self.buf.slice(self.pos); self.pos = self.buf.length; return r; }, close: noop, flush: noop,
    __enter__: ([self]) => self, __exit__: () => false,
  }, 'io'),
  BytesIO: nativeClass('BytesIO', { __init__: ([self, v]) => { self.buf = v ? Buffer.from(v.b) : Buffer.alloc(0); return None; }, write: ([self, b]) => { self.buf = Buffer.concat([self.buf, b.b]); return b.b.length; }, getvalue: ([self]) => new PyBytes(self.buf), close: noop }, 'io'),
  open: ([p, m], kw) => openFile(p, m || 'r', kw),
});

// ── json ─────────────────────────────────────────────────────────────────────────────────────────────────────
function toPy(v) {
  if (v === null) return None;
  if (Array.isArray(v)) return v.map(toPy);
  if (typeof v === 'object') { const d = new PyDict(); for (const [k, x] of Object.entries(v)) dictSet(d, k, toPy(x)); return d; }
  return v;
}
function toJs(v, sortKeys) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return v;
  if (v instanceof PyObject && typeof v.num === 'number') return v.num;
  if (Array.isArray(v)) return v.map(x => toJs(x, sortKeys));
  if (v instanceof PyTuple) return v.a.map(x => toJs(x, sortKeys));
  if (v instanceof PyDict) { const o = {}; let ents = Array.from(v.m.values()); if (sortKeys) ents = ents.sort((a, b) => (str(a[0]) < str(b[0]) ? -1 : 1)); for (const [k, x] of ents) o[typeof k === 'string' ? k : str(k)] = toJs(x, sortKeys); return o; }
  throw raise('TypeError', `Object of type ${typeOf(v).name} is not JSON serializable`);
}
const JSON_ESC = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
const jsonStr = (s) => '"' + s.replace(/["\\\u0000-\u001f\u007f-￿]/g, (c) => JSON_ESC[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '"';
function jsonDump(v, kw) {
  const ind = kw && kw.get('indent');
  const indent = ind === undefined || ind === None ? null : (typeof ind === 'number' ? ' '.repeat(ind) : ind);
  const sk = truthy(kw && kw.get('sort_keys'));
  const itemSep = indent === null ? ', ' : ',';
  const rec = (x, lvl) => {
    if (x === null || x === undefined) return 'null';
    if (x === true) return 'true';
    if (x === false) return 'false';
    if (typeof x === 'number') { if (Number.isNaN(x)) return 'NaN'; if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity'; return O.repr(x); }
    if (typeof x === 'string') return jsonStr(x);
    if (x instanceof PyObject && typeof x.num === 'number') return rec(x.num, lvl);        // int / float subclass (CarNo): CPython writes the plain value
    let items, open, close;
    if (Array.isArray(x) || x instanceof PyTuple) {
      const a = Array.isArray(x) ? x : x.a;
      if (!a.length) return '[]';
      items = a.map(e => rec(e, lvl + 1)); open = '['; close = ']';
    } else if (x instanceof PyDict) {
      let ents = Array.from(x.m.values());
      if (!ents.length) return '{}';
      if (sk) ents = ents.sort((a, b) => (str(a[0]) < str(b[0]) ? -1 : 1));
      items = ents.map(([k, e]) => jsonStr(typeof k === 'string' ? k : (typeof k === 'boolean' ? (k ? 'true' : 'false') : (k instanceof PyObject && typeof k.num === 'number' ? O.repr(k.num) : str(k)))) + ': ' + rec(e, lvl + 1));
      open = '{'; close = '}';
    } else throw raise('TypeError', `Object of type ${typeOf(x).name} is not JSON serializable`);
    if (indent === null) return open + items.join(itemSep) + close;
    const pad = '\n' + indent.repeat(lvl + 1);
    return open + pad + items.join(itemSep + pad) + '\n' + indent.repeat(lvl) + close;
  };
  return rec(v, 0);
}
const JSONErr = mkType('JSONDecodeError', [T.ValueError], false); delete T.JSONDecodeError; JSONErr.module = 'json';
mkModule('json', {
  JSONDecodeError: JSONErr,
  loads: ([s]) => { try { return toPy(JSON.parse(s instanceof PyBytes ? s.b.toString('utf8') : s)); } catch (e) { throw new PyErr(C.newExc(JSONErr, e.message)); } },
  load: ([f]) => { const s = A.call(A.getattr(f, 'read'), [], null); try { return toPy(JSON.parse(s)); } catch (e) { throw new PyErr(C.newExc(JSONErr, e.message)); } },
  dumps: ([v], kw) => jsonDump(v, kw),
  dump: ([v, f], kw) => { A.call(A.getattr(f, 'write'), [jsonDump(v, kw)], null); return None; },
});

// ── logging ──────────────────────────────────────────────────────────────────────────────────────────────────
vm.logSink = vm.logSink || null;
const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };
const lg = (lvl) => ([self, msg, ...a]) => { if (vm.logSink) vm.logSink(lvl, self.lname, a.length ? O.percentFormat(str(msg), new PyTuple(a)) : str(msg)); return None; };
const LoggerT = nativeClass('Logger', {
  debug: lg('DEBUG'), info: lg('INFO'), warning: lg('WARNING'), warn: lg('WARNING'), error: lg('ERROR'), critical: lg('CRITICAL'), exception: lg('ERROR'),
  setLevel: noop, addHandler: noop, isEnabledFor: () => false, log: noop, hasHandlers: () => false,
}, 'logging');
const loggers = new Map();
mkModule('logging', Object.assign({
  getLogger: ([n]) => { const name = n === undefined ? 'root' : n; if (!loggers.has(name)) { const o = new PyObject(LoggerT); o.lname = name; loggers.set(name, o); } return loggers.get(name); },
  basicConfig: noop, Logger: LoggerT, StreamHandler: nativeClass('StreamHandler', {}, 'logging'), FileHandler: nativeClass('FileHandler', {}, 'logging'), Formatter: nativeClass('Formatter', {}, 'logging'),
  NullHandler: nativeClass('NullHandler', {}, 'logging'), handlers: new PyModule('logging.handlers'),
}, LEVELS));

// ── collections ──────────────────────────────────────────────────────────────────────────────────────────────
const DefaultDictT = mkType('defaultdict', [T.dict], false); delete T.defaultdict; DefaultDictT.module = 'collections';
DefaultDictT.ctor = (args, kw) => { const d = new PyDict(); d.factory = args[0] === undefined || args[0] === None ? null : args[0]; if (args[1] !== undefined) A.M.dict.update(d, [args[1]], null); return d; };
const CounterT = mkType('Counter', [T.dict], false); delete T.Counter; CounterT.module = 'collections';
CounterT.ctor = (args) => { const d = new PyDict(); d.isCounter = true; if (args[0] !== undefined) for (const x of toList(args[0])) dictSet(d, x, (dictGet(d, x) || 0) + 1); return d; };
A.M.dict.most_common = (d, [n]) => { const items = Array.from(d.m.values()).map(([k, v]) => [k, v]); const s = items.map((x, i) => [x, i]).sort((a, b) => (b[0][1] - a[0][1]) || (a[1] - b[1])).map(x => new PyTuple(x[0])); return n === undefined || n === None ? s : s.slice(0, n); };
A.M.dict.elements = (d) => { const o = []; for (const [, [k, v]] of d.m) for (let i = 0; i < v; i++) o.push(k); return o; };
const DequeT = nativeClass('deque', {
  __init__: ([self, it, ml], kw) => { const maxlen = ml !== undefined ? ml : (kw && kw.get('maxlen')); self.items = it === undefined ? [] : toList(it); self.maxlen = maxlen === undefined || maxlen === None ? null : maxlen; while (self.maxlen !== null && self.items.length > self.maxlen) self.items.shift(); return None; },
  append: ([self, x]) => { self.items.push(x); if (self.maxlen !== null && self.items.length > self.maxlen) self.items.shift(); return None; },
  appendleft: ([self, x]) => { self.items.unshift(x); if (self.maxlen !== null && self.items.length > self.maxlen) self.items.pop(); return None; },
  pop: ([self]) => { if (!self.items.length) throw raise('IndexError', 'pop from an empty deque'); return self.items.pop(); },
  popleft: ([self]) => { if (!self.items.length) throw raise('IndexError', 'pop from an empty deque'); return self.items.shift(); },
  clear: ([self]) => { self.items.length = 0; return None; }, extend: ([self, it]) => { for (const x of toList(it)) DequeT.d.get('append')([self, x]); return None; },
  __len__: ([self]) => self.items.length, __iter__: ([self]) => new O.ArrIter(self.items.slice()), __getitem__: ([self, i]) => O.getitem(self.items, i), __bool__: ([self]) => self.items.length > 0,
}, 'collections');
mkModule('collections', { defaultdict: DefaultDictT, Counter: CounterT, OrderedDict: T.dict, deque: DequeT,
  namedtuple: ([name, fields]) => { const names = typeof fields === 'string' ? fields.replace(/,/g, ' ').split(/\s+/).filter(Boolean) : toList(fields); const t = mkType(name, [T.tuple], false); delete T[name]; t.ctor = (args, kw) => { const a = args.slice(); for (let i = args.length; i < names.length; i++) a.push(kw ? kw.get(names[i]) : None); const tup = new PyTuple(a); return tup; }; return t; } });

// ── dataclasses ──────────────────────────────────────────────────────────────────────────────────────────────
const MISSING = { missing: true };
class FieldSpec { constructor(o) { Object.assign(this, { default: MISSING, default_factory: MISSING, init: true, repr: true, compare: true }, o); } }
function dataclassFields(cls) {
  if (cls.dcFields) return cls.dcFields;
  const fields = [];
  const seen = new Map();
  for (const base of mroOf(cls).slice().reverse()) {
    if (base === cls) break;
    if (base.dcFields) for (const f of base.dcFields) { if (seen.has(f.name)) fields[seen.get(f.name)] = f; else { seen.set(f.name, fields.length); fields.push(f); } }
  }
  const ann = cls.d.get('__annotations__');
  if (ann instanceof PyDict) {
    for (const [, [name, typ]] of ann.m) {
      if (typeof typ === 'string' && /^(typing\.)?ClassVar\b/.test(typ)) continue;
      let dv = cls.d.get(name);
      const f = { name, default: MISSING, default_factory: MISSING, init: true, repr: true, compare: true };
      if (dv instanceof FieldSpec) { Object.assign(f, dv); if (dv.default !== MISSING) cls.d.set(name, dv.default); else cls.d.delete(name); }
      else if (dv !== undefined) f.default = dv;
      if (seen.has(name)) fields[seen.get(name)] = f; else { seen.set(name, fields.length); fields.push(f); }
    }
  }
  cls.dcFields = fields;
  return fields;
}
function dataclassApply(cls, opts) {
  const fields = dataclassFields(cls);
  const frozen = opts.frozen;
  if (opts.init !== false && !cls.d.has('__init__')) {
    const init = meth('__init__', (args, kw) => {
      const self = args[0]; const pos = args.slice(1);
      const init_fields = fields.filter(f => f.init);
      if (pos.length > init_fields.length) throw raise('TypeError', `__init__() takes ${init_fields.length + 1} positional arguments but ${pos.length + 1} were given`);
      init_fields.forEach((f, i) => {
        let v;
        if (i < pos.length) v = pos[i];
        else if (kw && kw.has(f.name)) v = kw.get(f.name);
        else if (f.default !== MISSING) v = f.default;
        else if (f.default_factory !== MISSING) v = call(f.default_factory, [], null);
        else throw raise('TypeError', `__init__() missing 1 required positional argument: '${f.name}'`);
        self.d.set(f.name, v);
      });
      if (kw) for (const k of kw.keys()) if (!init_fields.some(f => f.name === k)) throw raise('TypeError', `__init__() got an unexpected keyword argument '${k}'`);
      for (const f of fields) if (!f.init && !self.d.has(f.name)) { if (f.default !== MISSING) self.d.set(f.name, f.default); else if (f.default_factory !== MISSING) self.d.set(f.name, call(f.default_factory, [], null)); }
      const pi = C.lookupType(self.cls, '__post_init__');
      if (pi !== undefined) call(pi, [self], null);
      return None;
    });
    cls.d.set('__init__', init);
  }
  if (opts.repr !== false && !cls.d.has('__repr__')) cls.d.set('__repr__', meth('__repr__', ([self]) => `${cls.name}(${fields.filter(f => f.repr).map(f => `${f.name}=${repr(self.d.get(f.name))}`).join(', ')})`));
  if (opts.eq !== false && !cls.d.has('__eq__')) {
    cls.d.set('__eq__', meth('__eq__', ([a, b]) => (b instanceof PyObject && b.cls === a.cls ? fields.filter(f => f.compare).every(f => eq(a.d.get(f.name), b.d.get(f.name))) : C.NotImplemented)));
    if (!cls.d.has('__hash__')) cls.d.set('__hash__', frozen ? meth('__hash__', ([a]) => { let h = 0; for (const f of fields) h = (h * 31 + hk(a.d.get(f.name)).length) | 0; return h; }) : null);
  }
  if (frozen) cls.d.set('__setattr__', meth('__setattr__', ([o, n, v]) => { if (o.d.has(n) || fields.some(f => f.name === n)) throw raise('AttributeError', `cannot assign to field '${n}'`); o.d.set(n, v); return None; }));
  cls.d.set('__dataclass_fields__', new PyDict());
  return cls;
}
const FrozenErr = mkType('FrozenInstanceError', [T.AttributeError], false); delete T.FrozenInstanceError;
mkModule('dataclasses', {
  dataclass: (args, kw) => {
    const opts = {}; if (kw) for (const [k, v] of kw) opts[k] = v;
    if (args.length === 1 && args[0] instanceof PyType) return dataclassApply(args[0], opts);
    return nat('dataclass_decorator', ([cls]) => dataclassApply(cls, opts));
  },
  field: (args, kw) => { const o = {}; if (kw) for (const [k, v] of kw) o[k] = v; return new FieldSpec(o); },
  replace: ([obj], kw) => {
    const fields = dataclassFields(obj.cls); const k = new Map();
    for (const f of fields) if (f.init) k.set(f.name, kw && kw.has(f.name) ? kw.get(f.name) : obj.d.get(f.name));
    return A.callType(obj.cls, [], k);
  },
  fields: ([o]) => dataclassFields(o instanceof PyType ? o : o.cls).map(f => { const x = new PyObject(tObject); x.d.set('name', f.name); return x; }),
  asdict: ([o]) => { const d = new PyDict(); for (const f of dataclassFields(o.cls)) dictSet(d, f.name, o.d.get(f.name)); return d; },
  is_dataclass: ([o]) => !!((o instanceof PyType ? o : typeOf(o)).dcFields),
  MISSING, FrozenInstanceError: FrozenErr,
});

// ── re ───────────────────────────────────────────────────────────────────────────────────────────────────────
function jsRegex(pat, flags) {
  let p = pat.replace(/\(\?P<([A-Za-z_]\w*)>/g, '(?<$1>').replace(/\(\?P=([A-Za-z_]\w*)\)/g, '\\k<$1>').replace(/\\Z/g, '$(?![\\s\\S])').replace(/\\A/g, '^');
  if (flags & 64) p = p.replace(/\\#/g, '\u0001').replace(/#.*$/gm, '').replace(/\s+/g, '').replace(/\u0001/g, '\\#');
  let f = 'u';
  if (flags & 2) f += 'i'; if (flags & 8) f += 'm'; if (flags & 16) f += 's';
  try { return new RegExp(p, f + 'g'); } catch (e) { return new RegExp(p, f.replace('u', '') + 'g'); }
}
const MatchT = nativeClass('Match', {
  group: ([self, ...a]) => { const g = (k) => { const v = typeof k === 'string' ? (self.m.groups ? self.m.groups[k] : undefined) : self.m[k || 0]; return v === undefined ? None : v; }; return a.length <= 1 ? g(a[0]) : new PyTuple(a.map(g)); },
  groups: ([self, d]) => new PyTuple(self.m.slice(1).map(x => (x === undefined ? (d === undefined ? None : d) : x))),
  groupdict: ([self]) => { const o = new PyDict(); if (self.m.groups) for (const [k, v] of Object.entries(self.m.groups)) dictSet(o, k, v === undefined ? None : v); return o; },
  start: ([self, k]) => { if (!k) return self.m.index; return self.m.indices ? self.m.indices[k][0] : self.m.index; }, end: ([self]) => self.m.index + self.m[0].length, span: ([self]) => new PyTuple([self.m.index, self.m.index + self.m[0].length]),
  __getitem__: ([self, k]) => { const v = typeof k === 'string' ? self.m.groups[k] : self.m[k]; return v === undefined ? None : v; },
}, 're');
const mkMatch = (m) => { if (!m) return None; const o = new PyObject(MatchT); o.m = m; return o; };
const PatternT = nativeClass('Pattern', {
  match: ([self, s, pos]) => { const re = new RegExp(self.re.source, self.re.flags.replace('g', '') + 'y'); re.lastIndex = pos || 0; return mkMatch(re.exec(s)); },
  fullmatch: ([self, s]) => { const re = new RegExp('^(?:' + self.re.source + ')$', self.re.flags.replace('g', '')); return mkMatch(re.exec(s)); },
  search: ([self, s, pos]) => { const re = new RegExp(self.re.source, self.re.flags); re.lastIndex = pos || 0; return mkMatch(re.exec(s)); },
  findall: ([self, s]) => { const out = []; const re = new RegExp(self.re.source, self.re.flags); let m; while ((m = re.exec(s)) !== null) { if (m[0] === '') re.lastIndex++; out.push(m.length === 1 ? m[0] : (m.length === 2 ? (m[1] === undefined ? '' : m[1]) : new PyTuple(m.slice(1).map(x => (x === undefined ? '' : x))))); } return out; },
  finditer: ([self, s]) => { const re = new RegExp(self.re.source, self.re.flags); return new O.FnIter(() => { const m = re.exec(s); if (!m) return DONE; if (m[0] === '') re.lastIndex++; return mkMatch(m); }); },
  sub: ([self, rep, s, count]) => { let n = 0; const re = new RegExp(self.re.source, self.re.flags); return s.replace(re, (...m) => { if (count && n >= count) return m[0]; n++; if (typeof rep === 'string') return rep.replace(/\\(\d+)/g, (_, i) => (m[+i] === undefined ? '' : m[+i])).replace(/\\g<(\w+)>/g, (_, k) => m[m.length - 1][k] || ''); const mm = m.slice(0, -2); mm.index = m[m.length - 2]; mm.groups = typeof m[m.length - 1] === 'object' ? m[m.length - 1] : undefined; return call(rep, [mkMatch(mm)], null); }); },
  split: ([self, s]) => s.split(new RegExp(self.re.source, self.re.flags)).map(x => (x === undefined ? None : x)),
}, 're');
const compileRe = (p, flags) => { if (p instanceof PyObject && p.re) return p; const o = new PyObject(PatternT); o.re = jsRegex(p, flags || 0); o.d.set('pattern', p); return o; };
const reFn = (name) => ([p, ...rest], kw) => { const pat = compileRe(p, 0); const meth_ = PatternT.d.get(name); if (name === 'sub') { const [rep, s, count, flags] = rest; const pp = compileRe(p, (kw && kw.get('flags')) || flags || 0); return meth_([pp, rep, s, count || (kw && kw.get('count'))]); } const [s, flags] = rest; const pp = flags ? compileRe(p, flags) : pat; return meth_([pp, s]); };
mkModule('re', {
  compile: ([p, f]) => compileRe(p, f), match: reFn('match'), search: reFn('search'), findall: reFn('findall'), finditer: reFn('finditer'), sub: reFn('sub'), split: reFn('split'), fullmatch: reFn('fullmatch'),
  escape: ([s]) => s.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&'), IGNORECASE: 2, I: 2, MULTILINE: 8, M: 8, DOTALL: 16, S: 16, VERBOSE: 64, X: 64, Pattern: PatternT, Match: MatchT,
  error: (() => { const t = mkType('error', [T.Exception], false); delete T.error; t.module = 're'; return t; })(),
});

// ── csv ──────────────────────────────────────────────────────────────────────────────────────────────────────
const csvQuote = (v) => { const s = v === None ? '' : (typeof v === 'string' ? v : str(v)); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
mkModule('csv', {
  writer: ([f]) => { const w = new PyObject(CsvWriterT); w.f = f; return w; },
  QUOTE_MINIMAL: 0,
});
const CsvWriterT = nativeClass('writer', {
  writerow: ([self, row]) => { A.call(A.getattr(self.f, 'write'), [toList(row).map(csvQuote).join(',') + '\r\n'], null); return None; },
  writerows: ([self, rows]) => { for (const r of toList(rows)) CsvWriterT.d.get('writerow')([self, r]); return None; },
}, '_csv');

// ── functools / itertools / typing / sys / abc / misc ───────────────────────────────────────────────────────────
mkModule('functools', {
  lru_cache: (args) => (args.length === 1 && !(typeof args[0] === 'number') ? args[0] : nat('lru', ([f]) => f)),
  partial: ([f, ...a], kw) => nat('partial', (b, k) => call(f, [...a, ...b], k || kw ? new Map([...(kw || []), ...(k || [])]) : null)),
  wraps: () => nat('wraps', ([f]) => f), reduce: ([f, it, init]) => { const l = toList(it); let acc = init; let i = 0; if (init === undefined) acc = l[i++]; for (; i < l.length; i++) acc = call(f, [acc, l[i]], null); return acc; },
  cached_property: ([f]) => f, total_ordering: ([c]) => c,
});
mkModule('itertools', {
  chain: (its) => { const l = its.flatMap(toList); return new O.ArrIter(l); },
  count: ([s, st]) => { let n = s === undefined ? 0 : s; return new O.FnIter(() => { const v = n; n += st === undefined ? 1 : st; return v; }); },
  islice: ([it, a, b, c]) => { const l = toList(it); const start = b === undefined ? 0 : (a === None ? 0 : a), stop = b === undefined ? a : b, step = c === undefined ? 1 : c; const out = []; for (let i = start; i < (stop === None || stop === undefined ? l.length : Math.min(stop, l.length)); i += step) out.push(l[i]); return new O.ArrIter(out); },
  product: (its) => { let res = [[]]; for (const p of its.map(toList)) res = res.flatMap(r => p.map(x => [...r, x])); return new O.ArrIter(res.map(r => new PyTuple(r))); },
  zip_longest: (its, kw) => { const ls = its.map(toList); const n = Math.max(...ls.map(l => l.length)); const f = kw && kw.get('fillvalue') !== undefined ? kw.get('fillvalue') : None; const out = []; for (let i = 0; i < n; i++) out.push(new PyTuple(ls.map(l => (i < l.length ? l[i] : f)))); return new O.ArrIter(out); },
  accumulate: ([it]) => { let s = 0; const out = []; for (const x of toList(it)) { s = O.binop('+', s, x); out.push(s); } return new O.ArrIter(out); },
  groupby: ([it, key]) => { const out = []; let cur = null, grp = null; for (const x of toList(it)) { const k = key ? call(key, [x], null) : x; if (grp && eq(k, cur)) grp.push(x); else { grp = [x]; cur = k; out.push(new PyTuple([k, grp])); } } return new O.ArrIter(out); },
});
const anyT = nativeClass('_SpecialForm', { __getitem__: ([self]) => self, __call__: ([self]) => self, __or__: ([self]) => self }, 'typing');
const anyObj = new PyObject(anyT);
const typingMod = mkModule('typing', { TYPE_CHECKING: false, cast: ([, v]) => v, TypeVar: () => anyObj, NamedTuple: tObject, overload: ([f]) => f, __getattr__: () => anyObj });
mkModule('__future__', { annotations: true });
mkModule('abc', { ABC: tObject, abstractmethod: ([f]) => f, ABCMeta: T.type });
mkModule('enum', { Enum: tObject, IntEnum: tObject, auto: () => 0 });
mkModule('copy', { copy: ([o]) => (Array.isArray(o) ? o.slice() : (o instanceof PyDict ? A.M.dict.copy(o) : o)), deepcopy: ([o]) => structuredCloneLike(o) });
function structuredCloneLike(o) {
  if (Array.isArray(o)) return o.map(structuredCloneLike);
  if (o instanceof PyTuple) return new PyTuple(o.a.map(structuredCloneLike));
  if (o instanceof PyDict) { const d = new PyDict(); for (const [, [k, v]] of o.m) dictSet(d, structuredCloneLike(k), structuredCloneLike(v)); return d; }
  if (o instanceof PySet) { const s = new PySet(o.frozen); for (const [h, v] of o.m) s.m.set(h, structuredCloneLike(v)); return s; }
  if (o instanceof PyObject && !o.cls.builtin) { const n = new PyObject(o.cls); for (const [k, v] of o.d) n.d.set(k, structuredCloneLike(v)); return n; }
  return o;
}
mkModule('sys', { modules: A.dictFromMap(new Map()), version_info: new PyTuple([3, 12, 0, 'final', 0]), platform: 'win32', argv: ['aimod'], maxsize: Number.MAX_SAFE_INTEGER, frozen: true, executable: 'aimod', path: [], stdout: new PyObject(tObject), stderr: new PyObject(tObject), getrecursionlimit: () => 1000, setrecursionlimit: noop, exc_info: () => new PyTuple([None, None, None]) });
mkModule('threading', {
  Lock: nativeClass('Lock', { acquire: () => true, release: noop, __enter__: ([s]) => s, __exit__: () => false, locked: () => false }, 'threading'),
  RLock: nativeClass('RLock', { acquire: () => true, release: noop, __enter__: ([s]) => s, __exit__: () => false }, 'threading'),
  Event: nativeClass('Event', { __init__: ([s]) => { s.flag = false; return None; }, set: ([s]) => { s.flag = true; return None; }, clear: ([s]) => { s.flag = false; return None; }, is_set: ([s]) => s.flag, wait: ([s]) => s.flag }, 'threading'),
  Thread: nativeClass('Thread', { __init__: noop, start: noop, join: noop, is_alive: () => false }, 'threading'), current_thread: () => anyObj,
});
const uiStub = (name) => {
  const t = nativeClass(name, { __init__: noop, __getattr__: ([, n]) => (n.startsWith('__') ? undefined : nat(n, () => None)) }, 'tkinter');
  return t;
};
for (const n of ['tkinter', 'tkinter.ttk', 'tkinter.font', 'tkinter.filedialog', 'tkinter.messagebox', 'tkinter.colorchooser', 'tkinter.simpledialog']) {
  const m = mkModule(n, { __getattr__: ([a]) => uiStub(a) });
  void m;
}
mkModule('ctypes', { __getattr__: ([a]) => uiStub(a), c_void_p: uiStub('c_void_p'), windll: anyObj, wintypes: anyObj, Structure: tObject, sizeof: () => 8, byref: ([x]) => x });
mkModule('ctypes.wintypes', { __getattr__: ([a]) => uiStub(a) });
mkModule('array', { __getattr__: ([a]) => uiStub(a), array: uiStub('array') });
mkModule('wave', { open: () => { throw raise('OSError', 'wave unsupported'); } });
// zlib: AIMOD's driver behavior only needs crc32 (a fixed per-driver hash for the personalities)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf, start) => { let c = ((start || 0) ^ 0xFFFFFFFF) >>> 0; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const adler32 = (buf, start) => { let a = (start === undefined ? 1 : start) & 0xFFFF, b = ((start === undefined ? 1 : start) >>> 16) & 0xFFFF; for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; };
const bytesOf = (d) => (d && d.b ? d.b : Buffer.from(String(d), 'latin1'));
mkModule('zlib', { crc32: ([d, v]) => crc32(bytesOf(d), v), adler32: ([d, v]) => adler32(bytesOf(d), v) });
mkModule('tempfile', { gettempdir: () => require('os').tmpdir(), mkdtemp: () => fs.mkdtempSync(nodePath.join(require('os').tmpdir(), 'aimod_')), __getattr__: ([a]) => uiStub(a) });
mkModule('secrets', { token_hex: ([n]) => require('crypto').randomBytes(n || 16).toString('hex'), token_urlsafe: ([n]) => require('crypto').randomBytes(n || 16).toString('base64url'), compare_digest: ([a, b]) => String(a) === String(b) });
mkModule('base64', {
  b64encode: ([d]) => new PyBytes(Buffer.from(Buffer.from(bytesOf(d)).toString('base64'), 'latin1')),
  b64decode: ([d]) => new PyBytes(Buffer.from(String(d && d.b ? d.b.toString('latin1') : d), 'base64')),
  urlsafe_b64encode: ([d]) => new PyBytes(Buffer.from(Buffer.from(bytesOf(d)).toString('base64url'), 'latin1')),
  urlsafe_b64decode: ([d]) => new PyBytes(Buffer.from(String(d && d.b ? d.b.toString('latin1') : d), 'base64url')),
});
mkModule('hashlib', { sha1: () => anyObj, md5: () => anyObj, sha256: () => anyObj });
mkModule('traceback', { format_exc: () => '', print_exc: noop });
mkModule('atexit', { register: ([f]) => f });
mkModule('glob', { glob: ([p]) => { const d = nodePath.win32.dirname(p); const pat = new RegExp('^' + nodePath.win32.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'); try { return fs.readdirSync(d).filter(f => pat.test(f)).map(f => nodePath.win32.join(d, f)); } catch (e) { return []; } } });
mkModule('shutil', { copyfile: ([a, b]) => { fs.copyFileSync(a, b); return b; }, rmtree: noop });
mkModule('socket', { __getattr__: ([a]) => uiStub(a) });
mkModule('mimetypes', { guess_type: () => new PyTuple([None, None]) });
mkModule('urllib', {}); mkModule('urllib.parse', { unquote: ([s]) => decodeURIComponent(s), parse_qs: ([s]) => { const d = new PyDict(); for (const [k, v] of new URLSearchParams(s)) dictSet(d, k, [v]); return d; }, quote: ([s]) => encodeURIComponent(s) });
mkModule('http', {}); mkModule('http.server', { __getattr__: ([a]) => uiStub(a) });
mkModule('socketserver', { __getattr__: ([a]) => uiStub(a) });
mkModule('pymem', { __getattr__: ([a]) => uiStub(a) }); mkModule('pymem.process', { __getattr__: ([a]) => uiStub(a) });
mkModule('winsound', { __getattr__: ([a]) => uiStub(a) });
mkModule('PIL', { __getattr__: ([a]) => uiStub(a) }); mkModule('PIL.Image', { __getattr__: ([a]) => uiStub(a) }); mkModule('PIL.ImageTk', { __getattr__: ([a]) => uiStub(a) });
mkModule('string', { ascii_letters: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', digits: '0123456789', ascii_lowercase: 'abcdefghijklmnopqrstuvwxyz', ascii_uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
mkModule('operator', { itemgetter: (a) => nat('itemgetter', ([o]) => (a.length === 1 ? O.getitem(o, a[0]) : new PyTuple(a.map(k => O.getitem(o, k))))), attrgetter: ([n]) => nat('attrgetter', ([o]) => A.getattr(o, n)) });

// ── bisect / html (AIMOD 2.2's race results) ─────────────────────────────────────────────────────────────────
const bisectAt = (a, x, lo, hi, kw, right) => {
  const key = kw && kw.get('key');
  const k = (v) => (key && key !== None ? A.call(key, [v], null) : v);
  lo = lo === undefined || lo === None ? 0 : num(lo); hi = hi === undefined || hi === None ? len(a) : num(hi);
  while (lo < hi) {
    const mid = (lo + hi) >> 1, v = k(O.getitem(a, mid));
    if (right ? truthy(O.lessThan(x, v)) : truthy(O.lessThan(v, x))) { if (right) hi = mid; else lo = mid + 1; } else if (right) lo = mid + 1; else hi = mid;
  }
  return lo;
};
mkModule('bisect', {
  bisect_left: ([a, x, lo, hi], kw) => bisectAt(a, x, lo, hi, kw, false),
  bisect_right: ([a, x, lo, hi], kw) => bisectAt(a, x, lo, hi, kw, true),
  bisect: ([a, x, lo, hi], kw) => bisectAt(a, x, lo, hi, kw, true),
  insort: ([a, x, lo, hi], kw) => { A.call(A.getattr(a, 'insert'), [bisectAt(a, x, lo, hi, kw, true), x], null); return None; },
  insort_left: ([a, x, lo, hi], kw) => { A.call(A.getattr(a, 'insert'), [bisectAt(a, x, lo, hi, kw, false), x], null); return None; },
});
mkModule('html', {
  escape: ([s, quote], kw) => {
    const q = kw && kw.get('quote') !== undefined ? truthy(kw.get('quote')) : quote === undefined ? true : truthy(quote);
    let r = str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (q) r = r.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
    return r;
  },
});

module.exports = { mkModule, nativeClass, openFile, MT, structParse, structPack, structUnpack };
