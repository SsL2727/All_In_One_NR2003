// Number cards, headshots, manufacturer logos and driver colours for the broadcast graphics.
// Same folders All In One NR2003's season tools keep: <series root>\<series id>\{numbers,headshots,manufacturers}\<car number>.png, colors.json,
// rookies.json. Roots: All In One NR2003's own series folder, plus the folders listed in the `art_folders` setting (a root, or one series folder).
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const TTL = 30000;

class ArtLibrary {
  // opts: { roots: () => [dir], now? }
  constructor(opts) { this.opts = opts; this.series = new Map(); this.at = -1e9; this.now = opts.now || Date.now; }

  _scanSeries(dir, id) {
    const png = (sub) => { try { return new Set(fs.readdirSync(path.join(dir, sub)).filter(f => /\.png$/i.test(f)).map(f => f.slice(0, -4))); } catch (e) { return new Set(); } };
    const json = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return {}; } };
    return { id, dir, logo: fs.existsSync(path.join(dir, 'serieslogo.png')) ? path.join(dir, 'serieslogo.png') : '', numbers: png('numbers'), heads: png('headshots'), manus: png('manufacturers'), colors: json('colors.json'), rookies: json('rookies.json'), names: json('names.json') };
  }

  scan(force) {
    const t = this.now();
    if (!force && t - this.at < TTL) return;
    this.at = t; this.series.clear();
    for (const root of this.opts.roots() || []) {
      try {
        if (!root || !fs.existsSync(root)) continue;
        if (fs.existsSync(path.join(root, 'numbers')) || fs.existsSync(path.join(root, 'headshots'))) { this.series.set(path.basename(root), this._scanSeries(root, path.basename(root))); continue; }
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const d = path.join(root, e.name);
          if (fs.existsSync(path.join(d, 'numbers')) || fs.existsSync(path.join(d, 'headshots'))) this.series.set(e.name, this._scanSeries(d, e.name));
        }
      } catch (e) { /* unreadable root */ }
    }
  }

  ids() { this.scan(); return [...this.series.keys()]; }

  imagePath(series, kind, number) {
    this.scan();
    const s = this.series.get(String(series || ''));
    if (!s) return '';
    if (kind === 'logo') return s.logo || '';
    const n = String(number || '');
    const sub = kind === 'number' ? 'numbers' : kind === 'head' ? 'headshots' : kind === 'manu' ? 'manufacturers' : '';
    const set = kind === 'number' ? s.numbers : kind === 'head' ? s.heads : kind === 'manu' ? s.manus : null;
    return sub && set && set.has(n) ? path.join(s.dir, sub, n + '.png') : '';
  }

  // the series to use: a named one if it exists, else the one with the most of the field's car numbers
  pick(nums, preferred, strict = false) {
    this.scan();
    if (preferred && preferred !== 'auto') {
      const k = [...this.series.keys()].find(x => x.toLowerCase() === String(preferred).toLowerCase());
      if (k) return this.series.get(k);
      if (strict) return null;
    }
    let best = null, bs = -1;
    for (const s of this.series.values()) {
      let n = 0; for (const x of nums) if (s.numbers.has(String(x)) || s.heads.has(String(x))) n++;
      if (n > bs) { bs = n; best = s; }
    }
    return best;
  }

  static art(s, num) {
    const n = String(num);
    if (!s) return { number: '', head: '', manu: '', logo: '', color: '', rookie: false };
    const url = (sub, set) => (set.has(n) ? pathToFileURL(path.join(s.dir, sub, n + '.png')).href : '');
    const nm = s.names && s.names[n];
    return { number: url('numbers', s.numbers), head: url('headshots', s.heads), manu: url('manufacturers', s.manus), logo: s.logo ? pathToFileURL(s.logo).href : '', color: s.colors[n] || '', rookie: !!(s.rookies && s.rookies[n]), nameOv: nm || null, series: s.id };
  }
}

module.exports = { ArtLibrary };
