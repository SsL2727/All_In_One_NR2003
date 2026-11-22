// AI tweaks — three features of the "AI EDITING" Cheat Engine trainer, done in-process:
//
//   * crashing mode         : the trainer's CRASHING MODE switch
//   * pit-in-2nd-yellow-lap : the trainer's "AI PIT IN SECOND YELLOW FLAG LAP" code injection
//   * damage                : the trainer's DAMAGE float
//
// (The trainer's laps-left / strategy-update patch is gone: AIMOD owns the AI's pit planning now.)
//
// Every code patch verifies the bytes it is about to overwrite and remembers the originals, so toggling
// off (or releasing on exit) restores exactly what was there.
'use strict';

const A = require('./addresses');

const hex = (b) => Buffer.from(b).toString('hex');

class AIEditing {
  constructor(mem, log) {
    this.mem = mem;
    this.log = log || (() => {});
    this.reset();
  }

  reset() {
    this.crashing = null;         // { addr, original }
    this.pitYellow = null;        // { site, original: Buffer }
    this.cave = 0;                // executable cave kept for the process lifetime (never freed under a running thread)
    this.damageOriginal = null;
    this.lastError = '';
  }

  _at(rva) { return this.mem.base + rva; }

  // ── crashing mode ─────────────────────────────────────────────────────────
  setCrashing(on) {
    const P = A.PATCH.CRASHING;
    const addr = this._at(P.rva);
    if (on) {
      if (this.crashing) return true;
      const cur = this.mem.readBytes(addr, 3);
      if (!cur || hex(cur) !== P.original) { this.lastError = `unexpected bytes at the crashing-mode site (${cur ? hex(cur) : 'unreadable'})`; return false; }
      if (!this.mem.writeBytes(addr, Buffer.from(P.on, 'hex'))) return false;
      this.crashing = { addr, original: Buffer.from(P.original, 'hex') };
      return true;
    }
    if (!this.crashing) return true;
    const ok = this.mem.writeBytes(this.crashing.addr, this.crashing.original);
    if (ok) this.crashing = null;
    return ok;
  }

  // ── AI pit in second yellow flag lap ──────────────────────────────────────
  _findPitYellowSite() {
    const P = A.PATCH.PIT_YELLOW;
    const pat = Buffer.from(P.pattern, 'hex');
    const expected = this._at(P.rva);
    const here = this.mem.readBytes(expected, pat.length);
    if (here && here.equals(pat)) return expected;
    const found = this.mem.scan(this.mem.base + A.TEXT.start, A.TEXT.size, pat);
    return found || 0;
  }

  setPitYellow(on) {
    const P = A.PATCH.PIT_YELLOW;
    if (on) {
      if (this.pitYellow) return true;
      const site = this._findPitYellowSite();
      if (!site) { this.lastError = 'could not find the pit-under-yellow code (different NR2003.exe build?)'; return false; }
      const original = this.mem.readBytes(site, P.length);
      if (!this.cave) this.cave = this.mem.alloc(0x100);
      if (!this.cave) { this.lastError = 'could not allocate memory in NR2003.exe'; return false; }
      const jeTarget = site + 3 + 2 + original[4];            // the original `je +17` destination
      const ret = site + P.length;
      const code = Buffer.alloc(8 + 6 + 3 + 5);
      let o = 0;
      code.set([0x83, 0xF8, 0x02], o); o += 3;                 // cmp eax,2
      code.set([0x0F, 0x84], o); code.writeInt32LE(jeTarget - (this.cave + o + 6), o + 2); o += 6;   // je original-target
      code.set([0x83, 0xF8, 0x02], o); o += 3;                 // cmp eax,2   (was cmp eax,1)
      code.set([0xE9], o); code.writeInt32LE(ret - (this.cave + o + 5), o + 1); o += 5;              // jmp return
      if (!this.mem.writeBytes(this.cave, code.subarray(0, o))) { this.lastError = 'write failed (cave)'; return false; }
      const jmp = Buffer.from([0xE9, 0, 0, 0, 0, 0x90, 0x90, 0x90]);
      jmp.writeInt32LE(this.cave - (site + 5), 1);
      if (!this.mem.writeBytes(site, jmp)) { this.lastError = 'write failed (pit-yellow site)'; return false; }
      this.pitYellow = { site, original };
      this.log('[ai] pit-in-second-yellow-lap enabled');
      return true;
    }
    if (!this.pitYellow) return true;
    const ok = this.mem.writeBytes(this.pitYellow.site, this.pitYellow.original);
    if (ok) { this.pitYellow = null; this.log('[ai] pit-in-second-yellow-lap disabled'); }
    return ok;
  }

  // ── damage ────────────────────────────────────────────────────────────────
  damageAddr() { return this._at(A.GLOBAL.DAMAGE_MULT); }
  readDamage() { return this.mem.readF32(this.damageAddr()); }
  setDamage(v) {
    if (this.damageOriginal == null) this.damageOriginal = this.readDamage();
    return this.mem.writeF32(this.damageAddr(), v);
  }
  restoreDamage() {
    if (this.damageOriginal == null) return true;
    const ok = this.mem.writeF32(this.damageAddr(), this.damageOriginal);
    if (ok) this.damageOriginal = null;
    return ok;
  }

  status() {
    return { crashing: !!this.crashing, pitYellow: !!this.pitYellow, damage: this.damageOriginal != null, lastError: this.lastError };
  }

  // put everything back (called when the feature is switched off, the app quits, or NR2003 is leaving)
  releaseAll() {
    const r = [this.setCrashing(false), this.setPitYellow(false), this.restoreDamage()];
    return r.every(Boolean);
  }
}

module.exports = { AIEditing };
