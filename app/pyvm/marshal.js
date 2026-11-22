// CPython 3.12 marshal reader -> pyvm values + decoded code objects.
'use strict';
const C = require('./core');
const { PyTuple, PyBytes, PyDict, PySet, None } = C;
const { OP, CACHE, HAVE_ARGUMENT } = require('./opcodes');

const JUMP_FWD = new Set([OP.JUMP_FORWARD, OP.POP_JUMP_IF_FALSE, OP.POP_JUMP_IF_TRUE, OP.POP_JUMP_IF_NONE, OP.POP_JUMP_IF_NOT_NONE, OP.FOR_ITER, OP.SEND]);
const JUMP_BACK = new Set([OP.JUMP_BACKWARD, OP.JUMP_BACKWARD_NO_INTERRUPT]);

class CodeObj {
  constructor(f) {
    Object.assign(this, f);
    this.decode();
  }
  decode() {
    const b = this.bytes;
    const ops = [], args = [], offs = [], next = [], byOff = new Map();
    let ext = 0, prefix = [];
    for (let o = 0; o < b.length;) {
      const op = b[o], a = b[o + 1];
      const sz = 2 + 2 * (CACHE[require('./opcodes').NAMES[op]] || 0);
      if (op === OP.EXTENDED_ARG) { ext = (ext | a) << 8; prefix.push(o); o += sz; continue; }
      const arg = op >= HAVE_ARGUMENT ? (ext | a) : 0;
      ext = 0;
      for (const po of prefix) byOff.set(po, ops.length);       // jumps may target the EXTENDED_ARG prefix
      prefix = [];
      byOff.set(o, ops.length);
      ops.push(op); args.push(arg); offs.push(o); next.push(o + sz);
      o += sz;
    }
    // resolve jump targets to instruction indexes
    const tgt = new Int32Array(ops.length).fill(-1);
    for (let i = 0; i < ops.length; i++) {
      if (JUMP_FWD.has(ops[i])) tgt[i] = byOff.get(next[i] + args[i] * 2);
      else if (JUMP_BACK.has(ops[i])) tgt[i] = byOff.get(next[i] - args[i] * 2);
    }
    this.ops = Uint8Array.from(ops); this.args = Int32Array.from(args); this.offs = offs; this.nextOff = next; this.byOff = byOff; this.tgt = tgt;
    // exception table: varint-encoded (start, length, target, depth<<1|lasti) in 2-byte units
    const et = this.exctable, ents = [];
    let p = 0;
    const varint = () => { let x = et[p++], v = x & 63; while (x & 64) { x = et[p++]; v = (v << 6) | (x & 63); } return v; };
    while (p < et.length) {
      const start = varint() * 2, len = varint() * 2, target = varint() * 2, dl = varint();
      ents.push({ start, end: start + len, target, depth: dl >> 1, lasti: !!(dl & 1) });
    }
    this.excEntries = ents;
    this.nlocals = this.localsplusnames.length;
    const kinds = this.localspluskinds;
    this.nCellVars = 0; this.nFreeVars = 0;
    this.freevars = []; this.cellvars = [];
    for (let i = 0; i < this.nlocals; i++) {
      if (kinds[i] & 0x80) this.freevars.push(this.localsplusnames[i]);
      if (kinds[i] & 0x40) this.cellvars.push(this.localsplusnames[i]);
    }
    this.isGen = !!(this.flags & 0x20);
    this.varnames = this.localsplusnames.filter((_, i) => !(kinds[i] & 0x80));
  }
}

function loads(buf) {
  let p = 0;
  const refs = [];
  const i32 = () => { const v = buf.readInt32LE(p); p += 4; return v; };
  const u8 = () => buf[p++];

  function rObj() {
    const code = buf[p++];
    const flag = code & 0x80, t = String.fromCharCode(code & 0x7f);
    let idx = -1;
    const reserve = () => { if (flag) { idx = refs.length; refs.push(undefined); } };
    const set = (v) => { if (flag) { if (idx < 0) { idx = refs.length; refs.push(v); } else refs[idx] = v; } return v; };
    switch (t) {
      case '0': return undefined;
      case 'N': return None;
      case 'F': return false;
      case 'T': return true;
      case 'S': return C.T.StopIteration;
      case '.': return C.Ellipsis;
      case 'i': return set(i32());
      case 'l': {
        const n = i32(); const cnt = Math.abs(n); let v = 0n;
        for (let i = 0; i < cnt; i++) { v |= BigInt(buf.readUInt16LE(p)) << BigInt(15 * i); p += 2; }
        return set(Number(n < 0 ? -v : v));
      }
      case 'g': { const v = buf.readDoubleLE(p); p += 8; return set(v); }
      case 'f': { const n = u8(); const s = buf.toString('latin1', p, p + n); p += n; return set(parseFloat(s)); }
      case 's': { const n = i32(); const b = Buffer.from(buf.subarray(p, p + n)); p += n; return set(new PyBytes(b)); }
      case 'u': case 't': { const n = i32(); const s = buf.toString('utf8', p, p + n); p += n; return set(s); }
      case 'a': case 'A': { const n = i32(); const s = buf.toString('latin1', p, p + n); p += n; return set(s); }
      case 'z': case 'Z': { const n = u8(); const s = buf.toString('latin1', p, p + n); p += n; return set(s); }
      case ')': case '(': {
        reserve();
        const n = t === ')' ? u8() : i32(); const a = [];
        for (let i = 0; i < n; i++) a.push(rObj());
        return set(new PyTuple(a));
      }
      case '[': { reserve(); const n = i32(); const a = []; set(a); for (let i = 0; i < n; i++) a.push(rObj()); return a; }
      case '{': { reserve(); const d = new PyDict(); set(d); for (;;) { const k = rObj(); if (k === undefined) break; C.dictSet(d, k, rObj()); } return d; }
      case '<': case '>': { reserve(); const n = i32(); const s = new PySet(t === '>'); set(s); for (let i = 0; i < n; i++) C.setAdd(s, rObj()); return s; }
      case 'r': { const i = i32(); return refs[i]; }
      case 'c': {
        reserve();
        const f = {};
        f.argcount = i32(); f.posonly = i32(); f.kwonly = i32(); f.stacksize = i32(); f.flags = i32();
        f.bytes = rObj().b; f.consts = rObj().a; f.names = rObj().a; f.localsplusnames = rObj().a; f.localspluskinds = rObj().b;
        f.filename = rObj(); f.name = rObj(); f.qualname = rObj(); f.firstlineno = i32(); f.linetable = rObj().b; f.exctable = rObj().b;
        return set(new CodeObj(f));
      }
      default: throw new Error('marshal: unsupported type code ' + t + ' at ' + (p - 1));
    }
  }
  return rObj();
}

module.exports = { loads, CodeObj };
