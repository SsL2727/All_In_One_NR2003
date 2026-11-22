'use strict';
const path = require('path');

const TYPES = new Set(['fixed', 'range', 'percent', 'percent_range', 'laps_to_go', 'laps_to_go_range', 'yellow', 'restart']);
const int = (v, d = 1) => Number.isFinite(Number(v)) ? Math.max(1, Math.round(Number(v))) : d;
const pct = (v, d = 1) => Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : d;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function normalize(item = {}) {
  const type = TYPES.has(item.type) ? item.type : 'fixed';
  const out = { id: String(item.id || `trigger-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`), type,
    presetId: String(item.presetId || item.steelfire_preset_id || ''), presetName: String(item.presetName || item.builtin_preset_name || ''),
    randomPreset: !!(item.randomPreset || item.is_random), folderPath: String(item.folderPath || item.folderpath || ''),
    presetIds: Array.isArray(item.presetIds) ? item.presetIds.map(String).slice(0, 500) : [],
    description: String(item.description || '').slice(0, 500) };
  for (const k of ['lap_number', 'lap_min', 'lap_max', 'laps_to_go', 'laps_to_go_min', 'laps_to_go_max']) if (item[k] !== undefined) out[k] = int(item[k]);
  for (const k of ['percent', 'percent_min', 'percent_max']) if (item[k] !== undefined) out[k] = pct(item[k]);
  if (type === 'range' && out.lap_min > out.lap_max) [out.lap_min, out.lap_max] = [out.lap_max, out.lap_min];
  if (type === 'percent_range' && out.percent_min > out.percent_max) [out.percent_min, out.percent_max] = [out.percent_max, out.percent_min];
  if (type === 'laps_to_go_range' && out.laps_to_go_min > out.laps_to_go_max) [out.laps_to_go_min, out.laps_to_go_max] = [out.laps_to_go_max, out.laps_to_go_min];
  return out;
}

function scheduledLap(item, raceLaps, rng = Math.random) {
  if (!(raceLaps > 0)) return null;
  const pick = (a, b) => Math.floor(Math.min(a, b) + rng() * (Math.abs(b - a) + 1));
  let lap;
  switch (item.type) {
    case 'fixed': lap = int(item.lap_number); break;
    case 'range': lap = pick(int(item.lap_min), int(item.lap_max)); break;
    case 'percent': lap = Math.round(pct(item.percent) * raceLaps / 100); break;
    case 'percent_range': lap = Math.round(pick(pct(item.percent_min), pct(item.percent_max)) * raceLaps / 100); break;
    case 'laps_to_go': lap = raceLaps - int(item.laps_to_go) + 1; break;
    case 'laps_to_go_range': lap = raceLaps - pick(int(item.laps_to_go_min), int(item.laps_to_go_max)) + 1; break;
    default: return null;
  }
  return clamp(lap, 1, raceLaps);
}

function schedule(items, raceLaps, rng = Math.random) {
  return (Array.isArray(items) ? items : []).map(normalize).map(item => ({ ...item, fireLap: scheduledLap(item, raceLaps, rng), fired: false }));
}

function label(item, fireLap) {
  switch (item.type) {
    case 'fixed': return `Lap ${fireLap || item.lap_number || '?'}`;
    case 'range': return `Laps ${item.lap_min || '?'}–${item.lap_max || '?'}`;
    case 'percent': return `${item.percent || 0}%`;
    case 'percent_range': return `${item.percent_min || 0}–${item.percent_max || 0}%`;
    case 'laps_to_go': return `${item.laps_to_go || '?'} to go`;
    case 'laps_to_go_range': return `${item.laps_to_go_min || '?'}–${item.laps_to_go_max || '?'} to go`;
    case 'yellow': return 'Yellow';
    case 'restart': return 'Restart';
    default: return item.type;
  }
}

function toRaceFile(items, presets, deepCopy = true) {
  return { race_format_version: 1, deep_copy: !!deepCopy, lap_triggers: (items || []).map(raw => {
    const t = normalize(raw), row = { type: t.type, description: t.description || undefined,
      lap_number: t.lap_number, lap_min: t.lap_min, lap_max: t.lap_max, percent: t.percent,
      percent_min: t.percent_min, percent_max: t.percent_max, laps_to_go: t.laps_to_go,
      laps_to_go_min: t.laps_to_go_min, laps_to_go_max: t.laps_to_go_max,
      steelfire_preset_id: t.presetId || undefined, builtin_preset_name: t.presetName || undefined };
    if (t.randomPreset) {
      row.is_random = true;
      row.steelfire_preset_ids = t.presetIds.length ? t.presetIds : undefined;
      if (deepCopy && presets) row.preset_folder_contents = t.presetIds.map(id => presets.get(id)).filter(Boolean).map(p => ({ name: p.name, preset: p.preset }));
      else if (t.folderPath) row.filepath = t.folderPath;
    }
    const found = presets && presets.get(t.presetId);
    if (found) {
      row.builtin_preset_name = t.presetName || found.name;
      if (deepCopy) row.preset = found.preset;
      else if (found.id.startsWith('user:') && presets.dir) row.filepath = path.join(presets.dir, found.id.slice(5));
    }
    return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
  }) };
}

function fromRaceFile(file, presets, addEmbedded, resolveFile) {
  if (!file || typeof file !== 'object' || !Array.isArray(file.lap_triggers)) throw new Error('Not a valid AI Enhanced race file (missing lap_triggers).');
  return file.lap_triggers.map((raw, index) => {
    const t = normalize({ ...raw, id: `loaded-${Date.now()}-${index}` });
    if (raw.preset && typeof raw.preset === 'object' && addEmbedded) {
      t.presetId = addEmbedded(raw.preset, t.presetName || `Race Trigger ${index + 1}`);
    }
    if (Array.isArray(raw.preset_folder_contents) && addEmbedded) {
      t.presetIds = raw.preset_folder_contents.map((entry, i) => {
        const p = entry && entry.preset ? entry.preset : entry;
        const name = entry && entry.name ? entry.name : `Race Trigger ${index + 1} Random ${i + 1}`;
        return p && typeof p === 'object' ? addEmbedded(p, name) : '';
      }).filter(Boolean);
      if (t.presetIds.length) t.randomPreset = true;
    }
    if (!t.presetIds.length && Array.isArray(raw.steelfire_preset_ids)) t.presetIds = raw.steelfire_preset_ids.map(String).filter(id => !presets || presets.get(id));
    if (t.randomPreset && raw.filepath) t.folderPath = typeof resolveFile === 'function' ? (resolveFile(raw.filepath, true) || String(raw.filepath)) : String(raw.filepath);
    else if (!t.presetId && typeof resolveFile === 'function') {
      const filePath = raw.filepath || raw.filepath_relative;
      if (filePath) { try { const imported = resolveFile(filePath); if (imported) t.presetId = imported; } catch (e) { /* keep the trigger row; its missing preset is reported in the UI */ } }
    }
    if (!t.presetId && t.presetName && presets) {
      const found = presets.all().find(p => p.name.toLowerCase() === t.presetName.toLowerCase());
      if (found) t.presetId = found.id;
    }
    return t;
  });
}

module.exports = { TYPES: [...TYPES], normalize, scheduledLap, schedule, label, toRaceFile, fromRaceFile };
