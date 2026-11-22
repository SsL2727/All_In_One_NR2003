// RaceControl engine part: pit road timing (when pits open), the pit road gate, pit entry learning, state hand-off.
'use strict';
const { r0, f2, f1, f3t, pct } = require('../format');
const fs = require('fs');
const A = require('../addr');
const { GameMemoryError } = require('../gamemem');

const mod = (a, b) => { const n = a % b; return n < 0 ? n + b : n; };
const stableBy = (arr, key, desc) => arr.map((v, i) => [v, i]).sort((a, b) => { const d = desc ? key(b[0]) - key(a[0]) : key(a[0]) - key(b[0]); return d || (a[1] - b[1]); }).map(x => x[0]);

module.exports = function (E) {
  const P = E.prototype;

  // pit_lane merge points from a track.ini: [[merge_to_pit_line_dlong, pit_lane_start_dlong], ...]
  E.ReadPitMerges = function (trackIni) {
    const lanes = [];
    let merge = NaN, start = NaN, inLane = false;
    const flush = () => { if (inLane && !Number.isNaN(merge) && !Number.isNaN(start)) lanes.push([merge, start]); };
    for (const line of fs.readFileSync(trackIni, 'latin1').split(/\r?\n/)) {
      const t = line.split(';')[0].trim();
      if (t.startsWith('[')) {
        flush();
        inLane = t.replace(/^[\[\] \t]+|[\[\] \t]+$/g, '').toLowerCase().startsWith('pit_lane');
        merge = start = NaN;
        continue;
      }
      const eq = t.indexOf('=');
      if (!inLane || eq < 0) continue;
      const k = t.substring(0, eq).trim().toLowerCase();
      const v = parseFloat(t.substring(eq + 1).trim());
      if (!Number.isNaN(v) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t.substring(eq + 1).trim())) {
        if (k === 'merge_to_pit_line_dlong') merge = v; else if (k === 'pit_lane_start_dlong') start = v;
      }
    }
    flush();
    return lanes;
  };

  P.EntryPoint = function (trackLen) {
    if (!Number.isNaN(this.PitEntry) && this.PitEntry >= 0.0 && this.PitEntry < trackLen) return this.PitEntry;
    if (!this.fallbackLogged) {
      this.fallbackLogged = true;
      this.Log(`pit entry not seen at this track yet: assuming ${r0(trackLen * 0.85)} m (85% of the lap) until a car pits`);
    }
    return trackLen * 0.85;
  };

  P.OpenPoint = function (trackLen) {
    const num = this.EntryPoint(trackLen);
    let result = num, num2 = 0.0, text = null;
    for (const pm of this.PitMerges) {
      if (!(pm[0] < 0.0) && !(pm[0] >= trackLen)) {
        const n3 = mod(num - pm[0], trackLen);
        if (!(n3 > trackLen / 2.0) && !(n3 <= num2)) {
          num2 = n3; result = pm[0];
          text = `${r0(pm[0])} m, pit lane proper at ${r0(pm[1])} m`;
        }
      }
    }
    this.openPointName = text != null ? 'where cars move over for pit road' : 'pit entry';
    const key = text + '|' + trackLen;
    if (text != null && this.mergeLoggedFor !== key) {
      this.mergeLoggedFor = key;
      this.Log(`pits open from where cars move over for pit road (the track's settings: ${text}), ${r0(num2)} m before pit entry`);
    }
    return result;
  };

  P.LearnPitEntry = function () {
    const trackLen = this.m.F64(A.TrackLength);
    if (trackLen <= 100.0) return;
    for (let i = 0; i <= this.maxIdx && i < 64; i++) {
      if (i === 1) continue;
      const on = this.Running(i) && this.OnPitRoad(i);
      if (on && !this.wasOnPitRoad[i] && this.entrySeen) this.entrySamples.push(this.DlongOf(i));
      this.wasOnPitRoad[i] = on;
    }
    this.entrySeen = true;
    if (this.entrySamples.length > 15) this.entrySamples.splice(0, this.entrySamples.length - 15);
    if (this.entrySamples.length < 3) return;
    const dist = (a, b) => Math.abs(mod(a - b + trackLen / 2.0, trackLen) - trackLen / 2.0);
    const best = stableBy(this.entrySamples, s => this.entrySamples.reduce((acc, o) => acc + Math.min(dist(s, o), 100.0), 0))[0];
    if (Number.isNaN(this.PitEntry) || !(dist(best, this.PitEntry) < 5.0)) {
      this.PitEntry = best;
      this.Log(`pit entry is at ${r0(best)} m from the line (${this.entrySamples.length} cars seen)`);
      if (this.PitEntryLearned) this.PitEntryLearned(best);
    }
  };

  P.HoldPitsClosed = function () {
    const m = this.m;
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i !== 1 && this.Running(i) && !this.OnPitRoad(i) && m.U8(A.Pitting + i * A.Ocd) !== 0 && !this.MinSpeedFlagged(i)) {
        m.W8(A.Pitting + i * A.Ocd, 0);
        if (!this.requestsCancelled.has(i)) { this.requestsCancelled.add(i); this.Log(`pits closed: #${this.CarNumber(i)}'s pit request called off`); }
      }
    }
    if (!this.closedLogged) this.Log(this.OpenWhenPacked ? "pits closed until the field is packed up behind the pace car (at the latest the leader's second time by)" : "pits closed until the leader's second time by");
    this.closedLogged = true;
    this.CloseGate();
    this.PublishPitsClosed(true);
  };

  P.CloseGate = function () {
    const m = this.m;
    const text = m.I32(A.PitGate) + '/' + m.I32(7796071);
    for (let i = 0; i < 2; i++) if (m.I32(A.PitGate + i * 4) !== 3) m.W32(A.PitGate + i * 4, 3);
    if (!this.gateClosed) this.Log(`pit road gate closed for every car (the game had ${text})`);
    this.gateClosed = true;
  };

  P.GatedCars = function () {
    const list = [];
    const tl = this.m.F64(A.TrackLength);
    for (const [k, v] of this.eligible) {
      if (v.Pitted || !this.Running(k) || this.OnPitRoad(k)) continue;
      const st = this.settle.get(k);
      const atLine = this.WaveAtLine && tl >= 3203.0 && st !== undefined && st.Waved && !st.LeadLap && !st.FreePass;
      if (!v.Restored || atLine) list.push(k);
    }
    for (const k of this.stuckAtOpen) if (!this.eligible.has(k) && !this.pitted.has(k) && this.Running(k) && !this.OnPitRoad(k)) list.push(k);
    if (this.OneStopPerCaution) for (const k of this.stopped) if (!list.includes(k) && this.Running(k) && !this.OnPitRoad(k)) list.push(k);
    return list.filter(k => !this.MinSpeedFlagged(k));
  };

  // All In One NR2003: a car that has been on pit road with the pits open has had its stop for this caution; pit road stays shut for it until the green
  // (the game or AIMOD sends cars in again "without a request", or for a penalty that is forgiven)
  P.WatchStops = function () {
    for (let k = 0; k <= this.maxIdx && k < 48; k++) {
      if (k === 1 || this.stopped.has(k) || !this.Running(k) || !this.OnPitRoad(k) || this.pitRoadAtCaution.has(k) || this.MinSpeedFlagged(k)) continue;
      this.stopped.add(k);
      this.Log(`#${this.CarNumber(k)} is making its stop under this caution: pit road shuts for it once it leaves, until the green`);
    }
  };

  // put the game's own per-car gate bytes back for the cars we shut
  P.RestoreCarGateBytes = function (only) {
    for (const [k, v] of Array.from(this.gateSaved.entries())) {
      if (only && !only.includes(k)) continue;
      try { this.m.W8(A.PitGateCar + k, v); } catch (e) { /* ignore */ }
      this.gateSaved.delete(k);
    }
  };

  P.PerCarGateTick = function () {
    const m = this.m;
    const onWave = this.GateCatchingCars && this.WaveAroundOn && this.pitsOpen && this.flag >= 1 && this.flag <= (this.GateThroughOneToGo ? 5 : 4);     // All In One NR2003: through one to go too, so cars waved then (the pit stops were not done before) do not turn into pit road; off = the original RaceControl
    const onStop = this.OneStopPerCaution && this.pitsOpen && this.flag >= 1 && this.flag <= 5;
    if (onStop) this.WatchStops();
    const on = onWave || onStop;
    if (onWave && !this.stuckTaken) {
      this.stuckTaken = true;
      const list = this.Field();
      if (list != null) for (const item of list) if (item.Stuck && !this.eligible.has(item.Idx)) this.stuckAtOpen.add(item.Idx);
      const g = this.GatedCars();
      if (g.length > 0) {
        this.Log('pit road stays shut for' + g.map(i => this.CarNumber(i)).sort((a, b) => a - b).map(n => ' #' + n).join('') + ' (caught in front of the leader or going around the pace car) until each has crossed the line after passing the pace car');
      }
      for (const i of g) this.gateLogged.add(i);
    }
    const held = on ? this.GatedCars() : [];
    for (const item of Array.from(this.gateLogged).filter(i => !held.includes(i))) {
      this.gateLogged.delete(item);
      if (on) this.Log(`pit road open for #${this.CarNumber(item)} now`);
    }
    this.RestoreCarGateBytes(Array.from(this.gateSaved.keys()).filter(k => !held.includes(k)));
    if (held.length === 0) {
      if (this.perCarGate) { this.perCarGate = false; this.RestoreGate(); }
      return;
    }
    this.perCarGate = true;
    for (let j = 0; j < 2; j++) if (m.I32(A.PitGate + j * 4) !== 1) m.W32(A.PitGate + j * 4, 1);
    for (let k = 0; k <= this.maxIdx && k < 48; k++) {
      const isHeld = held.includes(k);
      if (isHeld && this.OneStopPerCaution && !this.gateSaved.has(k)) this.gateSaved.set(k, m.U8(A.PitGateCar + k));
      if (isHeld || this.OpenPitsToAll) {
        const v = !isHeld ? 1 : 0;
        if (m.U8(A.PitGateCar + k) !== v) m.W8(A.PitGateCar + k, v);
      }
    }
    for (const item of held) {
      if (!this.gateLogged.has(item)) { this.gateLogged.add(item); this.Log(this.stopped.has(item) ? `pit road shut for #${this.CarNumber(item)} (its stop is done) until the green` : `pit road shut for #${this.CarNumber(item)} (going around the pace car) until it has crossed the line after passing it`); }
      if (!this.OnPitRoad(item) && m.U8(A.Pitting + item * A.Ocd) !== 0) {
        m.W8(A.Pitting + item * A.Ocd, 0);
        if (!this.requestsCancelled.has(item)) { this.requestsCancelled.add(item); this.Log(`pit road still shut for #${this.CarNumber(item)}: its pit request called off`); }
      }
    }
  };

  P.RestoreGate = function () {
    try {
      const v = (!this.OpenPitsToAll && this.flag < 3) ? 1 : 2;
      for (let i = 0; i < 2; i++) this.m.W32(A.PitGate + i * 4, v);
    } catch (e) { /* ignore, like RaceControl */ }
  };

  P.EndPerCarGate = function () {
    this.gateLogged.clear();
    this.RestoreCarGateBytes();
    if (this.perCarGate) { this.perCarGate = false; this.RestoreGate(); }
  };

  P.OpenGate = function (why) {
    if (!this.gateClosed) return;
    this.gateClosed = false;
    try {
      const num = (!this.OpenPitsToAll && this.flag < 3) ? 1 : 2;
      for (let i = 0; i < 2; i++) this.m.W32(A.PitGate + i * 4, num);
      this.Log(`pit road gate opened (${num === 2 ? 'all cars' : 'lead lap cars, the rest when the game opens it'}): ${why}`);
    } catch (e) { /* ignore */ }
  };

  P.PublishPitsClosed = function (closed) {
    const text = this.StageEndsLine();
    const text2 = (this.shuttingDown || !this.InRace) ? null : (this.WaveAroundOn ? '1' : '0');
    const secs = Date.now() / 1000 - this.lastPublish;
    if (closed === this.publishedClosed && text === this.publishedStages && text2 === this.publishedWave) {
      let skip;
      if (!closed) { if (text == null && text2 == null) return; skip = secs < 2.0; } else skip = secs < 1.0;
      if (skip) return;
    }
    try { if (this.writeState) this.writeState('pits_closed=' + (closed ? '1' : '0') + '\r\n' + (text != null ? 'stage_ends=' + text + '\r\n' : '') + (text2 != null ? 'wave_around=' + text2 + '\r\n' : '')); } catch (e) { /* ignore */ }
    this.publishedClosed = closed;
    this.publishedStages = text;
    this.publishedWave = text2;
    this.lastPublish = Date.now() / 1000;
  };

  P.StageEndsLine = function () {
    if (this.shuttingDown || !this.InRace) return null;
    const a = this.CurrentStageEnds();
    return a != null && a.length !== 0 ? a.slice().sort((x, y) => x - y).join(',') : null;
  };

  P.PublishState = function () { this.PublishPitsClosed(this.publishedClosed); };

  P.PitsOpenTick = function () {
    if (this.pitsOpen) return true;
    if (!this.PitsClosedFirstLap) {
      this.OpenGate('closed first lap switched off');
      this.PublishPitsClosed(false);
      this.pitsOpen = this.flag >= 1;
      if (this.pitsOpen && this.Classic) this.Log("pits open on the game's own timing (classic rules: lead lap cars now, lapped cars from the game's next pace lap)");
      return this.pitsOpen;
    }
    const num = this.m.F64(A.TrackLength);
    let leader = null, list = null;
    if (num > 100.0) { const f = this.FieldFull(); if (f) { list = f.list; leader = f.leader; } }
    if (this.flag >= 5 || (list == null && this.flag >= 3)) { this.OpenNow("one to go came before the leader's second time by"); return true; }
    this.HoldPitsClosed();
    if (this.flag < 1 || list == null) return false;
    const n2 = this.OpenPoint(num);
    const n3 = mod(n2 - this.DlongOf(leader.Idx), num);
    if (leader.Idx !== this.entryLeader) { this.entryLeader = leader.Idx; this.leaderToEntry = -1.0; }
    if (this.leaderToEntry >= 0.0 && n3 > this.leaderToEntry + num / 2.0) {
      if (this.leaderPasses === 0 || this.PaceCarHasLeader(leader, num)) this.leaderPasses++;
      else this.Log(`leader #${leader.Num} went by pit road again before the pace car picked it up: that time by doesn't count`);
    }
    this.leaderToEntry = n3;
    if (n3 > num * 0.25) return false;
    const gate = this.WaveAroundOn && this.GateCatchingCars;
    const text = this.NotPickedUp(list, leader, false, gate && this.leaderPasses >= 1);
    if (this.leaderPasses < 1) {
      const t2 = (this.OpenWhenPacked && text == null) ? this.Packed(list) : null;
      if (t2 == null) return false;
      this.OpenNow(`leader #${leader.Num} is ${r0(n3)} m from ${this.openPointName} on its first time by and the field is packed up (${t2})`);
      return true;
    }
    if (text != null && this.leaderPasses < 2) {
      if (this.heldFor == null || text.replace(/\(\d+ m/g, '(') !== this.heldFor.replace(/\(\d+ m/g, '(')) this.Log("pits stay closed on the leader's second time by: " + text);
      this.heldFor = text;
      return false;
    }
    this.OpenNow(`leader #${leader.Num} is ${r0(n3)} m from ${this.openPointName} on its ${this.leaderPasses < 2 ? 'second' : 'third'} time by${text != null ? ' (opened anyway: ' + text + ')' : (this.heldFor != null ? ' (the field is lined up behind the pace car now)' : '')}`);
    return true;
  };

  P.NotPickedUp = function (cars, leader, anyCatching, gated) {
    if (anyCatching === undefined) anyCatching = false;
    if (gated === undefined) gated = false;
    const stuck = stableBy(cars.filter(c => c.Stuck && !this.eligible.has(c.Idx)), c => c.Num);
    if (stuck.length > 0 && !gated) return 'lead lap car(s)' + stuck.map(c => ' #' + c.Num).join('') + ' still in front of the leader';
    const catching = cars.filter(c => this.sentEarly.has(c.Idx) && !this.eligible.get(c.Idx).Pitted);
    let rest = cars.filter(c => !catching.includes(c));
    if (gated) rest = rest.filter(c => !c.Stuck);
    const tail = rest.length > 0 ? Math.max(...rest.map(c => c.Gap)) : 0.0;
    const list3 = stableBy(catching.filter(c => this.GoingAround(c.Idx) || c.Gap > tail + 100.0), c => c.Num);
    if (list3.length > 0 && !anyCatching && !gated) return '#' + list3.map(c => c.Num).join(' #') + ' sent around, still catching the back of the field';
    const lead = cars.find(c => c.Idx === leader.Idx);
    if (!lead) return null;
    const tlen = this.m.F64(14339852);
    if (tlen > 100.0 && !this.PaceCarHasLeader(lead, tlen)) return `the pace car has not picked up leader #${lead.Num} yet (${lead.Gap >= tlen / 2.0 ? 'the leader is in front of it' : 'it is still on pit road'})`;
    let num = 0.0;
    for (const item of stableBy(cars.filter(c => c.Gap <= lead.Gap && !catching.includes(c)), c => c.Gap)) {
      if (item.Gap - num > (num === 0.0 ? 150 : 100)) return `the pace car has not picked up leader #${lead.Num} yet (${r0(lead.Gap)} m behind it)`;
      num = item.Gap;
    }
    if (!this.PaceFixes && this.Packed(cars.filter(c => !catching.includes(c))) == null) return 'the field is still strung out behind the pace car';
    return null;
  };

  P.Packed = function (cars) {
    const list = stableBy(cars, c => c.Gap);
    if (list.length < 2 || list[0].Gap > 120.0) return null;
    let num = 0, num2 = 0.0;
    for (let i = 1; i < list.length; i++) {
      const d = list[i].Gap - list[i - 1].Gap;
      if (d > 60.0 && ++num > 2) return null;
      if (d <= 60.0) num2 = list[i].Gap;
    }
    return `${list.length - num} cars in ${r0(num2)} m${num > 0 ? ', ' + num + ' straggling' : ''}`;
  };

  P.OpenNow = function (why) {
    this.pitsOpen = true;
    this.OpenGate('pits open');
    this.PublishPitsClosed(false);
    this.Log('pits open' + (this.OpenPitsToAll ? ' to all cars' : '') + ': ' + why);
  };

  P.StartEntryWatch = function () { this.toEntry.clear(); this.passedEntry.clear(); this.readyToDecide.clear(); };

  P.EntryWatchTick = function () {
    const num = this.m.F64(A.TrackLength);
    if (num <= 100.0) return;
    const n2 = this.EntryPoint(num);
    for (let i = 0; i <= this.maxIdx; i++) {
      if (i !== 1 && this.Running(i) && !this.readyToDecide.has(i)) {
        const n3 = mod(n2 - this.DlongOf(i), num);
        if (this.toEntry.has(i) && this.toEntry.get(i) < num * 0.25 && n3 > num * 0.75) this.passedEntry.add(i);
        this.toEntry.set(i, n3);
        if (this.passedEntry.has(i) && (n3 <= num - 60.0 || this.OnPitRoad(i))) this.readyToDecide.add(i);
      }
    }
  };

  P.Shutdown = function () {
    this.shuttingDown = true;
    this.RestoreTail('RaceControl closing');
    this.RestorePaceSpeed('RaceControl closing');
    this.ResetPaceCar();
    this.EndLowLine('RaceControl closing');
    this.RestoreContact();
    this.OpenGate('RaceControl closing');
    this.EndPerCarGate();
    this.PublishPitsClosed(false);
  };

  // car-to-car contact back on for every car left ghosted (RaceControl closing)
  P.RestoreContact = function () {
    const m = this.m;
    let n = 0;
    for (let i = 0; i < 48; i++) {
      try {
        const load = m.U8(A.CarClassLoad + i * A.Ocd);
        if (load !== 0 && m.U8(A.CarClass + i * A.Ocd) === 0) { m.W8(A.CarClass + i * A.Ocd, load); n++; }
      } catch (e) { if (e instanceof GameMemoryError) return; throw e; }
    }
    this.ghostEndWanted.clear();
    if (n > 0) this.Log('car-to-car contact back on for ' + n + ' car(s) (RaceControl closing)');
  };

  P.ReleaseClosedBit = function () { this.OpenGate('caution over'); this.EndPerCarGate(); this.PublishPitsClosed(false); };

  P.ResetPits = function () {
    this.pitsOpen = this.closedLogged = false;
    this.heldFor = null;
    this.requestsCancelled.clear();
    this.entryLeader = -1; this.leaderPasses = 0; this.leaderToEntry = -1.0;
    this.stuckAtOpen.clear(); this.stuckTaken = false;
    this.StartEntryWatch();
  };
};
