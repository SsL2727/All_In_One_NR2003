// Season schedules (All In One NR2003's own; the NR Season Generator stays the separate tool it is): the installed tracks from their track.ini,
// a schedule built from a real season (data/*.json, matched to installed tracks), a balanced rotation of track types or a random one,
// and NR2003's own season file (series\<series>\2003season.ini: [ EventN ] day, month, name, numberOfLaps, trackDirectory, startingGrid).
'use strict';
const fs = require('fs');
const path = require('path');

const MILE = 1609.344;
const TYPES = ['short', 'intermediate', 'superspeedway', 'road'];

function readIni(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'latin1').split(/\r?\n/)) {
    const t = line.split(';')[0];
    const eq = t.indexOf('=');
    if (eq > 0) out[t.slice(0, eq).trim().toLowerCase()] = t.slice(eq + 1).trim();
  }
  return out;
}
// "1.5m", "2.66 mi", "5.02km", "0.5" (miles) -> metres
function lengthM(v) {
  const m = /^\s*([0-9.]+)\s*([a-z]*)/i.exec(String(v || ''));
  if (!m) return 0;
  const n = Number(m[1]), u = m[2].toLowerCase();
  if (!(n > 0)) return 0;
  return u.startsWith('k') ? n * 1000 : n * MILE;
}
function typeOf(ini, len, dir) {
  const txt = (String(ini.track_length_n_type || '') + ' ' + dir + ' ' + (ini.track_name || '')).toLowerCase();
  if (/road|street|circuit|roval|\bgp\b|grand prix/.test(txt) || Number(ini.track_type) === 5) return 'road';
  if (len >= 3700) return 'superspeedway';
  if (len >= 1400 * 1.0 && len >= 1.3 * MILE) return 'intermediate';
  return 'short';
}
// every installed track: { dir, name, short, lengthM, miles, type, laps }
function scanTracks(nrDir) {
  const root = path.join(nrDir || '', 'tracks');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (e) { return []; }
  const out = [];
  for (const dir of dirs) {
    const f = path.join(root, dir, 'track.ini');
    if (!fs.existsSync(f)) continue;
    let ini; try { ini = readIni(f); } catch (e) { continue; }
    const len = lengthM(ini.track_length);
    out.push({ dir, name: ini.track_name || dir, short: ini.track_name_short || ini.track_name || dir, lengthM: Math.round(len), miles: Math.round(len / MILE * 1000) / 1000,
      type: typeOf(ini, len, dir), laps: parseInt(ini.default_event_laps, 10) || 0 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── matching a real race's track to an installed one ─────────────────────────────────────────────────────────────────
const STOP = new Set(['speedway', 'motor', 'international', 'raceway', 'race', 'track', 'park', 'the', 'of', 'day', 'night', 'wkc', 'bbmc', 'fse', 'te', 'foh', 'mb', 'pst', 'dtn', 'n', 'revamped', 'hardcore', 'v1', 'v2']);
const ALIAS = { 'cota': ['circuit', 'americas', 'cota'], 'phoenix': ['phoenix', 'ism'], 'charlotte roval': ['roval'], 'chicago street': ['chicago', 'street'], 'nashville': ['nashville'], 'gateway': ['gateway', 'wwt'],
  'north wilkesboro': ['wilkesboro'], 'mexico city': ['hermanos', 'rodriguez', 'mexico'], 'watkins glen': ['watkins', 'glen'], 'sonoma': ['sonoma', 'sears'], 'indianapolis': ['indianapolis', 'indy'], 'san diego': ['coronado', 'san', 'diego'] };
const words = (s) => String(s || '').toLowerCase().replace(/[_\-.]/g, ' ').replace(/\b(19|20)\d\d\w*\b/g, ' ').split(/[^a-z]+/).filter(w => w && !STOP.has(w) && w.length > 1);
function matchScore(race, t) {
  const want = ALIAS[String(race.track || race.name).toLowerCase()] || words(race.track || race.name);
  const have = new Set(words(t.dir + ' ' + t.name + ' ' + t.short));
  let hit = 0; for (const w of want) if (have.has(w)) hit++;
  if (!hit) return -1;
  let s = hit * 10 - (have.size - hit) * 0.5;
  if (race.miles > 0 && t.miles > 0) s -= Math.min(10, Math.abs(race.miles - t.miles) / race.miles * 20);
  const roadWanted = /cota|roval|street|glen|sonoma|mexico|road|circuit|san diego/i.test(String(race.track || race.name));
  if (roadWanted !== (t.type === 'road')) s -= 8;
  return s;
}
function bestTrack(race, tracks) {
  let best = null, bs = -1;
  for (const t of tracks) { const s = matchScore(race, t); if (s > bs) { bs = s; best = t; } }
  return best;
}

// ── schedules ────────────────────────────────────────────────────────────────────────────────────────────────────────
// an event: { n, name, track (dir or ''), trackName, laps, stages: [lap numbers], day, month, missing? }
function weekly(i, startMonth = 2, startDay = 15) {
  const d = new Date(Date.UTC(2026, startMonth - 1, startDay + i * 7));
  return { day: d.getUTCDate(), month: d.getUTCMonth() + 1 };
}
function fromReference(ref, tracks) {
  return ref.races.map((r, i) => {
    const t = bestTrack(r, tracks);
    return Object.assign({ n: i + 1, name: r.name, track: t ? t.dir : '', trackName: t ? t.name : '', laps: r.laps, stages: (r.stages || []).slice(), real: r.track, missing: !t }, r.month >= 1 && r.month <= 12 && r.day >= 1 && r.day <= 31 ? { day: r.day, month: r.month } : weekly(i));      // a reference with real dates keeps them
  });
}
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// stage ends for a generated race: NASCAR-like proportions (about 25% and 50%) for 3 stages, none for road courses under 80 laps
function stagesFor(laps, type) {
  if (!(laps >= 30)) return [];
  if (type === 'road' && laps < 80) return [Math.round(laps * 0.25), Math.round(laps * 0.5)];
  return [Math.round(laps * 0.25), Math.round(laps * 0.5)];
}
// opts: { count, style: 'balanced' | 'random', types: [...], repeat: bool, seed }
function generate(tracks, opts = {}) {
  const count = Math.max(1, Math.min(60, opts.count | 0 || 36));
  const types = (opts.types && opts.types.length ? opts.types : TYPES).filter(t => TYPES.includes(t));
  const rnd = mulberry(opts.seed != null ? opts.seed : Date.now() & 0xffffff);
  const pool = tracks.filter(t => types.includes(t.type));
  if (!pool.length) return [];
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const byType = {}; for (const t of pool) (byType[t.type] = byType[t.type] || []).push(t);
  for (const k of Object.keys(byType)) shuffle(byType[k]);
  const used = new Set(), out = [];
  const take = (type) => {
    const list = byType[type] || [];
    let t = list.find(x => !used.has(x.dir));
    if (!t && opts.repeat) t = list[Math.floor(rnd() * list.length)];
    return t || null;
  };
  let order = shuffle(Object.keys(byType).slice());
  for (let i = 0; out.length < count && i < count * 4; i++) {
    let t = null;
    if (opts.style === 'random') {
      const free = pool.filter(x => opts.repeat || !used.has(x.dir));
      t = free.length ? free[Math.floor(rnd() * free.length)] : null;
    } else {
      t = take(order[i % order.length]);                       // balanced: the types take turns
      if (i % order.length === order.length - 1) order = shuffle(order);
    }
    if (!t) { if (!opts.repeat && used.size >= pool.length) break; continue; }
    used.add(t.dir);
    const laps = t.laps || Math.max(20, Math.round(400000 / Math.max(400, t.lengthM)));
    out.push(Object.assign({ n: out.length + 1, name: t.short, track: t.dir, trackName: t.name, laps, stages: stagesFor(laps, t.type) }, weekly(out.length)));
  }
  return out;
}

// ── NR2003's season file ─────────────────────────────────────────────────────────────────────────────────────────────
function seasonIni(events) {
  const pad = (s, n) => String(s).padEnd(n);
  return events.map((e, i) => [
    `[ Event${i + 1} ]`,
    `${pad('day = ' + e.day, 40)}\t; Day of the event [1-31]`,
    `${pad('month = ' + e.month, 40)}\t; Month of the event [1-12]`,
    `${pad('name = ' + String(e.name).replace(/[\r\n;]/g, ' '), 40)}\t; Name of the event`,
    `${pad('numberOfLaps = ' + e.laps, 40)}\t; Number of laps for the race session`,
    `${pad('trackDirectory = ' + e.track, 40)}\t; Directory for the track data`,
    `${pad('startingGrid = 1', 40)}\t; Starting grid: grid_2x2_InLinePoleOnLeft`,
    '',
  ].join('\r\n')).join('\r\n');
}
function parseSeasonIni(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (/^\[\s*event\s*\d+\s*\]$/i.test(line)) { cur = { n: out.length + 1, name: '', track: '', laps: 0, day: 1, month: 1, stages: [] }; out.push(cur); continue; }
    const eq = line.indexOf('=');
    if (!cur || eq < 0) continue;
    const k = line.slice(0, eq).trim().toLowerCase(), v = line.slice(eq + 1).trim().replace(/[^\x20-\x7e]/g, '');
    if (k === 'day') cur.day = parseInt(v, 10) || 1;
    else if (k === 'month') cur.month = parseInt(v, 10) || 1;
    else if (k === 'name') cur.name = v;
    else if (k === 'numberoflaps') cur.laps = parseInt(v, 10) || 0;
    else if (k === 'trackdirectory') cur.track = v;
  }
  return out;
}
// writes series\<series>\2003season.ini (the game's own kept as 2003season.ini.steelfire-backup the first time)
function writeSeason(nrDir, series, events) {
  const dir = path.join(nrDir, 'series', series);
  if (!fs.existsSync(dir)) throw new Error('no such series folder: ' + series);
  const f = path.join(dir, '2003season.ini'), bak = f + '.steelfire-backup';
  if (fs.existsSync(f) && !fs.existsSync(bak)) fs.copyFileSync(f, bak);
  fs.writeFileSync(f, seasonIni(events), 'latin1');
  return f;
}
function readSeason(nrDir, series) {
  const f = path.join(nrDir, 'series', series, '2003season.ini');
  return fs.existsSync(f) ? parseSeasonIni(fs.readFileSync(f, 'latin1')) : [];
}

// does a track the bridge reports (its name or folder) belong to an event?
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function sameTrack(event, tracks, reported) {
  if (!event || !reported) return false;
  const r = norm(reported);
  if (!r) return false;
  const t = tracks && tracks.find(x => x.dir === event.track);
  return [event.track, event.trackName, t && t.name, t && t.short].filter(Boolean).some(x => norm(x) === r);
}

module.exports = { TYPES, scanTracks, lengthM, bestTrack, matchScore, fromReference, generate, stagesFor, seasonIni, parseSeasonIni, writeSeason, readSeason, sameTrack };
