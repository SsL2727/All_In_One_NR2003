// GameMem — RaceControl's memory view (absolute VAs) on top of All In One NR2003's memory layer (Win32Memory / ShadowMemory /
// FakeMemory). Reads that fail throw GameMemoryError, like RaceControl's ProcessMemory, so the engine can stop a tick.
'use strict';

class GameMemoryError extends Error {}

class GameMem {
  constructor(mem) { this.mem = mem; }
  _a(va) { return this.mem.base - 0x400000 + va; }
  _r(va, n) {
    const b = this.mem.readBytes(this._a(va), n);
    if (!b || b.length !== n) throw new GameMemoryError('read failed at 0x' + va.toString(16).toUpperCase());
    return b;
  }
  _w(va, buf) {
    if (!this.mem.writeBytes(this._a(va), buf)) throw new GameMemoryError('write failed at 0x' + va.toString(16).toUpperCase());
  }
  U8(a) { return this._r(a, 1)[0]; }
  U16(a) { return this._r(a, 2).readUInt16LE(0); }
  I32(a) { return this._r(a, 4).readInt32LE(0); }
  U32(a) { return this._r(a, 4).readUInt32LE(0); }
  F32(a) { return this._r(a, 4).readFloatLE(0); }
  F64(a) { return this._r(a, 8).readDoubleLE(0); }
  Str(a, max) {
    const b = this.mem.readBytes(this._a(a), max);
    if (!b) throw new GameMemoryError('read failed at 0x' + a.toString(16).toUpperCase());
    const z = b.indexOf(0);
    return b.toString('latin1', 0, z < 0 ? max : z);
  }
  W8(a, v) { this._w(a, Buffer.from([v & 0xff])); }
  W16(a, v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff, 0); this._w(a, b); }
  W32(a, v) { const b = Buffer.alloc(4); b.writeInt32LE(v | 0, 0); this._w(a, b); }
  WF32(a, v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); this._w(a, b); }
  W64(a, buf) { this._w(a, buf); }
  // run a game function (absolute VA) in the game: false when this memory layer cannot (read-only test mode, fakes)
  CallGame(va) { return typeof this.mem.callGame === 'function' ? !!this.mem.callGame(this._a(va)) : false; }
}

module.exports = { GameMem, GameMemoryError };
