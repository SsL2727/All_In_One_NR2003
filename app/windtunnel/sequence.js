'use strict';

const { CHANNEL_LIMITS, validate } = require('./wtdc');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function bezier(t, x1, y1, x2, y2) {
  // Invert the cubic x curve by bisection, then evaluate y at the same parameter.
  let lo = 0, hi = 1, u = t;
  for (let i = 0; i < 18; i++) {
    u = (lo + hi) * 0.5;
    const x = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
    if (x < t) lo = u; else hi = u;
  }
  return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
}

function sampleTrack(track, step) {
  const keys = (track && track.keys || []).slice().sort((a, b) => a.step - b.step);
  if (!keys.length) return track && track.channel === 6 ? 0 : 0;
  if (step <= keys[0].step) return keys[0].value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (step > b.step) continue;
    if (track.channel === 6) return a.value;
    const t = clamp((step - a.step) / Math.max(1, b.step - a.step), 0, 1);
    if (a.easing === 1) return t < 1 ? a.value : b.value; // Hold
    const shape = a.bezier || [0.25, 0.1, 0.25, 1];
    return a.value + (b.value - a.value) * bezier(t, ...shape);
  }
  return keys[keys.length - 1].value;
}

function addKey(seq, channel, step, value, easing = 0) {
  validate(seq);
  const track = seq.tracks.find(t => t.channel === channel);
  if (!track) throw new Error('Unknown Director channel.');
  step = Math.round(Number(step)); value = Number(value);
  if (!Number.isInteger(step) || step < 1 || step > seq.duration || !Number.isFinite(value)) throw new Error('Key step/value is out of range.');
  if (step === 1 && channel < 6 && value !== 0) throw new Error('Step 1 is locked at zero movement.');
  if (channel === 6) value = value ? 1 : 0;
  const limits = CHANNEL_LIMITS[channel];
  if (limits && (value < limits[0] || value > limits[1])) throw new Error(`This channel must stay between ${limits[0]} and ${limits[1]}.`);
  const old = track.keys.findIndex(k => k.step === step), key = { step, value, easing: Math.trunc(easing), bezier: [0.25, 0.1, 0.25, 1] };
  if (old >= 0) track.keys[old] = key; else track.keys.push(key);
  track.keys.sort((a, b) => a.step - b.step);
  if (track.keys.length > 128) { track.keys.pop(); throw new Error('A channel can contain at most 128 keys.'); }
  return key;
}

function removeKey(seq, channel, step) {
  const track = seq.tracks.find(t => t.channel === channel); if (!track) return false;
  const i = track.keys.findIndex(k => k.step === step); if (i < 0) return false;
  track.keys.splice(i, 1); return true;
}

module.exports = { bezier, sampleTrack, addKey, removeKey, CHANNEL_LIMITS };
