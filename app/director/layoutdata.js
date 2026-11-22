// The data the overlay layouts draw (director/layoutdraw.js): one snapshot of the race per overlay update, plus what RaceVision 2.0
// keeps per car over a race (laps led, pit stops, place at the green, lap times, the brake estimate) - tv_director.cpp's Car fields.
'use strict';

const MPH = 2.23694;

class CarStats {
  constructor() { this.reset(); }
  reset() { this.cars = new Map(); this.started = false; this.leader = -1; this.lastFlag = null; this.track = ''; }
  _c(slot) {
    let c = this.cars.get(slot);
    if (!c) { c = { lapsLed: 0, ledLap: -1, pits: 0, wasPit: false, startPos: 0, lastLaps: -1, lapAt: NaN, lapLastMs: 0, lapBestMs: 0, brk: 0, hist: [] }; this.cars.set(slot, c); }
    return c;
  }
  // f: the ranked field (order with .pos), t: game seconds
  update(f, t) {
    if (!f || !f.order) return;
    if (f.track && f.track !== this.track) { this.reset(); this.track = f.track; }
    const lead = f.order[0];
    if (lead && lead.laps < 1 && this.started && !f.green) this.reset(), this.track = f.track || '';     // a new race on the same track
    // the place each car had at the first green flag (RaceVision: official position at the green)
    if (f.green && !this.started && f.order.length) { this.started = true; for (const c of f.order) this._c(c.slot).startPos = c.pos; }
    for (const car of f.order) {
      const c = this._c(car.slot);
      if (car.pit && !c.wasPit && this.started) c.pits++;
      c.wasPit = !!car.pit;
      if (lead && car.slot === lead.slot && car.laps > c.ledLap && car.laps > 0) { if (c.ledLap >= 0) c.lapsLed++; c.ledLap = car.laps; }
      // lap times: the game clock between two line crossings (laps count moving on)
      if (c.lastLaps >= 0 && car.laps === c.lastLaps + 1 && Number.isFinite(c.lapAt)) {
        const ms = Math.round((t - c.lapAt) * 1000);
        if (ms > 5000 && ms < 400000) { c.lapLastMs = ms; if (!c.lapBestMs || ms < c.lapBestMs) c.lapBestMs = ms; }
      }
      if (car.laps !== c.lastLaps) { c.lastLaps = car.laps; c.lapAt = t; }
      // the brake, as RaceControl's telemetry strip works it out: the real pedal when the slot has it, else how hard the car slows with
      // the throttle off, less what it would lose coasting
      const mph = (car.speed || 0) * MPH, q = c.hist;
      if (q.length && t < q[q.length - 1][0]) q.length = 0;
      if (!q.length || t > q[q.length - 1][0]) q.push([t, mph]);
      while (q.length > 2 && t - q[0][0] > 0.6) q.shift();
      if (Number.isFinite(car.brkRaw) && car.brkRaw > 0.01) c.brk = Math.min(1, car.brkRaw);
      else if ((car.thr || 0) > 0.05) c.brk = 0;
      else {
        let from = q[0];
        for (const p of q) { if (t - p[0] >= 0.25) from = p; else break; }
        const dt = q[q.length - 1][0] - from[0];
        if (dt >= 0.1) {
          const decel = (from[1] - q[q.length - 1][1]) / dt, v = (from[1] + q[q.length - 1][1]) / 2, coast = 1.5 + 6 * (v / 200) * (v / 200);
          const b = mph < 2 ? 0 : Math.min(1, Math.max(0, (decel - coast) / 35));
          c.brk = c.brk * 0.4 + b * 0.6;
        }
      }
    }
  }
  get(slot) { return this.cars.get(slot) || null; }
}

// the snapshot layoutdraw.js reads. f: ranked field; ov: All In One NR2003's overlay decision (tag / battle / dash...); d: director state (cur);
// R: resolved settings; extra: { stats: CarStats, rc (Race Control feed or null), art(num) -> { number, head, color }, picUrl(file),
// replay (bool), lapsTotal, session ('race'|...), headshotZoom }
function snapshot(f, ov, d, R, extra) {
  const x = extra || {};
  const cars = {}, colors = {}, art = {};
  const order = [];
  if (f && f.order) {
    for (const car of f.order) {
      const st = x.stats ? x.stats.get(car.slot) : null;
      const a = x.art ? x.art(car.num) || {} : {};
      const nm = a.nameOv || null;
      cars[car.slot] = {
        number: car.num, first: (nm && nm.first) || car.first || '', last: (nm && nm.last) || car.last || car.name || '', pos: car.pos,
        speed: car.speed || 0, rpm: car.rpm || 0, gear: car.gear, thr: car.thr || 0, brk: st ? st.brk : 0, steer: car.steer || 0,
        laps: car.laps, lapsLed: st ? st.lapsLed : 0, pits: st ? st.pits : 0, startPos: st ? st.startPos : 0,
        lapLastMs: st ? st.lapLastMs : 0, lapBestMs: st ? st.lapBestMs : 0, progress: car.laps * (f.trackLen || 0) + (car.dlong || 0), pit: !!car.pit,
      };
      if (a.color) colors[car.num] = a.color;
      art[car.num] = { number: a.number || '', head: a.head || '' };
      order.push(car.slot);
    }
  }
  const cur = d && d.cur ? d.cur : null;
  const snap = {
    car: cur ? cur.slot : -1, other: cur && cur.other !== undefined ? cur.other : -1, cars, order, colors, art,
    race: { lap: f && f.order && f.order.length ? f.order[0].laps : 0, lapsTotal: x.lapsTotal || 0, flag: f ? f.flag : 0, session: x.session || '' },
    track: f ? f.track || '' : '', trackLen: f ? f.trackLen || 0 : 0, replay: !!x.replay, rc: x.rc || null, battleKind: cur ? cur.kind : '',
    dash: { accent: R ? R.dash_accent : '', accent2: R ? R.dash_accent2 : '', artColors: !!(R && Number(R.dash_art_colors)) }, headshotZoom: x.headshotZoom || 1.35,
    shotSub: x.replay ? 'REPLAY' : '', story: null, hi: 0, gap: 0, metres: 0,
  };
  // the battle box's two cars (top = the one ahead) and the gap
  if (cur && cur.other !== undefined && cars[cur.slot] && cars[cur.other]) {
    const a = f.order.find(c => c.slot === cur.slot), b = f.order.find(c => c.slot === cur.other);
    const [top, bottom] = a.pos < b.pos ? [a, b] : [b, a];
    snap.top = top.slot; snap.bottom = bottom.slot; snap.hi = Math.min(a.pos, b.pos);
    snap.gap = Math.abs(bottom.gapAheadS || 0); snap.metres = Math.abs(bottom.gapAhead || 0);
    if (!x.replay) snap.shotSub = `in battle with ${(cars[cur.slot === a.slot ? b.slot : a.slot] || {}).last || ''} for ${ordinalLow(snap.hi)}`;
  }
  // the tag's story line (All In One NR2003's own: gap / rivalry / lap), in RaceVision's form: a place plate and coloured parts
  if (ov && ov.tag && ov.tag.story) snap.story = { label: 'LAP ' + snap.race.lap, parts: [[String(ov.tag.story), '#aab0be']] };
  return snap;
}
const ordinalLow = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th');

module.exports = { CarStats, snapshot };
