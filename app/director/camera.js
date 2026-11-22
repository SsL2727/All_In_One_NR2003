// Camera and TV focus of NR2003, the way RaceVision does it.
//
//   0xC069DB  u32  the camera number showing (1-3 cockpit, 4 chase ... 19 TV1, 20 TV2, 21 spectator)
//   0xC069E3  u32  address of the car record being followed (0xC12030 + 0x15B8 * slot)
//   (while the game's replay plays, 0xB8E59A = 1 and the replay's own camera object is at 0xB8E5BD instead of 0xC069D7)
//
// Writing the camera number straight into memory works but skips the game's own camera code (camera sounds, smoothing). RaceVision
// therefore hooks a per-frame function (0x599A80, 5 bytes: sub esp,3Ch / push ebx / push ebp) to jump to a small code cave. Each frame
// the cave looks at its mailbox: command 1 calls the game's camera switch (0x568E20, the one the C key uses) with the camera and car we
// ask for, command 2 calls any game function with three cdecl arguments (the replay start / stop use it); then it counts the call done.
//
// Cave layout (0x200 bytes allocated in the game): +0 command, +4 camera, +8 car record address, +0xC frame counter (the hook is alive),
// +0x10 function, +0x14 / +0x18 / +0x1C its arguments, +0x20 calls done, +0x24 busy, +0x28 the camera object (ecx), +0x38 'RV4H'; code
// at +0x40. Byte-for-byte the hook RaceVision 1.1.0 installs, so the two never disagree.
'use strict';

const A = {
  Camera: 0xC069DB, Focus: 0xC069E3, CarRec: 0xC12030, ReplayCarRec: 0xE0C238, CarStride: 0x15B8, CarSlot: 0x5B2,   // slot number stored in the record
  Hook: 0x599A80, HookBack: 0x599A85, HookBack2: 0x5999F6, CamCall: 0x568E20, ThisPtr: 0xC069D7, ReplayThis: 0xB8E5BD,
  ReplayState: 0xB8E59A, TapeTicks: 0xB8E586, TickRateFlag: 0x755A18, TickRate: 0x7559B4, InCar: 0xC067D4,
  ReplayStart: 0x5024A0, ReplayStop: 0x502B50, Pause: 0x5464E0, Resume: 0x5465E0,
};
const ORIGINAL = Buffer.from([0x83, 0xEC, 0x3C, 0x53, 0x55]);       // sub esp,3Ch; push ebx; push ebp
const MAGIC = 0x34485652;                                            // 'RV4H'
const CODE_AT = 0x40, CODE_LEN = 0x8F, CAVE_SIZE = 0x200;

// the 0x8F bytes RaceVision writes at cave+0x40 (disassembly in the comments)
function caveCode(cave) {
  const b = Buffer.alloc(CODE_LEN);
  let o = 0;
  const u8 = (...v) => { for (const x of v) b[o++] = x; };
  const u32 = (v) => { b.writeUInt32LE(v >>> 0, o); o += 4; };
  u8(0xFF, 0x05); u32(cave + 0xC);                                  // inc dword [cave+0xC]           frame counter
  u8(0x83, 0x3D); u32(cave); u8(0x00);                              // cmp dword [cave], 0            nothing asked
  u8(0x74, 0x76);                                                   // jz out
  u8(0x83, 0x3D); u32(cave + 0x24); u8(0x00);                       // cmp dword [cave+0x24], 0       busy (re-entered)
  u8(0x75, 0x6D);                                                   // jnz out
  u8(0x60, 0x9C);                                                   // pushad; pushfd
  u8(0xC7, 0x05); u32(cave + 0x24); u32(1);                         // mov dword [cave+0x24], 1
  u8(0xA1); u32(cave);                                              // mov eax, [cave]
  u8(0xC7, 0x05); u32(cave); u32(0);                                // mov dword [cave], 0
  u8(0x83, 0xF8, 0x02);                                             // cmp eax, 2
  u8(0x74, 0x1F);                                                   // je generic
  u8(0x8B, 0x0D); u32(cave + 0x28);                                 // mov ecx, [cave+0x28]           the camera object
  u8(0xFF, 0x35); u32(cave + 8);                                    // push [cave+8]   (car record)
  u8(0x6A, 0x00, 0x6A, 0x00);                                       // push 0; push 0
  u8(0xFF, 0x35); u32(cave + 4);                                    // push [cave+4]   (camera)
  u8(0xB8); u32(A.CamCall);                                         // mov eax, 0x568E20
  u8(0xFF, 0xD0);                                                   // call eax
  u8(0xEB, 0x1C);                                                   // jmp done
  u8(0xFF, 0x35); u32(cave + 0x1C);                                 // generic: push [cave+0x1C]
  u8(0xFF, 0x35); u32(cave + 0x18);                                 //          push [cave+0x18]
  u8(0xFF, 0x35); u32(cave + 0x14);                                 //          push [cave+0x14]
  u8(0xA1); u32(cave + 0x10);                                       //          mov eax, [cave+0x10]
  u8(0xFF, 0xD0);                                                   //          call eax
  u8(0x83, 0xC4, 0x0C);                                             //          add esp, 0Ch
  u8(0xFF, 0x05); u32(cave + 0x20);                                 // done: inc dword [cave+0x20]
  u8(0xC7, 0x05); u32(cave + 0x24); u32(0);                         // mov dword [cave+0x24], 0
  u8(0x9D, 0x61);                                                   // popfd; popad
  u8(0x83, 0xEC, 0x3C, 0x53, 0x55);                                 // out: the five bytes we replaced
  u8(0xE9); u32(A.HookBack - (cave + CODE_AT + o + 4));            // jmp back (0x599A85)
  if (o !== CODE_LEN) throw new Error('hook code is ' + o + ' bytes');
  return b;
}

class Camera {
  // mem: Win32Memory/ShadowMemory-like { readBytes, writeBytes, readU32, writeI32, alloc, free }
  constructor(mem, log) { this.m = mem; this.log = log || (() => {}); this.cave = 0; this.hooked = false; this.foreign = false; }

  // -> 'hooked' | 'already' (somebody's hook is there) | 'unsupported' | 'failed'
  install() {
    const m = this.m;
    const cur = m.readBytes(A.Hook, 5);
    if (!cur) return 'failed';
    if (cur[0] === 0xE9) {                                           // already hooked: RaceVision's cave has the same layout
      const target = cur.readInt32LE(1) + A.Hook + 5;
      const base = target - CODE_AT;
      const magic = m.readBytes(base + 0x38, 4);
      this.cave = base;
      this.hooked = true; this.foreign = !(magic && magic.readUInt32LE(0) === MAGIC);
      return 'already';
    }
    if (!cur.equals(ORIGINAL)) return 'unsupported';
    const cave = m.alloc(CAVE_SIZE);
    if (!cave) return 'failed';
    const head = Buffer.alloc(CODE_AT);
    head.writeUInt32LE(A.ThisPtr, 0x28); head.writeUInt32LE(MAGIC, 0x38);
    if (!m.writeBytes(cave, head)) return 'failed';
    if (!m.writeBytes(cave + CODE_AT, caveCode(cave))) return 'failed';
    const jmp = Buffer.alloc(5); jmp[0] = 0xE9; jmp.writeInt32LE(cave + CODE_AT - A.HookBack, 1);
    if (!m.writeBytes(A.Hook, jmp)) return 'failed';
    this.cave = cave; this.hooked = true; this.foreign = false;
    return 'hooked';
  }

  // frame counter moving = the hook runs every frame
  alive() { return this.hooked && this.cave ? this.m.readU32(this.cave + 0xC) : null; }

  uninstall() {
    if (!this.hooked) return;
    try {
      if (!this.foreign) { const cur = this.m.readBytes(A.Hook, 5); if (cur && cur[0] === 0xE9) this.m.writeBytes(A.Hook, ORIGINAL); }
    } catch (e) { /* game gone */ }
    this.hooked = false; this.cave = 0;
  }

  current() { return this.m.readU32(A.Camera); }
  focusAddr() { return this.m.readU32(A.Focus); }
  focusSlot() {
    const p = this.focusAddr();
    if (!p || p < A.CarRec) return -1;
    const i = (p - A.CarRec) / A.CarStride;
    return Number.isInteger(i) && i >= 0 && i < 44 ? i : -1;
  }
  carRec(slot) { return (this.replaying() ? A.ReplayCarRec : A.CarRec) + slot * A.CarStride; }   // the replay plays its own copy of the cars
  slotValid(slot) { return slot >= 0 && slot < 44 && this.m.readU32(this.carRec(slot) + A.CarSlot - 0x0) !== null && (this.m.readI32(this.carRec(slot) + A.CarSlot) & 0xFFFF) === slot; }

  // is the game playing a replay right now (its own camera object is then at 0xB8E5BD)
  replaying() { return this.m.readU32(A.ReplayState) === 1; }
  inCar() { return this.m.readU32(A.InCar) === 3; }

  _usable() { return this.hooked && this.cave && !this.foreign; }

  // switch camera (and car) the way the game's C key does; falls back to writing the numbers when the hook is not there
  set(cam, slot, { call = true } = {}) {
    const m = this.m;
    const rec = slot === undefined || slot === null || slot < 0 ? (this.focusAddr() || 0) : this.carRec(slot);
    if (call && this._usable()) {
      const b = Buffer.alloc(8); b.writeUInt32LE(cam >>> 0, 0); b.writeUInt32LE(rec >>> 0, 4);
      m.writeBytes(this.cave + 4, b);
      m.writeI32(this.cave + 0x28, this.replaying() ? A.ReplayThis : A.ThisPtr);      // the replay has its own camera object
      m.writeI32(this.cave, 1);
      return true;
    }
    if (rec) m.writeI32(A.Focus, rec);
    m.writeI32(A.Camera, cam);
    return true;
  }

  // run a game function with up to three cdecl arguments (ints; pass floats as their bits) through the cave; resolves true once the
  // game made the call (the done counter moved), false if the hook is not there or it did not answer in time
  async callGame(fn, a = 0, b = 0, c = 0, { timeoutMs = 1500, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
    if (!this._usable()) return false;
    const m = this.m, cave = this.cave;
    const waitIdle = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (m.readU32(cave) === 0 && m.readU32(cave + 0x24) === 0) return true; await sleep(10); } return false; };
    if (!await waitIdle(1000)) return false;
    const before = m.readU32(cave + 0x20);
    const args = Buffer.alloc(16);
    args.writeUInt32LE(fn >>> 0, 0); args.writeUInt32LE(a >>> 0, 4); args.writeUInt32LE(b >>> 0, 8); args.writeUInt32LE(c >>> 0, 12);
    m.writeBytes(cave + 0x10, args);
    m.writeI32(cave, 2);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await sleep(10);
      if (m.readU32(cave + 0x20) !== before) return true;
    }
    return false;
  }
}

const floatBits = (f) => { const b = Buffer.alloc(4); b.writeFloatLE(f, 0); return b.readUInt32LE(0); };

module.exports = { Camera, caveCode, A, ORIGINAL, MAGIC, floatBits, CODE_AT, CODE_LEN, CAVE_SIZE };
