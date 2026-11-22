// Session map learning and RaceVision-compatible JSONL event/sample capture.
'use strict';
const fs = require('fs');
const path = require('path');

const safe = s => String(s || 'Unknown Track').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'Unknown_Track';
const wrap = (x, n) => ((x % n) + n) % n;

class Timeline {
  constructor(opts = {}) {
    this.dir = opts.dir || (opts.userData ? path.join(opts.userData, 'racevision', 'timelines') : '');
    this.tv = opts.tvcams || null;
    this.events = []; this.samples = []; this.bins = []; this.filePath = '';
    this.reset();
  }
  reset() {
    this.track = ''; this.session = -1; this.startedAt = ''; this.lastGameT = -1; this.lastSampleT = -1; this.lastMapT = -1;
    this.lastFlag = null; this.lastLap = null; this.lastCur = ''; this.events = []; this.samples = [];
    this.bins = Array.from({ length: 360 }, () => ({ x: 0, y: 0, n: 0 })); this.filePath = '';
  }
  _write(row) {
    if (this.filePath) { try { fs.appendFileSync(this.filePath, JSON.stringify(row) + '\n'); } catch (e) { /* keep the live map even when recording storage is unavailable */ } }
  }
  _event(f, kind, extra = {}) {
    const e = Object.assign({ t: f.t, lap: f.order[0] ? f.order[0].laps : 0, flag: f.flag, kind }, extra);
    this.events.push(e); if (this.events.length > 2000) this.events.shift(); this._write({ e });
    return e;
  }
  _begin(f) {
    this.track = f.track || 'Unknown Track'; this.session = f.session;
    this.startedAt = new Date().toISOString(); this.lastGameT = f.t; this.lastSampleT = -1; this.lastMapT = -1;
    this.lastFlag = null; this.lastLap = null; this.lastCur = '';
    this.events = []; this.samples = []; this.bins = Array.from({ length: 360 }, () => ({ x: 0, y: 0, n: 0 }));
    this.filePath = '';
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').replace(/\..+/, '');
        this.filePath = path.join(this.dir, `${stamp}_${safe(this.track)}_${f.session}.jsonl`);
        this._write({ h: { v: 1, track: this.track, session: f.session, started: this.startedAt, laps: f.order[0] ? f.order[0].laps : 0 } });
        this._write({ c: f.order.map(c => [c.slot, c.num, c.name, '']) });
        const old = fs.readdirSync(this.dir).filter(n => n.endsWith('.jsonl')).map(n => ({ n, t: fs.statSync(path.join(this.dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
        for (const x of old.slice(30)) fs.unlinkSync(path.join(this.dir, x.n));
      } catch (e) { this.filePath = ''; }
    }
  }
  observe(f, director, camera, waiting) {
    if (!f || !f.order) return;
    const leaderLap = f.order[0] ? f.order[0].laps : 0;
    const restarted = this.lastLap !== null && leaderLap < this.lastLap - 3;
    if (!this.track || this.track !== (f.track || 'Unknown Track') || this.session !== f.session || (this.lastGameT >= 0 && f.t < this.lastGameT - 5) || restarted) this._begin(f);
    this.lastGameT = f.t;
    for (const c of f.order) if (Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.ldist) && f.trackLen > 0) {
      const i = Math.floor(wrap(c.ldist, f.trackLen) / f.trackLen * this.bins.length) % this.bins.length, b = this.bins[i];
      b.x += c.x; b.y += c.y; b.n++;
    }
    if (this.lastMapT < 0 || f.t - this.lastMapT >= 30) { this._write({ m: this.map(f.trackLen) }); this.lastMapT = f.t; }
    if (this.lastFlag !== f.flag) {
      this.lastFlag = f.flag; this._event(f, 'FLAG', { value: f.flag, green: !!f.green });
    }
    const lap = f.order[0] ? f.order[0].laps : 0;
    if (this.lastLap !== null && lap !== this.lastLap) this._event(f, 'LAP', { value: lap });
    this.lastLap = lap;
    const cur = director && director.cur;
    if (cur) this.lastCur = `${cur.kind}:${cur.slot}:${camera}`;
    if (f.t - this.lastSampleT >= 0.9) {
      const p = f.order.map(c => [c.slot, c.num, c.x, c.y, c.pit ? 1 : 0, c.pos]);
      const sample = { t: f.t, car: cur ? cur.slot : -1, cam: camera || 0, p, waiting: !!(waiting && waiting.waiting) };
      this.samples.push(sample); if (this.samples.length > 3600) this.samples.shift();
      this.lastSampleT = f.t; this._write({ p: sample });
    }
  }
  cut(f, act, cam) {
    if (!f) return;
    const c = f.order.find(x => x.slot === act.slot);
    this._event(f, String(act.kind || 'CUT').toUpperCase(), { car: act.slot, num: c ? c.num : 0, cam, why: act.why, x: c && c.x, y: c && c.y });
  }
  map(trackLen) {
    const pts = this.bins.filter(b => b.n).map(b => [b.x / b.n, b.y / b.n]);
    return { track: this.track, len: trackLen || 0, from: 'cars', pts, tv: this.tv && trackLen > 0 ? this.tv.read(trackLen).map(g => g.map(c => ({ n: c.n, from: c.start / trackLen, to: c.start / trackLen, x: c.d, y: c.lat, h: c.h, fixed: c.fixed }))) : [[], [], []] };
  }
  at(t) {
    if (!this.samples.length) return null;
    return this.samples.reduce((best, s) => Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best, this.samples[0]);
  }
  files() {
    if (!this.dir) return [];
    try { return fs.readdirSync(this.dir).filter(f => f.endsWith('.jsonl')).map(name => { const st = fs.statSync(path.join(this.dir, name)); return { name, size: st.size, at: st.mtime.toISOString() }; }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30); } catch (e) { return []; }
  }
  readFile(name) {
    if (!this.dir || path.basename(name) !== name || !name.endsWith('.jsonl')) return null;
    try { return fs.readFileSync(path.join(this.dir, name), 'utf8'); } catch (e) { return null; }
  }
}

module.exports = { Timeline, safe };
