// RaceControl 2.0's overlay feed (OverlayFeed.cs, feed_version 1): the data behind the qualifying timing box, the broadcast /
// telemetry panel and the choose cone board, for overlays drawn from layouts. All In One NR2003's built-in RaceVision reads it straight from
// here; it is also written to %PROGRAMDATA%\NR2003 Companions\racecontrol\overlay_feed.json (at most every 100 ms, a heartbeat every
// 2 s), the file a standalone RaceVision 2.0 reads.
'use strict';
const fs = require('fs');
const path = require('path');

const FEED_VERSION = 1, MIN_GAP_MS = 100, HEARTBEAT_MS = 2000;
const DEFAULT_PATH = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'NR2003 Companions', 'racecontrol', 'overlay_feed.json');

const S = (s) => (s == null ? '' : String(s));
const R = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : 0);
const label = (v) => {                     // Qualifying.Label: 100 = 00, 2xxx / 3xxx = zero-padded numbers
  if (!(v >= 0)) return '';
  if (v === 100) return '00';
  if (v >= 2000) { const d = Math.floor(v / 1000), n = v % 1000; if (d >= 2 && d <= 3 && n < (d === 2 ? 100 : 1000)) return String(n).padStart(d, '0'); }
  return String(v);
};

function qual(d, show) {
  const has = !!d;
  d = d || { PoleNum: -1, CarNum: -1 };
  return { active: has, show: has && show, header: S(d.Header), pole_num: label(d.PoleNum), pole_name: S(d.PoleName), pole_time: S(d.PoleTime),
    car_num: label(d.CarNum), car_name: S(d.CarName), car_pos: S(d.CarPos), right: S(d.Right), right_mode: d.Mode | 0, projected: S(d.Projected), faster: !!d.Faster };
}
function tele(d, show) {
  const has = !!d;
  d = d || { Session: '', Num: -1, RpmTop: 0, LapNo: -1, LapsTotal: -1, Ahead: false, ShowOrder: false, Order: [] };
  const ok = has && !!d.Tele;
  return { active: has, show: has && show, track: S(d.Track), session: S(d.Session), num: label(d.Num), first: S(d.First), last: S(d.Last), tele_ok: ok,
    mph: ok ? R(d.Mph, 1) : 0, rpm: ok ? R(d.Rpm, 0) : 0, rpm_top: ok ? R(d.RpmTop, 0) : 0, throttle: ok ? R(d.Throttle, 3) : 0,
    brake: ok && d.Brake >= 0 ? R(d.Brake, 3) : 0, brake_known: ok && d.Brake >= 0, gear: ok ? d.Gear | 0 : 0, lap_no: d.LapNo, laps_total: d.LapsTotal,
    current: S(d.Current), last_lap: S(d.LastLap), best_lap: S(d.BestLap), faster: has && !!d.Ahead, show_order: has && !!d.ShowOrder,
    order: (d.Order || []).map(it => ({ pos: S(it[0]), num: S(it[5]), first: S(it[1]), last: S(it[2]), time: S(it[3]), kind: S(it[4]) })) };
}
// board: the engine's ConeBoard ({ Title, Cars, Done, Version, Inside[], Outside[] }); names(idx) -> { first, last }
function cone(board, show, names) {
  const has = !!board;
  const b = board || { Title: '', Inside: [], Outside: [] };
  const e = (x) => { const nm = names ? names(x.Idx) || {} : {}; return { row: x.Row, lane: x.Lane, num: label(x.Num), first: S(nm.first), last: S(nm.last), from: x.From, to: x.To, gained: x.Gained, player: !!x.Player }; };
  return { active: has, show: has && show, title: S(b.Title), cars: has ? b.Cars : 0, done: has && !!b.Done, version: has ? b.Version : -1,
    inside: (b.Inside || []).map(e), outside: (b.Outside || []).map(e) };
}
function serialize(writtenMs, session, q, t, c, names, build) {
  return { feed_version: FEED_VERSION, written_ms: writtenMs, app: 'RaceControl', build: build || 'All In One NR2003', session: session || 'other',
    qual: qual(q, true), tele: tele(t, true), cone: cone(c, true, names) };
}

class OverlayFeed {
  constructor(opts) {
    this.o = opts || {};
    this.filePath = this.o.path || DEFAULT_PATH;
    this.lastBody = ''; this.lastTry = -1e9; this.lastWrite = -1e9; this.failStreak = 0; this.loggedFail = false; this.writes = 0; this.now = null;
  }
  // build the feed (kept for the built-in overlays) and write the file when it changed or the heartbeat is due
  publish(session, q, t, c, names, write) {
    const nowMs = Date.now();
    this.now = serialize(nowMs, session, q, t, c, names);
    if (!write) return false;
    const tick = this.o.clock ? this.o.clock() : nowMs;
    if (tick - this.lastTry < MIN_GAP_MS && tick - this.lastTry >= 0) return false;
    this.lastTry = tick;
    const body = JSON.stringify(Object.assign({}, this.now, { written_ms: 0 }));
    if (body === this.lastBody && tick - this.lastWrite < HEARTBEAT_MS && tick - this.lastWrite >= 0) return false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.now));
      fs.renameSync(tmp, this.filePath);
      this.lastBody = body; this.lastWrite = tick; this.writes++;
      if (this.loggedFail && this.o.log) this.o.log('overlay feed: writing again (' + this.filePath + ')');
      this.failStreak = 0; this.loggedFail = false;
      return true;
    } catch (e) {
      this.failStreak++;
      if (!this.loggedFail && this.failStreak >= 3) { this.loggedFail = true; if (this.o.log) this.o.log('overlay feed: cannot write ' + this.filePath + ' (' + e.message + ')'); }
      return false;
    }
  }
}

module.exports = { OverlayFeed, serialize, label, DEFAULT_PATH, FEED_VERSION };
