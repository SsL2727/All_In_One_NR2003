// The human player's car in AI Enhanced (its 44th slot): the player has no driver-stat bytes, so AI Enhanced scales physics constants instead
// (FUN_004494c0 / FUN_004492d0 for slot 43, cached by FUN_00449a60, put back by FUN_00449b30 / FUN_00449c80):
//   engine factor f0: four engine floats = cached / f0, and ai_drag_modifier = cached * f0 (the AI share the constants: this keeps them as they were)
//   grip factor f1:   four tyre-grip floats = cached * f1, and ai_grip_modifier = cached / f1 (same idea)
// While the game's session byte (0x73BAB8) is 3 the cached values are written back instead.
'use strict';

const ENGINE = [0x7235f8, 0x7237c0, 0x723988, 0x7247c8];      // written: cached / f0
const GRIP = [0xbf3a3c, 0xbf4475, 0xbf4eae, 0xbf58e7];        // written: cached * f1
const DRAG = 0x74bc10, GRIP_MOD = 0x74bc0c, SESSION = 0x73bab8;
const ENGINE_FIXED_0 = 0x3ea8f5c3, ENGINE_FIXED_3 = 0x3f4a9b39;  // AI Enhanced caches 0.33 and 0.7914 for the first and last engine float (not read)

const f32 = (bits) => { const b = Buffer.alloc(4); b.writeUInt32LE(bits >>> 0, 0); return b.readFloatLE(0); };
const buf = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };

class PlayerEffects {
  constructor() { this.cache = null; }
  reset() { this.cache = null; }

  // FUN_00449a60: at track load. -> true when the constants were read
  capture(mem) {
    const e1 = mem.readF32(0x7240a8), e2 = mem.readF32(0x724270), drag = mem.readF32(DRAG), gripMod = mem.readF32(GRIP_MOD);
    const grip = GRIP.map(a => mem.readF32(a));
    if ([e1, e2, drag, gripMod, ...grip].some(v => v === null || !Number.isFinite(v))) return false;
    this.cache = { engine: [f32(ENGINE_FIXED_0), e1, e2, f32(ENGINE_FIXED_3)], grip, drag, gripMod };
    return true;
  }

  // every tick, with slot 43's factors. bases: { drag, gripMod } in effect (the INI values AI Enhanced's own cache follows), defaults: the cache
  write(mem, f0, f1, bases = {}) {
    const c = this.cache;
    if (!c) return false;
    const drag = Number.isFinite(bases.drag) ? bases.drag : c.drag, gripMod = Number.isFinite(bases.gripMod) ? bases.gripMod : c.gripMod;
    const replay = mem.readU8(SESSION) === 3;
    if (f0 > 0) {
      if (replay) { ENGINE.forEach((a, i) => mem.writeBytes(a, buf(c.engine[i]))); mem.writeBytes(DRAG, buf(drag)); }
      else { ENGINE.forEach((a, i) => mem.writeBytes(a, buf(c.engine[i] / f0))); mem.writeBytes(DRAG, buf(drag * f0)); }
    }
    if (replay) { GRIP.forEach((a, i) => mem.writeBytes(a, buf(c.grip[i]))); mem.writeBytes(GRIP_MOD, buf(gripMod)); }
    else {
      GRIP.forEach((a, i) => mem.writeBytes(a, buf(f1 * c.grip[i])));
      if (f1 > 0) mem.writeBytes(GRIP_MOD, buf(gripMod / f1));
    }
    return true;
  }

  // FUN_00449b30(43): the cached constants back
  restore(mem, bases = {}) {
    const c = this.cache;
    if (!c) return;
    const drag = Number.isFinite(bases.drag) ? bases.drag : c.drag, gripMod = Number.isFinite(bases.gripMod) ? bases.gripMod : c.gripMod;
    ENGINE.forEach((a, i) => mem.writeBytes(a, buf(c.engine[i]))); mem.writeBytes(DRAG, buf(drag));
    GRIP.forEach((a, i) => mem.writeBytes(a, buf(c.grip[i]))); mem.writeBytes(GRIP_MOD, buf(gripMod));
  }
}

module.exports = { PlayerEffects, ENGINE, GRIP, DRAG, GRIP_MOD };
