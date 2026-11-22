// The TV director: from a ranked field snapshot it decides which car is on TV and which camera shows it.
//
// Shots: incident (a car's speed collapses), pass, battle (cars within battle_gap seconds for battle_min_age seconds; on short tracks
// battle_short_m metres), pit (entry / stall / exit on their own cameras), restart (leaders after a green flag), leader, tour (rotating
// through the first tour_depth cars when nothing happens) and qual (a lone car running in practice). Each shot opens on a camera from its
// cam_<shot> list and after follow_after seconds moves on to cam_<shot>_follow, changing every camera_every seconds. A shot holds at least
// min_hold seconds and at most max_hold; a better shot (score x switch_margin) may interrupt. Only cameras the user allowed are used.
'use strict';

const SCORE = { incident: 100, qual: 80, pass: 70, restart: 60, battle: 50, pit: 40, leader: 20, tour: 10 };

class Director {
  // S: resolved settings (settings.resolve), opts: { rnd, favourites: () => [numbers] }
  constructor(S, opts = {}) {
    this.S = S; this.rnd = opts.rnd || Math.random; this.opts = opts;
    this.reset();
  }

  setSettings(S) { this.S = S; }

  reset() {
    this.hist = new Map();             // slot -> [{ t, v }]
    this.lastOrder = new Map();        // slot -> pos
    this.battles = new Map();          // "a-b" -> first seen t
    this.events = [];                  // recent { kind, slot, t }
    this.cur = null;                   // { kind, slot, since, camSince, cam, camIdx }
    this.lastSeen = new Map();         // slot -> t it was last on TV
    this.manualUntil = 0; this.paused = false;
    this.greenSince = null; this.restartAt = null; this.prevGreen = null; this.raceLaps = 0; this.tourIdx = 0;
    this.crashAt = new Map(); this.pitPhase = new Map(); this.now = 0; this.applied = { cam: -1, slot: -1 };
  }

  pause(on) { this.paused = !!on; }
  auto() { this.manualUntil = 0; }
  // the user picked a car / camera: leave it alone for manual_hold seconds
  manual(slot, cam, now) {
    this.manualUntil = now + this.S.manual_hold;
    const prev = this.cur;
    this.cur = { kind: 'manual', slot: slot ?? (prev && prev.slot), since: now, camSince: now, cam: cam || (prev && prev.cam) || -1, camIdx: 0, score: 1e9 };
    return { cam: this.cur.cam, slot: this.cur.slot, why: 'manual' };
  }

  // ── detection ──────────────────────────────────────────────────────────────────────────────────
  _detect(f) {
    const S = this.S, t = f.t, cars = f.order;
    // speeds history, crashes
    for (const c of cars) {
      let h = this.hist.get(c.slot); if (!h) this.hist.set(c.slot, h = []);
      h.push({ t, v: c.speed });
      while (h.length && t - h[0].t > S.crash_window + 0.01) h.shift();
      const peak = Math.max(...h.map(x => x.v));
      if (peak - c.speed >= S.crash_drop && peak > 15 && (this.crashAt.get(c.slot) || -99) < t - 20 && !c.pit) {
        this.crashAt.set(c.slot, t); this.events.push({ kind: 'incident', slot: c.slot, t });
      }
    }
    // passes (not through the pits, not on the line where progress can jump)
    const pos = new Map(cars.map(c => [c.slot, c.pos]));
    for (const c of cars) {
      const was = this.lastOrder.get(c.slot);
      if (was && c.pos < was && !c.pit && f.green) {
        const victim = cars.find(x => this.lastOrder.get(x.slot) === c.pos && x.slot !== c.slot);
        if (victim && !victim.pit && victim.gapAhead < 61 && Math.abs(c.dlong - victim.dlong) < 80) this.events.push({ kind: 'pass', slot: c.slot, victim: victim.slot, t, pos: c.pos });
      }
    }
    this.lastOrder = pos;
    // battles
    const seen = new Set();
    const short = f.trackLen < S.short_track_m;
    for (const c of cars) {
      const a = cars[c.pos - 2];
      if (!a || c.pit || a.pit) continue;
      const close = short ? (c.gapAhead <= S.battle_short_m) : (c.gapAheadS <= S.battle_gap && c.gapAhead < 120);
      if (!close) continue;
      const k = a.slot + '-' + c.slot; seen.add(k);
      if (!this.battles.has(k)) this.battles.set(k, t);
    }
    for (const k of [...this.battles.keys()]) if (!seen.has(k)) this.battles.delete(k);
    this.events = this.events.filter(e => t - e.t < 30);
    // start / restart
    if (this.prevGreen === false && f.green) { this.restartAt = t; this.restartLap = (cars[0] && cars[0].laps) || 0; }
    if (f.green === false) this.restartAt = null;
    this.prevGreen = f.green;
  }

  _settle(f) {
    if (this.restartAt === null) return false;
    const lead = f.order[0];
    return lead && lead.laps - this.restartLap < this.S.settle_laps;
  }

  _isLeadBattle(a, b, f) {
    const S = this.S;
    if (!(S.lead_battle_depth > 0) || a === undefined || b === undefined) return false;
    const ca = f.order.find(c => c.slot === a), cb = f.order.find(c => c.slot === b);
    if (!ca || !cb || ca.pit || cb.pit || Math.min(ca.pos, cb.pos) > S.lead_battle_depth || !(f.trackLen > 0)) return false;
    const lead = f.order[0], progress = c => c.laps + c.dlong / f.trackLen, leadProgress = progress(lead);
    let pack = 0;
    for (const c of f.order) {
      if (c.pit || Math.abs(progress(c) - leadProgress) >= 0.5) continue;
      if (Math.max(0, lead.progress - c.progress) / Math.max(10, c.speed) < 1.5) pack++;
    }
    return pack < Math.max(1, S.lead_battle_pack);
  }

  // ── candidates ─────────────────────────────────────────────────────────────────────────────────
  _candidates(f) {
    const S = this.S, t = f.t, out = [], order = f.order, settle = this._settle(f);
    const byslot = new Map(order.map(c => [c.slot, c]));
    for (const e of this.events) {
      const c = byslot.get(e.slot); if (!c) continue;
      if (e.kind === 'incident' && t - e.t < S.incident_hold) out.push({ kind: 'incident', slot: e.slot, score: SCORE.incident, hold: S.incident_hold });
      if (e.kind === 'pass' && t - e.t < 6 && (!settle || c.pos <= S.settle_positions)) out.push({ kind: 'pass', slot: e.slot, other: e.victim, score: SCORE.pass - c.pos * 0.5, hold: 6 });
    }
    for (const [k, since] of this.battles) {
      if (t - since < S.battle_min_age) continue;
      const [a, b] = k.split('-').map(Number), cb = byslot.get(b), ca = byslot.get(a);
      if (!cb || !ca) continue;
      if (settle && cb.pos > S.settle_positions) continue;
      const p = Math.min(ca.pos, cb.pos);
      const age = t - since;
      const leadFight = age < S.lead_battle_hold && this._isLeadBattle(a, b, f);
      // rivals (AIMOD's racing intensity & rivals / the season's rivalries): a battle between them is worth more and stays worth watching
      const riv = this.opts.rivalOf ? this.opts.rivalOf(ca.num, cb.num) : null;
      const boost = riv ? (Number(S.rival_boost) >= 0 ? Number(S.rival_boost) : 1) : 0;
      const fade = leadFight || (riv && boost > 0) ? 1 : (age <= 60 ? 1 : Math.max(0.4, 1 - (age - 60) / 90));
      out.push({ kind: 'battle', slot: a, score: (SCORE.battle + Math.max(0, 20 - p) * 0.8 - cb.gapAheadS * 5) * fade + (riv ? boost * (6 + 6 * Math.max(1, riv.level || 1)) : 0), other: b, hold: S.min_hold, rival: riv || undefined });
    }
    // a pit stop of someone in the first tour_depth
    for (const c of order) {
      if (!c.pit || c.pos > Math.max(S.tour_depth, 1)) continue;
      out.push({ kind: 'pit', slot: c.slot, score: SCORE.pit - c.pos * 0.5, hold: 6 });
    }
    // restart / start: the front of the field
    if (settle && order[0]) out.push({ kind: 'restart', slot: order[0].slot, score: SCORE.restart, hold: S.settle_hold });
    // a lone car on track in practice
    const running = order.filter(c => !c.pit && c.speed > 5);
    if (f.session !== 7 && running.length === 1) out.push({ kind: 'qual', slot: running[0].slot, score: SCORE.qual, hold: S.min_hold });
    // quiet: leader, then a tour of the front
    if (order[0]) {
      const lead = order[0];
      const quiet = (this.lastSeen.get(lead.slot) ?? -999) < t - S.revisit_after;
      out.push({ kind: 'leader', slot: lead.slot, score: SCORE.leader + (quiet ? 5 : 0), hold: S.min_hold });
      const fav = (this.opts.favourites && this.opts.favourites()) || [];
      const depth = Math.min(order.length, Math.max(1, S.tour_depth));
      const stale = order.slice(0, depth).filter(c => (this.lastSeen.get(c.slot) ?? -999) < t - S.revisit_after);
      const pickFrom = fav.length ? order.filter(c => fav.includes(c.num)) : [];
      const target = pickFrom.length ? pickFrom[this.tourIdx % pickFrom.length] : (stale.length ? stale[0] : order[this.tourIdx % depth]);
      if (target) out.push({ kind: 'tour', slot: target.slot, score: SCORE.tour + (fav.includes(target.num) ? 8 : 0), hold: S.min_hold });
    }
    return out;
  }

  // ── cameras ──────────────────────────────────────────────────────────────────────────────────
  _pickCam(list, idx) { return list.length ? list[idx % list.length] : -1; }

  _shotCams(kind, car, f) {
    const S = this.S;
    if (kind === 'pit' && car) {
      const phase = this.pitPhase.get(car.slot) || 'in';
      if (car.pit && car.speed < 2) { this.pitPhase.set(car.slot, 'stall'); return { open: S.cam_pit_stall, follow: S.cam_pit_follow }; }
      if (car.pit && phase === 'stall') { this.pitPhase.set(car.slot, 'out'); return { open: S.cam_pit_exit, follow: S.cam_pit_follow }; }
      return { open: S.cam_pit, follow: S.cam_pit_follow };
    }
    if (kind === 'qual' && car) return car.pit ? { open: S.cam_qual_exit, follow: S.cam_qual_follow } : { open: S.cam_qual, follow: S.cam_qual_follow };
    return { open: S['cam_' + kind] || [], follow: S['cam_' + kind + '_follow'] || [] };
  }

  // ── the decision ───────────────────────────────────────────────────────────────────────────────
  // f: ranked field. -> { cam, slot, why } when the TV should change, else null
  update(f) {
    const S = this.S, t = f.t; this.now = t;
    this._detect(f);
    if (this.paused || t < this.manualUntil || !f.order.length) return null;
    const cands = this._candidates(f);
    const bySlot = new Map(f.order.map(c => [c.slot, c]));
    let cur = this.cur;
    if (cur && cur.kind !== 'manual' && !bySlot.has(cur.slot)) cur = this.cur = null;
    if (cur && cur.kind === 'manual') cur = this.cur = null;     // manual hold over: back to the director
    const best = cands.sort((a, b) => b.score - a.score)[0];
    let change = false;
    if (!cur) change = !!best;
    else if (best) {
      const age = t - cur.since;
      const curStill = cands.find(c => c.kind === cur.kind && c.slot === cur.slot);
      const curScore = curStill ? curStill.score : 0;
      const isSame = best.kind === cur.kind && best.slot === cur.slot;
      const leadHold = (cur.kind === 'battle' || cur.kind === 'pass') && this._isLeadBattle(cur.slot, cur.other, f);
      const holdLimit = leadHold ? Math.max(S.max_hold, S.lead_battle_hold) : S.max_hold;
      if (!isSame) {
        if (best.kind === 'incident' && cur.kind !== 'incident') change = true;
        else if (leadHold && age < holdLimit) {
          if ((best.kind === 'restart' && cur.kind !== 'restart') || best.score > curScore * S.switch_margin) change = true;
        } else if (age >= Math.max(cur.hold || 0, Math.min(S.min_hold, cur.kind === 'pit' || cur.kind === 'pass' ? cur.hold : S.min_hold)) && (best.score > curScore * S.switch_margin || age >= holdLimit || !curStill)) change = true;
        else if (age >= holdLimit) change = true;
      } else if (age >= holdLimit) {
        // the same shot has run long enough: move on to the next best different one
        const other = cands.find(c => !(c.kind === cur.kind && c.slot === cur.slot));
        if (other) { cands.unshift(other); change = true; }
      }
    }
    if (change) {
      const pick = cur && cands[0] && cands[0].kind === cur.kind && cands[0].slot === cur.slot ? cands[1] || cands[0] : cands[0];
      const car = bySlot.get(pick.slot);
      const cams = this._shotCams(pick.kind, car, f);
      this.cur = { kind: pick.kind, slot: pick.slot, since: t, camSince: t, cam: this._pickCam(cams.open, Math.floor(this.rnd() * 7)), camIdx: 0, hold: pick.hold, score: pick.score, other: pick.other, cams };
      this.lastSeen.set(pick.slot, t);
      if (pick.kind === 'tour') this.tourIdx++;
      return this._act(f, pick.kind);
    }
    return this._followUp(f);
  }

  // follow cameras: after follow_after seconds, then every camera_every seconds, never cutting away from an on-board shot early
  _followUp(f) {
    const cur = this.cur, S = this.S, t = f.t;
    if (!cur || cur.kind === 'manual') return null;
    const car = f.order.find(c => c.slot === cur.slot);
    const cams = this._shotCams(cur.kind, car, f); cur.cams = cams;
    const camAge = t - cur.camSince, shotAge = t - cur.since;
    const onboard = S.onboard_cams.has(cur.cam);
    if (onboard && camAge < S.onboard_hold) return null;
    const wait = cur.camIdx === 0 ? S.follow_after : S.camera_every;
    if (camAge >= wait && cams.follow.length && shotAge >= S.follow_after) {
      const cam = this._pickCam(cams.follow, cur.camIdx + (cur.camIdx === 0 ? 0 : 0));
      cur.camIdx++; cur.camSince = t;
      const next = this._pickCam(cams.follow, cur.camIdx - 1);
      if (next !== cur.cam) { cur.cam = next; return this._act(f, cur.kind + ' (follow)'); }
    }
    if (cur.kind === 'pit' && car) {                              // the stall / exit cameras follow the car through pit road
      const open = this._shotCams('pit', car, f).open;
      const c = this._pickCam(open, 0);
      if (c !== -1 && !cams.follow.includes(cur.cam) && c !== cur.cam) { cur.cam = c; cur.camSince = t; return this._act(f, 'pit'); }
    }
    return null;
  }

  _act(f, why) {
    const cur = this.cur;
    const a = { cam: cur.cam, slot: cur.slot, why, kind: cur.kind };
    if (a.cam === -1) a.cam = this.applied.cam > 0 ? this.applied.cam : -1;       // an empty list keeps the camera that is showing
    if (a.cam === this.applied.cam && a.slot === this.applied.slot) return null;
    this.applied = { cam: a.cam, slot: a.slot };
    return a;
  }

  state() { return { cur: this.cur ? { kind: this.cur.kind, slot: this.cur.slot, cam: this.cur.cam, since: this.cur.since, other: this.cur.other } : null, paused: this.paused, manual: this.now < this.manualUntil, events: this.events.slice(-8), battles: [...this.battles.keys()] }; }
}

module.exports = { Director, SCORE };
