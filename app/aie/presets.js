// AI Enhanced presets: the 15 built-in ones (extracted from AI Enhanced v0_2_1b, see tools/aie/build_builtin.py) and .nrpreset / .json
// files the user saves from AI Enhanced or drops into <userData>\aie\presets. A preset applies only the fields it contains, like AI
// Enhanced does. Ported sections apply in All In One NR2003; unsupported items remain listed so nothing is silently dropped.
'use strict';
const fs = require('fs');
const path = require('path');

const BUILTIN = require('./builtin.json');
const EXTRA_DIR = path.join(__dirname, 'additional-presets');
const { IniFiles } = require('./inifiles');
const { fromPreset } = require('./modules');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : undefined);

// the lap lines a preset carries: { race?, minrace?, maxrace? } each { count, length, rec: Float32Array(count * 7) }.
// Built-in presets keep them packed (lap_lines, base64 float32 records); presets saved by AI Enhanced have racelp_data.points.
function lapLinesOf(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const n of ['race', 'minrace', 'maxrace']) {
    const packed = p.lap_lines && p.lap_lines[n], raw = p[n + 'lp_data'];
    try {
      if (packed && typeof packed.data === 'string') {
        const b = Buffer.from(packed.data, 'base64');
        const rec = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
        if (rec.length === packed.count * 7) out[n] = { count: packed.count, length: packed.length, rec };
      } else if (raw && Array.isArray(raw.points) && raw.points.length > 20 && raw.points.every(q => Array.isArray(q) && q.length === 7)) {
        const rec = new Float32Array(raw.points.length * 7);
        raw.points.forEach((q, i) => q.forEach((v, k) => { rec[i * 7 + k] = v; }));
        out[n] = { count: raw.points.length, length: raw.length, rec };
      }
    } catch (e) { /* skip a damaged line */ }
  }
  if (!Object.keys(out).length) return null;
  if (typeof p.lap_data_version === 'number') out.version = p.lap_data_version;       // 2: speeds stored at strength 100 / modifier 1
  return out;
}

// what a preset sets for the ported part: { envGrip?, rubber?, cleanRubber? }, plus the names of the unported sections it carries
function summarize(p) {
  const out = {}, other = [];
  if (p && typeof p.env_grip === 'object' && p.env_grip) {
    const e = {};
    for (const k of ['base', 'maxrace', 'minrace']) if (num(p.env_grip[k]) !== undefined) e[k] = num(p.env_grip[k]);
    if (Object.keys(e).length) out.envGrip = e;
  }
  if (p && typeof p.rubber_buildup === 'object' && p.rubber_buildup) {
    const r = {}, rb = p.rubber_buildup;
    if (num(rb.rate) !== undefined) r.rate = rb.rate > 0 ? num(rb.rate) : 0;
    if (num(rb.grip_mult) !== undefined) r.gripMult = rb.grip_mult > 0 ? num(rb.grip_mult) : 1;
    if (typeof rb.active === 'boolean') r.active = rb.active;
    if (Object.keys(r).length) out.rubber = r;
  }
  if (p && p.clean_track_rubber === true) out.cleanRubber = true;
  if (p && p.reset_to_track_defaults === true) out.resetDefaults = true;
  const ll = lapLinesOf(p);
  if (ll) out.lapLines = ll;
  const sliders = {};
  for (const [key, name] of [['racelp_slider', 'race'], ['minracelp_slider', 'minrace'], ['maxracelp_slider', 'maxrace']]) {
    if (num(p && p[key]) !== undefined) sliders[name] = Math.max(0, Math.min(100, num(p[key])));
  }
  if (Object.keys(sliders).length) out.lapSliders = sliders;
  const mods = fromPreset(p);
  if (Object.keys(mods).length) out.modules = mods;
  if (p && p.settings && typeof p.settings === 'object') {
    const ini = {};
    for (const [k, v] of Object.entries(p.settings)) {
      if (IniFiles.known(k) && typeof v === 'number' && Number.isFinite(v)) ini[k] = v;
      else if (k !== 'parameter_table_magic_number') other.push('INI setting ' + k);
    }
    if (Object.keys(ini).length) out.iniSettings = ini;
  }
  if (p) {
    if (p.special_modes) {
      const m = p.special_modes;
      if (m.pit_adjust_active) other.push('pit adjustments');
    }
    if (p.lap_triggers) other.push('lap triggers');
  }
  out.needsAiEnhanced = [...new Set(other)];
  return out;
}

class PresetStore {
  constructor(userDir) {
    this.dir = userDir;
    this.user = [];
    this.reload();
  }

  reload() {
    this.user = [];
    this.builtins = BUILTIN.slice();
    try {
      for (const f of fs.readdirSync(EXTRA_DIR).filter(n => /\.nrpreset$/i.test(n)).sort()) {
        try {
          const preset = JSON.parse(fs.readFileSync(path.join(EXTRA_DIR, f), 'utf8'));
          if (!preset || typeof preset !== 'object' || Array.isArray(preset)) continue;
          const name = f.replace(/\.nrpreset$/i, ''), key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const terms = Array.isArray(preset.auto_keywords) ? preset.auto_keywords.map(x => String(x).toLowerCase()).filter(x => x.length > 2) : name.toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 2);
          this.builtins.push({ id: 'builtin-extra:' + key, name, builtin: true, keywords: terms, preset });
        } catch (e) { /* skip invalid shipped presets */ }
      }
    } catch (e) { /* source presets unavailable in this build */ }
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { /* ignore */ }
    let files = [];
    try { files = fs.readdirSync(this.dir).filter(f => /\.(nrpreset|json)$/i.test(f)); } catch (e) { /* ignore */ }
    for (const f of files.sort()) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (p && typeof p === 'object') this.user.push({ id: 'user:' + f, name: f.replace(/\.(nrpreset|json)$/i, ''), builtin: false, keywords: [], preset: p });
      } catch (e) { /* skip unreadable files */ }
    }
  }

  all() { return [...this.builtins, ...this.user]; }
  get(id) { return this.all().find(p => p.id === id) || null; }

  list() {
    return this.all().map(e => ({ id: e.id, name: e.name, builtin: !!e.builtin, description: (e.preset.description || '').replace(/\s+/g, ' ').trim(), ...summarize(e.preset) }));
  }

  // copy a preset file into the user folder (the file picker / drop in the UI gives a path)
  importFile(file) {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('not an AI Enhanced preset');
    const name = path.basename(file).replace(/\.(nrpreset|json)$/i, '') + '.nrpreset';
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(p));
    this.reload();
    return 'user:' + name;
  }

  saveNew(name, preset) {
    const clean = String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/g, '').slice(0, 80);
    if (!clean) throw new Error('enter a preset name');
    fs.mkdirSync(this.dir, { recursive: true });
    const stem = clean.replace(/\s+/g, ' ');
    let file = stem + '.nrpreset', n = 2;
    while (fs.existsSync(path.join(this.dir, file))) file = `${stem} (${n++}).nrpreset`;
    fs.writeFileSync(path.join(this.dir, file), JSON.stringify(preset, null, 2), { flag: 'wx' });
    this.reload();
    return 'user:' + file;
  }

  restoreBuiltins() { this.reload(); return this.builtins.length; }

  // Explicit user mappings win. Otherwise prefer the most specific matching keyword, then the profile priority.
  forTrack(track, mapping, auto) {
    const t = String(track || '').toLowerCase();
    if (!t) return null;
    if (mapping && Object.prototype.hasOwnProperty.call(mapping, t)) return mapping[t] ? this.get(mapping[t]) : null;   // '' = explicitly none
    if (!auto) return null;
    let best = null, bestScore = -1;
    for (const e of this.builtins) {
      const match = e.keywords.filter(k => t.includes(k));
      if (!match.length) continue;
      const specificity = Math.max(...match.map(k => k.length));
      const priority = Number.isFinite(e.preset && e.preset.auto_priority) ? e.preset.auto_priority : 0;
      const score = specificity * 1000 + priority;
      if (score > bestScore) { best = e; bestScore = score; }
    }
    return best;
  }
}

module.exports = { PresetStore, summarize };
