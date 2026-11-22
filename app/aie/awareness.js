// AI Enhanced "Awareness": Brake for Wrecks Ahead (wrecks.js), Slow Cars Move (FUN_00440020), Mirror Drivin' (FUN_004422a0), Drafting
// Teamwork (FUN_00440340 / FUN_004407b0 / FUN_00440d00 / FUN_00441690) and Sandbagging (FUN_00442760). Ported from the decompile; not
// checked against the live program like the other modules.
//
// Slow cars and the leader are "nudged" by adding to field 2 of the race-line point 4 points (12 m) ahead of the car; the game puts its
// line back, so the nudge is worked out fresh every tick and returned as { point, delta }. Drafting Teamwork "lines up" a stretch of the
// race line by copying the bound line over it (returned as `blends`), and makes a few cars lay back for a moment (engine factor 0.7).
// AI Enhanced runs everything on a 25 ms tick: the counters and odds below are per such tick; step() runs as many as ctx.now says passed.
//
// opts: { slowCarsMoveOver, moveDirection, behindMin, behindMax, speedThreshold, minLapsAhead, slowCarsAheadClearance,
//         leaderBlocks, leaderBlocksMinGap, leaderBlocksMaxGap, leaderBlocksSpeedThreshold, leaderBlocksAheadClearance, leaderBlocksMode,
//         sandbagging, sandbaggingEngineMult, brakeForWrecks, draftingTeamwork }
// ctx: { trackLen, teams (TeamTable), now (ms), rnd, brakeScale (speed scale * 36) }
'use strict';
const { wreckCaps } = require('./wrecks');
const { NO_TEAMS } = require('./teams');

const NCARS = 44, PLAYER = 43, CELL = 3.0, TICK_MS = 25, MAX_TICKS = 8;

const DEFAULTS = {
  slowCarsMoveOver: true, moveDirection: 1, behindMin: 8, behindMax: 48, speedThreshold: 0.5, minLapsAhead: 1, slowCarsAheadClearance: 12,
  leaderBlocks: false, leaderBlocksMinGap: 5.5, leaderBlocksMaxGap: 18, leaderBlocksSpeedThreshold: 0.7, leaderBlocksAheadClearance: 15, leaderBlocksMode: 0,
  sandbagging: false, sandbaggingEngineMult: 0.7,
  brakeForWrecks: false, draftingTeamwork: false,
};
const KEYS = Object.keys(DEFAULTS);

// Drafting Teamwork's constants (read out of the exe)
const TW = {
  pickOdds: 9600, pickTicks: 2400,           // every tick 1 in 9600: a "betrayal window" of 60 s; 2/3 of them (mode 2) only teams line up, the rest (mode 1) nobody does
  attackOdds: 4800, attackTicks: 119, attackCooldown: 1200,   // every tick 1 in 4800 a car just behind the leader may get others to lay back for 3 s; 30 s pause
  layback: 0.7, followers: 30, assailMin: 5, assailMax: 10, assailSep: 5,
  packGap: 50, sideLon: 5, sideLat: 2, chain: 11, blend: 0.99, window: 1,
};

const randInt = (rnd, max) => Math.floor(rnd() * (max + 1));      // 0..max

// the leader: most laps, then furthest round the lap (FUN_00441ce0 over the 43 AI slots); the player (slot 43) leads when ahead of that car
function leaderOf(dl, laps) {
  let best = 0;
  for (let i = 1; i < 43; i++) if (laps[i] > laps[best] || (laps[i] === laps[best] && dl[i] > dl[best])) best = i;
  if (laps[best] < laps[PLAYER]) return PLAYER;
  if (laps[best] === laps[PLAYER]) return dl[PLAYER] <= dl[best] ? best : PLAYER;
  return best;
}

class Awareness {
  constructor() { this.reset(); }
  reset() {
    this.last = null; this.mode = 0; this.modeTicks = 0; this.attackTicks = 0; this.attackCool = 0; this.flags = new Uint8Array(43);
    this.braking = false; this.wrecks = 0; this.status = { mode: 0, modeTicks: 0, attackTicks: 0, attackCool: 0, wrecks: 0, chain: 0 };
  }

  // cars[i] = { dlong, dlat, speed, laps, moving } | null ; lines = { race, minrace, maxrace } ; ctx = { trackLen, teams, now, rnd, brakeScale }
  // -> { f0: [44], nudges: [{ point, delta }], blends: [{ start, end, marks }], bound: 'minrace' | 'maxrace', brake: { count, caps, apply } | null, leader }
  step(cars, lines, o, ctx) {
    o = Object.assign({}, DEFAULTS, o);
    const teams = ctx.teams || NO_TEAMS, rnd = ctx.rnd || Math.random;
    const L = ctx.trackLen > 0 ? ctx.trackLen : 0;
    const dl = new Array(NCARS).fill(0), dt = new Array(NCARS).fill(0), sp = new Array(NCARS).fill(0), laps = new Array(NCARS).fill(0), live = new Array(NCARS).fill(false);
    for (let i = 0; i < NCARS; i++) {
      const c = cars[i]; if (!c) continue;
      dl[i] = c.dlong || 0; dt[i] = c.dlat || 0; sp[i] = c.speed || 0; laps[i] = c.laps || 0;
      live[i] = i === PLAYER || sp[i] > 0;
    }
    const wrap = (d) => { if (L > 0) { if (d > L * 0.5) d -= L; if (d < -L * 0.5) d += L; } return d; };
    const out = { f0: new Array(NCARS).fill(1), nudges: [], blends: [], bound: o.moveDirection ? 'maxrace' : 'minrace', brake: null, leader: -1 };
    const n = lines && lines.race ? Math.min(lines.race.count, lines.minrace.count, lines.maxrace.count) : 0;
    if (!n) return out;
    const leader = leaderOf(dl, laps);
    out.leader = leader;
    const pointOf = (d) => Math.min(n - 1, Math.max(0, Math.floor(d / CELL)));
    const clamp1 = (x) => (x <= 1 ? (x >= -1 ? x : -1) : 1);
    const nearestBehind = (c) => {      // the car just behind c: smallest positive gap
      let j = -1, g = Infinity;
      for (let k = 0; k < NCARS; k++) if (k !== c && live[k]) { const d = wrap(dl[c] - dl[k]); if (d > 0 && d < g) { g = d; j = k; } }
      return [j, g];
    };
    // inside the lane between minrace and maxrace (with a metre to spare) at the car's own point (FUN_0043ff00)
    const inLane = (i) => {
      if (!cars[i]) return false;
      const p = pointOf(dl[i]), a = lines.minrace.rec[p * 7 + 3], b = lines.maxrace.rec[p * 7 + 3];
      return Math.min(a, b) - TW.window <= dt[i] && dt[i] <= Math.max(a, b) + TW.window;
    };
    const total = (i) => laps[i] * L + dl[i];

    const ticks = this._ticks(ctx.now);
    const teamwork = !!o.draftingTeamwork;
    const brakeWas = this.braking;

    // ── Drafting Teamwork: which "betrayal window" is on, and the lay-back of a few cars behind the leader ───────────────────────
    let mode = 0, laybackNow = false;
    if (teamwork && !brakeWas) {
      for (let t = 0; t < ticks; t++) {
        if (this.modeTicks > 0) this.modeTicks--;
        if (randInt(rnd, TW.pickOdds - 1) === 0) { this.modeTicks = TW.pickTicks; this.mode = randInt(rnd, 2) !== 0 ? 2 : 1; }
      }
    } else if (!teamwork) { this.modeTicks = 0; this.mode = 0; }
    if (teamwork && this.modeTicks > 0) mode = this.mode;

    const chain = (lead) => {           // FUN_00441690: the cars right behind the leader that are of its team (or make)
      const r = { abort: false, last: -1, count: 1 };
      if (!(L > 0) || mode === 1) return r;
      const info = teams.get(lead);
      if (!info) return r;
      const list = [];
      for (let c = 0; c < NCARS; c++) {
        if (c === lead || !cars[c]) continue;
        if (c < 43 && !teams.isValid(c)) continue;
        if (!inLane(c)) continue;
        const g = wrap(dl[lead] - dl[c]);
        if (g > 0) list.push({ c, g });
      }
      list.sort((a, b) => a.g - b.g || a.c - b.c);
      for (const e of list) {
        if (r.count > TW.chain || e.c > 42 || !teams.isValid(e.c)) break;
        const same = mode === 2 ? teams.sameTeam(lead, e.c) : (teams.sameMake(lead, e.c) || teams.sameTeam(lead, e.c));
        if (!same) break;
        r.count++; r.last = e.c;
      }
      r.abort = r.count > 1;
      return r;
    };

    if (teamwork && !brakeWas) {
      for (let t = 0; t < ticks; t++) {
        if (this.attackCool > 0) this.attackCool--;
        if (this.attackTicks > 0) { laybackNow = true; this.attackTicks--; continue; }
        if (randInt(rnd, TW.attackOdds - 1) !== 0) continue;
        if (chain(leader).abort) continue;
        let c1 = -1, g1 = Infinity, c2 = -1, g2 = Infinity;
        for (let i = 0; i < NCARS; i++) {
          if (i === leader || !inLane(i)) continue;
          const g = wrap(dl[leader] - dl[i]);
          if (!(g > 0)) continue;
          if (g1 <= g) { if (g < g2) { c2 = i; g2 = g; } } else { c2 = c1; g2 = g1; c1 = i; g1 = g; }
        }
        if (c1 >= 0 && c2 >= 0 && g1 <= TW.assailMax && TW.assailMin <= g1 && TW.assailSep <= g2 - g1) {
          let any = false;
          for (let i = 0; i < 43; i++) {
            this.flags[i] = 0;
            if (i === leader) continue;
            const g = wrap(dl[leader] - dl[i]);
            if (g > 0 && g <= TW.followers && inLane(i)) { this.flags[i] = 1; any = true; }
          }
          if (any) { this.attackTicks = TW.attackTicks; this.attackCool = TW.attackCooldown; laybackNow = true; }
        }
      }
    } else if (!teamwork) { this.attackTicks = 0; this.attackCool = 0; this.flags.fill(0); }
    if (teamwork && this.attackTicks > 0) laybackNow = true;           // calls that fall between two ticks keep the lay-back on
    if (laybackNow) for (let i = 0; i < 43; i++) if (this.flags[i]) out.f0[i] *= TW.layback;

    // ── Drafting Teamwork: line the cars up (copy the bound line over a stretch of the race line) ────────────────────────────────
    if (teamwork && L > 0) {
      const lineUp = out.bound;      // the same line Slow Cars Move uses (checked against the running AI Enhanced: direction 1 copies the maxrace line, the shorter, inside one at Daytona)
      // the cars that are within the lane, nearest behind the leader first: key = distance driven
      const list = [];
      for (let c = 0; c < NCARS; c++) if (c !== leader && cars[c] && inLane(c)) list.push({ c, key: total(c) });
      list.sort((a, b) => b.key - a.key || a.c - b.c);
      let prev = total(leader), k = 0;
      while (k < list.length && prev - list[k].key <= TW.packGap) { prev = list[k].key; k++; }
      if (k < list.length) {          // the first car that fell more than 50 m behind the car in front of it: the chasers
        // FUN_0043fde0 is handed (chaser + 5, leader + 18) and walks backwards, so the bound line goes under the chasers and everything behind
        // them (the 2-wide points are skipped) and past the leader, while the stretch between them keeps the race line. The 2-wide marks only
        // make sense for that direction, which is why it is ported as it is.
        const start = (pointOf(dl[list[k].c]) + 5) % n;
        const shift = Math.floor((o.behindMax + o.behindMin) / CELL);
        const end = (n + (shift + pointOf(dl[leader])) % n) % n;
        const marks = new Uint8Array(n);
        for (let q = k; q < list.length; q++) {
          const car = list[q].c;
          if (car >= 43) continue;
          for (let j = 0; j < NCARS; j++) {
            if (j === car || !inLane(j)) continue;
            const d = wrap(dl[j] - dl[car]);
            if (Math.abs(d) <= TW.sideLon && Math.abs(dt[j] - dt[car]) > TW.sideLat) {
              const pc = pointOf(dl[car]); marks[pc % n] = 1; marks[(pc + 1) % n] = 1; marks[(pc + 2) % n] = 1;
              break;
            }
          }
        }
        out.blends.push({ start, end, marks, bound: lineUp });
      }
      if (this.attackCool <= 0) {      // the leader and the team mates right behind it line up too
        const r = chain(leader);
        if (r.abort && r.last >= 0) out.blends.push({ start: (pointOf(dl[leader]) + 3) % n, end: (pointOf(dl[r.last]) - 1 + n) % n, marks: null, bound: lineUp });
        this.status.chain = r.count;
      }
    }

    // ── Slow cars move over (FUN_00440020) ──────────────────────────────────────────────────────────────────────────────────────
    if (o.slowCarsMoveOver) {
      const bound = lines[out.bound];
      const leaderLaps = laps[leader];
      for (let c = 0; c < 43; c++) {
        if (!cars[c]) continue;
        const [j, gap] = nearestBehind(c);
        if (j < 0 || gap < o.behindMin || gap > o.behindMax) continue;
        if (!(sp[j] - sp[c] >= o.speedThreshold) && !teams.sameTeam(c, j)) continue;     // a team mate behind always gets by
        if (laps[j] - laps[c] < o.minLapsAhead) continue;
        let blocked = false;
        for (let k2 = 0; k2 < 43 && !blocked; k2++) {
          if (k2 === c || !live[k2]) continue;
          const d = wrap(dl[k2] - dl[c]);
          if (d > 0 && d <= o.slowCarsAheadClearance && laps[k2] === leaderLaps) blocked = true;
        }
        if (blocked) continue;
        const idx = pointOf(dl[c]);
        if (idx + 4 >= n) continue;
        out.nudges.push({ point: idx + 4, delta: 0.001 * clamp1(bound.rec[idx * 7 + 3] - dt[c]) });
      }
    }

    // ── Mirror Drivin': the leader blocks the car behind (FUN_004422a0) ─────────────────────────────────────────────────────────
    if (o.leaderBlocks && leader < NCARS) {
      const [j, gap] = nearestBehind(leader);
      const strict = o.leaderBlocksMode === 1 && (j < 0 || !teams.sameTeam(leader, j));
      const minGap = strict ? 4 : o.leaderBlocksMinGap, scale = (strict ? 1.5 : 1) * 0.002;
      if (j >= 0 && gap >= minGap && gap <= o.leaderBlocksMaxGap && sp[leader] < sp[j] && (strict || sp[j] - sp[leader] < o.leaderBlocksSpeedThreshold)) {
        let ahead = false;
        for (let k2 = 0; k2 < NCARS && !ahead; k2++) {
          if (k2 === leader || !live[k2]) continue;
          const d = wrap(dl[k2] - dl[leader]);
          if (d > 0 && d <= o.leaderBlocksAheadClearance) ahead = true;
        }
        const idx = pointOf(dl[leader]);
        if (!ahead && idx + 4 < n) out.nudges.push({ point: idx + 4, delta: scale * clamp1(dt[j] - dt[leader]) });
      }
    }

    if (o.sandbagging && leader < 43 && !brakeWas) this._sandbag(out, dl, dt, sp, laps, live, leader, lines, n, L, o, pointOf);

    // ── Brake for wrecks (cuts the speed of the lines in front of a slow car) ──────────────────────────────────────────────────
    this.braking = false; this.wrecks = 0;
    if (o.brakeForWrecks) {
      const w = wreckCaps(cars, lines, teams, n, ctx.brakeScale > 0 ? ctx.brakeScale : 36);
      this.wrecks = w.count;
      if (w.count > 0) { this.braking = true; out.brake = w; }
    }
    this.status = { mode, modeTicks: this.modeTicks, attackTicks: this.attackTicks, attackCool: this.attackCool, wrecks: this.wrecks, chain: this.status.chain || 0, layback: laybackNow, blends: out.blends.length };
    return out;
  }

  // how many 25 ms ticks of AI Enhanced's loop passed since the last call
  _ticks(now) {
    if (typeof now !== 'number') return 1;
    if (this.last === null) { this.last = now; return 1; }
    const n = Math.floor((now - this.last) / TICK_MS);
    if (n <= 0) return 0;
    this.last += n * TICK_MS;
    return Math.min(MAX_TICKS, n);
  }

  // FUN_00442760: the pack that stays within 45 m of the car in front of it on the lead lap loses engine unless the car ahead is much faster
  _sandbag(out, dl, dt, sp, laps, live, leader, lines, n, L, o, pointOf) {
    const total = (i) => laps[i] * L + dl[i];
    const inLane = (i) => {
      const k = pointOf(dl[i]);
      const a = lines.minrace.rec[k * 7 + 3], b = lines.maxrace.rec[k * 7 + 3];
      return Math.min(a, b) - 1 <= dt[i] && dt[i] <= Math.max(a, b) + 1;
    };
    const list = [];
    for (let i = 0; i < 43; i++) if (i !== leader && live[i] && inLane(i)) list.push(i);
    list.sort((a, b) => total(b) - total(a));
    let prev = total(leader), cut = false;
    for (const i of list) {
      if (!cut && prev - total(i) > 45) cut = true;
      prev = total(i);
      if (cut || laps[i] !== laps[leader]) continue;
      let ahead = -1, g = Infinity;
      for (const k of [leader, ...list]) {
        if (k === i || !live[k]) continue;
        const d = dl[k] - dl[i];
        if (d > 0 && d < g) { g = d; ahead = k; }
      }
      if (ahead >= 0 && sp[ahead] - sp[i] > 0.5) continue;
      out.f0[i] *= o.sandbaggingEngineMult;
    }
  }
}

// copy the bound line over a stretch of the race line, going backwards from op.start to op.end (FUN_0043fde0): every field of the bound
// line's point, then the lateral position 99% of the way from where the race line was to the bound line. buf: the race line as the game
// holds it (28 bytes a point); bound: its Float32Array(count * 7)
function blendRace(buf, bound, n, op) {
  const REC = 28;
  let p = op.start;
  for (let steps = 0; steps < n; steps++) {
    if (p === op.end) return;
    if (!op.marks || !op.marks[p]) {
      const lat0 = buf.readFloatLE(p * REC + 12);
      for (let k = 0; k < 7; k++) buf.writeFloatLE(bound[p * 7 + k], p * REC + k * 4);
      buf.writeFloatLE((bound[p * 7 + 3] - lat0) * TW.blend + lat0, p * REC + 12);
    }
    p = (p - 1 + n) % n;
  }
}

module.exports = { Awareness, DEFAULTS, KEYS, TW, leaderOf, blendRace };
