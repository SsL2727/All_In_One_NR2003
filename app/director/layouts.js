// RaceVision 2.0 overlay layouts, built in: the layouts folder (the built-in looks, the overlay pack, your own), style presets for
// the whole screen, which layout each panel uses and where it sits, and the editor's calls (/api/overlay/...): a port of
// racevision_layout.cpp's store and LayApi. Drawing is director/layoutdraw.js (the overlay window and the preview window).
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// the built-in layouts: the looks RaceVision has always drawn, as data (racevision_layout.cpp LAY_DEFAULTS)
const BUILTIN = require('./layouts_builtin.json');

// the panels: key, label, base size, default spot on a 1920 x 1080 screen (All In One NR2003's overlay positions are in that space)
const PANELS = [
  ['tag', 'Driver tag', 560, 126, [40, 900, 1]], ['battle', 'Battle box', 420, 110, [620, 900, 1]],
  ['onboard', 'On-board gauges', 300, 120, [1560, 880, 1]], ['dash', 'In-car dash', 660, 140, [40, 30, 1]],
  ['custom1', 'Custom 1', 400, 60, [760, 120, 1]], ['custom2', 'Custom 2', 400, 60, [760, 200, 1]],
  ['custom3', 'Custom 3', 400, 60, [760, 280, 1]], ['custom4', 'Custom 4', 400, 60, [760, 360, 1]],
  ['rc_qual', 'Qualifying timing box', 440, 132, [40, 740, 1]], ['rc_tele', 'Telemetry strip', 960, 172, [480, 880, 1]],
  ['rc_cone', 'Cone board', 600, 300, [660, 100, 1]], ['rc_order', 'Qualifying order ticker', 1280, 56, [320, 1010, 1]],
];
const PANEL_KEYS = PANELS.map(p => p[0]);
// All In One NR2003's own positions for the panels it already had (the dash shares the on-board spot)
const POS_KEY = { tag: 'overlay_tag', battle: 'overlay_battle', onboard: 'overlay_onboard', dash: 'overlay_onboard' };

const CAR_FIELDS = [
  ['place', 'Place (number)', 'num'], ['place_p', 'Place as P12', 'text'], ['place_ord', 'Place as 12TH', 'text'],
  ['number', 'Car number', 'text'], ['first', 'First name', 'text'], ['last', 'Last name', 'text'],
  ['full', 'Full name', 'text'], ['short', 'Short name (last)', 'text'],
  ['speed_mph', 'Speed, mph', 'num'], ['speed_kph', 'Speed, km/h', 'num'], ['rpm', 'RPM', 'num'],
  ['rpm_frac', 'RPM, share of the highest seen (0-1)', 'num'], ['rpm_10k', 'RPM / 10000 (0-1)', 'num'],
  ['gear', 'Gear', 'text'], ['in_gear', 'In a forward gear (yes/no)', 'bool'],
  ['throttle', 'Throttle (0-1)', 'num'], ['brake', 'Brake (0-1)', 'num'],
  ['throttle_pct', 'Throttle, percent (0-100)', 'num'], ['brake_pct', 'Brake, percent (0-100)', 'num'],
  ['steer', 'Steering, degrees (+ = left)', 'num'], ['steer_abs', 'Steering, degrees (no sign)', 'num'],
  ['laps', 'Laps done', 'num'], ['laps_led', 'Laps led', 'num'], ['pits', 'Pit stops', 'num'],
  ['start_pos', 'Started in (place)', 'num'], ['places_gained', 'Places gained since the start', 'text'],
  ['last_lap', 'Last lap time', 'text'], ['best_lap', 'Best lap time', 'text'],
  ['interval', 'Gap to the car ahead', 'text'], ['gap_leader', 'Gap to the leader', 'text'],
  ['pit', 'In the pits (yes/no)', 'bool'], ['color', 'Has a paint colour (yes/no)', 'bool'],
  ['has_card', 'Has number-card art (yes/no)', 'bool'], ['valid', 'Is on track (yes/no)', 'bool']];
const RC_ROWS = (grp, n, fields) => { const o = []; for (let i = 1; i <= n; i++) for (const [k, l, t] of fields) o.push([`rc.${grp}.${i}.${k}`, `${grp === 'tele.order' ? 'Order' : grp === 'cone.inside' ? 'Cone inside' : 'Cone outside'} row ${i}: ${l}`, t]); return o; };
const GLOBALS = [
  ['shot.sub', 'What he is doing (battle line, REPLAY)', 'text'], ['story.label', 'Race story: place plate', 'text'],
  ['story.any', 'A race story is available (yes/no)', 'bool'],
  ['battle.title', 'Battle title: BATTLE FOR P2', 'text'], ['battle.title_ord', 'Battle title: BATTLE FOR 2ND', 'text'],
  ['battle.place', 'Battle place', 'num'], ['battle.gap', 'Gap between the two (seconds)', 'num'], ['battle.metres', 'Gap between the two (metres)', 'num'],
  ['replay', 'A replay is playing (yes/no)', 'bool'],
  ['race.lap', "Leader's lap", 'num'], ['race.laps_total', 'Race length', 'num'], ['race.laps_to_go', 'Laps to go', 'num'], ['race.progress', 'Race distance done (0-1)', 'num'],
  ['race.green', 'Green flag (yes/no)', 'bool'], ['race.flag', 'Flag', 'text'], ['track.name', 'Track', 'text'],
  ['rc.live', 'Race Control feed is running (yes/no)', 'bool'], ['rc.session', 'Race Control: session', 'text'],
  ['rc.qual.show', 'Qual box: showing now (yes/no)', 'bool'], ['rc.qual.header', 'Qual box: header', 'text'],
  ['rc.qual.pole_num', 'Qual box: pole car number', 'text'], ['rc.qual.pole_name', 'Qual box: pole driver', 'text'], ['rc.qual.pole_time', 'Qual box: pole time', 'text'],
  ['rc.qual.car_num', 'Qual box: car number', 'text'], ['rc.qual.car_name', 'Qual box: car driver', 'text'], ['rc.qual.car_pos', 'Qual box: car position', 'text'],
  ['rc.qual.right', 'Qual box: right-hand value (delta / lap time)', 'text'], ['rc.qual.right_mode', 'Qual box: right mode (0 text, 1 lap, 2 delta)', 'num'],
  ['rc.qual.projected', 'Qual box: projected time', 'text'], ['rc.qual.faster', 'Qual box: faster than pole (yes/no)', 'bool'],
  ['rc.tele.show', 'Telemetry strip: showing now (yes/no)', 'bool'], ['rc.tele.track', 'Telemetry: track', 'text'], ['rc.tele.session', 'Telemetry: session', 'text'],
  ['rc.tele.num', 'Telemetry: car number', 'text'], ['rc.tele.first', 'Telemetry: first name', 'text'], ['rc.tele.last', 'Telemetry: last name', 'text'],
  ['rc.tele.tele_ok', 'Telemetry: data available (yes/no)', 'bool'], ['rc.tele.mph', 'Telemetry: mph', 'num'], ['rc.tele.rpm', 'Telemetry: RPM', 'num'],
  ['rc.tele.rpm_top', 'Telemetry: RPM at the top of the dial', 'num'], ['rc.tele.throttle', 'Telemetry: throttle (0-1)', 'num'], ['rc.tele.brake', 'Telemetry: brake (0-1)', 'num'],
  ['rc.tele.rpm_frac', 'Telemetry: RPM share of the dial (0-1)', 'num'], ['rc.tele.gear', 'Telemetry: gear', 'num'], ['rc.tele.lap_no', 'Telemetry: lap number', 'num'], ['rc.tele.laps_total', 'Telemetry: laps in the run', 'num'],
  ['rc.tele.current', 'Telemetry: current lap', 'text'], ['rc.tele.last_lap', 'Telemetry: last lap', 'text'], ['rc.tele.best_lap', 'Telemetry: best lap', 'text'],
  ['rc.tele.faster', 'Telemetry: ahead of the best (yes/no)', 'bool'], ['rc.tele.show_order', 'Telemetry: order slide-in showing (yes/no)', 'bool'],
  ...RC_ROWS('tele.order', 3, [['pos', 'place', 'text'], ['num', 'number', 'text'], ['last', 'last name', 'text'], ['time', 'time', 'text']]),
  ['rc.cone.show', 'Cone board: showing now (yes/no)', 'bool'], ['rc.cone.title', 'Cone board: title', 'text'], ['rc.cone.cars', 'Cone board: cars', 'num'],
  ...RC_ROWS('cone.inside', 2, [['num', 'number', 'text'], ['last', 'last name', 'text'], ['to', 'new place', 'num']]),
  ...RC_ROWS('cone.outside', 2, [['num', 'number', 'text'], ['last', 'last name', 'text'], ['to', 'new place', 'num']])];
const WHOS = ['car', 'other', 'top', 'bottom', 'leader', 'ahead', 'behind', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];

const validName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 40 && /^[A-Za-z0-9_-]+$/.test(n);
const isPic = (n) => /\.(png|jpe?g)$/i.test(n);
const isFont = (n) => /\.(ttf|otf)$/i.test(n);
const readJson = (p) => { try { const t = fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; } };
const writeAtomic = (p, data) => { const tmp = p + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, p); };
const jtext = (o) => JSON.stringify(o, null, 1) + '\n';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// a font file's family name (the name table: id 16 typographic family, else 1)
function fontFamily(file) {
  try {
    const b = fs.readFileSync(file);
    const n = b.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      if (b.toString('latin1', r, r + 4) !== 'name') continue;
      const off = b.readUInt32BE(r + 8), count = b.readUInt16BE(off + 2), so = off + b.readUInt16BE(off + 4);
      const found = {};
      for (let k = 0; k < count; k++) {
        const e = off + 6 + k * 12, pid = b.readUInt16BE(e), id = b.readUInt16BE(e + 6), len = b.readUInt16BE(e + 8), at = so + b.readUInt16BE(e + 10);
        if (id !== 1 && id !== 16) continue;
        let s;
        if (pid === 3 || pid === 0) { const u = Buffer.from(b.subarray(at, at + len)); u.swap16(); s = u.toString('utf16le'); }
        else s = b.toString('latin1', at, at + len);
        if (s && !(id in found)) found[id] = s;
      }
      return found[16] || found[1] || '';
    }
  } catch (e) { /* not a font */ }
  return '';
}

class LayoutStore {
  // opts: { dir, stockDir, fontPackDir, extraFontDirs: [], settings() -> raw settings, setSettings(patch), log(msg), screen() -> {w,h},
  //         live() -> bool, artSeries() -> { id, dir, roots: [] }, render(layout, { scale, live, sample, panel }) -> Promise<Buffer png> }
  constructor(opts) {
    this.o = opts;
    this.dir = opts.dir;
    this.lays = new Map(); this.bad = new Map(); this.styles = new Map(); this.sig = ''; this.loaded = false; this.checked = 0;
    this.fonts = null;
  }
  log(m) { if (this.o.log) this.o.log(m); }

  // ---- the folder
  install() {
    const dir = this.dir;
    for (const d of [dir, path.join(dir, 'images'), path.join(dir, 'fonts'), path.join(dir, 'presets')]) fs.mkdirSync(d, { recursive: true });
    // the overlay pack: copied in once; what was copied is noted in stock.txt, so one you delete stays deleted
    const note = path.join(dir, 'stock.txt');
    let seen = new Set();
    try { seen = new Set(fs.readFileSync(note, 'utf8').split(/\r?\n/).filter(Boolean)); } catch (e) { /* first time */ }
    const add = [];
    if (this.o.stockDir && fs.existsSync(this.o.stockDir)) {
      for (const [sub, re] of [['', /\.json$/i], ['images', /./], ['presets', /\.json$/i]]) {
        let names = [];
        try { names = fs.readdirSync(path.join(this.o.stockDir, sub), { withFileTypes: true }).filter(d => d.isFile() && re.test(d.name)).map(d => d.name); } catch (e) { continue; }
        for (const n of names) {
          if (sub === '' && /^README/i.test(n)) continue;
          const rel = (sub ? '\\' + sub : '') + '\\' + n;
          if (seen.has(rel)) continue;
          const to = path.join(dir, sub, n);
          if (!fs.existsSync(to)) { try { fs.copyFileSync(path.join(this.o.stockDir, sub, n), to); } catch (e) { continue; } }
          add.push(rel);
        }
      }
    }
    if (add.length) { fs.appendFileSync(note, add.join('\n') + '\n'); this.log('overlay pack: new layouts / presets copied into ' + dir); }
    // the font pack: copied in when layouts\fonts has no fonts yet
    const fd = path.join(dir, 'fonts');
    let have = false;
    try { have = fs.readdirSync(fd).some(isFont); } catch (e) { /* none */ }
    if (!have && this.o.fontPackDir && fs.existsSync(this.o.fontPackDir)) {
      for (const n of fs.readdirSync(this.o.fontPackDir)) if (isFont(n)) { try { fs.copyFileSync(path.join(this.o.fontPackDir, n), path.join(fd, n)); } catch (e) { /* skip */ } }
      this.log('overlay fonts: the font pack was copied into ' + fd);
    }
    for (const [name, doc] of Object.entries(BUILTIN)) {
      const p = path.join(dir, name + '.json');
      if (!fs.existsSync(p)) fs.writeFileSync(p, jtext(doc));
    }
    const rd = path.join(dir, 'README.txt');
    if (!fs.existsSync(rd)) fs.writeFileSync(rd, 'RaceVision overlay layouts (built into All In One NR2003)\r\n\r\nEach .json file here is one overlay. Build and edit them in the Overlays editor (TV director, Overlays button),\r\nor edit the files by hand: All In One NR2003 picks up a changed file within a second.\r\n\r\nimages\\  PNG / JPG pictures for the layouts.\r\nfonts\\   .ttf / .otf fonts to use in text.\r\npresets\\ whole-screen style presets (which layout each panel uses and where).\r\n\r\nThe built-in layouts (tag_classic, tag_dash, battle_classic, battle_dash, onboard_classic, dash_dash) are written back only when missing.\r\n');
  }
  _sig() {
    const parts = [];
    for (const sub of ['', 'presets']) {
      let names = [];
      try { names = fs.readdirSync(path.join(this.dir, sub)).filter(n => /\.json$/i.test(n)); } catch (e) { /* none */ }
      for (const n of names) { try { const st = fs.statSync(path.join(this.dir, sub, n)); parts.push(sub + n + st.mtimeMs + ':' + st.size); } catch (e) { /* gone */ } }
    }
    return parts.join('|');
  }
  load() {
    this.lays.clear(); this.bad.clear(); this.styles.clear();
    let names = [];
    try { names = fs.readdirSync(this.dir).filter(n => /\.json$/i.test(n)); } catch (e) { /* none */ }
    for (const file of names) {
      const name = file.slice(0, -5);
      if (!validName(name)) continue;
      const doc = readJson(path.join(this.dir, file));
      if (!doc) { this.bad.set(name, 'not valid JSON'); this.log(`layout ${file} is not valid JSON, skipped`); continue; }
      this.lays.set(name, this._finish(name, doc));
    }
    let ps = [];
    try { ps = fs.readdirSync(path.join(this.dir, 'presets')).filter(n => /\.json$/i.test(n)); } catch (e) { /* none */ }
    for (const file of ps) {
      const name = file.slice(0, -5), doc = readJson(path.join(this.dir, 'presets', file));
      if (!validName(name) || !doc) continue;
      this.styles.set(name, { name, title: String(doc.title || name), base: String(doc.base || 'classic'),
        layouts: doc.layouts && typeof doc.layouts === 'object' ? doc.layouts : {}, screen: doc.screen && typeof doc.screen === 'object' ? doc.screen : {} });
    }
    this.sig = this._sig(); this.loaded = true;
  }
  _finish(name, doc) {
    return { name, doc, title: String(doc.title || name), panel: String(doc.panel || 'custom'), when: String(doc.when || ''), accent: String(doc.accent || 'car'),
      w: clamp(Number(doc.w) || 300, 20, 2400), h: clamp(Number(doc.h) || 100, 20, 1400) };
  }
  ensure() {
    if (!this.loaded) { try { this.install(); } catch (e) { this.log('overlay layouts: could not set up ' + this.dir + ' (' + e.message + ')'); } this.load(); }
    const now = Date.now();
    if (now - this.checked >= 1000) { this.checked = now; if (this._sig() !== this.sig) { this.log('overlay layouts changed on disk: reloaded'); this.load(); } }
  }

  // ---- styles and panels (the director's settings: overlay_style, layout_<panel>, overlay_<panel>)
  S() { return this.o.settings() || {}; }
  styleNow() {
    const s = String(this.S().overlay_style || 'classic');
    if (!s.startsWith('preset:')) return null;
    this.ensure();
    return this.styles.get(s.slice(7)) || null;
  }
  dashLook() { const sp = this.styleNow(); if (sp) return sp.base.toLowerCase() === 'dash'; return String(this.S().overlay_style || '').toLowerCase() === 'dash'; }
  // the layout name a panel uses: '' = All In One NR2003's own look (no layout), 'off' = switched off
  pick(key) {
    let name = String(this.S()['layout_' + key] || '').trim();
    if (!name) { const sp = this.styleNow(); if (sp && typeof sp.layouts[key] === 'string') name = sp.layouts[key]; }
    return name;
  }
  isOff(key) { return this.pick(key) === 'off'; }
  layoutFor(key) {
    this.ensure();
    const name = this.pick(key);
    if (!name || name === 'off') return null;
    return this.lays.get(name) || null;
  }
  pos(key) {
    const P = PANELS.find(p => p[0] === key);
    const raw = String(this.S()[POS_KEY[key] || 'overlay_' + key] || '');
    const v = raw.split(',').map(Number);
    return v.length >= 3 && v.every(Number.isFinite) ? v.slice(0, 3) : (P ? P[4] : [100, 100, 1]);
  }
  _savePos(key, x, y, s) { this.o.setSettings({ [POS_KEY[key] || 'overlay_' + key]: `${Math.round(x)}, ${Math.round(y)}, ${(+s).toFixed(2)}` }); }
  applyStyle(name) {
    const sp = name !== 'dash' && name !== 'classic' ? this.styles.get(name) : null;
    const screen = sp && sp.screen && Object.keys(sp.screen).length;
    const patch = { overlay_style: name === 'dash' || name === 'classic' ? name : 'preset:' + name };
    if (!screen) for (const k of PANEL_KEYS) patch['layout_' + k] = '';
    if (screen) for (const k of PANEL_KEYS) {
      const m = sp.layouts[k];
      patch['layout_' + k] = typeof m === 'string' ? m : '';
      const p = sp.screen[k];
      if (Array.isArray(p) && p.length >= 3) patch[POS_KEY[k] || 'overlay_' + k] = `${Math.round(+p[0])}, ${Math.round(+p[1])}, ${clamp(+p[2], 0.4, 3).toFixed(2)}`;
    }
    this.o.setSettings(patch);
  }
  used(name) { return PANEL_KEYS.filter(k => { const L = this.layoutFor(k); return L && L.name === name; }).join(','); }
  defaultJson(name) {
    if (BUILTIN[name]) return BUILTIN[name];
    if (!validName(name) || !this.o.stockDir) return null;
    return readJson(path.join(this.o.stockDir, name + '.json'));
  }

  // ---- pictures and fonts
  picPath(file) {
    file = String(file || '');
    if (!file || file.includes('..')) return '';
    if (file.startsWith('art:')) {
      const rel = file.slice(4).replace(/\//g, '\\');
      if (!rel || rel[0] === '\\' || rel.includes(':')) return '';
      const art = this.o.artSeries ? this.o.artSeries() : null;
      if (/^@series(\\|$)/.test(rel)) return art && art.dir ? path.join(art.dir, rel.slice(7)) : '';
      for (const r of (art && art.roots) || []) { const p = path.join(r, rel); if (fs.existsSync(p)) return p; }
      return '';
    }
    if (file.includes(':') || file[0] === '\\' || file[0] === '/') return '';
    return path.join(this.dir, 'images', file);
  }
  picUrl(file) { const p = this.picPath(file); return p && fs.existsSync(p) ? pathToFileURL(p).href : ''; }
  fontFiles() {
    if (this.fonts) return this.fonts;
    const out = [], seen = new Set();
    for (const [d, mine] of [[path.join(this.dir, 'fonts'), true], ...(this.o.extraFontDirs || []).map(x => [x, false])]) {
      let names = [];
      try { names = fs.readdirSync(d).filter(isFont); } catch (e) { continue; }
      for (const n of names) {
        if (seen.has(n.toLowerCase())) continue;
        seen.add(n.toLowerCase());
        const p = path.join(d, n), family = fontFamily(p);
        if (family) out.push({ family, file: n, path: p, mine, url: pathToFileURL(p).href });
      }
    }
    return (this.fonts = out);
  }
  _walk(base, rel, depth, prefix, out, budget) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch (e) { return; }
    for (const d of ents) {
      if (budget.n <= 0) return;
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) { if (depth > 0 && !['numbers', 'headshots', 'flags_cache'].includes(d.name.toLowerCase())) this._walk(base, r, depth - 1, prefix, out, budget); }
      else if (isPic(d.name)) {
        try { if (fs.statSync(path.join(base, r)).size >= 6000000) continue; } catch (e) { continue; }
        budget.n--;
        const sl = r.lastIndexOf('/');
        out.push({ path: 'art:' + prefix + r, group: (prefix === '@series/' ? 'series: ' : '') + (sl < 0 ? '(top)' : r.slice(0, sl)) });
      }
    }
  }
  images() { try { return fs.readdirSync(path.join(this.dir, 'images')).filter(isPic); } catch (e) { return []; } }

  // ---- the editor's calls: sub = '' | pictures | image | fontfile | layout | save | delete | reset | duplicate | stylesave | styleuse |
  // styledelete | panelpos | panelpng | use | render | upload.  -> { code, type, body }
  async api(sub, q, body) {
    const J = (o, code = 200) => ({ code, type: 'application/json; charset=utf-8', body: JSON.stringify(o) });
    const E = (m, code = 400) => J({ error: m }, code);
    this.ensure();
    const name = String(q.name || '');
    const panelOf = (k) => PANELS.find(p => p[0] === k);
    if (!sub) {
      const scr = this.o.screen ? this.o.screen() : { w: 1920, h: 1080 };
      const art = this.o.artSeries ? this.o.artSeries() : null;
      return J({
        dir: this.dir,
        layouts: [...this.lays.values()].sort((a, b) => a.name.localeCompare(b.name)).map(L => ({ name: L.name, title: L.title, panel: L.panel, w: L.w, h: L.h, builtin: !!this.defaultJson(L.name), used: this.used(L.name) })),
        styles: [...this.styles.values()].map(s => ({ name: s.name, title: s.title, base: s.base })), style: String(this.S().overlay_style || 'classic'),
        broken: [...this.bad].map(([k, v]) => k + ': ' + v),
        panels: PANELS.map(([key, label, w, h]) => {
          const L = this.layoutFor(key), p = this.pos(key);
          return { key, label, set: String(this.S()['layout_' + key] || '').trim(), using: L ? L.name : '', x: p[0], y: p[1], scale: p[2], w: L ? L.w : w, h: L ? L.h : h };
        }),
        screenW: scr.w, screenH: scr.h,
        sources: { car: CAR_FIELDS.map(([key, label, kind]) => ({ key, label, kind })), global: GLOBALS.map(([key, label, kind]) => ({ key, label, kind })), whos: WHOS },
        fonts: this.fontFiles().map(f => ({ family: f.family, file: f.file, mine: f.mine })), sysfonts: [],
        artSeries: art && art.dir ? art.id : '', images: this.images(), live: !!(this.o.live && this.o.live()),
      });
    }
    if (sub === 'pictures') {
      const art = this.o.artSeries ? this.o.artSeries() : null, out = [], budget = { n: 1200 };
      if (art && art.dir) this._walk(art.dir, '', 2, '@series/', out, budget);
      for (const r of (art && art.roots) || []) this._walk(path.join(r, 'images'), '', 3, 'images/', out, budget);
      return J({ mine: this.images(), art: out, series: art ? art.id || '' : '' });
    }
    if (sub === 'image' || sub === 'fontfile') {
      let p = '';
      if (sub === 'image') p = this.picPath(q.src);
      else { const f = this.fontFiles().find(x => x.file === q.name); p = f ? f.path : ''; }
      let data = null;
      try { data = p ? fs.readFileSync(p) : null; } catch (e) { data = null; }
      if (!data || !data.length) return E('No such file.', 404);
      return { code: 200, type: sub === 'fontfile' ? 'font/ttf' : data[0] === 0xff ? 'image/jpeg' : 'image/png', body: data };
    }
    if (sub === 'layout') { const L = this.lays.get(name); return L ? { code: 200, type: 'application/json; charset=utf-8', body: jtext(L.doc) } : E('No such layout.', 404); }
    if (sub === 'save') {
      if (!validName(name)) return E('Layout names are letters, digits, _ and - (up to 40).');
      let doc; try { doc = JSON.parse(String(body || '')); } catch (e) { doc = null; }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return E('That layout is not valid JSON.');
      if (!Array.isArray(doc.elements) || doc.elements.length > 400) return E('A layout needs an elements list (up to 400).');
      try { writeAtomic(path.join(this.dir, name + '.json'), jtext(doc)); } catch (e) { return E('Could not write the layout file.'); }
      this.load(); this.log(`overlay layout ${name} saved`); return J({ ok: true });
    }
    if (sub === 'delete') {
      if (!this.lays.has(name)) return E('No such layout.', 404);
      if (this.defaultJson(name)) return E('Built-in layouts can be reset, not deleted.');
      if (this.used(name)) return E('A panel is using this layout: pick another for it first.');
      try { fs.unlinkSync(path.join(this.dir, name + '.json')); } catch (e) { /* gone */ }
      this.load(); return J({ ok: true });
    }
    if (sub === 'reset') {
      const def = this.defaultJson(name);
      if (!def) return E('That layout has no built-in version.');
      writeAtomic(path.join(this.dir, name + '.json'), jtext(def)); this.load(); return J({ ok: true });
    }
    if (sub === 'duplicate') {
      const as = String(q.as || ''), L = this.lays.get(name);
      if (!L) return E('No such layout.', 404);
      if (!validName(as)) return E('Layout names are letters, digits, _ and - (up to 40).');
      if (this.lays.has(as)) return E('There is a layout called that already.');
      const doc = JSON.parse(JSON.stringify(L.doc)); doc.title = as;
      writeAtomic(path.join(this.dir, as + '.json'), jtext(doc)); this.load(); return J({ ok: true });
    }
    if (sub === 'stylesave') {
      const title = q.title ? String(q.title) : name;
      if (!validName(name)) return E('Style names are letters, digits, _ and - (up to 40).');
      const map = {}, scr = {};
      for (const k of PANEL_KEYS) { const L = this.layoutFor(k); map[k] = L ? L.name : 'off'; scr[k] = this.pos(k); }
      const base = q.base === 'classic' ? 'classic' : q.base === 'dash' ? 'dash' : this.dashLook() ? 'dash' : 'classic';
      try { writeAtomic(path.join(this.dir, 'presets', name + '.json'), jtext({ title, base, layouts: map, screen: scr })); } catch (e) { return E('Could not write the style.'); }
      this.load(); this.applyStyle(name); return J({ ok: true });
    }
    if (sub === 'styleuse') {
      if (name !== 'dash' && name !== 'classic' && !this.styles.has(name)) return E('No such style.', 404);
      this.applyStyle(name); return J({ ok: true });
    }
    if (sub === 'styledelete') {
      if (!this.styles.has(name)) return E('No such style.', 404);
      try { fs.unlinkSync(path.join(this.dir, 'presets', name + '.json')); } catch (e) { /* gone */ }
      if (String(this.S().overlay_style) === 'preset:' + name) this.o.setSettings({ overlay_style: 'classic' });
      this.load(); return J({ ok: true });
    }
    if (sub === 'panelpos') {
      const key = String(q.panel || '');
      if (!panelOf(key)) return E('No such panel.');
      const p = this.pos(key);
      const x = q.x !== undefined && q.x !== '' ? parseInt(q.x, 10) : p[0], y = q.y !== undefined && q.y !== '' ? parseInt(q.y, 10) : p[1];
      const s = q.scale !== undefined && q.scale !== '' ? clamp(parseFloat(q.scale) || 1, 0.4, 3) : p[2];
      this._savePos(key, x, y, s); return J({ ok: true });
    }
    if (sub === 'use') {
      const key = String(q.panel || '');
      if (!panelOf(key)) return E('No such panel.');
      let n = name;
      if (n && n !== 'off' && !this.lays.has(n)) return E('No such layout.', 404);
      if (!n && (key.startsWith('custom') || key.startsWith('rc_'))) n = 'off';
      this.o.setSettings({ ['layout_' + key]: n }); return J({ ok: true });
    }
    if (sub === 'panelpng' || sub === 'render') {
      let L;
      if (sub === 'panelpng') { L = this.layoutFor(String(q.panel || '')); if (!L) return E('That panel is off.', 404); L = L.doc; }
      else { try { L = JSON.parse(String(body || '')); } catch (e) { L = null; } if (!L || typeof L !== 'object') return E('That layout is not valid JSON.'); }
      const scale = sub === 'render' ? clamp(parseFloat(q.s) > 0 ? parseFloat(q.s) : 1, 0.5, 3) : 1;
      const live = sub === 'render' && String(q.live) === '1' && this.o.live && this.o.live();
      if (!this.o.render) return E('Could not draw that.');
      try {
        const png = await this.o.render(L, { scale, live, sample: !live });
        if (!png || !png.length) return E('Could not draw that.');
        return { code: 200, type: 'image/png', body: png };
      } catch (e) { return E('Could not draw that (' + e.message + ').'); }
    }
    if (sub === 'upload') {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'latin1');
      const png = buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG', jpg = buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
      const ok = name && name.length <= 60 && /^[A-Za-z0-9_\-. ]+$/.test(name) && !name.includes('..') && /\.(png|jpg)$/i.test(name);
      if (!ok || !(png || jpg)) return E('Upload a PNG or JPG (letters, digits, _ - . in the name).');
      try { writeAtomic(path.join(this.dir, 'images', name), buf); } catch (e) { return E('Could not save the picture.'); }
      return J({ ok: true });
    }
    return E('not found', 404);
  }

  // ---- what the overlay window draws: each panel with a layout, where it sits, whether it shows now
  // ov: All In One NR2003's own overlay decisions (tag / battle / dash shown), onboard, battleShot, replay; snap: the data (snapshot())
  panels(ov, snap, o) {
    this.ensure();
    const out = [], dash = this.dashLook();
    const draw = (key, on) => {
      const L = this.layoutFor(key);
      if (!L) return;
      const p = this.pos(key);
      out.push({ key, layout: L.doc, name: L.name, on: !!on, x: p[0], y: p[1], scale: p[2] });
    };
    const has = (k) => !!(ov && ov[k]);
    draw('tag', has('tag'));
    draw('battle', has('battle'));
    draw('onboard', has('dash') && !dash);
    draw('dash', has('dash') && dash);
    const RV = require('./layoutdraw');
    for (const k of ['custom1', 'custom2', 'custom3', 'custom4']) {
      const L = this.layoutFor(k);
      if (!L) continue;
      const fromRc = L.when.includes('rc.');
      const on = o.overlaysOn && (fromRc || o.replay || (snap.car != null && snap.car >= 0)) && RV.when(L.doc, snap, o);
      draw(k, on);
    }
    for (const k of ['rc_qual', 'rc_tele', 'rc_cone', 'rc_order']) {
      const L = this.layoutFor(k);
      if (!L) continue;
      const grp = k === 'rc_qual' ? 'qual' : k === 'rc_cone' ? 'cone' : 'tele';
      const on = o.overlaysOn && (L.when.includes('rc.') || RV.rcShowing(snap, grp)) && RV.when(L.doc, snap, o);
      draw(k, on);
    }
    return out;
  }
  // the panels Race Control's own windows should leave to the layouts (RaceControl 2.0: OverlaysDrawnBy = RaceVision)
  rcDrawnHere() {
    return { qual: !!this.layoutFor('rc_qual'), tele: !!this.layoutFor('rc_tele'), cone: !!this.layoutFor('rc_cone'), order: !!this.layoutFor('rc_order') };
  }
}

module.exports = { LayoutStore, PANELS, PANEL_KEYS, fontFamily, validName };
