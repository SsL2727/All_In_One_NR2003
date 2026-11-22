// Read NR2003's three TV-camera tables and estimate when a car crosses their
// takeover points. The reader is keyed by lap length because the tables are
// rebuilt when a track is loaded.
'use strict';

const TABLE = 0xC548A0, GROUP_STRIDE = 0xE44, REC = 0x39, TRACK_LENGTH = 0xDACF0C;
const wrap = (x, len) => ((x % len) + len) % len;

class TvCameras {
  constructor(mem) { this.mem = mem; this.len = 0; this.groups = [[], [], []]; }
  read(trackLen) {
    if (!(trackLen > 100) || (this.len && Math.abs(trackLen - this.len) <= 0.5 && this.groups.some(g => g.length))) return this.groups;
    this.len = trackLen; this.groups = [[], [], []];
    for (let g = 0; g < 3; g++) {
      const head = this.mem.readBytes(TABLE + g * GROUP_STRIDE, 4);
      if (!head) continue;
      const count = head.readUInt32LE(0);
      if (count > 64) continue;
      for (let i = 0; i < count; i++) {
        const b = this.mem.readBytes(TABLE + g * GROUP_STRIDE + 4 + i * REC, REC);
        if (!b) break;
        const d = b.readFloatLE(0), lat = b.readFloatLE(4), h = b.readFloatLE(8), ofs = b.readFloatLE(12);
        if (![d, lat, h, ofs].every(Number.isFinite)) continue;
        this.groups[g].push({ n: i + 1, d, lat, h, ofs, start: wrap(d + ofs, trackLen), fixed: b[0x38] === 1 });
      }
      this.groups[g].sort((a, b) => a.start - b.start);
    }
    return this.groups;
  }
  timing(car, group, trackLen) {
    if (!car || !Number.isFinite(car.ldist) || group < 0 || group > 2) return null;
    const cams = this.read(trackLen)[group];
    if (!cams || !cams.length) return null;
    const at = wrap(car.ldist, trackLen), speed = Math.max(10, car.speed || 0);
    let prev = cams[cams.length - 1], next = cams[0];
    for (let i = 0; i < cams.length; i++) {
      if (cams[i].start <= at) prev = cams[i];
      if (cams[i].start > at) { next = cams[i]; break; }
    }
    let sinceM = wrap(at - prev.start, trackLen), nextM = wrap(next.start - at, trackLen);
    if (cams.length === 1) nextM = trackLen;
    return { group, n: prev.n, since_s: sinceM / speed, next_n: next.n, next_s: nextM / speed };
  }
}

module.exports = { TvCameras, TABLE, GROUP_STRIDE, REC, TRACK_LENGTH, wrap };
