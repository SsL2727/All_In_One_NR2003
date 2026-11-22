// RaceTracker — turns the bridge's telemetry frames (the same JSON the overlays
// receive on ws://localhost:8765) into a raw race record for the season engine.
//
// Pure logic: feed it frames with ingest(frame). It reports through callbacks
// and never touches the network or disk, so it can be unit-tested with synthetic
// frames and driven from the main process with a real WebSocket.
//
// Telemetry fields used (all already consumed by the shipped overlays):
//   session, sessionState, sessionFlag, sessionCookie, sessionNum, track,
//   trackNameShort, lapsTotal, lapsComplete, standings[], computedStandings[],
//   liveStandings[], drivers[], stageWinners[{stage,carIdx,pos}],
//   fastestLap, fastestCarIdx, averageLapTime, cautionPhase, atTrack, reset
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.PSFRaceTracker = factory(root.PSFSeasonEngine);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  const PASS_STABLE_FRAMES = 6;     // an order must hold this many frames before it counts
  const PASS_MAX_JUMP = 3;          // bigger single-event shuffles are pit cycles, not passes
  const QUALITY_POS = 15;           // "quality pass" = passing a top-15 car
  const MIN_LAP_SECONDS = 5;
  const FASTEST_LAP_FLOOR = 0.85;   // ignore laps >15% faster than a typical green lap (telemetry glitches)

  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }

  class RaceTracker {
    constructor(opts) {
      opts = opts || {};
      this.onRaceComplete = opts.onRaceComplete || function () {};
      this.onLive = opts.onLive || function () {};
      this.onStatus = opts.onStatus || function () {};
      this.log = opts.log || function () {};
      this.trackPasses = opts.trackPasses !== false;
      this._reset();
    }

    _reset() {
      this.ctx = null;
    }

    _newContext(d) {
      return {
        cookie: d.sessionCookie, sessionNum: d.sessionNum, track: d.track || '', trackShort: d.trackNameShort || d.track || '',
        lapsTotal: 0, sawRacing: false, sawCheckered: false, committed: false,
        carInfo: {},                    // carIdx -> {name, number}
        ledLaps: {}, lastLapsComplete: 0,
        stages: {},                     // stage -> { pos -> carIdx }
        fastest: null, lapRef: 0,
        gfp: {}, qp: {},
        stableOrder: null, candOrder: null, candCount: 0,
        finalStandings: null, finalSource: '',
        liveHash: '', startedAt: Date.now(), maxStage: 0,
        // more statistics: the grid, running positions each lap, the lead, cautions
        grid: null,                     // carIdx -> starting position (the order at the first green-flag racing frame)
        runSum: {}, runN: {}, top15: {}, lastLeader: null, leadChanges: 0, leaders: new Set(),
        cautions: 0, cautionLaps: 0, wasGreen: null,
      };
    }

    // ── public ────────────────────────────────────────────────────────────
    ingest(d) {
      if (!d || typeof d !== 'object') return;
      if (!d.atTrack) { this._teardown('left track'); return; }
      const session = lc(d.session);
      const state = lc(d.sessionState);

      if (session !== 'race') { this._teardown('session is ' + (session || 'unknown')); return; }

      const trackChanged = this.ctx && d.track && this.ctx.track && d.track !== this.ctx.track;
      const restarted = this.ctx && this.ctx.sawRacing && (state === 'get in car' || state === 'warmup' || state === 'parade laps');
      if (d.reset || trackChanged || restarted) this._teardown(d.reset ? 'bridge reset' : trackChanged ? 'track changed' : 'race restarted');
      if (!this.ctx) this.ctx = this._newContext(d);
      const c = this.ctx;

      this._learnCars(d);
      const lt = d.lapsTotal || 0;
      if (lt > 0 && lt < 32767) c.lapsTotal = lt;
      if (d.track) { c.track = d.track; c.trackShort = d.trackNameShort || d.track; }

      if (state === 'racing') {
        c.sawRacing = true;
        this._trackGrid(d);
        this._trackCautions(d);
        this._trackLapsLed(d);
        this._trackStages(d);
        this._trackFastest(d);
        if (this.trackPasses) this._trackPasses(d);
        this._emitLive(d);
      } else if (state === 'checkered') {
        if (c.sawRacing) {
          c.sawCheckered = true;
          this._trackStages(d);
          this._trackLapsLed(d);
          const snap = (Array.isArray(d.computedStandings) && d.computedStandings.length) ? d.computedStandings : d.standings;
          if (Array.isArray(snap) && snap.length && c.finalSource !== 'official') {
            c.finalStandings = snap.slice(); c.finalSource = 'checkered';
          }
        }
      } else if (state === 'cool down') {
        if (c.sawRacing && Array.isArray(d.standings) && d.standings.length) {
          c.sawCheckered = true;
          this._trackStages(d);
          c.finalStandings = d.standings.slice(); c.finalSource = 'official';
          this._commit('cool down');
        }
      }
      this._emitStatus(d, state);
    }

    // For the status line / manager window.
    getStatus() { return this._status || { phase: 'idle' }; }

    // ── data capture ──────────────────────────────────────────────────────
    _learnCars(d) {
      const c = this.ctx;
      const put = (idx, name, number) => {
        if (idx == null) return;
        const cur = c.carInfo[idx] || (c.carInfo[idx] = { name: '', number: '' });
        // standings names are last-name-only; drivers[] carries the full name — keep the longer one
        if (name && (!cur.name || String(name).length >= cur.name.length)) cur.name = String(name);
        if (number != null && number !== '' && number !== '??') cur.number = String(number);
      };
      for (const s of d.standings || []) put(s.carIdx, s.name, s.number);
      for (const r of d.drivers || []) put(r.carIdx, r.name, r.number);
    }

    _leaderCar(d) {
      const st = d.standings;
      return Array.isArray(st) && st.length ? st[0].carIdx : null;
    }

    _trackLapsLed(d) {
      const c = this.ctx;
      const lc2 = d.lapsComplete || 0;
      if (lc2 > c.lastLapsComplete) {
        const leader = this._leaderCar(d);
        if (leader != null && c.lastLapsComplete >= 0) {
          c.ledLaps[leader] = (c.ledLaps[leader] || 0) + (lc2 - c.lastLapsComplete);
        }
        // each completed lap: every car's running position (average running position, laps in the top 15), the caution laps
        const laps = lc2 - c.lastLapsComplete;
        if (Array.isArray(d.standings)) d.standings.forEach((s, i) => {
          if (!s || s.carIdx == null) return;
          c.runSum[s.carIdx] = (c.runSum[s.carIdx] || 0) + (i + 1) * laps;
          c.runN[s.carIdx] = (c.runN[s.carIdx] || 0) + laps;
          if (i < 15) c.top15[s.carIdx] = (c.top15[s.carIdx] || 0) + laps;
        });
        if (c.lastLapsComplete > 0 && !this._green(d)) c.cautionLaps += laps;
        c.lastLapsComplete = lc2;
      }
      // the lead: lead changes at the line and on track, and how many drivers led
      const leader = this._leaderCar(d);
      if (leader != null && lc2 >= 1) {
        if (c.lastLeader != null && leader !== c.lastLeader) c.leadChanges++;
        if (c.lastLeader !== leader) c.leaders.add(leader);
        c.lastLeader = leader;
      }
    }

    _green(d) { return lc(d.sessionFlag) === 'green'; }

    // the starting grid: the running order at the first racing frame
    _trackGrid(d) {
      const c = this.ctx;
      if (c.grid || !Array.isArray(d.standings) || d.standings.length < 2) return;
      c.grid = {};
      d.standings.forEach((s, i) => { if (s && s.carIdx != null && !(s.carIdx in c.grid)) c.grid[s.carIdx] = i + 1; });
    }

    // cautions: each time the flag goes from green to a yellow (not the white or the checkered)
    _trackCautions(d) {
      const c = this.ctx;
      const f = lc(d.sessionFlag);
      const green = f === 'green', yellow = /yellow|caution/.test(f);
      if (yellow && c.wasGreen === true) c.cautions++;
      if (green || yellow) c.wasGreen = green;
    }

    _trackStages(d) {
      const c = this.ctx;
      if (!Array.isArray(d.stageWinners)) return;
      for (const w of d.stageWinners) {
        if (!w || !(w.stage > 0) || !(w.pos > 0) || w.carIdx == null) continue;
        const m = c.stages[w.stage] || (c.stages[w.stage] = {});
        m[w.pos] = w.carIdx;
        if (w.stage > c.maxStage) c.maxStage = w.stage;
      }
    }

    _trackFastest(d) {
      const c = this.ctx;
      const t = d.fastestLap;
      if (!(t >= MIN_LAP_SECONDS) || d.fastestCarIdx == null) return;
      if ((d.lapsComplete || 0) < 2) return;                    // out/in/pace laps
      if (lc(d.sessionFlag) !== 'green' && c.lapRef === 0) return;
      const ref = d.averageLapTime > 0 ? d.averageLapTime : c.lapRef;
      if (ref > 0 && t < ref * FASTEST_LAP_FLOOR) return;       // implausibly quick — telemetry glitch
      if (!c.fastest || t < c.fastest.time) {
        c.fastest = { carIdx: d.fastestCarIdx, time: t };
        if (!c.lapRef || t < c.lapRef) c.lapRef = t;
      }
    }

    _trackPasses(d) {
      const c = this.ctx;
      const phase = lc(d.cautionPhase);
      const green = lc(d.sessionFlag) === 'green' && !['frozen', 'official', 'warmup'].includes(phase);
      const src = Array.isArray(d.liveStandings) && d.liveStandings.length ? d.liveStandings : d.standings;
      if (!green || !Array.isArray(src)) { c.stableOrder = null; c.candOrder = null; c.candCount = 0; return; }
      const order = src.filter(s => lc(s.status || 'running') === 'running' || s.status === '').map(s => s.carIdx);
      const sig = order.join(',');
      if (sig === c.candOrder) c.candCount++; else { c.candOrder = sig; c.candCount = 1; }
      if (c.candCount < PASS_STABLE_FRAMES) return;
      if (!c.stableOrder) { c.stableOrder = order; return; }
      if (c.stableOrder.join(',') === sig) return;

      const oldIdx = new Map(c.stableOrder.map((ci, i) => [ci, i]));
      const newIdx = new Map(order.map((ci, i) => [ci, i]));
      for (const a of order) {
        if (!oldIdx.has(a)) continue;
        const gain = oldIdx.get(a) - newIdx.get(a);
        if (gain <= 0 || gain > PASS_MAX_JUMP) continue;
        for (const b of order) {
          if (a === b || !oldIdx.has(b)) continue;
          // a was behind b, is now ahead of b
          if (oldIdx.get(a) > oldIdx.get(b) && newIdx.get(a) < newIdx.get(b)) {
            const lost = newIdx.get(b) - oldIdx.get(b);
            if (lost > PASS_MAX_JUMP) continue;
            c.gfp[a] = (c.gfp[a] || 0) + 1;
            if (oldIdx.get(b) < QUALITY_POS) c.qp[a] = (c.qp[a] || 0) + 1;
          }
        }
      }
      c.stableOrder = order;
    }

    // ── race record construction ──────────────────────────────────────────
    _identity(carIdx, s) {
      const info = this.ctx.carInfo[carIdx] || {};
      const name = Engine.normName(info.name || (s && s.name) || '');
      const number = info.number != null && info.number !== '' ? info.number : (s && s.number != null ? String(s.number) : '');
      return { name, number };
    }

    _stagesRaw() {
      const c = this.ctx;
      const out = [];
      Object.keys(c.stages).map(Number).sort((a, b) => a - b).forEach(stage => {
        const byPos = c.stages[stage];
        const order = Object.keys(byPos).map(Number).sort((a, b) => a - b).map(pos => {
          const id = this._identity(byPos[pos]);
          return { key: Engine.keyOf(id.name), pos };
        }).filter(o => o.key);
        if (order.length) out.push({ stage, order });
      });
      return out;
    }

    _buildRace(standings, provisional) {
      const c = this.ctx;
      const entries = [];
      const seen = new Set();
      standings.forEach((s, i) => {
        const id = this._identity(s.carIdx, s);
        if (!id.name) return;
        const key = Engine.keyOf(id.name);
        if (seen.has(key)) return;
        seen.add(key);
        const e = {
          key, name: id.name, number: id.number, finish: entries.length + 1,
          status: s.status || 'running',
          ledLaps: c.ledLaps[s.carIdx] || 0,
          gfp: c.gfp[s.carIdx] || 0, qp: c.qp[s.carIdx] || 0,
          carIdx: s.carIdx,
        };
        if (c.grid && c.grid[s.carIdx] > 0) e.startPos = c.grid[s.carIdx];
        if (Number.isFinite(Number(s.lap)) && s.lap !== '' && s.lap != null) e.lapsCompleted = Math.max(0, Number(s.lap));
        if (Number.isFinite(Number(s.lapsDown)) && s.lapsDown !== '' && s.lapsDown != null) e.lapsDown = Number(s.lapsDown);
        if (c.runN[s.carIdx] > 0) e.avgRun = Math.round(c.runSum[s.carIdx] / c.runN[s.carIdx] * 10) / 10;
        if (c.top15[s.carIdx] > 0) e.lapsTop15 = c.top15[s.carIdx];
        if (Number(s.bestLap) > 0) e.bestLap = Number(s.bestLap);
        entries.push(e);
      });
      let fastestKey = null;
      if (c.fastest) {
        const id = this._identity(c.fastest.carIdx);
        fastestKey = id.name ? Engine.keyOf(id.name) : null;
      }
      return {
        track: c.track, trackShort: c.trackShort, laps: c.lapsTotal, date: new Date().toISOString(),
        entries, stages: this._stagesRaw(), fastestKey,
        fastestLap: c.fastest ? c.fastest.time : null,
        source: 'telemetry', provisional: !!provisional, sessionCookie: c.cookie,
        stats: { leadChanges: c.leadChanges, leaders: c.leaders.size, cautions: c.cautions, cautionLaps: c.cautionLaps },
      };
    }

    _emitLive(d) {
      const c = this.ctx;
      const src = Array.isArray(d.liveStandings) && d.liveStandings.length ? d.liveStandings : d.standings;
      if (!Array.isArray(src) || !src.length) return;
      const hash = src.map(s => s.carIdx).join(',') + '|' + JSON.stringify(c.stages) + '|' + (c.fastest ? c.fastest.carIdx : '');
      if (hash === c.liveHash) return;
      c.liveHash = hash;
      this.onLive(this._buildRace(src, true));
    }

    _emitStatus(d, state) {
      const c = this.ctx;
      const s = {
        phase: c.committed ? 'committed' : (c.sawCheckered ? 'finished' : (c.sawRacing ? 'racing' : 'waiting')),
        track: c.track, lap: d.lapsComplete || 0, lapsTotal: c.lapsTotal, state,
        stagesSeen: c.maxStage, committed: c.committed,
      };
      const j = JSON.stringify(s);
      if (j !== this._statusJson) { this._statusJson = j; this._status = s; this.onStatus(s); }
    }

    _commit(why) {
      const c = this.ctx;
      if (!c || c.committed) return;
      if (!c.finalStandings || c.finalStandings.length < 2) return;
      c.committed = true;
      const race = this._buildRace(c.finalStandings, c.finalSource !== 'official');
      this.log('commit race (' + why + '): ' + race.track + ', ' + race.entries.length + ' cars, ' + race.stages.length + ' stage(s)');
      this.onLive(null);
      this.onRaceComplete(race);
    }

    // Session ended. If the checkered flag had flown but the results were never
    // finalised (user quit on the cooldown), still bank the race.
    _teardown(why) {
      const c = this.ctx;
      if (c && c.sawCheckered && !c.committed) this._commit('teardown: ' + why);
      if (c && !c.committed && c.sawRacing) this.log('race abandoned (' + why + ') — not scored');
      if (c) this.onLive(null);
      this.ctx = null;
      if (this._status && this._status.phase !== 'idle') {
        this._status = { phase: 'idle' };
        this._statusJson = '';
        this.onStatus(this._status);
      }
    }
  }

  return { RaceTracker };
});
