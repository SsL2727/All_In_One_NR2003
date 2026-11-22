// AI Enhanced's "INI Files" tab: the 143 papy_ai.ini parameters the game keeps as floats in memory. The addresses come from AI Enhanced's own
// table (checked against a running NR2003: 47 of the 47 values that papy_ai.ini also sets matched). You set only the ones you want to change;
// they are written over the game's values and re-applied if the game reloads its file; everything we changed is put back when switched off.
'use strict';
const PARAMS = require('./params.json');
const BY_NAME = new Map(PARAMS.map(p => [p.name, p]));

class IniFiles {
  constructor(mem) { this.m = mem; this.base = new Map(); this.written = new Map(); }

  static known(name) { return BY_NAME.has(name); }
  static names() { return PARAMS.map(p => p.name); }

  // every parameter with the game's current value
  list() { return PARAMS.map(p => ({ name: p.name, addr: p.addr, confirmed: !!p.confirmed, value: this.m.readF32(p.addr), base: this.base.has(p.name) ? this.base.get(p.name) : undefined })); }

  // make the game hold `overrides` ({ name: number }); -> number of values written this call
  apply(overrides) {
    let n = 0;
    for (const [name, want] of Object.entries(overrides || {})) {
      const p = BY_NAME.get(name), v = Number(want);
      if (!p || !Number.isFinite(v)) continue;
      const cur = this.m.readF32(p.addr);
      if (cur === null) continue;
      const w32 = Math.fround(v);
      if (cur === w32) continue;
      if (!this.base.has(name)) this.base.set(name, cur);               // the game's own value, before our first write
      const b = Buffer.alloc(4); b.writeFloatLE(v, 0);
      if (this.m.writeBytes(p.addr, b)) { this.written.set(name, w32); n++; }
    }
    return n;
  }

  // put back what we changed (only where the game still holds our value)
  restore() {
    let n = 0;
    for (const [name, orig] of this.base) {
      const p = BY_NAME.get(name), cur = this.m.readF32(p.addr);
      if (cur !== null && cur === this.written.get(name)) { const b = Buffer.alloc(4); b.writeFloatLE(orig, 0); if (this.m.writeBytes(p.addr, b)) n++; }
    }
    this.base.clear(); this.written.clear();
    return n;
  }

  // a name we are not holding an override for any more goes back to the game's value
  release(name) {
    if (!this.base.has(name)) return;
    const p = BY_NAME.get(name), cur = this.m.readF32(p.addr);
    if (cur !== null && cur === this.written.get(name)) { const b = Buffer.alloc(4); b.writeFloatLE(this.base.get(name), 0); this.m.writeBytes(p.addr, b); }
    this.base.delete(name); this.written.delete(name);
  }
}

module.exports = { IniFiles, PARAMS };
