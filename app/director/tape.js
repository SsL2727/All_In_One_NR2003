// The tape transport (RaceVision 1.2.0, racevision_tape.cpp): NR2003's own replay controls for the app and the phone - scrub, frame
// step, slow motion 1/2 - 1/17, fast forward / rewind, jump to a lap, a flag or a crash.
//
//   [0xB8E5A2] current tape frame        [0xB8E586] frames on the tape      [0xB8E59A] 0 live / 1 playing the tape
//   [0xB8E5AA] STEP (int)   [0xB8E5AE] SLOW flag (byte)   [0xB8E5AF] slow counter (int)
//     flag 0: the tape moves STEP frames a tick (1 = normal, 0 = paused, 2..16 fast forward, -1..-16 rewind)
//     flag 1: SLOW MOTION - one frame every |STEP|+1 ticks (STEP 1 = 1/2 ... 16 = 1/17; negative = backwards)
//   the game's own key functions: 0x502C20 to the beginning, 0x502870 / 0x502900 one frame forward / back, 0x502720(fraction 0..1)
//   seek (leaves it paused); 0x502B50 stop = back to live, 0x5024A0(seconds back, paused, 1) play.
// The speed is set by writing STEP + flag + counter (9 bytes) - what the slow-motion key does one step at a time - so any speed can be
// asked for at once. The calls go through the camera cave's generic-call mailbox (camera.js), on the game's main thread.
'use strict';
const { A, floatBits } = require('./camera');

const TP = { Idx: 0xB8E5A2, Step: 0xB8E5AA, Slow: 0xB8E5AE, Start: 0x502C20, Back1: 0x502900, Fwd1: 0x502870, Seek: 0x502720 };
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
const i32 = (m, a, d) => { const b = m.readBytes(a, 4); return b ? b.readInt32LE(0) : d; };
const u8 = (m, a, d) => { const b = m.readBytes(a, 1); return b ? b[0] : d; };

function tickRate(m) {
  const fl = m.readBytes(A.TickRateFlag, 4), r = m.readBytes(A.TickRate, 4);
  const rate = fl && fl.readInt32LE(0) !== 0 ? 36 : (r ? r.readInt32LE(0) : 36);
  return rate > 0 && rate <= 10000 ? rate : 36;
}
function setSpeed(m, step, slow) {
  const b = Buffer.alloc(9);
  b.writeInt32LE(step | 0, 0); b[4] = slow ? 1 : 0; b.writeInt32LE(0, 5);
  return m.writeBytes(TP.Step, b);
}
function speedText(m) {
  if (i32(m, A.ReplayState, 0) !== 1) return 'LIVE';
  const step = i32(m, TP.Step, 1), slow = u8(m, TP.Slow, 0) !== 0;
  if (step === 0) return 'PAUSED';
  if (slow) return (step < 0 ? 'SLOW REVERSE 1/' : 'SLOW 1/') + (Math.abs(step) + 1);
  if (step === 1) return 'PLAY';
  if (step === -1) return 'REWIND';
  return (step > 0 ? 'FAST x' : 'REWIND x') + Math.abs(step);
}

class Tape {
  // deps: { mem, cam (Camera), crashes (CrashLog), replay (ReplayController), S: () => settings, log, ready: () => '' | why not,
  //         focus: () => slot, replayCam: () => camera, wipe?: (kind, sub) => Promise<release fn>, sleep? }
  constructor(deps) {
    this.d = deps; this.log = deps.log || (() => {}); this.sleep = deps.sleep || sleepMs;
    this.queue = []; this.busy = false; this.manual = false; this.msg = ''; this.msgAt = 0;
    this.reset();
  }
  reset() { this.marks = []; this.lap = -1; this.flag = null; }
  say(m) { this.msg = m; this.msgAt = Date.now(); this.log('Playback: ' + m); }

  // live: what is on the tape (laps and flags; crashes come from the crash list). frames = the tape's length now
  markTick(frames, leaderLaps, green) {
    if (!(frames > 0)) return;
    if (this.marks.length && frames < this.marks[this.marks.length - 1].f) this.reset();        // a new tape (the race started over)
    if (this.lap < 0 || leaderLaps > this.lap) this.marks.push({ f: frames, t: 'L', l: 'LAP ' + (leaderLaps + 1) });
    this.lap = leaderLaps;
    if (this.flag !== null && green !== this.flag) this.marks.push({ f: frames, t: 'F', l: green ? 'GREEN' : 'CAUTION' });
    this.flag = green;
    if (this.marks.length > 4000) this.marks.splice(0, 500);
  }

  inReplay() { return i32(this.d.mem, A.ReplayState, 0) === 1; }
  push(op, n = 0, v = 0) { if (this.queue.length < 16) this.queue.push({ op, n: Number(n) || 0, v: Number(v) || 0 }); this.service(); }
  // the requests, one after another (each may call into the game and wait for it)
  async service() {
    if (this.busy) return;
    this.busy = true;
    try { while (this.queue.length) await this.run(this.queue.shift()); }
    catch (e) { this.say('error: ' + (e && e.message || e)); }
    finally { this.busy = false; }
  }
  // the tape rolled back to live by itself (the game's own keys, the tape end): the transport lets go
  tick() { if (this.manual && !this.inReplay() && !this.busy) { this.manual = false; this.d.replay.manual = false; } }

  // the tape under the transport's hand: a replay already rolling is taken over; from live one starts paused a few seconds back
  async enter() {
    const m = this.d.mem;
    if (this.inReplay()) { this.manual = true; this.d.replay.manual = true; return ''; }
    const why = this.d.ready();
    if (why) return why;
    const slot = this.d.focus(), cam = this.d.replayCam();
    let release = null;
    if (this.d.wipe && Number(this.d.S().replay_transition)) release = await this.d.wipe(0, 'PLAYBACK');
    try {
      await this.d.cam.callGame(A.ReplayStart, floatBits(4), 1, 1);        // (seconds back, PAUSED, 1 = like the key)
      for (let j = 0; j < 40 && !this.inReplay(); j++) await this.sleep(25);
      if (!this.inReplay()) return "the replay didn't start";
      if (slot >= 0 && cam > 0) this.d.cam.set(cam, slot, { call: true });
      setSpeed(m, 0, false);
      this.manual = true; this.d.replay.manual = true;
      return '';
    } finally { if (release) release(); }
  }
  async seekFrame(frame) {
    const m = this.d.mem, frames = i32(m, A.TapeTicks, 0);
    if (frames < 10) return;
    const frac = Math.max(0, Math.min(1, frame / (frames - 1)));
    const step = i32(m, TP.Step, 0), slow = u8(m, TP.Slow, 0) !== 0;
    await this.d.cam.callGame(TP.Seek, floatBits(frac), 0, 0);             // (it leaves the tape paused)
    if (step !== 0) setSpeed(m, step, slow);                               // ...so a tape that was rolling rolls on at its speed
  }
  crashFrame(id, rate) {
    const x = this.d.crashes.crashes.find(c => c.id === id);
    if (!x) return -1;
    const hit = [...x.cars.values()].reduce((a, b) => (b.hit > a.hit ? b : a), { hit: -1, hitAt: x.t0 });
    const f = this.d.crashes.frameAt(hit.hitAt, rate);
    return f >= 0 ? f - this.d.S().replay_preroll * rate : -1;
  }
  async run(r) {
    const m = this.d.mem;
    if (r.op === 'live') {
      if (this.d.replay.active) { this.d.replay.cancel(); this.manual = false; return; }
      if (this.inReplay()) {
        let release = null;
        if (this.d.wipe && Number(this.d.S().replay_transition)) release = await this.d.wipe(1, 'BACK TO THE RACE');
        try { setSpeed(m, 1, false); await this.d.replay.stop(); } finally { if (release) release(); }
      }
      this.manual = false; this.d.replay.manual = false;
      return;
    }
    const why = await this.enter();
    if (why) { this.say('not now: ' + why); return; }
    const rate = tickRate(m), idx = i32(m, TP.Idx, 0), frames = i32(m, A.TapeTicks, 0);
    const st = i32(m, TP.Step, 0), isSlow = u8(m, TP.Slow, 0) !== 0;
    switch (r.op) {
      case 'pause': setSpeed(m, 0, false); break;
      case 'toggle': setSpeed(m, st !== 0 ? 0 : 1, false); break;
      case 'slower': setSpeed(m, Math.min(16, isSlow ? Math.abs(st) + 1 : 1), true); break;
      case 'faster':
        if (isSlow && Math.abs(st) > 1) setSpeed(m, Math.abs(st) - 1, true);
        else if (isSlow || st < 1) setSpeed(m, 1, false);
        else setSpeed(m, st < 2 ? 2 : Math.min(16, st * 2), false);
        break;
      case 'play': setSpeed(m, 1, false); break;
      case 'slow': { const n = Math.max(1, Math.min(16, r.n)); setSpeed(m, r.v < 0 ? -n : n, true); break; }
      case 'fast': { const n = Math.max(2, Math.min(16, r.n)); setSpeed(m, r.v < 0 ? -n : n, false); break; }
      case 'step': await this.d.cam.callGame(r.n < 0 ? TP.Back1 : TP.Fwd1, 1, 0, 0); break;
      case 'start': await this.d.cam.callGame(TP.Start, 1, 0, 0); break;
      case 'seek': await this.seekFrame(r.v * (frames - 1)); break;
      case 'lap': {
        const mk = this.marks.find(x => x.t === 'L' && x.l === 'LAP ' + r.n);
        if (!mk) this.say('lap ' + r.n + " isn't on the tape"); else await this.seekFrame(mk.f - rate);
        break;
      }
      case 'crash': { const f = this.crashFrame(r.n, rate); if (f < 0) this.say("that crash isn't on the tape"); else await this.seekFrame(f); break; }
      case 'jump': {                                            // next / previous mark of a kind: n = +-1, v = 'L' / 'C' / 'F' (as a char code)
        const kind = String.fromCharCode(r.v), at = [];
        if (kind === 'C') { for (const c of this.d.crashes.crashes) { const f = this.crashFrame(c.id, rate); if (f >= 0) at.push(f); } }
        else for (const mk of this.marks) if (mk.t === kind) at.push(mk.f - (kind === 'L' ? rate : 0));
        at.sort((a, b) => a - b);
        let to = -1;
        if (r.n > 0) { for (const a of at) if (a > idx + rate * 1.5) { to = a; break; } }
        else { for (let i = at.length - 1; i >= 0; i--) if (at[i] < idx - rate * 2.0) { to = at[i]; break; } }
        if (to < 0) this.say(r.n > 0 ? 'nothing later on the tape' : 'nothing earlier on the tape'); else await this.seekFrame(to);
        break;
      }
      default: this.say('unknown playback command');
    }
  }

  // GET /api/tape
  state(attached) {
    const m = this.d.mem, ok = !!attached && this.d.cam.hooked && !this.d.cam.foreign;
    const mode = ok ? i32(m, A.ReplayState, 0) : 0, frames = ok ? i32(m, A.TapeTicks, 0) : 0, idx = ok ? i32(m, TP.Idx, 0) : 0, rate = ok ? tickRate(m) : 36;
    let can = ok, why = '';
    if (!attached) why = "NR2003 isn't running";
    else if (!ok) why = this.d.cam.foreign ? "another program's camera hook is in the game" : 'no camera control';
    else if (mode === 0) { why = this.d.ready(); can = !why; }
    const marks = this.marks.filter(x => !(frames > 0 && x.f > frames)).map(x => ({ f: x.f, t: x.t, id: 0, l: x.l }));
    for (const c of this.d.crashes.crashes) {
      const hit = [...c.cars.values()].reduce((a, b) => (b.hit > a.hit ? b : a), { hit: -1, hitAt: c.t0 });
      const f = this.d.crashes.frameAt(hit.hitAt, rate);
      if (f < 0 || (frames > 0 && f > frames)) continue;
      const who = [...c.cars.values()].sort((a, b) => b.hit - a.hit).slice(0, 2).map(x => '#' + x.num + ' ' + (x.name || '').split(' ').pop()).join(', ');
      marks.push({ f: Math.round(f), t: 'C', id: c.id, l: 'CRASH  ' + who });
    }
    marks.sort((a, b) => a.f - b.f);
    return {
      mode, frames, idx, rate, step: ok ? i32(m, TP.Step, 1) : 1, slow: ok && u8(m, TP.Slow, 0) !== 0, manual: this.manual, can,
      speed: ok ? speedText(m) : 'LIVE', why, msg: Date.now() - this.msgAt < 8000 ? this.msg : '', lap: this.lap + 1, marks,
    };
  }
}

// a phone / app request -> the queued op (the same commands RaceVision's /api/tape/ctl takes)
function ctl(tape, q) {
  const d = String(q.do || '');
  if (['pause', 'toggle', 'play', 'live', 'start', 'slower', 'faster'].includes(d)) tape.push(d);
  else if (d === 'slow' || d === 'fast') tape.push(d, parseInt(q.n, 10) || 0, q.rev ? -1 : 1);
  else if (d === 'step') tape.push(d, parseInt(q.d, 10) < 0 ? -1 : 1);
  else if (d === 'seek') tape.push(d, 0, parseFloat(q.f) || 0);
  else if (d === 'lap' || d === 'crash') tape.push(d, parseInt(q.n, 10) || 0);
  else if (d === 'jump') tape.push(d, parseInt(q.d, 10) < 0 ? -1 : 1, String(q.kind || 'C').charCodeAt(0));
  else return false;
  return true;
}

module.exports = { Tape, ctl, setSpeed, speedText, tickRate, TP };
