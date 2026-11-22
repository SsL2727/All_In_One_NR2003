'use strict';

const DEFAULT = Object.freeze({
  format: 'wind-tunnel-deluxe', version: 3, takeoff_speed_mph: 180, takeoff_angle_degrees: [90, 180],
  initial_spin_decay: 1, lift: 1, pitch: 1, roll: 1, speed_decay: 1, pitch_decay: 1, roll_decay: 1,
  pitch_delay_ms: 0, roll_delay_ms: 0, hover_time_ms: 0,
});
const NUM = new Set(['takeoff_speed_mph', 'initial_spin_decay', 'lift', 'pitch', 'roll', 'speed_decay', 'pitch_decay', 'roll_decay', 'pitch_delay_ms', 'roll_delay_ms', 'hover_time_ms']);
const ALIASES = { initial_spin_loss: 'initial_spin_decay', speed_loss: 'speed_decay', momentum_loss: 'initial_spin_decay', rotation_easing: 'pitch_decay' };

function normalize(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PRO tuning data must be a JSON object.');
  if (raw.format && raw.format !== 'wind-tunnel-deluxe') throw new Error('This is not a Wind Tunnel Deluxe PRO settings file.');
  const out = { ...DEFAULT };
  for (const [source, value] of Object.entries(raw)) {
    const key = ALIASES[source] || source;
    if (!NUM.has(key) && key !== 'takeoff_angle_degrees' && !['format', 'version', 'name', 'description'].includes(key)) throw new Error(`Unknown PRO setting: ${source}`);
    if (key === 'format' || key === 'version' || key === 'name' || key === 'description') { if (['name', 'description'].includes(key)) out[key] = String(value).slice(0, 160); continue; }
    if (key === 'takeoff_angle_degrees') {
      const a = Array.isArray(value) ? value : [value, value];
      if (a.length !== 2 || a.some(x => !Number.isFinite(Number(x)) || Number(x) < 0 || Number(x) > 180)) throw new Error('Takeoff angle endpoints must be between 0 and 180 degrees.');
      out[key] = a.map(Number); continue;
    }
    if (!Number.isFinite(Number(value))) throw new Error(`${source} must be a number.`);
    const n = Number(value);
    if (key.endsWith('_delay_ms')) { if (n < 0 || n > 1000) throw new Error(`${key} must be between 0 and 1000 ms.`); }
    else if (key === 'hover_time_ms') { if (n < 0 || n > 2000) throw new Error('hover_time_ms must be between 0 and 2000 ms.'); }
    else if (key === 'takeoff_speed_mph') { if (n < 0 || n > 360) throw new Error('takeoff_speed_mph must be between 0 and 360 mph.'); }
    else if (n < 0 || n > 5) throw new Error(`${key} must be between 0.00 and 5.00.`);
    out[key] = n;
  }
  out.format = 'wind-tunnel-deluxe'; out.version = 3;
  return out;
}

module.exports = { DEFAULT, normalize };
