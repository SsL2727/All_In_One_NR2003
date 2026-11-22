// QualControl 0.5.0 beta (github.com/NR2003-JT/QualControl) on top of Race Control's qualifying (qualifying.js): the running order
// from the practice before qualifying, saved results (reapplied exactly at a later weekend), merged sessions, the race field cut and
// a race roster .lst. A port of QualControl's Qualifying.cs additions and Merge.cs; mixed into Qualifying.prototype by qualifying.js.
'use strict';
const fs = require('fs');
const path = require('path');

const Cross0 = 0x77F996, CrossCar = 2048, CrossMask = 0x0FFFFFFF;
const CAR_FILE_OFF = 0x11F6, SERIES_NAME = 0x977938 + 0x20, TRACK_NAME = 0xDAF110;
const Block0 = 0xACCA30, Stride = 8724;

const msTime = (ms) => (ms / 1000).toFixed(3);

function install(Qualifying, Ph, deps) {
  const P = Qualifying.prototype;
  const { Known, LapFmt } = deps;

  // ---- the running order from the practice before qualifying ----------------------------------------------------------------
  // PracticeOrder on: that practice starts with the cars running free (nothing held) while each car's laps are timed from its line
  // crossings (game clock, ms). "Set the order from practice" or "Keep my list" ends the timing in the same session: the cars are
  // called in and held as usual, and Start starts qualifying.
  P.ResetSaved = function () {
    this.finalOrder = null; this.exactTimes = false; this.writtenPaceK = 1.0; this.savedPath = null;
    this.finalTrack = this.finalType = this.finalSeries = null; this.finalNames = this.finalFiles = null;
  };
  P.qcInit = function () {
    this.PracticeOrder = false; this.FastestLast = false;
    this.pLaps = new Map(); this.pSeen = new Map(); this.pLast = new Map(); this.pNum = new Map(); this.pName = new Map(); this.pNextRead = -1;
    this.ResetSaved();
  };
  Object.defineProperty(P, 'PracticeTiming', { get() { return this.phase === Ph.Timing; } });
  Object.defineProperty(P, 'HasResults', { get() { return !!this.finalOrder && this.runs.size > 0; } });
  Object.defineProperty(P, 'Reapplied', { get() { return !!this.exactTimes; } });
  Object.defineProperty(P, 'TrackName', { get() { try { return this.m ? this.m.Str(TRACK_NAME, 64).trim() : ''; } catch (e) { return ''; } } });
  Object.defineProperty(P, 'SeriesName', { get() { try { return this.m ? this.m.Str(SERIES_NAME, 32).trim() : ''; } catch (e) { return ''; } } });
  Object.defineProperty(P, 'TypeKey', { get() { const F = deps.Format; return this.Mode === F.IndyOval ? 'indy_oval' : this.Mode === F.IndyRoad ? 'indy_road' : this.Mode === F.Knockout ? 'knockout' : 'single'; } });
  // for the overlay feed: race | practice | qualifying | other
  Object.defineProperty(P, 'SessionName', { get() { try { if (!this.m) return 'other'; const k = this.SessionKind(); return k === 7 ? 'race' : k === 5 ? 'qualifying' : k === 4 ? 'practice' : 'other'; } catch (e) { return 'other'; } } });

  P.NewTiming = function () {
    this.field.clear(); this.told.clear(); this.outNow.clear(); this.runs.clear(); this.results = []; this.Board = [];
    this.Timing.Reset(); this.LiveBoard = []; this.dnq.clear();
    this.single = null; this.koRounds = null; this.PlayerCall = ''; this.playerCallUntil = -1;
    this.dnqNums = []; this.dnqSlots.clear(); this.hhLogged = false;
    this.resultCar = -1; this.BoxKind = deps.BoxShow.None; this.BoxCar = -1;
    this.pLaps.clear(); this.pSeen.clear(); this.pLast.clear(); this.pNum.clear(); this.pName.clear(); this.pNextRead = -1;
    this.ResetSaved();
    this.phase = Ph.Timing;
    this.Log('practice session: timing the practice laps for the running order (fastest goes out ' + (this.FastestLast ? 'last' : 'first') + '); the cars run free until the order is set');
  };
  // new line crossings of every car since the last read: each gap between two crossings is a lap
  P.TimingTick = function () {
    if (this.Wall >= this.pNextRead) {
      this.pNextRead = this.Wall + 1;
      const me = this.PlayerReady();
      for (let c = 0; c < 44; c++) {
        if (c === 0 ? !me : (c < 2 || !Known.has(this.St(c)))) continue;
        this.field.add(c);
        this.pNum.set(c, this.Num(c)); this.pName.set(c, this.Name(c));
        let seen = this.pSeen.get(c) || 0;
        const row = Cross0 + c * CrossCar;
        if (seen > 0 && this.m.U32(row + (seen - 1) * 4) === 0) { seen = 0; this.pLast.delete(c); this.pLaps.delete(c); }   // the table was cleared
        for (; seen < CrossCar / 4; seen++) {
          let v = this.m.U32(row + seen * 4);
          if (v === 0) break;
          v = (v & CrossMask) >>> 0;
          const prev = this.pLast.get(c);
          if (prev !== undefined && v > prev) {
            const ms = v - prev;
            if (ms > 5000 && ms < 400000) { if (!this.pLaps.has(c)) this.pLaps.set(c, []); this.pLaps.get(c).push([ms, v]); }
          }
          this.pLast.set(c, v);
        }
        this.pSeen.set(c, seen);
      }
      this.PracticeBoard();
    }
    const bests = this.PracticeBests();
    let top = null;
    for (const [c, b] of bests) if (!top || b[0] < top[1][0] || (b[0] === top[1][0] && b[1] < top[1][1])) top = [c, b];
    this.status = `Timing practice for the running order: ${bests.size} of ${this.field.size} cars have a lap${top ? ' (fastest #' + this.pNum.get(top[0]) + ' ' + msTime(top[1][0]) + ')' : ''}. Then click Set the order from practice.`;
  };
  // each car's best practice lap (ms) and when it was set (its crossing). A lap under 85% of the field's median best is a timing
  // glitch, not a lap: the car's next best counts.
  P.PracticeBests = function () {
    const o = new Map();
    const mins = [...this.pLaps.values()].filter(l => l.length).map(l => Math.min(...l.map(x => x[0]))).sort((a, b) => a - b);
    if (!mins.length) return o;
    const floor = 0.85 * mins[Math.floor(mins.length / 2)];
    for (const [c, laps] of this.pLaps) {
      const ok = laps.filter(l => l[0] >= floor).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      if (ok.length) o.set(c, ok[0]);
    }
    return o;
  };
  P.PracticeBoard = function () {
    const bests = [...this.PracticeBests()].sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1]);
    const b = [];
    let pos = 0, pole = 0;
    for (const [c, t] of bests) {
      if (pos === 0) pole = t[0];
      pos++;
      b.push(`${String(pos).padStart(2)}. #${String(this.pNum.get(c)).padEnd(4)}${msTime(t[0]).padStart(8)}${(pos === 1 ? '' : '+' + msTime(t[0] - pole)).padStart(8)}  ${this.pName.get(c)}`);
    }
    const timed = new Set(bests.map(x => x[0]));
    for (const c of [...this.field].filter(c => !timed.has(c) && this.pNum.has(c)).sort((x, y) => this.pNum.get(x).length - this.pNum.get(y).length || (this.pNum.get(x) < this.pNum.get(y) ? -1 : 1)))
      b.push(`    #${String(this.pNum.get(c)).padEnd(4)}  no lap          ${this.pName.get(c)}`);
    this.Board = b;
  };
  // "Set the order from practice": fastest first (or last with FastestLast); the cars without a lap go to the other end in a random
  // draw. The cars are then called in and held for qualifying. -> the order (car numbers), or null
  P.SetOrderFromPractice = function () {
    if (this.phase !== Ph.Timing || !this.m) return null;
    const bests = this.PracticeBests();
    if (!bests.size) { this.Log("no practice laps yet: the running order can't be set from practice"); return null; }
    const ranked = [...bests].sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1]).map(x => x[0]);
    const noLap = [...this.field].filter(c => !bests.has(c) && this.pNum.has(c)).map(c => [c, this.RndNext()]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    const order = this.FastestLast ? noLap.concat(ranked.slice().reverse()) : ranked.concat(noLap);
    const nums = order.map(c => this.pNum.get(c));
    this.Log('RUNNING ORDER FROM PRACTICE (fastest ' + (this.FastestLast ? 'last' : 'first') + ', ' + ranked.length + ' timed' +
      (noLap.length ? ', ' + noLap.length + ' without a lap ' + (this.FastestLast ? 'first' : 'last') : '') + '): ' +
      order.map(c => '#' + this.pNum.get(c) + (bests.has(c) ? ' ' + msTime(bests.get(c)[0]) : ' -')).join(' '));
    this.Order = nums.join(' ');
    this.NewPractice();
    return nums;
  };
  // "Keep my list": no order from practice this time - the running order list stands; hold the cars now
  P.KeepList = function () {
    if (this.phase !== Ph.Timing || !this.m) return;
    this.Log('practice timing ended without using it: the running order list stands');
    this.NewPractice();
  };

  // ---- saved results (QualControl stage 3) ------------------------------------------------------------------------------------
  // the round each car reached: knockout = the last round it ran in; Indy road = 1 the groups, 2 the Fast 12, 3 the Fast Six; else 1
  P.TakeFinal = function (order) {
    const F = deps.Format;
    this.finalOrder = order.map(o => {
      let round = 1;
      if (this.KnockoutLike) for (let r = 0; r < this.koEntered.length; r++) if (this.koEntered[r].has ? this.koEntered[r].has(o[0]) : this.koEntered[r].includes(o[0])) round = this.Mode === F.IndyRoad ? Math.max(1, r) : r + 1;
      return [o[0], o[1], round];
    });
  };
  // the .car file each session car was loaded from (48 chars at car block +0x11F6), '' if not readable
  P.CarFile = function (c) {
    try {
      const s = this.m.Str(Block0 + c * Stride + CAR_FILE_OFF, 48).trim();
      return /\.car$/i.test(s) && /^[\x20-\x7e]+$/.test(s) ? s : '';
    } catch (e) { return ''; }
  };
  P.SaveResults = function (file) {
    if (!this.HasResults) return 'no qualifying results to save yet';
    try {
      const k = this.exactTimes ? 1.0 : this.writtenPaceK, sc = (x) => Math.round(x * k);
      const r = { Track: this.finalTrack || this.TrackName, Type: this.finalType || this.TypeKey, Series: this.finalSeries || this.SeriesName, Saved: new Date(), Pace: k, Cars: [], Dnq: [], Sources: [] };
      let pos = 0;
      for (const f of this.finalOrder) {
        const laps = this.runs.get(f[0]);
        r.Cars.push({ Pos: ++pos, Round: f[2], Time: f[1] != null ? sc(f[1]) : null, Num: this.runNums.has(f[0]) ? this.runNums.get(f[0]) : this.Num(f[0]),
          Name: this.finalNames && this.finalNames.has(f[0]) ? this.finalNames.get(f[0]) : this.Name(f[0]),
          File: this.finalFiles ? (this.finalFiles.get(f[0]) || '') : this.CarFile(f[0]), IsPlayer: f[0] === 0, IsDnq: this.dnqSlots.has(f[0]),
          Laps: laps ? laps.map(sc) : [], Source: -1 });
      }
      r.Dnq = this.dnqNums.slice();
      writeResultsFile(r, file);
      this.savedPath = file;
      const msg = `${this.finalOrder.length} cars to ${path.basename(file)}${k !== 1.0 ? ` (times as the game was given them, pace x${k.toFixed(4)})` : ''}`;
      this.Log('results saved: ' + msg);
      return 'saved ' + msg;
    } catch (e) { this.Log("couldn't save the results: " + e.message); return "couldn't save: " + e.message; }
  };
  // a saved car -> this session's slot: the player's entry is the player's car; else by .car file or car number
  P._match = function (car, useFiles, byFile, bySlot) {
    if (car.IsPlayer) return this.PlayerReady() ? 0 : -1;
    if (useFiles && car.File) { const c = byFile.get(car.File.toLowerCase()); return c !== undefined && c !== 0 ? c : -1; }
    const c = bySlot.get(car.Num);
    return c === undefined ? -1 : c;
  };
  // Reapply: the file's times become this weekend's qualifying times, written exactly in the qualifying session (now if it is running,
  // else when it loads). Cars are matched by .car file (two rosters can share numbers), else car number; the file's cars not here are
  // skipped, cars here not in the file go to the back. -> what happened
  P.ReapplyResults = function (f) {
    if (!this.m) return 'start NR2003 and load the weekend first';
    if (this.phase === Ph.Holding || this.phase === Ph.Running || this.phase === Ph.Break || this.phase === Ph.Done) { this.LetGo(); this.FinalState(); }
    if (this.phase === Ph.Grid) this.FinishGrid();
    this.single = null; this.koRounds = null;
    const bySlot = new Map(), byFile = new Map();
    for (const c of this.QualSlots()) {
      if (c === 0 ? !this.PlayerReady() : !this.IsAi(c)) continue;
      bySlot.set(this.Num(c), c);
      const cf = this.CarFile(c);
      if (cf) byFile.set(cf.toLowerCase(), c);
    }
    const useFiles = byFile.size > 0 && f.Cars.some(x => x.File);
    this.runs.clear(); this.runNums.clear(); this.dnqNums = []; this.dnqSlots.clear();
    const order = [], rounds = [], missing = [], names = new Map(), files = new Map();
    for (const car of f.Cars) {
      const c = this._match(car, useFiles, byFile, bySlot);
      if (c < 0) { missing.push('#' + car.Num + (useFiles && car.File ? ' (' + car.File + ')' : '')); continue; }
      if (!car.Laps.length || this.runs.has(c)) continue;
      this.runs.set(c, car.Laps.slice()); this.runNums.set(c, this.Num(c)); names.set(c, car.Name); files.set(c, car.File || this.CarFile(c));
      order.push([c, car.Time]); rounds.push(car.Round);
    }
    if (!this.runs.size) { this.ResetSaved(); this.phase = Ph.Idle; return "none of the file's cars are in this session (matched by car number)"; }
    for (const car of f.Cars.filter(x => x.IsDnq)) {
      const c = this._match(car, useFiles, byFile, bySlot);
      if (c >= 0 && !this.dnqSlots.has(c)) { this.dnqNums.push(this.Num(c)); this.dnqSlots.add(c); }
    }
    this.WriteResults('SAVED RESULTS REAPPLIED (' + path.basename(f.Path || '') + ', ' + f.Track + ', ' + f.Type + ')', order);
    this.finalOrder = order.map((o, i) => [o[0], o[1], rounds[i]]);          // (the rounds come from the file, not from this session)
    this.exactTimes = true; this.writtenPaceK = 1.0; this.savedPath = null; this.finalTrack = f.Track; this.finalType = f.Type; this.finalNames = names; this.finalFiles = files; this.finalSeries = f.Series;
    this.Log('reapply: cars matched by ' + (useFiles ? '.car file' : 'car number'));
    if (missing.length) this.Log('reapply: not in this session, skipped: ' + missing.join(' '));
    const extra = bySlot.size - this.runs.size;
    if (extra > 0) this.Log('reapply: ' + extra + ' car(s) in this session have no saved time: they go to the back');
    this.SaveRuns();
    this.gridWritten = false; this.gridWaitLogged = false;
    this.phase = Ph.GridWait;
    let msg = this.runs.size + " cars' times reapplied from " + path.basename(f.Path || '') + ' (written exactly as saved)';
    if (this.SessionKind() === 5) { this.StartGrid(); msg += ': writing them in this qualifying session now'; }
    else msg += ': they are written when the qualifying session loads (no custom qualifying in this practice)';
    this.Log(msg);
    this.status = 'Saved results reapplied (' + this.runs.size + ' cars): ' + (this.SessionKind() === 5 ? 'writing them in this qualifying session.' : 'go to the qualifying session.');
    return msg;
  };
  void LapFmt;
}

// ---- results files (text, one car a line) ------------------------------------------------------------------------------------
//   QualControl results 1 / track / type / series / saved <iso> / pace <k> / source <i> <file> / car <pos> <num> <round> <time|-> <laps|-> <name>
//   / file <pos> <car file> / player <pos> / from <pos> <source> / dnq <nums> / dnqpos <positions>
function writeResultsFile(r, file) {
  const L = ['QualControl results 1', 'track ' + r.Track, 'type ' + r.Type];
  if (r.Series) L.push('series ' + r.Series);
  L.push('saved ' + new Date(r.Saved || Date.now()).toISOString(), 'pace ' + Number(r.Pace || 1).toFixed(4));
  (r.Sources || []).forEach((s, i) => L.push('source ' + i + ' ' + s));
  for (const c of r.Cars) {
    L.push(`car ${c.Pos} ${c.Num} ${c.Round} ${c.Time != null ? c.Time : '-'} ${c.Laps && c.Laps.length ? c.Laps.join(',') : '-'} ${c.Name}`);
    if (c.File) L.push('file ' + c.Pos + ' ' + c.File);
    if (c.IsPlayer) L.push('player ' + c.Pos);
    if (c.Source >= 0) L.push('from ' + c.Pos + ' ' + c.Source);
  }
  if (r.Dnq && r.Dnq.length) L.push('dnq ' + r.Dnq.join(' '));
  if (r.Cars.some(c => c.IsDnq)) L.push('dnqpos ' + r.Cars.filter(c => c.IsDnq).map(c => c.Pos).join(' '));
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, L.join('\r\n') + '\r\n');
}
function readResultsFile(file) {
  const o = { Path: file, Track: '', Type: '', Series: '', Saved: null, Pace: 1, Cars: [], Dnq: [], Sources: [] };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  if (!lines.length || !lines[0].startsWith('QualControl results')) throw new Error('not a QualControl results file');
  const files = new Map(), froms = new Map(), sources = new Map(), players = new Set(), dnqPos = new Set();
  for (const raw of lines.slice(1)) {
    const l = raw.trim(), sp = l.indexOf(' ');
    if (sp < 0) continue;
    const k = l.slice(0, sp), v = l.slice(sp + 1).trim(), p2 = v.indexOf(' '), n0 = p2 > 0 ? parseInt(v.slice(0, p2), 10) : NaN, keyed = p2 > 0 && Number.isFinite(n0);
    if (k === 'track') o.Track = v; else if (k === 'type') o.Type = v; else if (k === 'series') o.Series = v;
    else if (k === 'saved') o.Saved = new Date(v); else if (k === 'pace') o.Pace = parseFloat(v) || 1;
    else if (k === 'dnq') o.Dnq = v.split(' ').filter(Boolean);
    else if (k === 'file' && keyed) files.set(n0, v.slice(p2 + 1).trim());
    else if (k === 'player') { const pp = parseInt(v, 10); if (Number.isFinite(pp)) players.add(pp); }
    else if (k === 'dnqpos') for (const x of v.split(' ')) { const pp = parseInt(x, 10); if (Number.isFinite(pp)) dnqPos.add(pp); }
    else if (k === 'source' && keyed) sources.set(n0, v.slice(p2 + 1).trim());
    else if (k === 'from' && keyed) { const s = parseInt(v.slice(p2 + 1), 10); if (Number.isFinite(s)) froms.set(n0, s); }
    else if (k === 'car') {
      const f = splitN(v, ' ', 6);
      if (f.length < 5) continue;
      const t = parseInt(f[3], 10);
      o.Cars.push({ Pos: parseInt(f[0], 10) || 0, Num: f[1], Round: Math.max(1, parseInt(f[2], 10) || 1), Time: Number.isFinite(t) && t > 0 && /^\d+$/.test(f[3]) ? t : null,
        Laps: f[4] !== '-' ? f[4].split(',').map(x => parseInt(x, 10)).filter(n => n > 0) : [], Name: f.length > 5 ? f[5] : '', File: '', Source: -1, IsPlayer: false, IsDnq: false });
    }
  }
  for (const c of o.Cars) {
    if (files.has(c.Pos)) c.File = files.get(c.Pos);
    if (froms.has(c.Pos)) c.Source = froms.get(c.Pos);
    c.IsPlayer = players.has(c.Pos);
    c.IsDnq = dnqPos.size > 0 ? dnqPos.has(c.Pos) : o.Dnq.includes(c.Num);     // (files before 0.5.0: by number)
  }
  o.Sources = [...sources.keys()].sort((a, b) => a - b).map(k => sources.get(k));
  return o;
}
// C#'s Split(new[] {' '}, n): at most n parts, the last one keeps the rest (empty parts kept)
function splitN(s, sep, n) { const out = []; let rest = s; while (out.length < n - 1) { const i = rest.indexOf(sep); if (i < 0) break; out.push(rest.slice(0, i)); rest = rest.slice(i + 1); } out.push(rest); return out; }

// ---- merging sessions (Merge.cs) -------------------------------------------------------------------------------------------
// ranked by the round reached first, then the time (no time last); a driver in more than one session keeps the best; ties go to the
// earlier session, then the place within it; a driver is its .car file (else car number + name). Only where the merged order needs it
// a car's time is raised to 1 ms behind the car ahead.
const mergeKey = (c) => (c.IsPlayer ? 'player' : c.File ? 'file:' + c.File.toLowerCase() : 'num:' + c.Num + '|' + String(c.Name || '').trim().toLowerCase());
function merge(sessions) {
  const all = [];
  sessions.forEach((s, i) => { for (const c of s.Cars) all.push({ Car: c, Session: i, Key: mergeKey(c), Written: 0, Raised: false, Others: [] }); });
  const big = 2147483647;
  all.sort((a, b) => (b.Car.Round - a.Car.Round) || ((a.Car.Time != null ? 0 : 1) - (b.Car.Time != null ? 0 : 1)) || ((a.Car.Time != null ? a.Car.Time : big) - (b.Car.Time != null ? b.Car.Time : big)) || (a.Session - b.Session) || (a.Car.Pos - b.Car.Pos));
  const kept = [], byKey = new Map();
  for (const e of all) { const k = byKey.get(e.Key); if (k) { k.Others.push(e.Session); continue; } byKey.set(e.Key, e); kept.push(e); }
  let last = 0;
  for (const e of kept) {
    const want = e.Car.Time != null ? e.Car.Time : last + 100;
    e.Written = Math.max(want, last + 1);
    e.Raised = e.Car.Time != null && e.Written !== e.Car.Time;
    last = e.Written;
  }
  return kept;
}
// the race field: the top `cars` (the player's car counts as one); with playerAlwaysIn the player makes it from any place
function field(merged, cars, playerAlwaysIn) {
  const f = new Set(merged.slice(0, Math.max(0, cars)));
  const me = merged.find(e => e.Car.IsPlayer);
  if (playerAlwaysIn && me && !f.has(me) && cars > 0) {
    const lastAi = merged.slice(0, cars).filter(e => !e.Car.IsPlayer).pop();
    if (lastAi) f.delete(lastAi);
    f.add(me);
  }
  return f;
}
function toResults(sessions, merged, fieldSet) {
  const uniq = (a) => [...new Set(a)];
  const r = { Track: uniq(sessions.map(s => s.Track)).join(' + '), Type: 'merged ' + uniq(sessions.map(s => s.Type)).join('+'),
    Series: uniq(sessions.map(s => s.Series).filter(Boolean)).join(' + '), Saved: new Date(), Pace: 1, Sources: sessions.map(s => path.basename(s.Path || '')), Cars: [], Dnq: [] };
  let pos = 0;
  for (const e of merged) {
    const c = e.Car;
    const lapsOk = !e.Raised && c.Time != null && c.Laps.length > 0 && (Math.min(...c.Laps) === c.Time || c.Laps.every(x => x === c.Time));
    r.Cars.push({ Pos: ++pos, Num: c.Num, Name: c.Name, File: c.File, Round: c.Round, Time: c.Time, Source: e.Session, IsPlayer: c.IsPlayer, IsDnq: false, Laps: lapsOk ? c.Laps.slice() : [e.Written] });
  }
  if (fieldSet) { merged.forEach((e, i) => { r.Cars[i].IsDnq = !fieldSet.has(e); }); r.Dnq = r.Cars.filter(c => c.IsDnq).map(c => c.Num); }
  return r;
}
// The race roster: a copy of a roster .lst (every line kept, in order, same line ends) with only the + / - marks changed: + for the
// field's AI cars (by .car file), - for every other line. A field car the roster doesn't list is added at the end with +.
// (Read and written byte for byte: roster lines are file names.) -> { text, added, marked }
function roster(baseText, fieldFiles) {
  const nl = baseText.includes('\r\n') ? '\r\n' : '\n', endNl = baseText.endsWith('\n');
  const want = new Map(); for (const f of fieldFiles) if (f) want.set(f.toLowerCase(), f);
  const seen = new Set();
  const lines = baseText.replace(/\r\n/g, '\n').split('\n');
  if (endNl) lines.pop();
  let marked = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length < 2 || (l[0] !== '+' && l[0] !== '-')) continue;
    const name = l.slice(1), inField = want.has(name.trim().toLowerCase());
    if (inField) { seen.add(name.trim().toLowerCase()); marked++; }
    lines[i] = (inField ? '+' : '-') + name;
  }
  const added = [...want.keys()].filter(k => !seen.has(k)).map(k => want.get(k)).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  for (const a of added) lines.push('+' + a);
  return { text: lines.join(nl) + (endNl ? nl : ''), added, marked };
}

module.exports = { install, writeResultsFile, readResultsFile, merge, field, toResults, roster, mergeKey };
