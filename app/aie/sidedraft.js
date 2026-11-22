// AI Enhanced "Side Drafting" (FUN_00442b20). For every car it looks at the cars next to and behind it and returns three grip/power
// factors (f0 engine, f1 / f2 chassis); the caller multiplies the car's three driver-stat bytes by them.
//
//   dl = dlong[i] - dlong[j]   (>= 0: j is behind i)        dt = dlat[i] - dlat[j]
//   a car j counts when 0 <= dl <= lonWinBak and |dt| <= latWin; dt > 0 and dt < 0 are the two sides
//   a car close behind (0 < dl <= rearLonWin, |dt| <= latWinBak) means the car is being drafted from behind
'use strict';

const NCARS = 44;

// o: { lonWinBak, latWin, latWinBak, rearLonWin, engRight, engLeft, chsRight, chsLeft, chsBehind, playerEngScale, slideAmount }
function sideDraft(dlong, dlat, o) {
  const out = [];
  for (let i = 0; i < NCARS; i++) {
    let behind = false;
    let minLatR = 999, minLatL = 999, maxLonR = -1, maxLonL = -1;
    for (let j = 0; j < NCARS; j++) {
      if (j === i) continue;
      const dl = dlong[i] - dlong[j], dt = dlat[i] - dlat[j], adt = Math.abs(dt);
      if (dl >= 0 && dl <= o.lonWinBak && adt <= o.latWin) {
        if (dt >= 0) { if (dt > 0) { if (dl > maxLonR) maxLonR = dl; if (adt < minLatR) minLatR = adt; } }
        else { if (dl > maxLonL) maxLonL = dl; if (adt < minLatL) minLatL = adt; }
      }
      if (dl > 0 && dl <= o.rearLonWin && adt <= o.latWinBak) behind = true;
    }
    const fR = maxLonR < 0 ? 0 : maxLonR / o.lonWinBak;
    const fL = maxLonL < 0 ? 0 : maxLonL / o.lonWinBak;
    const slide = o.slideAmount;
    let f0 = 1, f1, f2 = 1, near = 1, haveNear = false;
    const nearOf = (m) => (m < 3 ? (m > 2 ? m - 2 : 0) : 1);
    if (maxLonR < 0) {
      f1 = 1;
      if (behind) { f1 = o.chsBehind; if (slide <= 1) f2 = (1 - o.chsBehind) * slide + o.chsBehind; }
      else if (maxLonL >= 0) { f0 = (o.engLeft - 1) * fL + 1; f1 = o.chsLeft; near = nearOf(minLatL); haveNear = true; }
    } else {
      f0 = (o.engRight - 1) * fR + 1; f1 = o.chsRight; near = nearOf(minLatR); haveNear = true;
    }
    if (haveNear) f2 = slide > 1 ? 1 - (1 - near) / slide : (near - f1) * slide + f1;
    if (i === NCARS - 1) f0 = (f0 - 1) * o.playerEngScale + 1;
    out.push({ f0, f1, f2 });
  }
  return out;
}

module.exports = { sideDraft };
