// StageEngine — the stage-racing state machine that drives the scorebug / ticker / live standings.
//
// This is a port of the compiled bridge's own stage code (_sr_update + _sr_build_stage_payload + _sr_compute_stage_end_laps,
// checked against the bridge's real functions by tests/stages.test.js via tools/stageparity). The one deliberate difference:
// the bridge works the stage-end laps out ONCE per race and never looks again, so when a caution ends a stage early the
// scorebug kept showing the old stage and the old stage length. Here the end laps are worked out on every frame from the
// plan and the early ends (RaceControl's, or this engine's own "end the stage early" rule), so the displayed stage number,
// lap, length and the stage-complete / top-10 sequence follow the stage that really ended.
//
// A master switch ("stages off") turns the whole thing off: no stage fields, no stage-complete sequence.
'use strict';

const lc = v => String(v == null ? '' : v).toLowerCase();

// the bridge's stage-end laps from a stage config (identical clamping to _sr_compute_stage_end_laps)
function computeEnds(lapsTotal, sr) {
  const numStages = Number(sr && sr.numStages) || 0;
  const mode = (sr && sr.inputMode) || 'percent';
  if (lapsTotal <= 0 || numStages < 2) return [];
  const clamp = lap => Math.max(1, Math.min(lapsTotal - 1, lap));
  const fix = res => { for (let i = 1; i < res.length; i++) if (res[i] <= res[i - 1]) res[i] = res[i - 1] + 1; return res; };
  if (mode === 'laps') {
    const raw = (sr.laps && sr.laps.length ? sr.laps : []);
    if (raw.length < numStages - 1) return [];
    return fix(raw.slice(0, numStages - 1).map(l => clamp(Math.trunc(Number(l)))));
  }
  const pcts = (sr.percentages && sr.percentages.length ? sr.percentages : []);
  if (pcts.length < numStages - 1) return [];
  return fix(pcts.slice(0, numStages - 1).map(p => clamp(Math.ceil(lapsTotal * Number(p) / 100.0))));
}

const OFF = Object.freeze({
  stageRacingActive: false, stageNum: 0, stageLap: 0, stageTotalLaps: 0, stageComplete: false, stageFinalStage: false,
  stageCompleteActive: false, stageCompleteNum: 0, stageWinners: [], stageCrossings: [],
});

class StageEngine {
  // opts: { getConfig() -> { stageRacing, stageGuard }, applyEarly(ends) -> ends (RaceControl's early ends), rcEarly() -> bool, log(msg) }
  constructor(opts) {
    this.opts = opts || {};
    this.log = this.opts.log || (() => {});
    this.reset();
  }

  reset() {
    this.armed = false;
    this.lastState = null;
    this.baseEnds = []; this.baseKey = '';
    this.ownEarly = new Map();                 // original end -> early end (this engine's own guard rule)
    this.guardDone = -1;
    this._resetFire();
  }

  _resetFire() {
    this.sent = new Set();
    this.baseEnds = []; this.baseKey = '';
    this.winners = []; this.crossings = []; this.crossed = new Set(); this.crossingStage = 0;
    this.completeActive = false; this.completeNum = 0; this.winnerCi = -1; this.winnersSnapped = false;
    this.sawYellow = false; this.noCautionClearLap = -1;
    this.ownEarly = new Map(); this.guardDone = -1;
  }

  // on = whether stages are switched on at all (master switch + the Stage Racing "enabled" flag)
  static stagesOn(cfg) { const sr = cfg && cfg.stageRacing; return !!(sr && sr.enabled && !sr.stagesOff); }

  _effectiveEnds() {
    let ends = this.baseEnds;
    if (this.ownEarly.size) ends = ends.map(e => (this.ownEarly.has(e) ? this.ownEarly.get(e) : e));
    if (this.opts.applyEarly) { try { ends = this.opts.applyEarly(ends.slice()) || ends; } catch (e) { /* keep the plan */ } }
    return ends;
  }

  // the stage end laps as the display currently has them (early ends applied); [] when stages are off or not in a race yet
  currentEnds() { return StageEngine.stagesOn(this.opts.getConfig() || {}) ? this._effectiveEnds().slice() : []; }

  // d = one bridge payload frame. Returns the stage fields to merge over it.
  update(d) {
    const cfg = this.opts.getConfig() || {};
    const sr = cfg.stageRacing || {};
    const on = StageEngine.stagesOn(cfg);
    const atTrack = !!(d && d.atTrack);
    const sessionType = lc(d && d.session);
    const state = lc(d && d.sessionState);

    if (!atTrack || !on) {
      if (this.armed) { this.log('[stages] disarmed (left track or stages off)'); this.armed = false; this._resetFire(); }
      this.lastState = state;
      return Object.assign({}, OFF);
    }
    if (sessionType !== 'race') { this.lastState = state; return Object.assign({}, OFF); }

    if (state === 'get in car' && !['', 'get in car'].includes(this.lastState == null ? '' : this.lastState)) {
      this.log('[stages] race restarted — re-arming');
      this._resetFire(); this.armed = false;
    }
    if (!this.armed) { this.armed = true; this._resetFire(); this.log('[stages] armed for this race session'); }

    const lapsTotal = Number(d.lapsTotal) || 0;
    if (lapsTotal <= 0 || lapsTotal >= 32767) { this.lastState = state; return Object.assign({}, OFF); }

    // the plan (re-worked when the stage settings change, which the bridge never did)
    const key = JSON.stringify([lapsTotal, sr.numStages, sr.inputMode, sr.laps, sr.percentages]);
    if (key !== this.baseKey && ['warmup', 'parade laps', 'racing', 'checkered'].includes(state)) {
      this.baseEnds = computeEnds(lapsTotal, sr); this.baseKey = key;
      if (this.baseEnds.length) this.log(`[stages] stage-end laps ${JSON.stringify(this.baseEnds)} (of ${lapsTotal})`);
    }

    const lapsComplete = Number(d.lapsComplete) || 0;
    const flag = lc(d.sessionFlag);
    this._guardRule(d, flag, lapsTotal, lapsComplete, sr, cfg);
    const ends = this._effectiveEnds();

    // a finished stage's flag clears on the next green (or a lap later without caution)
    if (this.completeActive && this.completeNum > 0) {
      const throwCaution = sr.throwCaution !== false;
      if (throwCaution) {
        if (flag === 'yellow') this.sawYellow = true;
        else if (flag === 'green' && this.sawYellow) {
          this.completeActive = false; this.completeNum = 0; this.sawYellow = false;
          this.log('[stages] green flag — stage complete cleared');
        } else if (flag === 'green' && this.opts.cautionFallback) {
          // the stage caution was expected but never came (RaceControl could not throw it): do not keep the banner forever
          const idx = this.completeNum - 1;
          if (idx < ends.length && lapsComplete >= ends[idx] + 2) { this.completeActive = false; this.completeNum = 0; this.sawYellow = false; this.log('[stages] no stage caution came — stage complete cleared'); }
        }
      } else {
        let clearLap = this.noCautionClearLap;
        if (clearLap < 0) {
          const idx = this.completeNum - 1;
          if (idx < ends.length) this.noCautionClearLap = ends[idx] + 1;
          clearLap = this.noCautionClearLap;
        }
        if (clearLap >= 0 && lapsComplete >= clearLap) { this.completeActive = false; this.completeNum = 0; this.noCautionClearLap = -1; }
      }
    }

    const lapped = d.lappedState || {};
    for (const stageEnd of ends) {
      if (this.sent.has(stageEnd)) continue;
      const stageNum = ends.indexOf(stageEnd) + 1;
      if (lapsComplete === stageEnd && flag === 'yellow' && this.crossingStage !== stageNum) {
        // the stage ended under caution: the order right now is the result
        const standings = d.standings || [];
        const lead = standings.filter(s => (lapped[(s && s.carIdx != null) ? s.carIdx : -1] || 0) === 0);
        lead.slice(0, 10).forEach((e, i) => {
          const ci = e && e.carIdx != null ? e.carIdx : -1;
          if (ci >= 0) this.winners.push({ stage: stageNum, pos: i + 1, carIdx: ci });
        });
        this.sent.add(stageEnd);
        this.completeActive = true; this.completeNum = stageNum;
        this.log(`[stages] stage ${stageNum} complete under caution (lap ${stageEnd})`);
        continue;
      }
      if (lapsComplete === stageEnd && this.crossingStage !== stageNum) {
        this.crossingStage = stageNum; this.crossings = []; this.crossed = new Set();
      }
      if (this.crossingStage !== stageNum) continue;
      if (this.crossed.size) continue;
      const standings = d.standings || [];
      if (!standings.length) continue;
      const ci = standings[0] && standings[0].carIdx != null ? standings[0].carIdx : -1;
      if (ci < 0) continue;
      this.crossings.push({ stage: stageNum, pos: 1, carIdx: ci });
      this.crossed.add(ci);
      this.sent.add(stageEnd);
      this.completeActive = true; this.completeNum = stageNum; this.winnerCi = ci; this.winnersSnapped = false;
      this.log(`[stages] stage ${stageNum} complete — leader crossed (car ${ci})`);
      this.crossingStage = 0;
    }

    // top 10 snapshot once the stage winner is 70% round the next lap
    if (this.completeActive && this.winnerCi >= 0 && !this.winnersSnapped) {
      let pct = null;
      for (const o of (d.opponents || [])) if (o && o.carIdx === this.winnerCi) pct = o.trkPct != null ? o.trkPct : null;
      if (this.winnerCi === (d.playerCarIdx != null ? d.playerCarIdx : -1)) pct = d.player && d.player.trkPct != null ? d.player.trkPct : null;
      if (pct != null && pct >= 0.7) {
        this.winnersSnapped = true;
        (d.standings || []).slice(0, 10).forEach((s, i) => {
          const w = { stage: this.completeNum, pos: i + 1, carIdx: s && s.carIdx != null ? s.carIdx : -1 };
          if (!this.winners.some(x => x.stage === w.stage && x.pos === w.pos && x.carIdx === w.carIdx)) this.winners.push(w);
        });
        this.log(`[stages] stage ${this.completeNum} top 10 snapshot`);
      }
    }
    this.lastState = state;

    return this._payload(lapsComplete, lapsTotal, flag, ends, sr);
  }

  // _sr_build_stage_payload
  _payload(lapsComplete, lapsTotal, flag, ends, sr) {
    const out = {
      stageRacingActive: false, stageNum: 0, stageLap: 0, stageTotalLaps: 0, stageComplete: false, stageFinalStage: false,
      stageCompleteActive: this.completeActive, stageCompleteNum: this.completeNum,
      stageWinners: this.winners.slice(), stageCrossings: this.crossings.slice(),
    };
    if (!ends.length) return Object.assign(out, { stageCompleteActive: false, stageCompleteNum: 0, stageWinners: [], stageCrossings: [] });
    const numStages = Number(sr.numStages) || 0;
    let cur = null, start = 0, endLap = 0;
    for (let i = 0; i < ends.length; i++) {
      if (lapsComplete <= ends[i]) { cur = i + 1; start = i > 0 ? ends[i - 1] : 0; endLap = ends[i]; break; }
    }
    if (cur === null) { cur = numStages; start = ends[ends.length - 1]; endLap = lapsTotal; }
    let isFinal = cur === numStages;
    let total = endLap - start, lap = lapsComplete - start;
    if (lapsComplete >= endLap && !isFinal && flag === 'green') {
      const nextI = ends.indexOf(endLap) + 1;
      if (nextI < ends.length) { cur = nextI + 1; start = endLap; endLap = ends[nextI]; }
      else { cur = numStages; start = endLap; endLap = lapsTotal; }
      isFinal = cur === numStages;
      total = endLap - start; lap = lapsComplete - start;
    }
    return Object.assign(out, {
      stageRacingActive: true, stageNum: cur, stageLap: Math.max(0, lap), stageTotalLaps: total,
      stageComplete: this.completeActive ? !isFinal : false, stageFinalStage: isFinal,
    });
  }

  // "end the stage early on a caution with N or fewer laps left" for when RaceControl is not doing it
  _guardRule(d, flag, lapsTotal, lapsComplete, sr, cfg) {
    const g = cfg.stageGuard || {};
    if (!g.enabled || (this.opts.rcEarly && this.opts.rcEarly())) return;
    if (flag !== 'yellow' || this.completeActive || !this.baseEnds.length) return;
    const ends = this._effectiveEnds();
    let stageNum = 0;
    for (let i = 0; i < ends.length; i++) if (lapsComplete <= ends[i]) { stageNum = i + 1; break; }
    if (!stageNum || stageNum > ends.length) return;           // final stage: nothing to end early
    const oldEnd = ends[stageNum - 1];
    const rem = oldEnd - lapsComplete;
    if (rem < 2 || rem > (Number(g.laps) || 5) || this.guardDone === stageNum) return;
    const newEnd = lapsComplete + 1;
    const next = ends[stageNum];
    if (newEnd >= oldEnd || (next != null && newEnd >= next)) { this.guardDone = stageNum; return; }
    const orig = this.baseEnds[stageNum - 1];
    this.ownEarly.set(orig, newEnd);
    this.guardDone = stageNum;
    this.log(`[stages] caution with ${rem} laps left in stage ${stageNum}: the stage ends early on lap ${newEnd} (was ${oldEnd})`);
  }
}

module.exports = { StageEngine, computeEnds, OFF };
