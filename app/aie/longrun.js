// AI Enhanced "Long Run Spread" (inline in its tick): the longer a car has been running since it last stopped (pit stop), the more its two
// chassis stat bytes drift by a fixed random amount per car (each car's own number in -1..1, times maxChsChange), reaching the full
// amount after `fullMiles` miles. Changes f1 and f2.
'use strict';

const MILE = 1609.344;

class LongRun {
  // rnd: optional per-car numbers in -1..1 (43); otherwise drawn here like AI Enhanced does when it starts
  constructor(rnd) {
    this.rnd = rnd ? Array.from(rnd) : Array.from({ length: 43 }, () => Math.fround(Math.random() * 2 - 1));
    this.st = Array.from({ length: 43 }, () => ({ stopped: false, start: 0 }));
  }

  // laps[43] (laps completed), moving[43] (bool), trackLen (m), raceUnits (the game value AI Enhanced reads: full effect after
  // 100 / (raceUnits + 1) miles, never less than 0.1 mile), maxChsChange -> factor per car (f1 and f2 are both multiplied by it)
  step(laps, moving, trackLen, raceUnits, maxChsChange) {
    const full = Math.max(0.1, 100 / ((raceUnits & 0xff) + 1));
    const out = new Array(43).fill(1);
    for (let i = 0; i < 43; i++) {
      const s = this.st[i], stopped = !moving[i];
      if (s.stopped && !stopped) s.start = laps[i];
      s.stopped = stopped;
      const run = Math.max(0, laps[i] - s.start);
      const miles = trackLen > 0 ? (run * trackLen) / MILE : 0;
      out[i] = this.rnd[i] * maxChsChange * Math.min(1, miles / full) + 1;
    }
    return out;
  }
}

module.exports = { LongRun };
