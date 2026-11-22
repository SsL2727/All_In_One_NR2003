// Camera sets (RaceVision, Nov 2026): choose the TV cameras of a track and the car cameras of a series.
//
// A set is either the game's own ("stock"), one of RaceVision's recipes made from the game's own (camfiles.RECIPES) or a .cam file in
// the camsets folder (presets\track\<track>\*.cam, presets\series\<series>\*.cam). "Use now" writes it into the cameras the game is
// using this moment (the TV tables and pit cameras of the loaded track; the car cameras of every car model that has the series' cameras);
// "Save for the next session" writes it over the game's file, after keeping the game's own copy (stock\...), so it can be put back.
// A track whose cameras are packed inside its .dat has no loose file: its sets can only be used live.
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./camfiles');

const safe = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };

class CameraSets {
  // opts: { mem (readBytes/writeBytes), gameDir: () => path, root: () => camsets folder, programData?: path, log }
  constructor(opts) {
    this.o = opts; this.mem = opts.mem; this.log = opts.log || (() => {});
    this.loadedTrack = null;      // { track, name } live in the game now
    this.loadedSeries = null;     // { series, name, models: [indices] }
    this.seriesWhy = '';          // how detectSeries() knows: 'chosen' (you picked it / we applied it) | 'guess' (the cameras match) | ''
  }
  gameDir() { return this.o.gameDir() || ''; }
  root() {
    const r = this.o.root && this.o.root();
    if (r) return r;
    const pd = this.o.programData || process.env.PROGRAMDATA || 'C:\\ProgramData';
    return path.join(pd, 'NR2003 Companions', 'racevision', 'camsets');
  }
  _applied() { return readJson(path.join(this.root(), 'applied.json'), { track: {}, series: {} }); }
  _setApplied(kind, who, name) {
    const a = this._applied(); a[kind] = a[kind] || {};
    if (!name || name === 'stock') delete a[kind][who]; else a[kind][who] = name;
    fs.mkdirSync(this.root(), { recursive: true });
    fs.writeFileSync(path.join(this.root(), 'applied.json'), JSON.stringify(a, null, 1));
  }

  // ── where things are ─────────────────────────────────────────────────────────────────────
  trackFile(track) { return path.join(this.gameDir(), 'tracks', track, track + '.cam'); }
  seriesFile(series) { return path.join(this.gameDir(), 'series', series, 'make_a.cam'); }
  stockPath(kind, who) { return kind === 'track' ? path.join(this.root(), 'stock', 'tracks', safe(who) + '.cam') : path.join(this.root(), 'stock', 'series', safe(who), 'make_a.cam'); }
  _noFileMark(kind, who) { return this.stockPath(kind, who) + '.none'; }

  tracks() {
    const dir = path.join(this.gameDir(), 'tracks');
    if (!isDir(dir)) return [];
    const pd = this.o.programData || process.env.PROGRAMDATA || 'C:\\ProgramData';
    return fs.readdirSync(dir).filter(t => isDir(path.join(dir, t))).sort((a, b) => a.localeCompare(b))
      .map(name => ({ name, file: exists(this.trackFile(name)), map: exists(path.join(pd, 'NR2003 Companions', 'tracks', safe(name), 'map.json')) }));
  }
  series() {
    const dir = path.join(this.gameDir(), 'series');
    return isDir(dir) ? fs.readdirSync(dir).filter(s => isDir(path.join(dir, s))).sort((a, b) => a.localeCompare(b)) : [];
  }

  // ── the game's own set ───────────────────────────────────────────────────────────────────
  // kept the first time: from the loose file, or (packed track / series without a file) from the game's memory while nothing is applied
  stockTrack(track, { liveTrack } = {}) {
    const sp = this.stockPath('track', track);
    if (exists(sp)) return C.parseTrack(fs.readFileSync(sp));
    const f = this.trackFile(track);
    if (exists(f)) { const b = fs.readFileSync(f); const s = C.parseTrack(b); this._keep(sp, b); return s; }
    if (liveTrack === track && !(this.loadedTrack && this.loadedTrack.track === track)) {
      const s = this.readLiveTrack();
      if (s) { this._keep(sp, C.writeTrack(s)); fs.writeFileSync(sp + '.packed', ''); return s; }
    }
    return null;
  }
  stockCar(series) {
    const sp = this.stockPath('series', series);
    if (exists(sp)) return C.parseCar(fs.readFileSync(sp));
    const f = this.seriesFile(series);
    if (exists(f)) { const b = fs.readFileSync(f); const c = C.parseCar(b); this._keep(sp, b); return c; }
    // packed: the cameras most car models have in the game now (only while nothing of ours is in the game)
    if (this.loadedSeries) return null;
    const live = this.readLiveCars();
    if (!live) return null;
    const count = new Map();
    for (const b of live) { if (!b.some(x => x)) continue; const k = b.toString('hex'); count.set(k, (count.get(k) || 0) + 1); }
    const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) return null;
    const c = C.carFromBytes(Buffer.from(best[0], 'hex'));
    this._keep(sp, C.writeCar(c)); fs.writeFileSync(this._noFileMark('series', series), '');
    return c;
  }
  _keep(p, buf) { fs.mkdirSync(path.dirname(p), { recursive: true }); if (!exists(p)) fs.writeFileSync(p, buf); }

  // ── the sets of a track / series ─────────────────────────────────────────────────────────
  _presetDir(kind, who) { return path.join(this.root(), 'presets', kind === 'track' ? 'track' : 'series', who); }
  _presets(kind, who) {
    const d = this._presetDir(kind, who);
    return isDir(d) ? fs.readdirSync(d).filter(f => /\.cam$/i.test(f)).map(f => ({ name: f.replace(/\.cam$/i, ''), file: path.join(d, f) })) : [];
  }
  // -> the set (parsed) or throws
  make(kind, who, name, ctx = {}) {
    const stock = kind === 'track' ? this.stockTrack(who, ctx) : this.stockCar(who);
    if (name === 'stock') { if (!stock) throw new Error("the game's own camera file isn't saved yet (and NR2003 has no session loaded for it)"); return stock; }
    const r = C.RECIPES.find(x => x.name === name && x.kind === kind);
    if (r) {
      if (!stock) throw new Error('no camera file to make ' + JSON.stringify(name) + ' from');
      return r.make(kind === 'track' ? C.cloneTrack(stock) : C.cloneCar(stock));
    }
    const p = this._presets(kind, who).find(x => x.name === name);
    if (!p) throw new Error('no such set');
    return C.parseAny(kind, fs.readFileSync(p.file));          // binary (MACT / MACC) or RaceVision's text form
  }
  list(kind, who, ctx = {}) {
    if (!who) return [];
    const applied = (this._applied()[kind] || {})[who] || 'stock';
    const live = kind === 'track' ? (this.loadedTrack && this.loadedTrack.track === who ? this.loadedTrack.name : (ctx.liveTrack === who ? 'stock' : null))
      : (this.loadedSeries && this.loadedSeries.series === who ? this.loadedSeries.name : null);
    const out = [];
    const add = (name, extra) => {
      let cams = null;
      if (kind === 'track') { try { const s = this.make(kind, who, name, ctx); cams = s.groups.map(g => g.length); } catch (e) { if (name !== 'stock') return; } }
      out.push(Object.assign({ name, title: C.setTitle(name, kind, kind === 'track' ? this.trackLength(who) : 0), desc: C.setDesc(name), builtin: false, loaded: live === name, saved: applied === name, cams }, extra));
    };
    add('stock', { desc: 'The game\'s own cameras.' });
    for (const r of C.RECIPES.filter(x => x.kind === kind)) add(r.name, { desc: r.desc, builtin: true });
    for (const p of this._presets(kind, who)) add(p.name, {});
    return out;
  }

  // the track's length from its track.ini (track_length = 1.5 mi / 2.5 k), metres; 0 when not known
  trackLength(track) {
    try {
      for (const line of fs.readFileSync(path.join(this.gameDir(), 'tracks', track, 'track.ini'), 'latin1').split(/\r?\n/)) {
        const t = line.split(';')[0].trim(), eq = t.indexOf('=');
        if (eq < 0 || t.slice(0, eq).trim().toLowerCase() !== 'track_length') continue;
        const m = /^\s*([0-9.]+)\s*([a-zA-Z]?)/.exec(t.slice(eq + 1)), v = m ? Number(m[1]) : NaN;
        if (!Number.isFinite(v)) return 0;
        const len = m[2].toLowerCase() === 'k' ? v * 1000 : v * 1609.344;
        return len > 100 && len < 50000 ? len : 0;
      }
    } catch (e) { /* no track.ini */ }
    return 0;
  }

  // ── preview: a set's cameras on the track map (for the simulated race of the preview page) ────
  // map: a TrackMap (Race Control's map.json). -> { track, name, len, lap, from, pts: [x, y, ...], tv: [[{ n, from, x, y, fixed }]...3], pit }
  preview(track, name, map, ctx = {}) {
    if (!map || !(map.Length > 100)) throw new Error('No track map for ' + track + ' yet - Race Control or RaceVision draws it from the cars in the first lap of a session.');
    const official = this.trackLength(track);
    if (official > 0 && Math.abs(map.Length - official) > official * 0.15) throw new Error('The track map of ' + track + ' was drawn with the wrong lap length (' + Math.round(map.Length) + ' m, the track is ' + Math.round(official) + ' m). Race Control draws it again in the next session there.');
    const set = this.make('track', track, name, ctx), L = map.Length;
    const r1 = (v) => Math.round(v * 10) / 10, wrap = (d) => ((d % L) + L) % L;
    const pts = []; for (let i = 0; i < map.X.length; i++) pts.push(r1(map.X[i]), r1(map.Y[i]));
    const tv = set.groups.map(g => g.map((r, i) => {
      const [x, y] = map.AtDlat(r.f[0], r.f[1]);
      return { n: i + 1, from: r1(wrap(r.f[0] + r.f[3])), d: r1(wrap(r.f[0])), x: r1(x), y: r1(y), h: r1(r.f[2]), fixed: r.fixed === 1 };
    }).sort((a, b) => a.from - b.from));
    const pit = [0, 1].map(i => ({ cam: 17 + i, x: r1(set.pit.readFloatLE(i * C.PIT)), y: r1(set.pit.readFloatLE(i * C.PIT + 4)) }))
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && (p.x || p.y));
    return { track, name, title: C.setTitle(name, 'track', this.trackLength(track)), len: r1(L), lap: r1(L), from: map.Source || 'cars', pts, tv, pit };
  }

  // ── NR2003's memory ──────────────────────────────────────────────────────────────────────
  sessionLoaded() { const b = this.mem.readBytes(C.A.TvMaster, 4); return !!b && b.readUInt32LE(0) <= C.MAX_CAMS; }
  replaying() { const b = this.mem.readBytes(0xB8E59A, 4); return !!b && b.readUInt32LE(0) === 1; }
  readLiveTrack() {
    const t = this.mem.readBytes(C.A.TvMaster, C.GROUPS * C.GROUP_STRIDE), p = this.mem.readBytes(C.A.Pit1, 2 * C.PIT);
    if (!t || !p) return null;
    try { return C.trackFromTables(t, p); } catch (e) { return null; }
  }
  readLiveCars() {
    const b = this.mem.readBytes(C.A.CarCams, C.A.CarModels * 6 * C.A.CarCam);
    if (!b) return null;
    const out = []; for (let m = 0; m < C.A.CarModels; m++) out.push(b.subarray(m * 6 * C.A.CarCam, (m + 1) * 6 * C.A.CarCam));
    return out;
  }
  _liveCheck() {
    if (!this.mem.readBytes(C.A.TvMaster, 4)) return "NR2003 isn't running";
    if (this.replaying()) return "a replay is playing - try again when it's over";
    if (!this.sessionLoaded()) return 'no session is loaded in NR2003 yet';
    return '';
  }
  liveTrack(set) {
    const why = this._liveCheck(); if (why) throw new Error(why);
    const tables = C.trackTables(set);
    // the records first, then the counts, in both copies; then the pit cameras (both copies)
    let ok = true;
    for (const base of [C.A.TvMaster, C.A.TvLive]) {
      for (let g = 0; g < C.GROUPS; g++) ok = this.mem.writeBytes(base + g * C.GROUP_STRIDE + 4, tables.subarray(g * C.GROUP_STRIDE + 4, (g + 1) * C.GROUP_STRIDE)) && ok;
      for (let g = 0; g < C.GROUPS; g++) ok = this.mem.writeBytes(base + g * C.GROUP_STRIDE, tables.subarray(g * C.GROUP_STRIDE, g * C.GROUP_STRIDE + 4)) && ok;
    }
    ok = this.mem.writeBytes(C.A.Pit1, set.pit) && this.mem.writeBytes(C.A.Pit2, set.pit) && ok;
    if (!ok) throw new Error("the game wouldn't take the camera tables");
    const back = this.mem.readBytes(C.A.TvMaster, tables.length);
    if (!back || !back.equals(tables)) throw new Error("the tables didn't read back the same");
  }
  // the car models that have `from` (any of the given sets) get `to`; -> models written
  liveCars(froms, to) {
    const why = this._liveCheck(); if (why) throw new Error(why);
    const live = this.readLiveCars();
    if (!live) throw new Error("couldn't find this series' car cameras in the game's memory");
    const fromBytes = froms.filter(Boolean).map(C.carBytes);
    const models = [];
    live.forEach((b, m) => { if (fromBytes.some(f => f.equals(b))) models.push(m); });
    if (!models.length) throw new Error("couldn't find this series' car cameras in the game's memory");
    const bytes = C.carBytes(to);
    for (const m of models) if (!this.mem.writeBytes(C.A.CarCams + m * 6 * C.A.CarCam, bytes)) throw new Error("the game wouldn't take the car cameras");
    return models;
  }
  // which mod these car cameras belong to, as you picked it: "<art series>=<game series folder>" lines in car_series.txt (RaceVision 1.2.0)
  _pickFile() { return path.join(this.root(), 'car_series.txt'); }
  _picks() {
    let t = ''; try { t = fs.readFileSync(this._pickFile(), 'utf8'); } catch (e) { return []; }
    return t.split(/\r?\n/).map(l => l.trim()).filter(l => l.indexOf('=') > 0).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]);
  }
  seriesChoice(key) { const k = String(key || 'default'); const p = this._picks().find(x => x[0] === k); return p ? p[1] : ''; }
  chooseSeries(key, name) {
    const k = String(key || 'default').replace(/[=\r\n]/g, '_');
    if (!name || safe(name) !== name || name.includes('..') || !this.series().includes(name)) throw new Error('no such series: ' + name);
    const out = this._picks().filter(x => x[0] !== k).map(x => x[0] + '=' + x[1]);
    out.push(k + '=' + name);
    fs.mkdirSync(this.root(), { recursive: true });
    fs.writeFileSync(this._pickFile(), out.join('\n') + '\n');
    this.log(`camera sets: car cameras belong to ${name} (remembered for ${k})`);
    return name;
  }
  // which series' cameras the game has now (its own or ours). Many mods keep the default car cameras, so a match is only a GUESS (the
  // first series that has them) until you pick the mod: the pick is remembered per art series (the mod the director is showing)
  detectSeries(key) {
    this.seriesWhy = '';
    const ch = this.seriesChoice(key);
    if (ch && this.series().includes(ch)) { this.seriesWhy = 'chosen'; return ch; }
    const live = this.readLiveCars();
    if (!live) return '';
    if (this.loadedSeries) { this.seriesWhy = 'chosen'; return this.loadedSeries.series; }
    this.seriesWhy = 'guess';
    for (const s of this.series()) {
      let stock = null;
      try { const sp = this.stockPath('series', s); stock = exists(sp) ? C.parseCar(fs.readFileSync(sp)) : (exists(this.seriesFile(s)) ? C.parseCar(fs.readFileSync(this.seriesFile(s))) : null); } catch (e) { stock = null; }
      if (!stock) continue;
      const b = C.carBytes(stock);
      if (live.some(x => x.equals(b))) return s;
    }
    this.seriesWhy = '';
    return '';
  }

  // ── use a set ────────────────────────────────────────────────────────────────────────────
  // -> { live: 'done' | 'failed' | 'not asked', liveMsg, saved: 'done' | 'failed' | 'not asked', saveMsg }
  apply(kind, who, name, { live = true, save = false, liveTrack = '' } = {}) {
    const r = { live: 'not asked', liveMsg: '', saved: 'not asked', saveMsg: '' };
    if (kind !== 'track' && kind !== 'series') throw new Error('bad kind');
    if (!who) throw new Error(kind === 'track' ? 'no track' : 'no series');
    const set = this.make(kind, who, name, { liveTrack });
    if (live) {
      try {
        if (kind === 'track') {
          if (liveTrack && liveTrack !== who) throw new Error("that isn't the track NR2003 has loaded");
          this.liveTrack(set); this.loadedTrack = { track: who, name };
        } else {
          const froms = [this.stockCar(who)];
          if (this.loadedSeries && this.loadedSeries.series === who) { try { froms.push(this.make('series', who, this.loadedSeries.name)); } catch (e) { /* gone */ } }
          const models = this.liveCars(froms, set);
          this.loadedSeries = name === 'stock' ? null : { series: who, name, models };
        }
        if (name === 'stock' && kind === 'track') this.loadedTrack = null;
        r.live = 'done';
      } catch (e) { r.live = 'failed'; r.liveMsg = e.message; }
    }
    if (save && kind === 'series' && this.o.seriesKey && this.detectSeries(this.o.seriesKey()) === who && this.seriesWhy === 'guess') {
      r.saved = 'failed'; r.saveMsg = "RaceVision can't tell which mod this is (many keep the default car cameras): pick it first, so no other mod's files are touched";
    } else if (save) {
      try { this._save(kind, who, name, set); r.saved = 'done'; } catch (e) { r.saved = 'failed'; r.saveMsg = e.message; }
    }
    this.log(`camera sets: ${kind} ${who} -> ${name}${r.live !== 'not asked' ? ' - live: ' + r.live + (r.liveMsg ? ' (' + r.liveMsg + ')' : '') : ''}${r.saved !== 'not asked' ? ', saved: ' + r.saved + (r.saveMsg ? ' (' + r.saveMsg + ')' : '') : ''}`);
    return r;
  }
  _save(kind, who, name, set) {
    const gd = this.gameDir();
    if (!gd || !isDir(gd)) throw new Error("the NR2003 folder isn't known yet");
    const target = kind === 'track' ? this.trackFile(who) : this.seriesFile(who);
    const sp = this.stockPath(kind, who);
    if (kind === 'track' && (exists(sp + '.packed') || (!exists(target) && !exists(sp)))) throw new Error("this track's cameras are packed inside its .dat - saved for next session isn't possible (live only)");
    if (!exists(sp)) {                                        // keep the game's own first
      if (exists(target)) this._keep(sp, fs.readFileSync(target));
      else if (kind === 'series') { this.stockCar(who); if (!exists(sp)) throw new Error("could not save the game's own file to " + sp); }
    }
    if (name === 'stock') {
      if (kind === 'series' && exists(this._noFileMark('series', who))) { try { fs.unlinkSync(target); } catch (e) { /* not there */ } }
      else if (exists(sp)) fs.copyFileSync(sp, target);
      else throw new Error("the game's own file was never saved here, so there is nothing to put back");
    } else {
      fs.writeFileSync(target, kind === 'track' ? C.writeTrack(set) : C.writeCar(set));
    }
    this._setApplied(kind, who, name);
  }
  restore(kind, who, opts) { return this.apply(kind, who, 'stock', opts); }

  // the game left: nothing of ours is live any more
  gameGone() { this.loadedTrack = null; this.loadedSeries = null; }

  // everything the Camera sets page shows
  state({ track, liveTrack, attached }) {
    const t = track || liveTrack || '';
    const key = this.o.seriesKey ? this.o.seriesKey() : 'default';
    const chosen = this.seriesChoice(key);
    const series = attached ? this.detectSeries(key) : (chosen && this.series().includes(chosen) ? chosen : '');
    const seriesWhy = attached ? this.seriesWhy : (series ? 'chosen' : '');
    const live = !!attached && this._liveCheck() === '';
    const r = {
      root: this.root(), game: this.gameDir(), attached: !!attached, live, session: live, current: liveTrack || '', track: t,
      tracks: this.tracks(), trackFile: !!t && exists(this.trackFile(t)) && !exists(this.stockPath('track', t) + '.packed'),
      trackSets: [], series, seriesWhy, seriesKey: key, seriesCands: this.series(), seriesList: this.series(), seriesSets: null,
      trackLoaded: this.loadedTrack && this.loadedTrack.track === t ? this.loadedTrack.name : (liveTrack === t ? 'stock' : ''),
      trackSaved: ((this._applied().track || {})[t]) || 'stock',
    };
    try { r.trackSets = this.list('track', t, { liveTrack }); } catch (e) { r.trackError = e.message; }
    if (series) { try { r.seriesSets = this.list('series', series); } catch (e) { r.seriesError = e.message; } }
    return r;
  }
}

module.exports = { CameraSets };
