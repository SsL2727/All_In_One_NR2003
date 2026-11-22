// RaceVision 1.2 camera extras for the NR2003 MS executable. Every patch is
// guarded by the original instruction bytes and restored by uninstall().
'use strict';

const CALL = 0xE8;
const f32 = (x) => { const b = Buffer.alloc(4); b.writeFloatLE(x, 0); return b; };
const relCall = (site, target) => { const b = Buffer.alloc(5); b[0] = CALL; b.writeInt32LE(target - site - 5, 1); return b; };
const match = (a, b) => !!a && a.equals(b);

class CameraEffects {
  constructor(mem, log = () => {}) {
    this.m = mem; this.log = log;
    this.angleCave = 0; this.angleOwned = false; this.angleSites = [];
    this.lensCave = 0; this.lensOwned = false; this.lensSites = [];
    this.lensOperand = null; this.refreshTicks = 0;
    this.clipOrig = null; this.followOrig = null; this.quietOrig = null;
  }

  _target(site) {
    const b = this.m.readBytes(site, 5);
    return b && b[0] === CALL ? site + 5 + b.readInt32LE(1) : 0;
  }

  _angleCode(cave) {
    const b = Buffer.alloc(0x50); let o = 0;
    for (let i = 0; i < 3; i++) {
      const off = 8 + i * 4;
      b.set([0xD9, 0x44, 0x24, off, 0xD8, 0x05], o); o += 6;
      b.writeUInt32LE(cave + 0x40 + i * 4, o); o += 4;
      b.set([0xD9, 0x5C, 0x24, off], o); o += 4;
    }
    b[o++] = 0xE9; b.writeInt32LE(0x5F6F20 - (cave + o + 4), o); o += 4;
    b.writeUInt32LE(0x32495652, 0x3C); // RVI2
    b.writeFloatLE(0, 0x40); b.writeFloatLE(0, 0x44); b.writeFloatLE(0, 0x48);
    return b;
  }

  _installAngles() {
    if (this.angleCave) return true;
    const sites = [0x569C91, 0x56AB9E], old = sites.map(s => this.m.readBytes(s, 5));
    if (old.some(b => !b || b[0] !== CALL)) return false;
    const targets = sites.map((s, i) => s + 5 + old[i].readInt32LE(1));
    if (targets.every(t => t === 0x5F6F20)) {
      const cave = this.m.alloc(0x50); if (!cave) return false;
      if (!this.m.writeBytes(cave, this._angleCode(cave))) { this.m.free(cave); return false; }
      const next = sites.map(s => relCall(s, cave));
      for (let i = 0; i < sites.length; i++) {
        if (!this.m.writeBytes(sites[i], next[i])) {
          for (let j = 0; j < i; j++) this.m.writeBytes(sites[j], old[j]);
          this.m.free(cave); return false;
        }
      }
      this.angleCave = cave; this.angleOwned = true; this.angleSites = sites.map((site, i) => ({ site, old: Buffer.from(old[i]) }));
      return true;
    }
    if (targets[0] === targets[1] && this.m.readBytes(targets[0] + 0x3C, 4)?.toString('ascii') === 'RVI2') {
      this.angleCave = targets[0]; this.angleOwned = false; return true;
    }
    return false;
  }

  setAngles(turn = 0, tilt = 0, roll = 0) {
    if (![turn, tilt, roll].every(Number.isFinite)) return false;
    if (![turn, tilt, roll].some(v => Math.abs(v) > 0.001) && !this.angleCave) return true;
    if (!this._installAngles()) return false;
    const b = Buffer.alloc(12);
    [turn, tilt, roll].forEach((v, i) => b.writeFloatLE(v * Math.PI / 180, i * 4));
    const ok = this.m.writeBytes(this.angleCave + 0x40, b);
    if (ok) this.refreshTicks = 3;
    return ok;
  }

  _lensCode(cave) {
    const b = Buffer.alloc(0x50);
    b.set([0xA1], 0); b.writeUInt32LE(cave + 0x40, 1);
    b.set([0x85, 0xC0, 0x74, 0x07, 0xD9, 0x05], 5); b.writeUInt32LE(cave + 0x40, 11);
    b[15] = 0xC3; b[16] = 0xE9; b.writeInt32LE(0x411850 - (cave + 21), 17);
    b.writeUInt32LE(0x314C5652, 0x3C); // RVL1
    b.writeFloatLE(0, 0x40); b.writeFloatLE(150, 0x44);
    return b;
  }

  _installLens() {
    if (this.lensCave) return true;
    const sites = [0x56AC30, 0x56AC4B], old = sites.map(s => this.m.readBytes(s, 5));
    const op = this.m.readBytes(0x56B3AD, 4);
    if (old.some(b => !b || b[0] !== CALL) || !op || op.readUInt32LE(0) !== 0x6EE574) return false;
    const targets = sites.map((s, i) => s + 5 + old[i].readInt32LE(1));
    if (targets.every(t => t === 0x411850)) {
      const cave = this.m.alloc(0x50); if (!cave) return false;
      if (!this.m.writeBytes(cave, this._lensCode(cave))) { this.m.free(cave); return false; }
      const next = sites.map(s => relCall(s, cave));
      for (let i = 0; i < sites.length; i++) {
        if (!this.m.writeBytes(sites[i], next[i])) {
          for (let j = 0; j < i; j++) this.m.writeBytes(sites[j], old[j]);
          this.m.free(cave); return false;
        }
      }
      this.lensCave = cave; this.lensOwned = true; this.lensSites = sites.map((site, i) => ({ site, old: Buffer.from(old[i]) }));
    } else if (targets[0] === targets[1] && this.m.readBytes(targets[0] + 0x3C, 4)?.toString('ascii') === 'RVL1') {
      this.lensCave = targets[0]; this.lensOwned = false;
    } else return false;
    this.lensOperand = Buffer.from(op);
    const ptr = Buffer.alloc(4); ptr.writeUInt32LE((this.lensCave + 0x44) >>> 0, 0);
    if (this.m.writeBytes(0x56B3AD, ptr)) return true;
    if (this.lensOwned) {
      for (const x of this.lensSites) if (this._target(x.site) === this.lensCave) this.m.writeBytes(x.site, x.old);
      this.m.free(this.lensCave);
    }
    this.lensCave = 0; this.lensOwned = false; this.lensSites = []; this.lensOperand = null;
    return false;
  }

  setLens(degrees = 0) {
    if (!Number.isFinite(degrees)) return false;
    const own = this.m.readBytes(0x894EE8, 4);
    const ownDeg = own ? own.readFloatLE(0) : 0;
    if (Math.abs(degrees - ownDeg) < 0.05) degrees = 0;
    if (degrees === 0 && !this.lensCave) return true;
    if (!this._installLens()) return false;
    const safe = degrees === 0 ? 0 : Math.max(20, Math.min(150, degrees)) * Math.PI / 180;
    const ok = this.m.writeBytes(this.lensCave + 0x40, f32(safe));
    if (ok) this.refreshTicks = 3;
    return ok;
  }

  refresh() {
    if (this.refreshTicks <= 0) return;
    const guard = this.m.readBytes(0x56AA15, 5);
    if (match(guard, Buffer.from([0xA0, 0x79, 0xC2, 0xC5, 0x00]))) this.m.writeBytes(0xC5C279, Buffer.from([0]));
    this.refreshTicks--;
  }

  setDrone(on, settings = {}) {
    on = !!on;
    const clipGuard = this.m.readBytes(0x56B064, 10);
    if (clipGuard && clipGuard.subarray(0, 6).equals(Buffer.from([0xC7, 0x85, 0xA4, 0, 0, 0]))) {
      const cur = clipGuard.readUInt32LE(6);
      if (cur === 0x41200000 || cur === 0x40000000) {
        if (!this.clipOrig) this.clipOrig = this.m.readBytes(0x56B06C, 2);
        this.m.writeBytes(0x56B06C, on ? Buffer.from([0, 0x40]) : this.clipOrig);
      }
    }
    const g1 = Buffer.from([0xD8, 0x15, 0x34, 0x5F, 0x6F, 0]), g2 = Buffer.from([0xD8, 0x0D, 0x38, 0x5F, 0x6F, 0]);
    if (match(this.m.readBytes(0x56A2A5, 6), g1) && match(this.m.readBytes(0x56A113, 6), g2)) {
      const at = 0x6F5F34, cur = this.m.readBytes(at, 12);
      if (cur) {
        if (!this.followOrig) this.followOrig = Buffer.from(cur);
        let data = this.followOrig;
        if (on) {
          const d0 = Number(settings.drone_distance), t0 = Number(settings.drone_top_mph), h0 = Number(settings.drone_hover_m);
          const dist = Math.max(20, Number.isFinite(d0) ? d0 : 100), top = Math.max(100, Math.min(300, Number.isFinite(t0) ? t0 : 175)), hover = Math.max(0, Math.min(80, Number.isFinite(h0) ? h0 : 25));
          data = Buffer.alloc(12); data.writeFloatLE(top / 2.23694, 0); data.writeFloatLE(1.6161615e-05 * 100 / dist, 4); data.writeFloatLE(hover * hover, 8);
        }
        this.m.writeBytes(at, data);
      }
    }
    const sites = [0x593699, 0x593579], saved = sites.map(s => this.m.readBytes(s, 3));
    if (saved.every(b => b && b[0] === 0x83 && b[1] === 0xF8 && (b[2] === 7 || b[2] === 0x7F))) {
      if (!this.quietOrig) this.quietOrig = saved.map(b => b[2]);
      const value = on && String(settings.drone_quiet) !== '0' ? 0x7F : 7;
      let changed = false;
      for (let i = 0; i < sites.length; i++) if (saved[i][2] !== value) { this.m.writeBytes(sites[i] + 2, Buffer.from([value])); changed = true; }
      if (changed) this.m.writeI32(0xD8C30C, -1);
    }
  }

  uninstall() {
    this.setDrone(false, {});
    if (this.angleOwned && this.angleCave) {
      for (const x of this.angleSites) if (this._target(x.site) === this.angleCave) this.m.writeBytes(x.site, x.old);
      this.m.free(this.angleCave);
    }
    if (this.lensOwned && this.lensCave) {
      for (const x of this.lensSites) if (this._target(x.site) === this.lensCave) this.m.writeBytes(x.site, x.old);
      if (this.lensOperand) this.m.writeBytes(0x56B3AD, this.lensOperand);
      this.m.free(this.lensCave);
    }
    this.angleCave = this.lensCave = 0; this.angleOwned = this.lensOwned = false;
    this.angleSites = this.lensSites = []; this.lensOperand = null; this.clipOrig = this.followOrig = this.quietOrig = null; this.refreshTicks = 0;
  }

  // The process handle died; its code caves are gone, so only forget their
  // addresses. Never write a former game's values into a later process.
  abandon() {
    this.angleCave = this.lensCave = 0; this.angleOwned = this.lensOwned = false;
    this.angleSites = this.lensSites = []; this.lensOperand = null;
    this.clipOrig = this.followOrig = this.quietOrig = null; this.refreshTicks = 0;
  }
}

module.exports = { CameraEffects };
