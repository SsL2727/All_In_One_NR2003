// NR2003 rosters (series\<series>\cars\*.lst): one car file per line, "+" in front = in the pool the AI field is drawn from, "-" = left out.
// A driver can have several cars (paint schemes) in a roster; "one car per driver" keeps exactly one of them in the pool.
'use strict';
const fs = require('fs');
const path = require('path');

// -> { entries: [{ enabled, file, raw }], eol }; lines that are not car entries (blank, comments) are kept as { raw } only
function parseLst(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const entries = String(text).split(/\r?\n/).map((raw) => {
    const m = /^([+-])(.*\S)\s*$/.exec(raw);
    return m ? { enabled: m[1] === '+', file: m[2], raw } : { raw };
  });
  if (entries.length && entries[entries.length - 1].raw === '') entries.pop();      // the trailing newline
  return { entries, eol };
}

function serializeLst(parsed) {
  return parsed.entries.map((e) => (e.file === undefined ? e.raw : (e.enabled ? '+' : '-') + e.file)).join(parsed.eol) + parsed.eol;
}

// [Driver] of a .car file: first_name, last_name, car_number, team_name, sponsor (plain text near the top of the file)
const cache = new Map();
function readDriver(carPath) {
  let st;
  try { st = fs.statSync(carPath); } catch (e) { return null; }
  const key = carPath + '|' + st.mtimeMs + '|' + st.size, hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out = null;
  try {
    const fd = fs.openSync(carPath, 'r'); const buf = Buffer.alloc(24 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const t = buf.toString('latin1', 0, n), i = t.indexOf('[Driver]');
    if (i >= 0) {
      const sec = t.slice(i, i + 700), get = (k) => { const m = new RegExp('^' + k + '=(.*?)\\s*$', 'm').exec(sec); return m ? m[1].trim() : ''; };
      out = { first: get('first_name'), last: get('last_name'), number: get('car_number'), team: get('team_name'), sponsor: get('sponsor') };
    }
  } catch (e) { out = null; }
  cache.set(key, out);
  return out;
}

const driverKey = (d) => (d && (d.first || d.last) ? `${d.first} ${d.last}`.toLowerCase().replace(/\s+/g, ' ').trim() : '');

// Plan the pool: one enabled car per driver (chosen with rnd), the player's driver gets no AI car at all.
//   parsed = parseLst(...), driverOf(file) -> { first, last, number } | null, opts = { rnd, playerKey }
// -> { parsed (new), report: { drivers, kept, removed: [{ name, kept, dropped: [files] }], unknown, playerRemoved: [files] } }
function planOnePerDriver(parsed, driverOf, opts = {}) {
  const rnd = opts.rnd || Math.random, playerKey = opts.playerKey || '';
  const byDriver = new Map(), unknown = [];
  parsed.entries.forEach((e, i) => {
    if (e.file === undefined || !e.enabled) return;
    const d = driverOf(e.file), k = driverKey(d);
    if (!k) { unknown.push(e.file); return; }                       // cannot tell who drives it: leave it alone
    if (!byDriver.has(k)) byDriver.set(k, { name: `${d.first} ${d.last}`.trim(), idx: [] });
    byDriver.get(k).idx.push(i);
  });
  const entries = parsed.entries.map((e) => Object.assign({}, e));
  const report = { drivers: 0, kept: [], removed: [], unknown, playerRemoved: [] };
  for (const [k, g] of byDriver) {
    if (k === playerKey) { g.idx.forEach((i) => { entries[i].enabled = false; report.playerRemoved.push(entries[i].file); }); continue; }
    const pick = g.idx[Math.min(g.idx.length - 1, Math.floor(rnd() * g.idx.length))];
    report.drivers++; report.kept.push(entries[pick].file);
    const dropped = g.idx.filter((i) => i !== pick);
    dropped.forEach((i) => { entries[i].enabled = false; });
    if (dropped.length) report.removed.push({ name: g.name, kept: entries[pick].file, dropped: dropped.map((i) => entries[i].file) });
  }
  return { parsed: { entries, eol: parsed.eol }, report };
}

// the .lst a series uses for the player: <nr2003>\series\<series>\cars\<roster>
const rosterPath = (nrDir, series, roster) => path.join(nrDir, 'series', series, 'cars', roster);

// "key=value" of one [section] of an ini (player.ini); '' when missing
function iniGet(text, section, key) {
  const lines = String(text).split(/\r?\n/); let inSec = false;
  for (const l of lines) {
    const s = /^\s*\[(.+?)\]\s*$/.exec(l);
    if (s) { inSec = s[1].toLowerCase() === section.toLowerCase(); continue; }
    if (!inSec) continue;
    const m = new RegExp('^\\s*' + key + '\\s*=\\s*([^;\\r\\n]*)', 'i').exec(l);
    if (m) return m[1].trim();
  }
  return '';
}

module.exports = { parseLst, serializeLst, readDriver, driverKey, planOnePerDriver, rosterPath, iniGet };
