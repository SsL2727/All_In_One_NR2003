// RaceVision "MPH" fix.
//
// Bug: RaceVision's classic on-board overlay (and the on-board gauges) print the float at car-record offset +0x1578 as the
// speed in mph. That field is the front-left WHEEL's rotation rate (rad/s; the next three floats are the other wheels, and
// +0x1568.. hold the tyre circumference, 2.503 m), so the overlay showed 193 where the car really did 172 mph, and it
// reads wrong again under braking or wheelspin. RaceVision already keeps every car's true ground speed (m/s, from the
// car's velocity vector) in its own table (it shows that one in its dash style, x 2.23694); the classic overlay just did
// not use it.
//
// Fix: one redirected instruction. At 0x422223 the original pops the gauge value off the x87 stack into a local
// (`fstp dword [ebp-0x98]`, right after the call that read it). This patch replaces that instruction with a jump to a
// tiny code cave in a new section that discards the gauge value and stores  speed[car] * 2.23694  instead, then returns
// to the next instruction. The cave is position independent (RaceVision is ASLR-enabled), uses only eax/edx (ecx holds
// the context pointer for the next call) and leaves everything else of RaceVision untouched. The original exe is
// never modified: a fixed copy is written next to it.
'use strict';
const crypto = require('crypto');

const IMAGE_BASE = 0x400000;
const PATCH_VA = 0x422223;                        // fstp dword ptr [ebp-0x98]  (d9 9d 68 ff ff ff)
const BACK_VA = 0x422229;                         // push esi
const SIG_VA = 0x42220d;                          // 68 78 15 00 00 56 e8 .. .. .. .. 8b 0d 44 5e 49 00 68 08 15 00 00 d9 9d 68 ff ff ff
const SIG_HEAD = Buffer.from('687815000056e8', 'hex');                          // push 0x1578 ; push esi ; call ..
const SIG_TAIL = Buffer.from('8b0d445e49006808150000d99d68ffffff', 'hex');    // from 0x422218
const SPEED_TABLE_VA = 0x491238;                  // float speed (m/s) per car, stride 0x1b0
const MPS_TO_MPH_VA = 0x47f994;                   // float 2.23694
const SECTION_NAME = '.rvfix';

const u32 = (b, o) => b.readUInt32LE(o), u16 = (b, o) => b.readUInt16LE(o);
const align = (v, a) => Math.ceil(v / a) * a;

function parse(buf) {
  if (buf.length < 0x200 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a Windows program');
  const pe = u32(buf, 0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const machine = u16(buf, pe + 4), nsec = u16(buf, pe + 6), optSize = u16(buf, pe + 20);
  const opt = pe + 24;
  if (machine !== 0x14c || u16(buf, opt) !== 0x10b) throw new Error('not a 32-bit program');
  const info = {
    pe, nsec, opt, optSize, imageBase: u32(buf, opt + 28), secAlign: u32(buf, opt + 32), fileAlign: u32(buf, opt + 36),
    sizeOfImage: u32(buf, opt + 56), sizeOfHeaders: u32(buf, opt + 60), secTable: opt + optSize, sections: [],
  };
  for (let i = 0; i < nsec; i++) {
    const o = info.secTable + i * 40;
    info.sections.push({ name: buf.toString('latin1', o, o + 8).replace(/\0+$/, ''), vsize: u32(buf, o + 8), va: u32(buf, o + 12), rawSize: u32(buf, o + 16), raw: u32(buf, o + 20), off: o });
  }
  return info;
}

const vaToOff = (info, va) => {
  const rva = va - info.imageBase;
  for (const s of info.sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va < s.rawSize ? s.raw + rva - s.va : -1;
  return -1;
};

// is this the RaceVision this fix was written for, and not patched yet?
function check(buf) {
  let info;
  try { info = parse(buf); } catch (e) { return { ok: false, reason: e.message }; }
  if (info.imageBase !== IMAGE_BASE) return { ok: false, reason: 'unexpected image base' };
  if (info.sections.some(s => s.name === SECTION_NAME)) return { ok: false, patched: true, reason: 'already patched' };
  const o = vaToOff(info, SIG_VA), o2 = vaToOff(info, PATCH_VA - 11);
  if (o < 0 || o2 < 0) return { ok: false, reason: 'code not where expected' };
  if (buf.compare(SIG_HEAD, 0, SIG_HEAD.length, o, o + SIG_HEAD.length) !== 0) return { ok: false, reason: 'speed read not found (a different RaceVision build?)' };
  const tail = vaToOff(info, 0x422218);
  if (buf.compare(SIG_TAIL, 0, SIG_TAIL.length, tail, tail + SIG_TAIL.length) !== 0) return { ok: false, reason: 'speed read not found (a different RaceVision build?)' };
  return { ok: true, info };
}

// the cave, assembled for a given VA it will be loaded at
function cave(caveVa) {
  const b = [];
  const push = (...x) => b.push(...x);
  const imm32 = v => { const t = Buffer.alloc(4); t.writeInt32LE(v | 0, 0); return [...t]; };
  push(0xDD, 0xD8);                                   // fstp st(0)           discard the wheel-speed gauge value
  push(0xE8, 0, 0, 0, 0);                             // call L1
  const l1 = caveVa + b.length;                       // L1: (the byte after the call)
  push(0x58);                                         // pop eax              eax = run-time address of L1
  push(0x2D, ...imm32(l1));                           // sub eax, link-time VA of L1  -> eax = load delta
  push(0x85, 0xF6);                                   // test esi, esi        esi = car index
  push(0x78, 0x16);                                   // js zero (skips the 22 bytes of the speed load)
  push(0x69, 0xD6, ...imm32(0x1B0));                  // imul edx, esi, 0x1b0
  push(0x01, 0xC2);                                   // add edx, eax
  push(0xD9, 0x82, ...imm32(SPEED_TABLE_VA));         // fld dword [edx + speed table]        (m/s)
  push(0xD8, 0x88, ...imm32(MPS_TO_MPH_VA));          // fmul dword [eax + 2.23694]
  push(0xEB, 0x02);                                   // jmp store
  push(0xD9, 0xEE);                                   // zero: fldz
  push(0xD9, 0x9D, 0x68, 0xFF, 0xFF, 0xFF);           // store: fstp dword [ebp-0x98]
  const jmpAt = caveVa + b.length;
  push(0xE9, ...imm32(BACK_VA - (jmpAt + 5)));        // jmp back (relative: independent of the load address)
  return Buffer.from(b);
}

// -> a new Buffer with the fix applied, or throws
function apply(buf) {
  const c = check(buf);
  if (!c.ok) throw new Error(c.reason);
  const info = c.info;
  const last = info.sections[info.sections.length - 1];
  if (info.secTable + (info.nsec + 1) * 40 > info.sections[0].raw) throw new Error('no room for another section header');
  const rva = align(Math.max(info.sizeOfImage, last.va + last.vsize), info.secAlign);
  const raw = align(buf.length, info.fileAlign);
  const caveVa = info.imageBase + rva;
  const code = cave(caveVa);
  const rawSize = align(code.length, info.fileAlign);
  const out = Buffer.alloc(raw + rawSize);
  buf.copy(out, 0);
  code.copy(out, raw);
  // the new section header
  const h = info.secTable + info.nsec * 40;
  out.fill(0, h, h + 40);
  out.write(SECTION_NAME, h, 'latin1');
  out.writeUInt32LE(code.length, h + 8); out.writeUInt32LE(rva, h + 12); out.writeUInt32LE(rawSize, h + 16); out.writeUInt32LE(raw, h + 20);
  out.writeUInt32LE(0x60000020, h + 36);                       // code, executable, readable
  out.writeUInt16LE(info.nsec + 1, info.pe + 6);
  out.writeUInt32LE(align(rva + code.length, info.secAlign), info.opt + 56);            // SizeOfImage
  out.writeUInt32LE(0, info.opt + 64);                                                   // CheckSum (not checked for programs)
  // redirect the original instruction: jmp cave ; nop
  const po = vaToOff(info, PATCH_VA);
  if (out.compare(Buffer.from('d99d68ffffff', 'hex'), 0, 6, po, po + 6) !== 0) throw new Error('unexpected bytes at the patch point');
  const rel = Buffer.alloc(4); rel.writeInt32LE(caveVa - (PATCH_VA + 5), 0);
  out[po] = 0xE9; rel.copy(out, po + 1); out[po + 5] = 0x90;
  return out;
}

const sha1 = b => crypto.createHash('sha1').update(b).digest('hex');
module.exports = { check, apply, cave, parse, sha1, PATCH_VA, BACK_VA, SPEED_TABLE_VA, MPS_TO_MPH_VA, SECTION_NAME };
