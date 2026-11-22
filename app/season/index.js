// SeasonService — runs inside Electron's main process.
//   * connects to the bridge websocket (ws://127.0.0.1:8765) and feeds the RaceTracker
//   * stores scored races in the SeasonStore and exports HTML after each race
//   * serves live standings to overlays (Electron windows and OBS browser sources)
//     over HTTP + Server-Sent Events on config.season.port (default 8769 — 8767 is AIMOD Live's)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const Rules = require('./rules');
const Engine = require('./engine');
const Entry = require('./entry');
const { RaceTracker } = require('./tracker');
const { SeasonStore } = require('./store');
const { IncidentWatcher } = require('./incidents');
const Calendar = require('./calendar');
const Career = require('./career');
const { TeamTable } = require('../aie/teams');

const DEFAULT_PORT = 8769;      // not 8767: the standalone AIMOD beta's live page owns that one
const LIVE_MIN_INTERVAL_MS = 800;
const MIN_FRAME_INTERVAL_MS = 80;

class SeasonService {
  // opts: { userData, appDir, getConfig, saveConfig, log, getRaceRivals?: () => [feud], setSeasonRivals?: (list|null) => void }
  //   getRaceRivals / setSeasonRivals: AIMOD's racing intensity & rivals - the feuds of the race that just ended, and the season's
  //   rivalries handed to AIMOD while a counted race runs (they carry on from race to race)
  constructor(opts) {
    this.opts = opts;
    const baseLog = opts.log || console.log;
    this.dir = path.join(opts.userData, 'seasons');
    fs.mkdirSync(this.dir, { recursive: true });
    // everything the season code logs also goes to seasons/tracker.log (capped) for troubleshooting
    this._logFile = path.join(this.dir, 'tracker.log');
    this.log = (m) => {
      baseLog(m);
      try {
        if (fs.existsSync(this._logFile) && fs.statSync(this._logFile).size > 1024 * 1024) {
          const keep = fs.readFileSync(this._logFile, 'utf8').slice(-200 * 1024);
          fs.writeFileSync(this._logFile, keep);
        }
        fs.appendFileSync(this._logFile, new Date().toISOString() + ' ' + m + '\n');
      } catch (e) { /* logging must never break scoring */ }
    };
    fs.mkdirSync(path.join(this.dir, 'pending'), { recursive: true });
    this.store = new SeasonStore(this.dir);
    this.tracker = new RaceTracker({
      trackPasses: this.cfg().trackPasses !== false,
      log: m => this.log('[season] ' + m),
      onRaceComplete: race => this._onRaceComplete(race),
      onLive: race => this._onLive(race),
      onStatus: () => this._broadcast(),
    });
    // incidents and damage (game memory) while a counted race runs: opts.memory = a Win32Memory for NR2003, none in tests
    this.incidents = opts.memory ? new IncidentWatcher(opts.memory) : null;
    this.teamTable = opts.memory ? new TeamTable() : null;           // each car's make and team (its .car file), for the championships
    this._teamAt = 0;
    this._incTimer = null; this._incPhase = 'idle';
    this.sse = new Set();
    this.liveRace = null;
    this.liveState = null;
    this._liveTimer = null;
    this._lastLive = 0;
    this.bridgeConnected = false;
    this._lastFrameAt = 0;
    this.ws = null;
    this.server = null;
    this.stopped = false;
    this.lastEvent = null;
  }

  // ── config (config.json → season) ───────────────────────────────────────
  cfg() {
    const c = this.opts.getConfig();
    if (!c.season) c.season = {};
    return c.season;
  }
  setCfg(patch) {
    Object.assign(this.cfg(), patch);
    this.opts.saveConfig();
    if ('trackPasses' in patch) this.tracker.trackPasses = patch.trackPasses !== false;
    if ('activeId' in patch || 'armed' in patch || 'requireArm' in patch) this._pushRivals();
    this._broadcast();
  }

  // ── counting a race: the user activates it (Season Manager / main window: "Count this race") ────────────────────
  // With requireArm (the default) a finished race is scored into the active season only when it was activated; otherwise it is
  // parked under Unassigned races (it can still be added from there). Activation lasts until a race is scored or it is cancelled.
  requireArm() { return this.cfg().requireArm !== false; }
  counting() { const a = this.cfg().armed; return !this.requireArm() || !!(a && a.season === this.cfg().activeId); }
  arm(on) {
    const season = this.activeSeason();
    if (on && !season) return { ok: false, error: 'Choose an active season first.' };
    this.setCfg({ armed: on ? { at: new Date().toISOString(), season: season.id } : null });
    if (!on) { this.liveState = null; }
    this._event({ type: on ? 'armed' : 'disarmed', season: season ? season.name : '', text: on ? `The next race finished counts for "${season.name}".` : 'This race will not count for the season.' });
    if (on && this.liveRace) this._computeLive();
    return { ok: true, armed: !!on };
  }
  // the active season's rivalries (level > 0) for the TV director: [{ a, b, level, holder }]
  seasonRivalsList() {
    const s = this.activeSeason();
    return s ? Object.values(s.rivals || {}).filter(r => r.level > 0).map(r => ({ a: r.a, b: r.b, level: r.level, holder: r.holder })) : [];
  }
  // the season's rivalries -> AIMOD while a counted race is on; nothing otherwise
  _pushRivals() {
    if (!this.opts.setSeasonRivals) return;
    try {
      const season = this.activeSeason();
      const list = season && this.counting() ? Object.values(season.rivals || {}).filter(r => r.level > 0).map(r => ({ a: r.a, b: r.b, level: r.level, holder: r.holder })) : null;
      this.opts.setSeasonRivals(list);
    } catch (e) { this.log('[season] rivals hand-over failed: ' + e.message); }
  }
  get port() { return this.cfg().port || DEFAULT_PORT; }
  exportDirFor(season) {
    const base = this.cfg().exportDir || path.join(this.opts.userData, 'season-exports');
    return path.join(base, season.name.replace(/[\\/:*?"<>|]+/g, '_'));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────
  start() {
    this._startServer();
    this._connectBridge();
    this._armTimer = setInterval(() => { try { this._autoArm(); } catch (e) { /* ignore */ } }, 1000);
    if (this._armTimer.unref) this._armTimer.unref();
    if (this.incidents) {
      this._incTimer = setInterval(() => this._incidentTick(), 250);
      if (this._incTimer.unref) this._incTimer.unref();
    }
  }
  // ── the schedule: the next scheduled race, set up and activated when you are at its track ──────────────────────────
  nrDir() { try { return (this.opts.nrDir && this.opts.nrDir()) || ''; } catch (e) { return ''; } }
  tracks(force) {
    if (!this._tracks || force || Date.now() - this._tracksAt > 60000) { this._tracks = Calendar.scanTracks(this.nrDir()); this._tracksAt = Date.now(); }
    return this._tracks;
  }
  references() {
    const dir = path.join(this.opts.appDir || path.join(__dirname, '..'), 'data');
    const out = [];
    try { for (const f of fs.readdirSync(dir)) if (/\.json$/i.test(f)) { try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (Array.isArray(d.races) && d.schedulePreset !== false) out.push({ id: f.replace(/\.json$/i, ''), name: d.series || f, races: d.races.length, data: d }); } catch (e) { /* not a schedule */ } } } catch (e) { /* none */ }
    return out;
  }
  buildSchedule(o = {}) {
    const tracks = this.tracks(true);
    if (o.style === 'reference') {
      const ref = this.references().find(r => r.id === o.ref) || this.references()[0];
      if (!ref) return { ok: false, error: 'no reference schedule' };
      return { ok: true, events: Calendar.fromReference(ref.data, tracks), name: ref.name };
    }
    return { ok: true, events: Calendar.generate(tracks, o), name: o.style === 'random' ? 'Random' : 'Balanced' };
  }
  nextEvent(season) {
    const s = season || this.activeSeason();
    const ev = s && s.schedule && s.schedule.events;
    if (!ev || !ev.length) return null;
    const run = (s.baseline ? s.baseline.racesRun || 0 : 0) + s.races.length;
    return run < ev.length ? Object.assign({ index: run }, ev[run]) : null;
  }
  setupNext(setDistance) {
    const e = this.nextEvent();
    if (!e) return { ok: false, error: 'No scheduled race left (or no schedule).' };
    if (!this.opts.applyRace) return { ok: false, error: 'not available' };
    const r = this.opts.applyRace({ id: 'schedule-' + e.index, name: e.name, laps: e.laps, stages: e.stages || [] }, !!setDistance);
    if (r && r.ok !== false) this._event({ type: 'setup', text: `Set up for race ${e.index + 1}: ${e.name} (${e.laps} laps${(e.stages || []).length ? ', stages end on ' + e.stages.join(' / ') : ''})${r.distance ? (r.distance.ok ? ', race length set' : ' - race length: ' + r.distance.error) : ''}.` });
    return Object.assign({ event: e }, r || {});
  }
  // guaranteed starters for the next race of the active season (season/entry.js): the top N in owner points (when on) and the chartered
  // cars (the scheduled race's own list, else the season's). -> null when nothing is guaranteed
  guaranteedNow() {
    const s = this.activeSeason();
    if (!s || this.cfg().enabled === false) return null;
    const e = Entry.entryOf(s);
    const ev = this.nextEvent(s);
    if (!e.lockTop && !e.charters.length && !(ev && (ev.charters || []).length)) return null;
    let st = null;
    if (e.lockTop) { try { st = Engine.computeSeason(s); } catch (err) { st = null; } }
    const g = Entry.guaranteed(s, ev, st);
    if (!g.any) return null;
    return Object.assign(g, { track: ev ? ev.track || '' : '', event: ev ? { index: ev.index, name: ev.name } : null, season: s.name });
  }
  // at the next scheduled race's track, in a race session: activate it (option, on with a schedule)
  _autoArm() {
    const s = this.activeSeason();
    if (!s || !s.schedule || s.schedule.autoArm === false || !this.requireArm() || this.counting()) return;
    const st = this.tracker.getStatus() || {};
    if (st.phase !== 'waiting' && st.phase !== 'racing') return;
    const e = this.nextEvent(s);
    if (!e || !Calendar.sameTrack(e, this.tracks(), st.track)) return;
    this.arm(true);
    this._event({ type: 'armed', text: `${e.name} is race ${e.index + 1} of the schedule: it counts for "${s.name}".` });
  }
  // ── the results graphic (nr2003_results.html): the last stage, the last race, the season's leaders ─────────────────
  _stageCardOf(race, scored) {
    const st = (race.stages || [])[race.stages.length - 1];
    if (!st) return null;
    const byKey = {}; for (const e of race.entries || []) byKey[e.key] = e;
    const pts = {}; for (const e of scored || []) pts[e.key] = e;
    const order = (st.order || []).slice().sort((a, b) => a.pos - b.pos).slice(0, 10).map(o => {
      const e = byKey[o.key] || {};
      return { pos: o.pos, name: e.name || o.key, number: e.number || '', pts: o.pts != null ? o.pts : null };
    });
    return { stage: st.stage, track: race.track, top: order };
  }
  _raceCard(season) {
    const r = season && season.races[season.races.length - 1];
    if (!r) return null;
    const rules = Rules.normalizeRuleset(season.ruleset);
    const { entries } = Engine.scoreRace(r, rules);
    return {
      track: r.track, laps: r.laps || 0, date: r.date, n: (season.baseline ? season.baseline.racesRun || 0 : 0) + season.races.length, stats: r.stats || null,
      top: entries.slice(0, 10).map(e => ({ pos: e.finish, name: e.name, number: e.number, start: e.startPos || null, led: e.ledLaps || 0, status: e.status || '', pts: e.total })),
      mostLed: entries.reduce((m, e) => ((e.ledLaps || 0) > (m ? m.ledLaps || 0 : 0) ? e : m), null),
    };
  }
  _statsCard(st) {
    if (!st || !st.rows.length) return null;
    const top = (key, asc, filter) => st.rows.filter(r => r[key] != null && (filter ? filter(r) : true) && (asc || r[key] > 0)).slice().sort((a, b) => (asc ? a[key] - b[key] : b[key] - a[key]) || a.rank - b.rank).slice(0, 5)
      .map(r => ({ name: r.name, number: r.number, value: r[key] }));
    const enough = (r) => r.races >= Math.max(1, Math.ceil(st.racesRun / 3));
    return { racesRun: st.racesRun, boards: [
      { title: 'Wins', rows: top('wins') }, { title: 'Poles', rows: top('poles') }, { title: 'Laps led', rows: top('lapsLed') },
      { title: 'Top 5s', rows: top('top5s') }, { title: 'Average finish', rows: top('afp', true, (r) => r.afp > 0 && enough(r)) }, { title: 'Average running position', rows: top('avgRun', true, (r) => r.avgRun > 0 && enough(r)) },
    ].filter(b => b.rows.length) };
  }
  cards(season, standings) {
    const now = Date.now();
    return {
      stage: this._stageCard && now - (this._stageCardAt || 0) < 10 * 60 * 1000 ? Object.assign({ age: Math.round((now - this._stageCardAt) / 1000) }, this._stageCard) : null,
      race: season ? (() => { const c = this._raceCard(season); if (c) c.age = c.date ? Math.round((now - Date.parse(c.date)) / 1000) : null; return c; })() : null,
      stats: this._statsCard(standings),
    };
  }
  // the incident watcher runs from the green flag of a counted race to its results; a new race starts it again
  _incidentTick() {
    const phase = (this.tracker.getStatus() || {}).phase || 'idle';
    if (phase !== this._incPhase) {
      if ((phase === 'waiting' || phase === 'racing') && (this._incPhase === 'idle' || this._incPhase === 'committed')) this.incidents.reset();
      this._incPhase = phase;
    }
    if (phase !== 'racing' && phase !== 'finished') return;
    if (!this.counting() || this.cfg().enabled === false) return;
    try {
      const m = this.opts.memory;
      if (m.attach && !m.attach()) return;              // (re-attaches when the game restarted)
      this.incidents.tick();
      if (this.teamTable && Date.now() - this._teamAt > 10000) { this._teamAt = Date.now(); this.teamTable.refresh(m, this.nrDir()); }
    } catch (e) { /* the game went away */ }
  }
  // each car's make / team (.car files) and rookie flag (the series art's rookies.json) onto the race's entries
  _addCarInfo(race) {
    const norm = (n) => String(parseInt(n, 10));
    const info = {};
    if (this.teamTable) for (const c of this.teamTable.entries) if (c && c.number) info[norm(c.number)] = c;
    let rookies = null;
    try { rookies = this.opts.rookies ? this.opts.rookies() : null; } catch (e) { rookies = null; }
    for (const e of race.entries || []) {
      const c = info[norm(e.number)];
      if (c) { if (c.make) e.make = c.make; if (c.team) e.team = c.team; }
      if (rookies && rookies.has(norm(e.number))) e.rookie = true;
    }
  }
  // the race's incidents onto its entries (by car number)
  _addIncidents(race) {
    if (!this.incidents) return;
    const by = this.incidents.summary();
    const norm = (n) => String(parseInt(n, 10));
    for (const e of race.entries || []) {
      const r = by[norm(e.number)];
      if (!r) continue;
      e.incidents = r.incidents; e.damage = r.damage; e.contacts = r.contacts; e.cautionsCaused = r.cautionsCaused;
    }
    if (race.stats) race.stats.cautionsFromIncidents = this.incidents.cautions;
  }
  stop() {
    this.stopped = true;
    if (this._incTimer) clearInterval(this._incTimer);
    if (this._armTimer) clearInterval(this._armTimer);
    try { if (this.ws) this.ws.close(); } catch (e) {}
    try { if (this.server) this.server.close(); } catch (e) {}
    for (const r of this.sse) { try { r.end(); } catch (e) {} }
    this.sse.clear();
  }

  // ── bridge websocket ────────────────────────────────────────────────────
  _connectBridge() {
    if (this.stopped) return;
    if (typeof WebSocket === 'undefined') { this.log('[season] no global WebSocket in this runtime — live tracking disabled'); return; }
    const url = this.cfg().wsUrl || 'ws://127.0.0.1:8765';
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this._retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.bridgeConnected = true; this.log('[season] bridge connected'); this._broadcast(); };
    ws.onmessage = ev => {
      // The bridge can push frames at up to the physics rate; scoring only needs a
      // dozen or so a second, so drop the rest before paying for JSON.parse.
      const now = Date.now();
      if (now - this._lastFrameAt < MIN_FRAME_INTERVAL_MS) return;
      this._lastFrameAt = now;
      let d;
      try { d = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
      this._noteGameOrder(d, now);
      if (this.cfg().enabled === false) return;
      if (this.opts.mapFrame) { try { d = this.opts.mapFrame(d); } catch (e) { /* use the bridge's frame */ } }
      if (this.cfg().recordFrames) this._record(d);
      try { this.tracker.ingest(d); } catch (e) { this.log('[season] tracker error: ' + (e && e.stack || e)); }
    };
    const closed = () => {
      if (this.ws === ws) this.ws = null;
      if (this.bridgeConnected) { this.bridgeConnected = false; this._broadcast(); }
      this._retry();
    };
    ws.onclose = closed;
    ws.onerror = () => { /* onclose follows */ };
  }
  // Troubleshooting aid (Setup → "Record telemetry sample"): keeps a thinned copy of the raw frames
  // — every frame when the session state/flag/stage data changes, otherwise one in 25 — capped at 12 MB.
  _record(d) {
    try {
      const f = path.join(this.dir, 'frames-sample.jsonl');
      const key = [d.session, d.sessionState, d.sessionFlag, d.lapsComplete, (d.stageWinners || []).length, d.atTrack].join('|');
      this._recN = (this._recN || 0) + 1;
      const changed = key !== this._recKey;
      this._recKey = key;
      if (!changed && this._recN % 25 !== 0) return;
      if (fs.existsSync(f) && fs.statSync(f).size > 12 * 1024 * 1024) return;
      const slim = Object.assign({}, d);
      delete slim.trackMap; delete slim.lapData; delete slim.relative;      // large and irrelevant to scoring
      fs.appendFileSync(f, JSON.stringify(slim) + '\n');
    } catch (e) { /* ignore */ }
  }

  // The game's own running order (the bridge's standings, before All In One NR2003 changes anything) for the TV graphics:
  // car number -> position, while a race is on and the bridge is current.
  _noteGameOrder(d, now) {
    const st = d && d.atTrack && String(d.session || '').toLowerCase() === 'race' && Array.isArray(d.standings) ? d.standings : null;
    const num = (v) => { const t = String(v == null ? '' : v).trim(); return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t; };   // " 02" -> "2", as the car block holds it
    this._gameOrder = st && st.length ? { at: now, numbers: st.map(s => num(s && s.number)) } : null;
  }
  gamePositions(maxAgeMs = 3000) {
    const g = this._gameOrder;
    if (!g || Date.now() - g.at > maxAgeMs) return null;
    const m = new Map();
    g.numbers.forEach((n, i) => { if (n && n !== '??' && !m.has(n)) m.set(n, i + 1); });
    return m.size ? m : null;
  }

  _retry() {
    if (this.stopped || this._retryTimer) return;
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this._connectBridge(); }, 3000);
  }

  // ── tracker callbacks ───────────────────────────────────────────────────
  _onRaceComplete(race) {
    const c = this.cfg();
    if (c.enabled === false) return;
    const season = this.activeSeason();
    if (!season) { this._savePending(race, 'No active season is selected.'); return; }
    if (!this.counting()) { this._savePending(race, 'The race was not activated for the season (press "Count this race" before or during a race).'); return; }
    this._addIncidents(race);
    this._addCarInfo(race);
    const res = this.store.addRace(season.id, race);
    if (!res.ok) { this._savePending(race, res.error); return; }
    if (res.duplicate) {
      this._event({ type: 'duplicate', season: season.name, track: race.track, text: 'That race was already scored — skipped.' });
      return;
    }
    // AIMOD's feuds of this race carry on through the season
    let rivalsNote = '';
    if (this.opts.getRaceRivals) {
      try {
        const feuds = this.opts.getRaceRivals();
        if (feuds && feuds.length) { const m = this.store.mergeRivals(season.id, feuds, race); if (m.updated) rivalsNote = ` ${m.updated} rivalr${m.updated === 1 ? 'y' : 'ies'} saved.`; }
      } catch (e) { this.log('[season] rivals not saved: ' + e.message); }
    }
    if (this.requireArm()) this.cfg().armed = null, this.opts.saveConfig();
    this._pushRivals();
    if (c.autoExport !== false) {
      try { this.store.exportAll(season.id, this.exportDirFor(season)); } catch (e) { this.log('[season] export failed: ' + e.message); }
    }
    const st = Engine.computeSeason(this.store.get(season.id));
    const winner = race.entries[0] ? race.entries[0].name : '';
    this._event({
      type: 'race-scored', season: season.name, track: race.track, winner,
      racesRun: st.racesRun, totalRaces: st.totalRaces, leader: st.leader ? st.leader.name : '',
      text: `Race ${st.racesRun}/${st.totalRaces} scored — ${race.track}: ${winner} wins. Points leader: ${st.leader ? st.leader.name + ' (' + st.leader.points + ')' : '—'}.${rivalsNote}`,
    });
    this.liveRace = null; this.liveState = null;
    this._broadcast();
  }

  _onLive(race) {
    this.liveRace = race;
    if (!race) { this.liveState = null; this._broadcast(); return; }
    const now = Date.now();
    const wait = LIVE_MIN_INTERVAL_MS - (now - this._lastLive);
    if (wait <= 0) this._computeLive();
    else if (!this._liveTimer) this._liveTimer = setTimeout(() => { this._liveTimer = null; this._computeLive(); }, wait);
  }

  _computeLive() {
    this._lastLive = Date.now();
    const season = this.activeSeason();
    if (!season || !this.liveRace || this.cfg().enabled === false || !this.counting()) { this.liveState = null; this._broadcast(); return; }
    try {
      const proj = Engine.projectLive(season, this.liveRace);
      const nextNo = proj.racesRun;
      const { entries } = Engine.scoreRace(this.liveRace, Rules.normalizeRuleset(season.ruleset), { raceNo: nextNo, totalRaces: proj.totalRaces });
      const by = {};
      entries.forEach(e => { by[e.key] = { finish: e.finish, racePts: e.total, stagePts: e.stagePts }; });
      proj.rows.forEach(r => {
        const b = by[r.key];
        r.livePos = b ? b.finish : null;
        r.racePts = b ? b.racePts : 0;
        r.liveStagePts = b ? b.stagePts : 0;
        r.liveDelta = r.delta || 0;
      });
      const stat = this.tracker.getStatus();
      // a stage just ended: its results card (shown for a while by the results graphic)
      const nst = (this.liveRace.stages || []).length;
      if (nst > (this._stagesSeen || 0)) { this._stageCard = this._stageCardOf(this.liveRace, entries); this._stageCardAt = Date.now(); }
      this._stagesSeen = nst;
      this.liveState = {
        track: this.liveRace.track, lap: stat.lap || 0, lapsTotal: stat.lapsTotal || this.liveRace.laps || 0,
        stagesDone: (this.liveRace.stages || []).length, rows: proj.rows, phase: proj.phase, racesRun: proj.racesRun,
      };
    } catch (e) { this.log('[season] live projection failed: ' + e.message); this.liveState = null; }
    this._broadcast();
  }

  // The overlay series (Layout/series dropdown) changed: switch to the season linked to it, if any.
  onSeriesChanged(seriesId) {
    if (!seriesId) return;
    const match = this.store.list().find(s => s.linkedSeries === seriesId);
    if (match && match.id !== this.cfg().activeId) {
      this.setCfg({ activeId: match.id });
      this.liveState = null;
      this._event({ type: 'switched', season: match.name, text: `Active season switched to "${match.name}" (linked to series ${seriesId}).` });
    }
  }

  // ── pending (race finished with nowhere to put it) ──────────────────────
  _savePending(race, why) {
    const f = path.join(this.dir, 'pending', Date.now() + '.json');
    fs.writeFileSync(f, JSON.stringify({ why, savedAt: new Date().toISOString(), race }, null, 2));
    this._event({ type: 'race-pending', track: race.track, text: `${race.track} finished but couldn't be scored (${why}). Open Season Manager → Unassigned races.` });
    this._broadcast();
  }
  listPending() {
    const d = path.join(this.dir, 'pending');
    return fs.readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        return { file: f, why: j.why, savedAt: j.savedAt, track: j.race.track, cars: j.race.entries.length, winner: j.race.entries[0] && j.race.entries[0].name };
      } catch (e) { return null; }
    }).filter(Boolean);
  }
  assignPending(file, seasonId) {
    const f = path.join(this.dir, 'pending', path.basename(file));
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = this.store.addRace(seasonId, j.race, { force: true });
    if (res.ok) { fs.unlinkSync(f); this._broadcast(); }
    return res.ok ? { ok: true } : res;
  }
  dismissPending(file) {
    try { fs.unlinkSync(path.join(this.dir, 'pending', path.basename(file))); } catch (e) {}
    this._broadcast();
    return { ok: true };
  }

  // ── state ───────────────────────────────────────────────────────────────
  activeSeason() {
    const id = this.cfg().activeId;
    if (!id) return null;
    try { return this.store.get(id); } catch (e) { return null; }
  }

  getState(seasonId) {
    const season = seasonId ? this.store.get(seasonId) : this.activeSeason();
    let standings = null;
    if (season) { try { standings = Engine.computeSeason(season); } catch (e) { standings = null; } }
    const isActive = season && season.id === this.cfg().activeId;
    const rules = season ? Rules.normalizeRuleset(season.ruleset) : null;
    const armed = this.cfg().armed || null;
    return {
      enabled: this.cfg().enabled !== false,
      bridge: this.bridgeConnected,
      tracker: this.tracker.getStatus(),
      requireArm: this.requireArm(), armed: !!(armed && this.activeSeason() && armed.season === this.cfg().activeId), counting: this.counting(),
      season: season ? { id: season.id, name: season.name, series: season.series, linkedSeries: season.linkedSeries || '', baseline: !!season.baseline, system: rules ? rules.system : '' } : null,
      rivals: season ? Object.entries(season.rivals || {}).map(([key, r]) => Object.assign({ key }, r)).sort((x, y) => y.level - x.level || y.runins - x.runins) : [],
      schedule: season && season.schedule ? { events: season.schedule.events || [], series: season.schedule.series || '', autoArm: season.schedule.autoArm !== false, name: season.schedule.name || '' } : null,
      cards: (() => { try { return this.cards(season, standings); } catch (e) { return null; } })(),
      next: season ? this.nextEvent(season) : null,
      entry: season ? Entry.entryOf(season) : null,
      guaranteed: isActive ? this.guaranteedNow() : null,
      standings,
      live: isActive ? this.liveState : null,
      races: season ? season.races.map((r, i) => ({
        id: r.id, n: (season.baseline ? season.baseline.racesRun || 0 : 0) + i + 1, track: r.track, date: r.date,
        winner: r.entries[0] ? r.entries[0].name : '', cars: r.entries.length, stages: (r.stages || []).length,
        source: r.source || '', provisional: !!r.provisional, fastestKey: r.fastestKey || null,
        multiplier: rules ? Engine.raceMultiplier(r, rules, { raceNo: (season.baseline ? season.baseline.racesRun || 0 : 0) + i + 1, totalRaces: rules.regularSeasonRaces + (rules.chase.enabled ? rules.chaseRaces : 0) }) : 1,
        pointsMultiplier: r.pointsMultiplier != null ? r.pointsMultiplier : null, stats: r.stats || null, laps: r.laps || 0,
      })) : [],
      rules: rules ? { system: rules.system, name: rules.name, finish: rules.finish, stage: rules.stage, fastestLapBonus: rules.fastestLapBonus, fastestLapTopN: rules.fastestLapTopN, lapLedBonus: rules.lapLedBonus, mostLapsLedBonus: rules.mostLapsLedBonus, poleBonus: rules.poleBonus, doublePoints: rules.doublePoints, qualPoints: rules.qualPoints, dropScores: rules.dropScores, chase: rules.chase, regularSeasonRaces: rules.regularSeasonRaces, chaseRaces: rules.chaseRaces } : null,
      pending: this.listPending().length,
      options: { autoExport: this.cfg().autoExport !== false, exportDir: this.cfg().exportDir || '', trackPasses: this.cfg().trackPasses !== false, recordFrames: !!this.cfg().recordFrames, port: this.port, requireArm: this.requireArm() },
      lastEvent: this.lastEvent,
      updatedAt: Date.now(),
    };
  }

  _event(evt) {
    this.lastEvent = Object.assign({ at: Date.now() }, evt);
    this.log('[season] ' + (evt.text || evt.type));
    for (const r of this.sse) { try { r.write('event: toast\ndata: ' + JSON.stringify(this.lastEvent) + '\n\n'); } catch (e) {} }
  }

  _broadcast() {
    if (!this.sse.size) return;
    if (this._bTimer) return;
    this._bTimer = setTimeout(() => {
      this._bTimer = null;
      let payload;
      try { payload = JSON.stringify(this.getState()); } catch (e) { return; }
      for (const r of this.sse) { try { r.write('event: state\ndata: ' + payload + '\n\n'); } catch (e) {} }
    }, 150);
  }

  // ── HTTP / SSE ──────────────────────────────────────────────────────────
  _startServer() {
    const host = this.opts.getConfig().streamIp && this.opts.getConfig().streamIp !== 'localhost' ? '0.0.0.0' : '127.0.0.1';
    const server = http.createServer((req, res) => this._handle(req, res));
    // the port can still be held by the previous copy of the app while it shuts down: keep trying until it is free
    server.on('error', e => {
      this.log('[season] HTTP server error: ' + e.message);
      if (e.code === 'EADDRINUSE' && this.server === server) { const t = setTimeout(() => { if (this.server === server) server.listen(this.port, host); }, 3000); if (t.unref) t.unref(); }
    });
    server.on('listening', () => this.log(`[season] overlay server on http://${host}:${this.port}`));
    server.listen(this.port, host);
    this.server = server;
  }

  _handle(req, res) {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      if (u.pathname === '/season/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getState(u.searchParams.get('id') || undefined)));
      } else if (u.pathname === '/season/seasons') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ activeId: this.cfg().activeId || null, seasons: this.store.list() }));
      } else if (u.pathname === '/season/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' });
        res.write('retry: 2000\n\n');
        res.write('event: state\ndata: ' + JSON.stringify(this.getState()) + '\n\n');
        this.sse.add(res);
        const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 20000);
        req.on('close', () => { clearInterval(ka); this.sse.delete(res); });
      } else if (u.pathname === '/widget/results' || u.pathname === '/nr2003_results.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(this.opts.appDir, 'nr2003_results.html')));
      } else if (u.pathname === '/widget/season' || u.pathname === '/nr2003_season.html') {
        const f = path.join(this.opts.appDir, 'nr2003_season.html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(f));
      } else if (u.pathname === '/season/standings.html') {
        const s = this.activeSeason();
        if (!s) { res.writeHead(404); res.end('No active season'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.store.standingsHtml(s.id));
      } else {
        res.writeHead(404); res.end('not found');
      }
    } catch (e) {
      res.writeHead(500); res.end(String(e && e.message || e));
    }
  }

  // ── IPC for the manager window ──────────────────────────────────────────
  registerIpc({ ipcMain, dialog, shell, getParentWindow }) {
    const h = (name, fn) => ipcMain.handle('season:' + name, async (e, ...a) => {
      try { return await fn(...a); } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
    const afterChange = r => { this._broadcast(); return r; };

    h('get-state', id => this.getState(id));
    h('list', () => ({ activeId: this.cfg().activeId || null, seasons: this.store.list() }));
    h('create', ({ name, series, linkedSeries, system }) => {
      const s = this.store.create({ name, series, linkedSeries, system });
      if (!this.cfg().activeId) this.setCfg({ activeId: s.id });
      return afterChange({ ok: true, id: s.id });
    });
    h('set-active', id => { this.setCfg({ activeId: id || null, armed: null }); this.liveState = null; return { ok: true }; });
    h('rename', ({ id, name }) => { this.store.rename(id, name); return afterChange({ ok: true }); });
    h('set-linked', ({ id, linkedSeries }) => { this.store.setLinkedSeries(id, linkedSeries); return afterChange({ ok: true }); });
    h('delete', id => {
      this.store.delete(id);
      if (this.cfg().activeId === id) this.setCfg({ activeId: null });
      return afterChange({ ok: true });
    });
    h('remove-race', ({ id, raceId }) => afterChange(this.store.removeRace(id, raceId)));
    h('update-race', ({ id, raceId, patch }) => afterChange(this.store.updateRace(id, raceId, patch)));
    h('get-race', ({ id, raceId }) => {
      const s = this.store.get(id);
      const r = s && s.races.find(x => x.id === raceId);
      if (!r) return { ok: false, error: 'Race not found' };
      const scored = Engine.scoreRace(r, Rules.normalizeRuleset(s.ruleset));
      return { ok: true, race: r, scored };
    });
    h('get-ruleset', id => ({ ok: true, ruleset: this.store.get(id).ruleset }));
    h('default-ruleset', series => ({ ok: true, ruleset: Rules.buildRuleset(series) }));
    h('set-ruleset', ({ id, ruleset }) => { this.store.setRuleset(id, ruleset); return afterChange({ ok: true }); });
    h('set-options', patch => { this.setCfg(patch); return { ok: true }; });
    h('series-presets', () => Object.values(Rules.SERIES));
    h('systems', () => Rules.systemsList());
    h('set-system', ({ id, system }) => afterChange(this.store.setSystem(id, system)));
    h('arm', on => afterChange(this.arm(!!on)));
    // schedule
    h('cal-tracks', () => this.tracks(true));
    h('cal-references', () => this.references().map(r => ({ id: r.id, name: r.name, races: r.races })));
    h('cal-build', (o) => this.buildSchedule(o || {}));
    h('cal-set', ({ id, schedule }) => afterChange(this.store.setSchedule(id, schedule)));
    h('cal-nr-series', () => { try { return fs.readdirSync(path.join(this.nrDir(), 'series')).filter(d => fs.statSync(path.join(this.nrDir(), 'series', d)).isDirectory()); } catch (e) { return []; } });
    h('cal-export', ({ id, series }) => {
      const s = this.store.get(id);
      if (!s.schedule || !(s.schedule.events || []).length) return { ok: false, error: 'This season has no schedule.' };
      const bad = s.schedule.events.filter(e => !e.track);
      if (bad.length) return { ok: false, error: `${bad.length} race(s) have no track: pick one for each first.` };
      const file = Calendar.writeSeason(this.nrDir(), series, s.schedule.events);
      this.store.setSchedule(id, Object.assign({}, s.schedule, { series }));
      return afterChange({ ok: true, file });
    });
    h('cal-import', ({ id, series }) => {
      const events = Calendar.readSeason(this.nrDir(), series);
      if (!events.length) return { ok: false, error: 'No season file (2003season.ini) in that series.' };
      const tracks = this.tracks(true);
      for (const e of events) { const t = tracks.find(x => x.dir.toLowerCase() === String(e.track).toLowerCase()); e.trackName = t ? t.name : ''; e.missing = !t; if (t) e.track = t.dir; e.stages = Calendar.stagesFor(e.laps, t ? t.type : 'oval'); }
      return afterChange(this.store.setSchedule(id, { events, series, name: series + ' 2003season.ini', autoArm: true }));
    });
    h('setup-next', (setDistance) => afterChange(this.setupNext(setDistance)));
    h('set-entry', ({ id, entry }) => afterChange(this.store.setEntry(id, entry)));
    // careers across all seasons, head to head, merged drivers
    h('career', () => Career.career(this.store));
    h('head-to-head', ({ a, b }) => Career.headToHead(this.store, a, b));
    h('aliases', () => this.store.aliases());
    h('alias-set', ({ from, to, name }) => afterChange(this.store.setAlias(from, to, name)));
    h('alias-remove', (from) => afterChange(this.store.removeAlias(from)));
    h('rival-remove', ({ id, key }) => { const r = this.store.removeRival(id, key); this._pushRivals(); return afterChange(r); });
    h('rivals-clear', id => { const r = this.store.clearRivals(id); this._pushRivals(); return afterChange(r); });

    h('import-xml', async id => {
      const r = await dialog.showOpenDialog(getParentWindow && getParentWindow(), {
        title: 'Select an AutoStages SeasonInfo.xml', filters: [{ name: 'XML', extensions: ['xml'] }], properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      return afterChange(this.store.importBaselineXml(id, fs.readFileSync(r.filePaths[0], 'utf8')));
    });
    h('import-html', async id => {
      const r = await dialog.showOpenDialog(getParentWindow && getParentWindow(), {
        title: 'Select AutoStages race result .html files', filters: [{ name: 'HTML', extensions: ['html', 'htm'] }], properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      const files = r.filePaths.map(f => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => a.t - b.t);
      let ok = 0; const errors = [];
      for (const { f, t } of files) {
        try {
          const res = this.store.importRaceHtml(id, fs.readFileSync(f, 'utf8'), { track: path.basename(f), date: new Date(t).toISOString() });
          if (res.ok) ok++; else errors.push(path.basename(f) + ': ' + res.error);
        } catch (e) { errors.push(path.basename(f) + ': ' + e.message); }
      }
      return afterChange({ ok: ok > 0, imported: ok, errors });
    });
    h('export', id => {
      const s = this.store.get(id);
      const dir = this.store.exportAll(id, this.exportDirFor(s));
      shell.openPath(dir);
      return { ok: true, dir };
    });
    h('choose-export-dir', async () => {
      const r = await dialog.showOpenDialog(getParentWindow && getParentWindow(), { title: 'Folder for season HTML exports', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      this.setCfg({ exportDir: r.filePaths[0] });
      return { ok: true, dir: r.filePaths[0] };
    });
    h('open-data-folder', () => { shell.openPath(this.dir); return { ok: true }; });
    h('pending-list', () => this.listPending());
    h('pending-assign', ({ file, id }) => this.assignPending(file, id));
    h('pending-dismiss', file => this.dismissPending(file));
  }
}

module.exports = { SeasonService, DEFAULT_PORT };
