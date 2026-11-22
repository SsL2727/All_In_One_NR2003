// Crash replays (RaceVision 1.1.0): finds crashes from the cars' damage and replays them with the game's own tape replay.
//
// Detection: a car whose damage jumps by `crash_damage` or more in one read is in a crash; a contact of `contact_join` or more near a
// crash that is going on puts that car in it too (for `crash_span` seconds). A crash is over once its cars have stopped (or left the
// track) and no new contact came; it is worth a replay when its score (the hardest hit + 0.5 for every car past the first) reaches
// `replay_worthy`. Each car's replay starts `replay_preroll` seconds before ITS hardest hit.
//
// The game keeps the last minutes of the race on a tape. Replay = call the game's replay start (0x5024A0) with how many seconds back to
// start, put a camera on the car, hold, then call the game's replay stop (0x502B50) to go back to live; the calls go through the camera
// cave's generic-call mailbox (camera.js). The tape's length is read from the game so a crash that has fallen off it is not attempted.
'use strict';
const { A, floatBits } = require('./camera');
const { setSpeed, TP } = require('./tape');
const TAPE_IDX = TP.Idx;                          // the tape frame showing (0xB8E5A2)

const STRIDE = 0x15B8;
const PLAYER_SLOT = 0;                           // your car in the camera's car table
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

// seconds of game time (the tick counter over the tick rate)
function gameSeconds(m) {
  const b = m.readBytes(0xBEBDF5, 4);
  const ticks = b ? b.readInt32LE(0) : 0;
  if (ticks <= 0) return 0;
  return ticks / tickRate(m);
}
function tickRate(m) {
  const fl = m.readBytes(A.TickRateFlag, 4), r = m.readBytes(A.TickRate, 4);
  let rate = fl && fl.readInt32LE(0) !== 0 ? 36 : (r ? r.readInt32LE(0) : 36);
  if (!(rate > 0 && rate <= 10000)) rate = 36;
  return rate;
}
const u32 = (m, a) => { const b = m.readBytes(a, 4); return b ? b.readUInt32LE(0) : null; };

class CrashLog {
  // S: () => resolved settings; opts { log }
  constructor(S, opts = {}) { this.S = S; this.log = opts.log || (() => {}); this.mem = opts.mem || null; this.reset(); }
  reset() { this.crashes = []; this.prev = new Map(); this.nextId = 1; this.open = []; this.tape = []; this.air = new Map(); }

  // a blowover (RaceVision 2.0, with the banked-track fix): a car well above where it ran at this spot last lap AND moving up or down fast
  // in the last 3 s has left the ground. Without lift a high reading is just another lane (Michigan, Talladega): learn it as the line.
  _blowover(c, g, L, S) {
    if (!Number.isFinite(c.z) || !(L > 400)) return false;
    let a = this.air.get(c.slot);
    const nb = Math.floor(L / 10) + 2;
    if (!a || a.prof.length !== nb) { a = { prof: new Float64Array(nb).fill(NaN), liftAt: -1e9, since: -1, flipAt: -1e9, up: 0 }; this.air.set(c.slot, a); }
    const bk = Math.floor(Math.max(0, c.dlong) / 10) % nb, ref = a.prof[bk], up = Number.isFinite(ref) ? c.z - ref : 0, vz = Number.isFinite(c.vz) ? c.vz : 0;
    if (Math.abs(vz) >= S.blowover_vz) a.liftAt = g;
    const lift = S.blowover_vz <= 0 || g - a.liftAt < 3.0;
    if (!c.pit && (!Number.isFinite(ref) || up < 1.5 || (!lift && up < 15 && c.speed > 10 && Math.abs(vz) < 2.5))) a.prof[bk] = Number.isFinite(ref) ? ref * 0.5 + c.z * 0.5 : c.z;
    if (S.blowover_m > 0 && !c.pit && Number.isFinite(ref) && up > S.blowover_m && c.speed > 10 && lift) {
      if (a.since < 0) a.since = g;
      a.up = Math.max(a.up, up);
      if (g - a.since > 0.15 && g - a.flipAt > 20) { a.flipAt = g; this.log(`BLOWOVER #${c.num}: ${a.up.toFixed(1)} m above its line at this spot last lap, climbing ${vz.toFixed(1)} m/s`); return true; }
    } else if (up < 2.0) { a.since = -1; a.up = 0; }
    return false;
  }

  // f: ranked field whose cars carry .dmg (damage) and .speed, g: game seconds now, caution: is the field under yellow
  observe(f, g) {
    const S = this.S();
    if (this.mem && g > 0 && u32(this.mem, A.ReplayState) === 0) {          // (the tape is sampled live only)
      const ticks = u32(this.mem, A.TapeTicks), rate = tickRate(this.mem);
      if (ticks !== null && this.tape.length && ticks < this.tape[this.tape.length - 1].ticks) this.tape = [];   // a new tape
      if (ticks !== null && (!this.tape.length || g > this.tape[this.tape.length - 1].g)) {
        this.tape.push({ g, ticks, rate });
        while (this.tape.length && g - this.tape[0].g > 600) this.tape.shift();
      }
    }
    const bySlot = new Map(f.cars.map(c => [c.slot, c]));
    const born = [];
    for (const c of f.cars) {
      if (c.pace || !this._blowover(c, g, f.trackLen, S)) continue;
      let crash = this.open.find(x => g - x.t0 <= S.crash_span && !x.over) || null;
      if (!crash) { crash = { id: this.nextId++, t0: g, last: g, cars: new Map(), score: 0, over: false, overAt: 0, replays: 0, when: Date.now() }; this.crashes.push(crash); this.open.push(crash); born.push(crash); }
      const m = crash.cars.get(c.slot) || { slot: c.slot, num: c.num, name: c.name, hit: 0, hitAt: g, total: 0 };
      if (S.blowover_bonus > m.hit) { m.hit = S.blowover_bonus; m.hitAt = g; }
      m.blowover = true;
      crash.cars.set(c.slot, m); crash.last = g;
    }
    for (const c of f.cars) {
      if (c.pace || !Number.isFinite(c.dmg)) continue;
      const before = this.prev.get(c.slot);
      this.prev.set(c.slot, c.dmg);
      if (before === undefined) continue;
      const d = c.dmg - before;
      if (!(d > 0.0005) || d > 50) continue;                          // repairs / garage resets are not hits
      let crash = null;
      if (d >= S.contact_join) crash = this.open.find(x => g - x.t0 <= S.crash_span && !x.over) || null;
      if (!crash && d >= S.crash_damage) {
        crash = { id: this.nextId++, t0: g, last: g, cars: new Map(), score: 0, over: false, overAt: 0, replays: 0, when: Date.now() };
        this.crashes.push(crash); this.open.push(crash); born.push(crash);
      }
      if (!crash) continue;
      const m = crash.cars.get(c.slot) || { slot: c.slot, num: c.num, name: c.name, hit: 0, hitAt: g, total: 0 };
      m.total += d;
      if (d > m.hit) { m.hit = d; m.hitAt = g; }
      crash.cars.set(c.slot, m);
      crash.last = g;
    }
    for (const x of this.open) {
      const hits = [...x.cars.values()].map(m => m.hit);
      x.score = (hits.length ? Math.max(...hits) : 0) + 0.5 * Math.max(0, x.cars.size - 1);
      if (!x.over && g - x.last >= 2) {
        const moving = [...x.cars.values()].some(m => { const c = bySlot.get(m.slot); return c && !c.pit && c.speed > 8; });
        if (!moving || g - x.last > S.crash_span) { x.over = true; x.overAt = g; }
      }
    }
    this.open = this.open.filter(x => !x.over || g - x.overAt < 1);
    for (const x of born) this.log(`crash #${x.id}: #${[...x.cars.values()][0].num} (damage +${[...x.cars.values()][0].hit.toFixed(2)})`);
    return born;
  }

  // (a highlight - a pass, a bump and run, the finish - is never "worth" a crash replay: those have their own rules, RaceVision 2.0)
  worthy(x) { return !x.kind && x.score >= this.S().replay_worthy; }

  // the tape frame that holds game second t (between samples: in proportion; outside them: rate frames a second); -1 without samples
  frameAt(t, rate) {
    const T = this.tape;
    if (!T.length || !Number.isFinite(t)) return -1;
    if (t <= T[0].g) return T[0].ticks - (T[0].g - t) * rate;
    const last = T[T.length - 1];
    if (t >= last.g) return last.ticks + (t - last.g) * rate;
    for (let i = 1; i < T.length; i++) if (T[i].g >= t) { const a = T[i - 1], b = T[i]; return b.g - a.g > 0 ? a.ticks + (b.ticks - a.ticks) * (t - a.g) / (b.g - a.g) : a.ticks; }
    return -1;
  }

  tapeBack(start) {
    if (!this.mem || this.tape.length < 2) return null;
    let lo = null, hi = null;
    for (let i = 1; i < this.tape.length; i++) if (this.tape[i - 1].g <= start && this.tape[i].g >= start) { lo = this.tape[i - 1]; hi = this.tape[i]; break; }
    if (!lo || !hi) return null;
    const q = (start - lo.g) / Math.max(1e-6, hi.g - lo.g), thenTicks = lo.ticks + (hi.ticks - lo.ticks) * q;
    const nowTicks = u32(this.mem, A.TapeTicks), rate = tickRate(this.mem);
    if (nowTicks === null || !(rate > 0)) return null;
    return { back: Math.max(0, (nowTicks - thenTicks) / rate), rate };
  }

  // the angles of a crash: the cars it hurt, hardest hit first; each { slot, num, name, hitAt, start }
  angles(x, max) {
    const S = this.S();
    return [...x.cars.values()].sort((a, b) => b.hit - a.hit).slice(0, Math.max(1, max || S.replay_angles))
      .map(m => ({ slot: m.slot, num: m.num, name: m.name, hit: m.hit, hitAt: m.hitAt, start: m.hitAt - S.replay_preroll }));
  }

  list() {
    return this.crashes.map(x => ({
      id: x.id, at: x.t0, score: Math.round(x.score * 100) / 100, over: x.over, worthy: this.worthy(x), replays: x.replays, kind: x.kind || 'crash', what: x.what || '',
      cars: [...x.cars.values()].sort((a, b) => b.hit - a.hit).map(m => ({ slot: m.slot, num: m.num, name: m.name, hit: Math.round(m.hit * 100) / 100 })),
    }));
  }
}

class ReplayController {
  // deps: { cam: Camera, mem, S: () => settings, crashes: CrashLog, log, onState(state), pauseDirector(on), sleep? }
  constructor(deps) {
    this.d = deps; this.log = deps.log || (() => {}); this.sleep = deps.sleep || sleepMs;
    this.state = { phase: 'idle', text: '', crash: 0, angle: 0, angles: 0, slot: -1 };
    this.abort = false; this.running = null;
    this.manual = false;             // the tape transport has the tape: no timed end, no more angles (RaceVision 1.2.0 g_tpManual)
  }
  get active() { return this.running !== null; }
  _set(p) { Object.assign(this.state, p); if (this.d.onState) this.d.onState(Object.assign({}, this.state)); }
  inReplay() { return u32(this.d.mem, A.ReplayState) === 1; }

  async _waitReplay(want, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((this.inReplay() ? 1 : 0) === want) return true; await this.sleep(25); }
    return (this.inReplay() ? 1 : 0) === want;
  }
  async stop() {                                         // back to live
    if (!this.inReplay()) return true;
    setSpeed(this.d.mem, 1, false);                       // (the game plays the next replay at the speed this one ended at)
    await this.d.cam.callGame(A.ReplayStop, 1, 0, 0);
    return this._waitReplay(0, 2000);
  }

  // one angle: start the replay `back` seconds ago, put a camera on its car; resolves false when the game would not
  async _angle(a, cam, back) {
    const m = this.d.mem, S = this.d.S();
    if (this.inReplay()) { await this.d.cam.callGame(A.ReplayStop, 1, 0, 0); if (!await this._waitReplay(0, 2000)) { this.log('replay: could not stop the replay that was playing'); return false; } }
    const tape = (() => { const t = m.readBytes(A.TapeTicks, 4); return t ? t.readInt32LE(0) / tickRate(m) - S.tape_margin : 0; })();
    if (tape < 2) { this.log('replay: the tape is empty'); return false; }
    let secs = back;
    if (secs > tape) { this.log(`replay: tape holds ${tape.toFixed(0)}s, the replay would start ${secs.toFixed(0)}s ago - starts at the tape's start`); secs = tape; }
    if (secs < S.tape_margin) { this.log('replay: too recent for the tape'); return false; }
    const called = await this.d.cam.callGame(A.ReplayStart, floatBits(secs), 0, 1);
    if (!called) this.log('replay: the replay call was slow to report back, checking the tape');
    if (!await this._waitReplay(1, 1200)) { this.log(`replay: did not start (${called ? 'called' : 'call not run'}, tape mode ${u32(m, A.ReplayState)})`); return false; }
    this.d.cam.set(cam, a.slot, { call: true });
    setSpeed(m, 1, false);                                // normal speed from here; smart slow motion takes over in the loop
    return true;
  }
  // the full-screen wipe (deps.wipe(kind, sub) resolves once the screen is covered, with the function that uncovers it)
  async _wipe(kind, sub) {
    if (!this.d.wipe || !Number(this.d.S().replay_transition)) return null;
    try { return await this.d.wipe(kind, sub); } catch (e) { return null; }
  }
  // smart slow motion (replay_smart): the take's speed for the tape d seconds from its hit; nMax from replay_slow_max and the crash's worth
  static slowFor(d, nMax) {
    if (d >= -1.6 && d < -0.8) return 1;
    if (d >= -0.8 && d < -0.25) return Math.max(1, Math.floor(nMax / 2));
    if (d >= -0.25 && d < 1.4) return nMax;
    return 0;                                  // RaceVision 2.0: straight back to full speed after the hit
  }

  // plan: [{ slot, num, hitAt, start, cams: [..], len, slow?, worth?, wipe? }]; slow = this angle shows the hit in slow motion (replay_smart)
  play(label, plan, opts = {}) {
    if (this.running) return this.running;
    this.abort = false; this.manual = false;
    this.running = (async () => {
      const S = this.d.S(), g0 = () => gameSeconds(this.d.mem), m = this.d.mem;
      const drive = this.d.cam.inCar() && S.replay_drive;
      // the live view to go back to: the replay's camera carries over to the live one when the replay stops
      const was = this.inReplay() || typeof this.d.cam.current !== 'function' ? null : { cam: this.d.cam.current(), slot: this.d.cam.focusSlot() };
      const tapeIdx = () => { const b = m.readBytes(TAPE_IDX, 4); return b ? b.readInt32LE(0) : 0; };
      let rolled = false;
      try {
        if (this.d.cam.inCar() && !S.replay_drive) { this.log('replay: you are in your car (replay_drive is off)'); return false; }
        this.d.pauseDirector(true);
        if (drive) { this.log('replay: pausing the race for your replay'); await this.d.cam.callGame(A.Pause, 0, 0, 0); await this.sleep(150); }
        if (S.replay_countdown > 0 && !opts.now) {
          for (let n = Math.round(S.replay_countdown); n > 0 && !this.abort; n--) { this._set({ phase: 'countdown', text: 'REPLAY IN ' + n, crash: opts.crash || 0 }); await this.sleep(1000); }
        }
        let ok = false;
        for (let i = 0; i < plan.length && !this.abort && !this.manual; i++) {
          const a = plan[i];
          const cam = a.cams[i % a.cams.length] || 19;
          const clockBack = g0() - a.start, tape = this.d.crashes ? this.d.crashes.tapeBack(a.start) : null;
          let back = clockBack;
          if (tape && Math.abs(tape.back - clockBack) > 3) {
            this.log(`replay: the tape has ${tape.back.toFixed(0)}s since then, the race clock ${clockBack.toFixed(0)}s - going back by the tape`);
            back = tape.back;
          }
          this._set({ phase: 'playing', text: label, crash: opts.crash || 0, angle: i + 1, angles: plan.length, slot: a.slot, num: a.num, name: a.name || '', liveIn: Math.max(0, a.len || 0) });
          // the wipe: into the replay with its label, a short one between angles; the cut happens while the screen is covered
          const fresh = !rolled || !!a.wipe;                       // the first take, or the next crash of the highlight reel
          const release = await this._wipe(fresh ? 0 : 2, fresh ? (a.wipe || label) : 'ANGLE ' + (i + 1));
          let started;
          try { started = await this._angle(a, cam, back); } finally { if (release) release(); }
          if (!started) { if (i === 0) break; continue; }
          ok = true; rolled = true;
          const len = Math.max(3, a.len), rate = tickRate(m);
          const until = Date.now() + len * 1000;
          const t0 = Date.now(), tk0 = u32(m, A.TapeTicks);
          // smart slow motion: slow into the hit and out of it on a slow angle; the take then runs by tape frames, not by the clock
          const smart = !!Number(S.replay_smart), idx0 = tapeIdx();
          const guideF = smart && this.d.crashes ? this.d.crashes.frameAt(a.hitAt, rate) : -1, endF = idx0 + len * rate;
          let nMax = Math.max(1, Math.min(16, Number(S.replay_slow_max) || 5));
          const worth = Number.isFinite(a.worth) ? a.worth : 3;
          if (a.kind) nMax = Math.min(nMax, a.kind === 'finish' ? 4 : 2);      // a pass, a bump: a gentle slow look (RaceVision 2.0)
          else if (worth < 2) nMax = Math.min(nMax, 2); else if (worth < 5) nMax = Math.min(nMax, 4);
          let curN = 0, lastBanner = 0;
          for (;;) {
            if (this.abort || !this.inReplay()) break;
            if (this.manual) { await this.sleep(100); continue; }               // the transport has the tape: it ends when you say so
            const idx = tapeIdx();
            if (smart && guideF >= 0) {
              const want = a.slow ? ReplayController.slowFor((idx - guideF) / rate, nMax) : 0;
              if (want !== curN) { curN = want; if (want) setSpeed(m, want, true); else setSpeed(m, 1, false); }
              if (idx >= endF || Date.now() - t0 > len * 5000 + 10000) break;
            } else if (Date.now() >= until) break;
            if (Date.now() - lastBanner >= 400) {
              lastBanner = Date.now();
              this._set({ liveIn: Math.max(0, Math.ceil(smart && guideF >= 0 ? (endF - idx) / rate : len - (Date.now() - t0) / 1000)) });
            }
            await this.sleep(100);
          }
          if (curN) setSpeed(m, 1, false);
          if (!this.abort && !this.manual && !this.inReplay() && Date.now() < until - 500) this.log('replay: the game left the replay after ' + ((Date.now() - t0) / 1000).toFixed(1) + 's of ' + len + 's (asked ' + back.toFixed(1) + 's back, tape ticks ' + tk0 + ' -> ' + u32(m, A.TapeTicks) + ', state ' + u32(m, A.ReplayState) + ')');
        }
        return ok;
      } finally {
        const release = rolled && this.inReplay() ? await this._wipe(1, 'BACK TO THE RACE') : null;
        try {
          await this.stop();
          if (drive) this.d.cam.set(was && was.cam >= 1 && was.cam <= 3 ? was.cam : 1, PLAYER_SLOT, { call: true });      // back in your cockpit
          else if (was && was.cam > 0) this.d.cam.set(was.cam, was.slot, { call: true });
          if (drive) { await this.d.cam.callGame(A.Resume, 0, 0, 0); }
        } finally { if (release) release(); }
        this.manual = false;
        this._set({ phase: 'idle', text: '', crash: 0, angle: 0, angles: 0, slot: -1, num: 0, name: '', liveIn: 0 });
        this.d.pauseDirector(false);
        this.running = null;
      }
    })();
    return this.running;
  }
  cancel() { this.abort = true; }
}

module.exports = { CrashLog, ReplayController, gameSeconds, tickRate, STRIDE };
