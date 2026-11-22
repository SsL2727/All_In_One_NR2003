// AI Enhanced "Tandem Drafting" (FUN_00442e00): cars that line up nose to tail get an engine boost, cars with a gap behind a pair are
// slowed, and every 40 ticks the three cars at the front of the lead lap are looked at: when the first two are well clear of the third
// they lift for 1600 ticks so the pack can catch up. Only the engine byte factor (f0) is changed.
//
// o: { ablonThr, bclonThr, latThr, boostMult, slowMult, adBehindMin, adBehindMax, congestionLon, congestionN }
'use strict';

const NCARS = 44;

class Tandem {
  constructor() { this.state = { tick: 0, laps: new Array(43).fill(0), maxLaps: 0, dl: new Array(44).fill(0), top: [-1, -1, -1], lift: 0 }; }
  reset() { this.state = { tick: 0, laps: new Array(43).fill(0), maxLaps: 0, dl: new Array(44).fill(0), top: [-1, -1, -1], lift: 0 }; }

  // dlong[44], dlat[44], laps[43+] (lap counts), trackLen -> f0 factor per car (44)
  step(dlong, dlat, laps, trackLen, o) {
    const wrap = (x) => {
      if (trackLen > 0) { if (trackLen * 0.5 < x) x -= trackLen; if (x < -trackLen * 0.5) x += trackLen; }
      return x;
    };
    const f0 = new Array(NCARS).fill(1);
    for (let i = 0; i < NCARS; i++) {
      let pair = false, slow = false;
      const flagSlow = () => { slow = i !== NCARS - 1; };
      // a car j ahead of i (within ablonThr and latThr) ...
      let j = 0;
      for (; j < NCARS; j++) {
        if (j === i) continue;
        const d = wrap(dlong[j] - dlong[i]);
        if (d > 0 && d <= o.ablonThr && Math.abs(dlat[j] - dlat[i]) <= o.latThr) break;
      }
      let decided = false;
      if (j < NCARS) {
        // ... that itself has a car ahead (within bclonThr): then i is slowed outright; with nobody ahead of j, i trails a pair
        let ahead = false;
        for (let k = 0; k < NCARS; k++) {
          if (k === i || k === j) continue;
          const d = wrap(dlong[k] - dlong[j]);
          if (d > 0 && d <= o.bclonThr && Math.abs(dlat[k] - dlat[j]) <= o.latThr) { ahead = true; break; }
        }
        if (ahead) { flagSlow(); decided = true; } else pair = true;
      }
      if (!decided) {
        let viaBehind = true;
        if ((i & 1) === 0) {                                     // even cars also look for congestion ahead
          let n = 0;
          for (let k = 0; k < NCARS; k++) {
            if (k === i) continue;
            const d = wrap(dlong[k] - dlong[i]);
            if (d > 0 && d <= o.congestionLon && Math.abs(dlat[k] - dlat[i]) <= o.latThr) n++;
          }
          if (n >= o.congestionN) { pair = false; flagSlow(); viaBehind = false; }
        }
        if (viaBehind && !pair) {                                // a car close behind (adBehindMin..adBehindMax)
          for (let k = 0; k < NCARS; k++) {
            if (k === i) continue;
            const d = wrap(dlong[i] - dlong[k]);
            if (o.adBehindMin < d && d <= o.adBehindMax && Math.abs(dlat[i] - dlat[k]) <= o.latThr) { flagSlow(); break; }
          }
        }
      }
      f0[i] = pair ? o.boostMult : (slow ? o.slowMult : 1);
    }
    this._lead(dlong, laps, f0);
    return f0;
  }

  // every 40 ticks: the three cars in front on the lead lap; if the first two are far ahead of the third, they lift for 1600 ticks
  _lead(dlong, laps, f0) {
    const S = this.state;
    if (S.tick === 0) {
      S.maxLaps = 0;
      for (let i = 0; i < 43; i++) { S.laps[i] = laps[i] >>> 0; if (S.laps[i] > S.maxLaps) S.maxLaps = S.laps[i]; }
      for (let i = 0; i < NCARS; i++) S.dl[i] = dlong[i];
      S.top = [-1, -1, -1];
      for (let i = 0; i < 44; i++) {
        if (i >= 43 || S.laps[i] !== S.maxLaps) continue;
        let p = 0;
        while (p < 3 && S.top[p] !== -1 && (S.dl[i] < S.dl[S.top[p]] || S.dl[i] === S.dl[S.top[p]])) p++;
        if (p >= 3) continue;
        for (let q = 2; q > p; q--) S.top[q] = S.top[q - 1];
        S.top[p] = i;
      }
    }
    S.tick = (S.tick + 1) % 40;
    const [a, b, c] = S.top;
    if (a > -1 && b > -1 && c > -1 && 80 < S.dl[a] - S.dl[c] && 70 < S.dl[b] - S.dl[c]) S.lift = 1600;
    if (S.lift > 0) {
      if (a > -1 && a !== 43) f0[a] *= 0.6;
      if (b > -1 && b !== 43) f0[b] *= 0.6;
      S.lift--;
    }
  }
}

module.exports = { Tandem };
