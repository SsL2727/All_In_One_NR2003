// What the broadcast graphics show, decided from the director's state: driver tag, battle box and the on-board dash.
// Pure: (director state, field, settings, memory of what was shown) -> { tag, battle, dash }. tvoverlay.html draws it.
'use strict';

const MPH = 2.23694;
const TAG_SHOW_S = 8;

class Overlays {
  constructor() { this.reset(); }
  reset() {
    this.tagAt = -1e9; this.tagSlot = -1; this.tagUntil = 0; this.lastSlot = -1; this.restartAt = null; this.prevGreen = null; this.startLap = 0;
    this.base = null; this.baseGame = false; this.baseSince = ''; this.baseLap = 0; this.starts = 0; this.gPrev = null; this.gainSlot = -1; this.gainUntil = 0; this.gainShown = new Map();
  }

  // a car's position for places gained: the game's own scoring when the bridge gives it (f.gamePos, by car number), else the director's order
  _posOf(f, c) {
    if (!f.gamePos) return this.base && this.baseGame ? null : c.pos;   // counting from the game's order: no guess while the bridge is quiet
    const p = f.gamePos.get(String(c.num));
    return p === undefined ? null : p;
  }

  // places made up since the start or the last restart: every car's position is noted when the field goes green
  _track(f) {
    if (!f || !f.order || !f.order.length) return;
    if (this.base && !this.baseGame && f.gamePos) this.base = null;            // the game's order came: count from it at the next green
    if (f.green && (this.gPrev === false || this.base === null)) {
      this.baseGame = !!f.gamePos;
      this.base = new Map(f.order.map(c => [c.slot, this._posOf(f, c)]).filter(([, p]) => p != null));
      this.baseLap = f.order[0].laps;
      this.baseSince = this.starts === 0 && f.order[0].laps <= 2 ? 'start' : 'restart';
      this.starts++;
      this.gainShown.clear();
    }
    this.gPrev = !!f.green;
  }

  // { places (+ = gained), from, to, since } for a car, or null when it was not in the field at the green
  gainOf(car, f) {
    if (!this.base || !this.base.has(car.slot)) return null;
    const from = this.base.get(car.slot), to = f ? this._posOf(f, car) : car.pos;
    if (to == null) return null;
    return { places: from - to, from, to, since: this.baseSince };
  }

  // d: Director.state() with cur; f: ranked field; S: resolved settings; cam: camera showing; t: seconds
  compute(d, f, S, cam, t) {
    const out = { on: false, tag: null, battle: null, dash: null, gain: null, style: S.overlay_style, accent: S.dash_accent, accent2: S.dash_accent2, speedMax: S.dash_speed_max };
    this._track(f);
    if (!S.overlays || !f || !f.order.length || !d.cur) return out;
    const car = f.order.find(c => c.slot === d.cur.slot);
    if (!car) return out;
    out.on = true;
    if (this.prevGreen === false && f.green) { this.restartAt = t; this.startLap = f.order[0].laps; }
    if (!f.green) this.restartAt = null;
    this.prevGreen = f.green;
    const runLaps = this.restartAt === null ? (f.green ? 99 : 0) : f.order[0].laps - this.startLap;
    const quiet = !f.green || runLaps < S.overlay_min_run_laps;
    const onboard = S.onboard_cams.has(cam);
    const ahead = car.pos > 1 ? f.order[car.pos - 2] : null;
    const info = { slot: car.slot, num: car.num, name: car.name, last: car.last, pos: car.pos, laps: car.laps, mph: Math.round(car.speed * MPH), rpm: Math.round(car.rpm || 0), gap: car.pos > 1 ? +car.gapAheadS.toFixed(1) : 0, ahead: ahead ? ahead.num : 0, pit: car.pit };
    const g = this.gainOf(car, f);
    if (g) info.gain = g;
    // places made up since the start / restart: when a car that has made up enough comes on TV, for a few seconds (not again for the same car for a while)
    if (S.gain && g && f.green && f.order[0].laps - this.baseLap >= S.gain_min_laps) {
      const worth = g.places >= S.gain_min || (S.gain_lost && g.places <= -S.gain_min);
      if (car.slot !== this.gainSlot) {
        this.gainSlot = car.slot;
        if (worth && t - (this.gainShown.get(car.slot) === undefined ? -1e9 : this.gainShown.get(car.slot)) >= S.gain_every) { this.gainShown.set(car.slot, t); this.gainUntil = t + S.gain_show; }
        else this.gainUntil = 0;
      }
      if (t < this.gainUntil && car.slot === this.gainSlot && worth) out.gain = Object.assign({}, info, g);
    }
    // the dash / on-board speed shows on every on-board shot
    if (onboard) out.dash = info;
    // the tag: when a new car comes on TV, at most once per overlay_gap seconds, not while the field is settling
    if (car.slot !== this.lastSlot) {
      this.lastSlot = car.slot;
      const battle = d.cur.kind === 'battle';
      if ((!quiet || (battle && onboard)) && t - this.tagAt >= S.overlay_gap) { this.tagAt = t; this.tagSlot = car.slot; this.tagUntil = t + TAG_SHOW_S; }
    }
    if (t < this.tagUntil && this.tagSlot === car.slot && !onboard) {
      const story = S.tag_story ? this._story(car, f, ahead, Math.floor((t - this.tagAt) / Math.max(1, S.tag_rotate))) : '';
      out.tag = Object.assign({ story }, info);
    }
    if (d.cur.kind === 'battle' && d.cur.other !== undefined) {
      const other = f.order.find(c => c.slot === d.cur.other);
      if (other && !quiet) {
        const [a, b] = car.pos < other.pos ? [car, other] : [other, car];
        out.battle = { a: { num: a.num, last: a.last, pos: a.pos }, b: { num: b.num, last: b.last, pos: b.pos }, gap: +b.gapAheadS.toFixed(2) };
        const riv = this.rivalOf ? this.rivalOf(a.num, b.num) : null;
        if (riv) out.battle.rival = rivalLabel(riv);
        else { const al = this.allyOf ? this.allyOf(a.num, b.num) : null; if (al) out.battle.rival = al.team ? 'TEAMMATES' : 'ALLIES'; }   // RaceLab's trusted allies
      }
    }
    return out;
  }

  _story(car, f, ahead, n) {
    const lines = [];
    lines.push(car.pos === 1 ? 'Leading the race' : `${car.gapAheadS.toFixed(1)} s behind #${ahead ? ahead.num : ''}`);
    // a rivalry with a car on track: the season's (or this race's) feud / grudge
    const rivals = this.rivalsOf ? this.rivalsOf(car.num) : [];
    const onTrack = new Set(f.order.map(c => String(c.num)));
    const r = rivals.find(x => onTrack.has(String(x.other)));
    if (r) lines.push(r.level >= 2 ? `Feud with #${r.other} (level ${r.level})` : r.holder != null && String(r.holder) === String(car.num) ? `Holds a grudge against #${r.other}` : r.holder != null ? `#${r.other} holds a grudge against him` : `Rivals with #${r.other}`);
    else {     // no rivalry on track: a trusted RaceLab ally on track (main.js hands over trusted allies only)
      const al = (this.alliesOf ? this.alliesOf(car.num) : []).find(x => x.trusted && onTrack.has(String(x.other)));
      if (al) lines.push(al.team ? `Trusted teammate of #${al.other}` : `Trusted drafting ally of #${al.other}`);
    }
    lines.push(`Lap ${car.laps}`);
    return lines[n % lines.length];
  }
}

function rivalLabel(r) { return r.level >= 2 ? 'FEUD L' + r.level : r.holder != null ? 'GRUDGE' : 'RIVALS'; }

module.exports = { Overlays, MPH, rivalLabel };
