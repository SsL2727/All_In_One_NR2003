'use strict';

const CHANNELS = ['X Roll', 'Y Pitch', 'Z Yaw', 'Altitude', 'Lateral', 'Forward', 'Crashing?'];
const MAX_KEYS = 128;
const CHANNEL_LIMITS = Object.freeze({ 3: [0, 100], 4: [-100, 100], 5: [-10000, 10000] });
const number = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`Invalid ${name}.`); return n; };

function freshSequence(name = 'Sequence 1') {
  return { version: 9, name, settings: ['0', ...Array(14).fill('0')], duration: 2880, easeIn: 0, strength: 100, tracks: CHANNELS.map((_, channel) => ({ channel, keys: channel === 6 ? [] : [{ step: 1, value: 0, easing: 0, bezier: [0.25, 0.1, 0.25, 1] }] })), extras: [] };
}

function parse(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  const head = /^WTDIRECTOR\s+(\d+)$/i.exec(lines[0] || '');
  if (!head) throw new Error('Not a Wind Tunnel Director sequence (missing WTDIRECTOR header).');
  const seq = freshSequence(); seq.version = Math.max(9, Math.min(12, Number(head[1]))); seq.tracks = []; seq.extras = [];
  let track = null, sawSequence = false, ended = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i], parts = line.split(/\s+/), tag = parts[0].toLowerCase();
    if (tag === 'settings') { seq.settings = parts.slice(1); continue; }
    if (tag === 'sequence') {
      if (parts.length < 4) throw new Error(`Invalid sequence header on line ${i + 1}.`);
      seq.duration = Math.max(1, Math.trunc(number(parts[1], 'duration'))); seq.easeIn = Math.max(0, Math.trunc(number(parts[2], 'ease-in'))); seq.strength = Math.max(0, Math.min(100, number(parts[3], 'strength'))); sawSequence = true; continue;
    }
    if (tag === 'track') {
      const channel = Math.trunc(number(parts[1], 'channel')), expected = Math.trunc(number(parts[2], 'key count'));
      if (channel < 0 || channel > 6 || expected < 0 || expected >= 129) throw new Error(`Invalid track declaration on line ${i + 1}.`);
      track = { channel, expected, keys: [] }; seq.tracks.push(track); continue;
    }
    if (tag === 'key' && track) {
      if (parts.length < 8) throw new Error(`Invalid key on line ${i + 1}.`);
      const key = { step: Math.trunc(number(parts[1], 'key step')), value: number(parts[2], 'key value'), easing: Math.trunc(number(parts[3], 'easing id')), bezier: parts.slice(4, 8).map((v, j) => number(v, `Bezier value ${j + 1}`)) };
      if (key.step < 1 || key.step > 10000000 || key.bezier.length !== 4) throw new Error(`Key out of range on line ${i + 1}.`);
      track.keys.push(key); continue;
    }
    if (tag === 'end') { ended = true; continue; }
    // Keep supports, recorded rows and future version fields byte-for-byte at the line level.
    seq.extras.push(line);
  }
  if (!sawSequence || !ended) throw new Error('Incomplete Director sequence (missing sequence data or end marker).');
  for (const t of seq.tracks) {
    if (t.keys.length !== t.expected) throw new Error(`Channel ${t.channel} declares ${t.expected} keys but contains ${t.keys.length}.`);
    t.keys.sort((a, b) => a.step - b.step);
    if (t.keys.length > MAX_KEYS || t.keys.some((k, i) => i && k.step === t.keys[i - 1].step)) throw new Error(`Channel ${t.channel} has too many keys or duplicate frame numbers.`);
  }
  for (let c = 0; c < 7; c++) if (!seq.tracks.some(t => t.channel === c)) seq.tracks.push({ channel: c, keys: [] });
  seq.tracks.sort((a, b) => a.channel - b.channel);
  validate(seq);
  return seq;
}

function serialize(seq) {
  validate(seq);
  const lines = [`WTDIRECTOR ${Math.max(9, Math.min(12, Math.trunc(seq.version || 9)))}`, `settings ${(seq.settings || []).join(' ')}`, `sequence ${Math.trunc(seq.duration)} ${Math.trunc(seq.easeIn)} ${Number(seq.strength).toFixed(4)}`];
  for (let c = 0; c < 7; c++) {
    const t = seq.tracks.find(x => x.channel === c) || { channel: c, keys: [] }, keys = [...t.keys].sort((a, b) => a.step - b.step);
    lines.push(`track ${c} ${keys.length}`);
    for (const k of keys) lines.push(`key ${Math.trunc(k.step)} ${Number(k.value).toFixed(6)} ${Math.trunc(k.easing || 0)} ${(k.bezier || [0.25, 0.1, 0.25, 1]).map(v => Number(v).toFixed(6)).join(' ')}`);
  }
  lines.push(...(seq.extras || []).filter(s => !/^end\s*$/i.test(s)));
  lines.push('end');
  return lines.join('\r\n') + '\r\n';
}

function validate(seq) {
  if (!seq || !Array.isArray(seq.tracks)) throw new Error('Sequence data is missing.');
  if (!(Number.isFinite(seq.duration) && seq.duration >= 1 && seq.duration <= 10000000)) throw new Error('Duration must be between 1 and 10,000,000 simulation steps.');
  if (!(Number.isFinite(seq.easeIn) && seq.easeIn >= 0 && seq.easeIn <= 28800)) throw new Error('Ease-in must be between 0 and 28,800 steps.');
  if (!(Number.isFinite(seq.strength) && seq.strength >= 0 && seq.strength <= 100)) throw new Error('Strength must be between 0 and 100 percent.');
  for (let channel = 0; channel <= 6; channel++) {
    const t = seq.tracks.find(x => x.channel === channel); if (!t) continue;
    if (t.keys.length > MAX_KEYS) throw new Error(`${CHANNELS[channel]} supports at most 128 keys.`);
    t.keys.sort((a, b) => a.step - b.step);
    for (let i = 0; i < t.keys.length; i++) {
      const k = t.keys[i];
      if (!Number.isInteger(k.step) || k.step < 1 || k.step > seq.duration || !Number.isFinite(k.value)) throw new Error(`${CHANNELS[channel]} has a key outside the sequence duration.`);
      const limits = CHANNEL_LIMITS[channel];
      if (limits && (k.value < limits[0] || k.value > limits[1])) throw new Error(`${CHANNELS[channel]} must stay between ${limits[0]} and ${limits[1]}.`);
      if (i && k.step === t.keys[i - 1].step) throw new Error(`${CHANNELS[channel]} has duplicate keys at step ${k.step}.`);
      if (channel === 6 && ![0, 1].includes(k.value)) throw new Error('Crash keys must be On (1) or Off (0).');
      if (k.step === 1 && channel < 6 && k.value !== 0) throw new Error('Step 1 is the locked zero-movement reference.');
    }
  }
  if (Array.isArray(seq.settings) && seq.settings.some(x => !/^-?\d+(?:\.\d+)?$/.test(String(x)))) throw new Error('Director settings header contains invalid values.');
  return true;
}

module.exports = { CHANNELS, CHANNEL_LIMITS, MAX_KEYS, freshSequence, parse, serialize, validate };
