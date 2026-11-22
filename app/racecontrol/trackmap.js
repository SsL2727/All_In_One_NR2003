// Port of RaceControl (Nov 2026)'s TrackMap / TrackMapRecorder: the track seen from above, drawn from the AI cars' world
// positions the first lap or so of a session (no driving needed), 500 points round the lap, saved to
// %PROGRAMDATA%\NR2003 Companions\tracks\<track>\map.json - the file RaceVision's dynamic cameras read too.
// Until then another overlay app's trackmap.json (%APPDATA%\*\tracks\<track>\trackmap.json) is borrowed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fx } = require('./format');

const N = 500, SMOOTH_M = 12.0, KEEP = 12, MAX_CARS = 64, CLEAR_OF_PITS = 300.0;
const fr = Math.fround;
const mod = (a, b) => { const n = a % b; return !(n < 0.0) ? n : n + b; };
const g3 = (v) => { const s = fx(v, 3); return s.replace(/\.?0+$/, '') || '0'; };     // "0.###"
const g2 = (v) => { const s = fx(v, 2); return s.replace(/\.?0+$/, '') || '0'; };     // "0.##"
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

let Folder = path.join(process.env.ProgramData || 'C:\\ProgramData', 'NR2003 Companions', 'tracks');

class TrackMap {
  constructor() { this.Track = ''; this.Source = ''; this.Made = ''; this.Length = 0; this.X = new Float32Array(N); this.Y = new Float32Array(N); }

  static get Folder() { return Folder; }
  static set Folder(v) { Folder = v; }
  static PathFor(track) { return path.join(Folder, String(track).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'), 'map.json'); }

  DlongOf(i) { return i * this.Length / N; }

  // Savitzky-Golay style smoothing over about 12 m either way
  Smooth() {
    let n = Math.round(SMOOTH_M / (this.Length / N));
    if (n < 2) n = 2;
    if (n > 40) n = 40;
    const den = (2 * n + 1) * (4.0 * n * n + 4 * n - 3.0);
    const w = new Float64Array(2 * n + 1);
    for (let i = -n; i <= n; i++) w[i + n] = (3.0 * (3.0 * n * n + 3 * n - 1.0) - 15.0 * i * i) / den;
    const x0 = Float32Array.from(this.X), y0 = Float32Array.from(this.Y);
    for (let j = 0; j < N; j++) {
      let sx = 0.0, sy = 0.0;
      for (let k = -n; k <= n; k++) { const m = ((j + k) % N + N) % N; sx += w[k + n] * x0[m]; sy += w[k + n] * y0[m]; }
      this.X[j] = sx; this.Y[j] = sy;
    }
  }

  At(dlong) {
    const t = mod(dlong, this.Length) / this.Length * N;
    const a = Math.floor(t) % N, b = (a + 1) % N, f = t - Math.floor(t);
    return [this.X[a] + (this.X[b] - this.X[a]) * f, this.Y[a] + (this.Y[b] - this.Y[a]) * f];
  }

  Heading(dlong) {
    const s = this.Length / N;
    const [x1, y1] = this.At(dlong - s), [x2, y2] = this.At(dlong + s);
    let tx = x2 - x1, ty = y2 - y1;
    const l = Math.sqrt(tx * tx + ty * ty);
    if (l < 1e-6) return [1.0, 0.0];
    return [tx / l, ty / l];
  }

  AtDlat(dlong, dlat) {
    const [x, y] = this.At(dlong), [tx, ty] = this.Heading(dlong);
    return [x + (0.0 - ty) * dlat, y + tx * dlat];
  }

  // -> { dlong, dist }: the nearest point of the line to (x, y)
  Nearest(x, y) {
    let best = Number.MAX_VALUE, a = 0.0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N, dx = this.X[j] - this.X[i], dy = this.Y[j] - this.Y[i], l2 = dx * dx + dy * dy;
      let t = l2 > 1e-9 ? ((x - this.X[i]) * dx + (y - this.Y[i]) * dy) / l2 : 0.0;
      t = Math.max(0.0, Math.min(1.0, t));
      const ex = this.X[i] + dx * t - x, ey = this.Y[i] + dy * t - y, d2 = ex * ex + ey * ey;
      if (d2 < best) { best = d2; a = (i + t) * this.Length / N; }
    }
    return { dlong: mod(a, this.Length), dist: Math.sqrt(best) };
  }

  Text() {
    let s = '{"track": "' + this.Track.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '",\n';
    s += ' "length_m": ' + g3(this.Length) + ',\n';
    s += ' "source": "' + this.Source + '",\n';
    s += ' "made": "' + this.Made + '",\n';
    s += ' "points": [';
    for (let i = 0; i < N; i++) s += (i === 0 ? '' : ',') + (i % 4 === 0 ? '\n  ' : ' ') + '[' + g3(this.X[i]) + ', ' + g3(this.Y[i]) + ', ' + g2(this.DlongOf(i)) + ']';
    return s + '\n]}\n';
  }

  Save() {
    const p = TrackMap.PathFor(this.Track);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + '.tmp', this.Text());
    try { fs.unlinkSync(p); } catch (e) { /* not there yet */ }
    fs.renameSync(p + '.tmp', p);
  }

  static Load(track) {
    try {
      const p = TrackMap.PathFor(track);
      if (!fs.existsSync(p)) return null;
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!Array.isArray(d.points) || d.points.length !== N) return null;
      const m = new TrackMap();
      m.Track = track; m.Length = Number(d.length_m);
      if (d.source != null) m.Source = String(d.source);
      if (d.made != null) m.Made = String(d.made);
      for (let i = 0; i < N; i++) { m.X[i] = Number(d.points[i][0]); m.Y[i] = Number(d.points[i][1]); }
      if (!(m.Length > 100.0)) return null;
      m.Smooth();
      return m;
    } catch (e) { return null; }
  }

  // another overlay app's map of this track (points [x, y, fraction of the lap]) until the cars have drawn our own
  static Import(track, length) {
    if (!(length > 100.0)) return null;
    let dirs;
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    try { dirs = fs.readdirSync(appData, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(appData, d.name)); } catch (e) { return null; }
    for (const dir of dirs) {
      const f = path.join(dir, 'tracks', track, 'trackmap.json');
      if (!fs.existsSync(f)) continue;
      try {
        const pts = JSON.parse(fs.readFileSync(f, 'utf8')).points;
        const list = [];
        for (const p of pts) {
          if (Array.isArray(p) && p.length >= 3) {
            const t = Number(p[2]);
            if (t >= 0.0 && t < 1.0) list.push([t, Number(p[0]), Number(p[1])]);
          }
        }
        if (list.length >= 50) {
          const m = new TrackMap();
          m.Track = track; m.Length = length; m.Source = 'imported';
          const t = fs.statSync(f).mtime;
          m.Made = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
          if (TrackMap.Resample(list, 1.0, m)) return { map: m, from: f };
        }
      } catch (e) { /* not a map we can read */ }
    }
    return null;
  }

  static Resample(src, period, map) {
    src = src.map((p, i) => ({ p, i })).sort((a, b) => a.p[0] - b.p[0] || a.i - b.i).map(x => x.p);
    const n = src.length;
    if (n < 3) return false;
    let i = 0;
    for (let j = 0; j < N; j++) {
      const at = period * j / N;
      while (i < n && src[i][0] <= at) i++;
      const a = src[(i - 1 + n) % n], b = src[i % n];
      const ta = a[0] - (i === 0 ? period : 0.0), tb = b[0] + (i === n ? period : 0.0);
      const f = tb - ta > 1e-12 ? (at - ta) / (tb - ta) : 0.0;
      map.X[j] = a[1] + (b[1] - a[1]) * f;
      map.Y[j] = a[2] + (b[2] - a[2]) * f;
    }
    return true;
  }
}

const medianF = (v) => {
  v.sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return NaN;
  const h = Math.trunc(n / 2);
  return n % 2 !== 1 ? fr(fr(v[h - 1] + v[h]) / 2) : v[h];
};

class TrackMapRecorder {
  constructor() {
    this.bins = Array.from({ length: N }, () => []);
    this.lastD = new Float32Array(MAX_CARS).fill(NaN);
    this.clear = new Float64Array(MAX_CARS);
    this.cars = new Set();
    this.Note = ''; this.Track = ''; this.Length = 0; this.Active = false; this.Started = new Date();
  }
  get Covered() { return this.bins.filter(b => b.length >= 3).length; }
  get Cars() { return this.cars.size; }

  Start(track, length) {
    this.Track = track; this.Length = length; this.Active = length > 100.0;
    for (const b of this.bins) b.length = 0;
    this.lastD.fill(NaN); this.clear.fill(CLEAR_OF_PITS);
    this.cars.clear();
    this.Started = new Date();
  }
  Stop() { this.Active = false; }

  // one pass over the cars; -> a finished TrackMap once every part of the lap has been seen (then the recorder stops)
  Sample(m, maxIdx) {
    if (!this.Active) return null;
    for (let i = 0; i <= Math.min(maxIdx, MAX_CARS - 1); i++) {
      if (i === 1) continue;
      if (m.U8(8025816 + i) !== 1 || m.U8(7779164 + i) !== 1 || m.U8(7781132 + i) === 1) { this.lastD[i] = NaN; this.clear[i] = 0.0; continue; }
      const d = m.F32(11330202 + i * 8724), lat = m.F32(11330230 + i * 8724);
      const b = 11323952 + i * 8724;
      const x = m.F32(b + 6622), y = m.F32(b + 6622 + 4);
      if (m.F32(11330202 + i * 8724) !== d || m.F32(b + 6622) !== x) continue;        // torn read: the game moved the car meanwhile
      if (!(d >= 0) || !(d < this.Length) || !(Math.abs(lat) < 40) || Number.isNaN(x) || Number.isNaN(y)) { this.lastD[i] = NaN; continue; }
      const last = this.lastD[i];
      this.lastD[i] = d;
      if (Number.isNaN(last)) continue;
      const step = mod(d - last, this.Length);
      if (step < 0.3 || step > 150.0) continue;
      this.clear[i] += step;
      if (!(this.clear[i] < CLEAR_OF_PITS)) {
        const bin = this.bins[Math.min(N - 1, Math.trunc(d / this.Length * N))];
        if (bin.length < KEEP) { bin.push({ X: x, Y: y, Lat: lat, D: d }); this.cars.add(i); }
      }
    }
    if (!this.Ready()) return null;
    this.Active = false;
    return this.Build();
  }

  Ready() {
    let seen = 0, first = -1;
    for (let i = 0; i < N; i++) if (this.bins[i].length >= 3) { seen++; if (first < 0) first = i; }
    if (seen < N - 10 || first < 0) return false;
    let run = 0, worst = 0;
    for (let j = 0; j < N; j++) {
      if (this.bins[(first + j) % N].length >= 3) { run = 0; continue; }
      run++; worst = Math.max(worst, run);
    }
    return worst <= 2;
  }

  Build() {
    const avgD = (b) => fr(b.reduce((s, x) => s + x.D, 0) / b.length);      // Enumerable.Average over floats returns a float
    const raw = [];
    for (const b of this.bins) if (b.length > 0) raw.push([avgD(b), medianF(b.map(s => s.X)), medianF(b.map(s => s.Y))]);
    const line = new TrackMap();
    line.Track = this.Track; line.Length = this.Length;
    TrackMap.Resample(raw, this.Length, line);
    const s0 = this.Spread(line, 0), sp = this.Spread(line, 1), sm = this.Spread(line, -1);
    let sign = sp <= sm ? 1 : -1;
    if (Math.min(sp, sm) > s0 * 0.8) {
      sign = 0.0;
      this.Note = `racing line (dlat did not line the cars up: ${fx(Math.sqrt(s0), 1)} m spread, ${fx(Math.sqrt(Math.min(sp, sm)), 1)} m with it)`;
    } else {
      this.Note = `centre line (${fx(Math.sqrt(s0), 1)} m spread across the cars, ${fx(Math.sqrt(Math.min(sp, sm)), 1)} m after dlat${sign > 0 ? '' : ', counted to the right'})`;
    }
    const pts = [];
    for (const b of this.bins) {
      if (b.length === 0) continue;
      const xs = [], ys = [];
      for (const it of b) {
        const [tx, ty] = line.Heading(it.D);
        xs.push(fr(it.X - sign * it.Lat * (0.0 - ty)));
        ys.push(fr(it.Y - sign * it.Lat * tx));
      }
      let mx = medianF(xs.slice()), my = medianF(ys.slice());
      const keep = xs.map((_, k) => k).filter(k => fr(fr(fr(xs[k] - mx) * fr(xs[k] - mx)) + fr(fr(ys[k] - my) * fr(ys[k] - my))) < 36);
      if (keep.length > 0 && keep.length < xs.length) { mx = medianF(keep.map(k => xs[k])); my = medianF(keep.map(k => ys[k])); }
      pts.push([avgD(b), mx, my]);
    }
    const map = new TrackMap();
    map.Track = this.Track; map.Length = this.Length; map.Source = 'recorded'; map.Made = today();
    TrackMap.Resample(pts, this.Length, map);
    map.Smooth();
    return map;
  }

  Spread(line, sign) {
    let sum = 0.0, n = 0;
    for (const b of this.bins) {
      if (b.length < 2) continue;
      const v = b.map(s => {
        const [tx, ty] = line.Heading(s.D), [x, y] = line.At(s.D);
        return (s.X - x) * (0.0 - ty) + (s.Y - y) * tx - fr(sign * s.Lat);
      });
      const avg = v.reduce((a, c) => a + c, 0) / v.length;
      for (const e of v) { sum += (e - avg) * (e - avg); n++; }
    }
    return n !== 0 ? sum / n : 0.0;
  }
}

module.exports = { TrackMap, TrackMapRecorder, N };
