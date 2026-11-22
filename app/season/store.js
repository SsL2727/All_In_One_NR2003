// SeasonStore — JSON persistence for seasons (userData/seasons/<id>.json).
// Every mutation first copies the previous file into seasons/backups/<id>/ so a
// race can always be rolled back or re-run.
'use strict';
const fs = require('fs');
const path = require('path');
const Rules = require('./rules');
const Engine = require('./engine');
const Imp = require('./import');
const Entry = require('./entry');

const KEEP_BACKUPS = 40;

function slug(s) {
  return String(s || 'season').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'season';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fingerprint(race) {
  const order = (race.entries || []).map(e => e.key || Engine.keyOf(e.name)).join('|');
  let h = 0;
  for (let i = 0; i < order.length; i++) h = ((h << 5) - h + order.charCodeAt(i)) | 0;
  return (race.track || '') + ':' + (race.entries || []).length + ':' + h;
}

class SeasonStore {
  constructor(dir) {
    this.dir = dir;
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  _file(id) { return path.join(this.dir, id + '.json'); }

  _write(file, data) {
    const tmp = file + '.tmp';
    const json = JSON.stringify(data, null, 2);
    try { fs.writeFileSync(tmp, json, 'utf8'); fs.renameSync(tmp, file); }
    catch (e) { fs.writeFileSync(file, json, 'utf8'); try { fs.unlinkSync(tmp); } catch (_) {} }
  }

  _backup(id, reason) {
    const f = this._file(id);
    if (!fs.existsSync(f)) return;
    const d = path.join(this.backupDir, id);
    fs.mkdirSync(d, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(f, path.join(d, stamp + '-' + slug(reason) + '.json'));
    const all = fs.readdirSync(d).sort();
    while (all.length > KEEP_BACKUPS) fs.unlinkSync(path.join(d, all.shift()));
  }

  list() {
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch (e) { return null; } })
      .filter(Boolean)
      .map(s => {
        const st = Engine.computeSeason(s, { noDelta: true });
        return { id: s.id, name: s.name, series: s.series, linkedSeries: s.linkedSeries || '', racesRun: st.racesRun, totalRaces: st.totalRaces, phase: st.phase, updatedAt: s.updatedAt, leader: st.leader ? st.leader.name : '' };
      })
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  get(id) {
    if (!id) return null;
    const f = this._file(id);
    if (!fs.existsSync(f)) return null;
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    s.ruleset = Rules.normalizeRuleset(s.ruleset);
    s.races = s.races || [];
    Object.defineProperty(s, 'aliases', { value: this.aliases(), enumerable: false, writable: true });   // merged drivers (never saved into the season)
    return s;
  }

  // ── merged drivers: a renamed driver's old name counts as the new one in every season (aliases.json next to the seasons) ──
  aliases() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'aliases.json'), 'utf8')) || {}; } catch (e) { return {}; }
  }
  setAlias(from, to, name) {
    const a = this.aliases();
    const f = Engine.keyOf(from), t = Engine.keyOf(to);
    if (!f || !t || f === t) return { ok: false, error: 'Pick two different drivers.' };
    if (a[t] && a[t].to === f) return { ok: false, error: 'That would merge the two into each other.' };
    a[f] = { to: t, name: Engine.normName(name || to) };
    for (const k of Object.keys(a)) if (a[k].to === f) a[k] = { to: t, name: a[f].name };       // chains end at the newest name
    this._writeAliases(a);
    return { ok: true, aliases: a };
  }
  removeAlias(from) { const a = this.aliases(); delete a[Engine.keyOf(from)]; this._writeAliases(a); return { ok: true, aliases: a }; }
  _writeAliases(a) { fs.writeFileSync(path.join(this.dir, 'aliases.json'), JSON.stringify(a, null, 1)); }

  _save(season, reason) {
    this._backup(season.id, reason || 'save');
    season.updatedAt = new Date().toISOString();
    this._write(this._file(season.id), season);
    return season;
  }

  create({ name, series, ruleset, linkedSeries, system }) {
    const base = slug(name);
    let id = base, n = 2;
    while (fs.existsSync(this._file(id))) id = base + '-' + (n++);
    const rs = Rules.normalizeRuleset(Object.assign({}, ruleset || Rules.buildRuleset(series || 'cup', system), { series: series || (ruleset && ruleset.series) || 'cup' }));
    const season = {
      version: 1, id, name: name || 'Season', series: rs.series, linkedSeries: linkedSeries || '', ruleset: rs, baseline: null, races: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this._write(this._file(id), season);
    return season;
  }

  rename(id, name) { const s = this.get(id); s.name = name; return this._save(s, 'rename'); }
  setLinkedSeries(id, linkedSeries) { const s = this.get(id); s.linkedSeries = linkedSeries || ''; return this._save(s, 'link'); }

  delete(id) {
    const f = this._file(id);
    if (!fs.existsSync(f)) return false;
    this._backup(id, 'deleted');
    fs.unlinkSync(f);
    return true;
  }

  setRuleset(id, ruleset) {
    const s = this.get(id);
    s.ruleset = Rules.normalizeRuleset(Object.assign({}, ruleset, { series: s.series }));
    return this._save(s, 'ruleset');
  }

  // the season's points system from the catalog (rules.js SYSTEMS), keeping the season's own structure (series)
  setSystem(id, systemId) {
    const s = this.get(id);
    if (!Rules.SYSTEMS[systemId]) return { ok: false, error: 'Unknown points system: ' + systemId };
    s.ruleset = Rules.normalizeRuleset(Rules.buildRuleset(s.series, systemId));
    this._save(s, 'points system');
    return { ok: true, season: s };
  }

  // ── rivals across the season (AIMOD's racing intensity & rivals) ───────────────────────────────────────────────
  // season.rivals: { "a|b": { a, b, names: [na, nb], level, holder, runins, races, settled, retaliations, last, lastRace, since } }
  // A counted race's feuds update their pair: the level (and the grudge holder) as the race ended, the run-ins added up. Pairs that
  // didn't meet keep what they had. `race` gives the car number -> driver name map of that race.
  mergeRivals(id, feuds, race) {
    const s = this.get(id);
    if (!s.rivals) s.rivals = {};
    const nameOf = {};
    for (const e of (race && race.entries) || []) if (e.number != null && e.number !== '') nameOf[String(parseInt(e.number, 10))] = e.name;
    const raceNo = (s.baseline ? s.baseline.racesRun || 0 : 0) + s.races.length;
    let n = 0;
    for (const f of feuds || []) {
      const a = String(parseInt(f.a, 10)), b = String(parseInt(f.b, 10));
      if (!a || !b || a === 'NaN' || b === 'NaN' || a === b) continue;
      const [x, y] = Number(a) <= Number(b) ? [a, b] : [b, a];
      const key = x + '|' + y;
      const had = s.rivals[key];
      if (!had && !(f.level > 0) && !(f.runins > 0)) continue;
      const r = had || (s.rivals[key] = { a: x, b: y, names: [nameOf[x] || '', nameOf[y] || ''], level: 0, holder: null, runins: 0, races: 0, settled: 0, retaliations: 0, since: raceNo });
      r.names = [nameOf[x] || r.names[0] || '', nameOf[y] || r.names[1] || ''];
      r.level = Math.max(0, Math.min(3, Number(f.level) || 0));
      r.holder = r.level === 1 && f.holder != null ? String(parseInt(f.holder, 10)) : null;
      r.runins += Number(f.runins) || 0;
      r.settled += Number(f.settled) || 0;
      r.retaliations += f.retaliate ? 1 : 0;
      r.races += 1;
      r.last = race && race.track || '';
      r.lastRace = raceNo;
      n++;
    }
    if (n) this._save(s, 'rivals');
    return { ok: true, updated: n, rivals: s.rivals };
  }
  // the season's schedule: { events: [{ name, track (folder), trackName, laps, stages, day, month }], series (NR2003 series folder), autoArm, name }
  setSchedule(id, schedule) {
    const s = this.get(id);
    if (!schedule) { delete s.schedule; this._save(s, 'schedule'); return { ok: true }; }
    const events = (schedule.events || []).map((e, i) => ({ n: i + 1, name: String(e.name || ('Race ' + (i + 1))), track: String(e.track || ''), trackName: String(e.trackName || ''),
      laps: Math.max(1, parseInt(e.laps, 10) || 1), stages: (e.stages || []).map(Number).filter(x => x > 0), day: Math.max(1, Math.min(31, parseInt(e.day, 10) || 1)), month: Math.max(1, Math.min(12, parseInt(e.month, 10) || 1)),
      real: e.real || undefined, missing: !e.track, charters: Entry.parseNums(e.charters || []) }));
    s.schedule = { events, series: schedule.series || (s.schedule && s.schedule.series) || '', autoArm: schedule.autoArm !== false, name: schedule.name || (s.schedule && s.schedule.name) || '' };
    this._save(s, 'schedule');
    return { ok: true, schedule: s.schedule };
  }
  // guaranteed starters: { lockTop, topN, charters } (season/entry.js)
  setEntry(id, entry) {
    const s = this.get(id);
    const e = entry || {};
    s.entry = { lockTop: !!e.lockTop, topN: Math.max(1, Math.min(200, parseInt(e.topN, 10) || Entry.DEFAULT_TOP)), charters: Entry.parseNums(e.charters || []) };
    this._save(s, 'entry list');
    return { ok: true, entry: s.entry };
  }
  removeRival(id, key) {
    const s = this.get(id);
    if (s.rivals && s.rivals[key]) { delete s.rivals[key]; this._save(s, 'remove rival'); }
    return { ok: true };
  }
  clearRivals(id) { const s = this.get(id); s.rivals = {}; this._save(s, 'clear rivals'); return { ok: true }; }

  // Returns { ok, duplicate?, race, season }.
  addRace(id, race, opts) {
    opts = opts || {};
    const s = this.get(id);
    if (!s) return { ok: false, error: 'No such season: ' + id };
    const problems = Engine.validateRace(race);
    if (problems.length) return { ok: false, error: problems.join(' ') };
    const fp = fingerprint(race);
    const last = s.races[s.races.length - 1];
    if (!opts.force && last && last.fingerprint === fp) {
      return { ok: true, duplicate: true, race: last, season: s };
    }
    const rec = Object.assign({}, race, {
      id: 'race_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      fingerprint: fp,
      date: race.date || new Date().toISOString(),
    });
    rec.entries = rec.entries.map(e => Object.assign({}, e, { key: e.key || Engine.keyOf(e.name), name: Engine.normName(e.name) }));
    delete rec.sessionCookie;
    s.races.push(rec);
    this._save(s, 'before race ' + (s.races.length));
    return { ok: true, race: rec, season: s };
  }

  removeRace(id, raceId) {
    const s = this.get(id);
    const i = s.races.findIndex(r => r.id === raceId);
    if (i < 0) return { ok: false, error: 'Race not found' };
    s.races.splice(i, 1);
    this._save(s, 'remove race');
    return { ok: true, season: s };
  }

  // patch: { fastestKey, track, notes, entries:[{key,finish}] }
  updateRace(id, raceId, patch) {
    const s = this.get(id);
    const r = s.races.find(x => x.id === raceId);
    if (!r) return { ok: false, error: 'Race not found' };
    if ('fastestKey' in patch) r.fastestKey = patch.fastestKey || null;
    // points multiplier of this race (double points): a number, or null = the ruleset decides
    if ('pointsMultiplier' in patch) { const m = Number(patch.pointsMultiplier); if (patch.pointsMultiplier == null || patch.pointsMultiplier === '' || !Number.isFinite(m)) delete r.pointsMultiplier; else r.pointsMultiplier = m; }
    if (patch.track) r.track = patch.track;
    if ('notes' in patch) r.notes = patch.notes;
    if (patch.stages) r.stages = patch.stages;
    if (patch.entries) {
      const f = new Map(patch.entries.map(e => [e.key, e.finish]));
      r.entries.forEach(e => { if (f.has(e.key)) e.finish = f.get(e.key); });
      r.entries.sort((a, b) => a.finish - b.finish);
      r.entries.forEach((e, i) => { e.finish = i + 1; });
    }
    r.fingerprint = fingerprint(r);
    this._save(s, 'edit race');
    return { ok: true, season: s };
  }

  importBaselineXml(id, xmlText) {
    const s = this.get(id);
    if (s.races.length) return { ok: false, error: 'Baseline import is only for a season with no races yet.' };
    const base = Imp.parseAutoStagesSeasonXml(xmlText);
    if (!Object.keys(base.drivers).length) return { ok: false, error: 'No drivers found in that XML.' };
    s.baseline = base;
    this._save(s, 'import xml');
    return { ok: true, season: s, drivers: Object.keys(base.drivers).length, racesRun: base.racesRun };
  }

  importRaceHtml(id, htmlText, hint) {
    const race = Imp.parseAutoStagesRaceHtml(htmlText, hint);
    if (hint && hint.date) race.date = hint.date;
    return this.addRace(id, race, { force: true });
  }

  // ── HTML exports (self-contained, no external assets) ───────────────────
  standingsHtml(id) {
    const s = this.get(id);
    const st = Engine.computeSeason(s);
    const phaseLabel = st.phase === 'complete' ? 'Final Standings' : st.phase === 'chase' && st.chase ? 'The Chase' : 'Regular Season';
    const head = '<tr><th>Pos</th><th>#</th><th>Driver</th><th>Points</th><th>Behind</th><th>Wins</th><th>Stage Wins</th><th>Top 5s</th><th>Top 10s</th><th>Laps Led</th><th>Fastest Laps</th><th>AFP</th><th>GFP</th><th>QP</th>' +
      '<th>Poles</th><th>Avg Start</th><th>Avg Run</th><th>Races Led</th><th>Lead Lap</th><th>DNF</th><th>Laps</th><th>Pos +/-</th></tr>';
    const dash = (v) => (v == null || v === '' ? '-' : v);
    const body = st.rows.map(r => {
      const cls = r.inChase === true ? ' class="chase"' : '';
      return `<tr${cls}><td>${r.rank}</td><td>${esc(r.number)}</td><td class="drv">${esc(r.name)}${r.inChase && st.phase !== 'regular' ? ' <span class="tag">CHASE</span>' : ''}</td>` +
        `<td><b>${r.points}</b></td><td>${r.rank === 1 ? '---' : r.behind}</td><td>${r.wins}</td><td>${r.stageWins}</td><td>${r.top5s}</td><td>${r.top10s}</td>` +
        `<td>${r.lapsLed}</td><td>${r.fastestLaps}</td><td>${r.afp || ''}</td><td>${r.gfp}</td><td>${r.qp}</td>` +
        `<td>${r.poles}</td><td>${dash(r.avgStart)}</td><td>${dash(r.avgRun)}</td><td>${r.racesLed}</td><td>${dash(r.leadLap)}</td><td>${r.dnfs}</td><td>${dash(r.lapsCompleted || null)}</td><td>${dash(r.gained)}</td></tr>`;
    }).join('\n');
    const sub = `${esc(phaseLabel)} — after ${st.racesRun} of ${st.totalRaces} races` + (st.cutPoints != null ? ` — Chase cut line: ${st.cutPoints} pts (top ${st.chaseField})` : '');
    return page(`${s.name} — Season Standings`, `<h1>${esc(s.name)}</h1><div class="sub">${sub}</div><div class="wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>` +
      `<div class="note">GFP = green flag passes, QP = quality passes (passing a top-15 car), AFP = average finish. Pass stats are estimated from live telemetry.</div>`);
  }

  raceHtml(id, raceId) {
    const s = this.get(id);
    const idx = s.races.findIndex(r => r.id === raceId);
    if (idx < 0) return null;
    const race = s.races[idx];
    const rules = Rules.normalizeRuleset(s.ruleset);
    const raceNo = (s.baseline ? s.baseline.racesRun || 0 : 0) + idx + 1;
    const { entries, stageResults } = Engine.scoreRace(race, rules, { raceNo, totalRaces: rules.regularSeasonRaces + (rules.chase.enabled ? rules.chaseRaces : 0) });
    const nameOf = {};
    entries.forEach(e => { nameOf[e.key] = e.name; });
    const rowsHtml = entries.map(e =>
      `<tr><td>${e.finish}</td><td>${esc(e.number)}</td><td class="drv">${esc(e.name)}</td><td><b>${e.total}</b></td><td>${e.stagePts || '-'}</td>` +
      `<td>${esc(e.status || '')}</td><td>${e.ledLaps || '-'}</td><td>${[e.fastestPts ? 'FL +' + e.fastestPts : '', e.ledPts ? 'Led +' + e.ledPts : '', e.mostLedPts ? 'Most led +' + e.mostLedPts : '', e.polePts ? 'Pole +' + e.polePts : '', e.qualPts ? 'Qual +' + e.qualPts : ''].filter(Boolean).join(' ')}</td>` +
      `<td>${e.startPos || '-'}</td><td>${e.lapsCompleted != null ? e.lapsCompleted : '-'}</td><td>${e.avgRun || '-'}</td><td>${e.bestLap ? Number(e.bestLap).toFixed(3) : '-'}</td></tr>`).join('\n');
    const rs = race.stats;
    const statsLine = rs ? ` — ${rs.leadChanges} lead changes among ${rs.leaders} leaders — ${rs.cautions} cautions for ${rs.cautionLaps} laps` : '';
    const stagesHtml = stageResults.map(sr =>
      `<div class="box"><h3>Stage ${sr.stage} Results</h3><table><thead><tr><th>Pos</th><th>Driver</th><th>Pts</th></tr></thead><tbody>` +
      sr.order.map(o => `<tr><td>${o.pos}</td><td class="drv">${esc(nameOf[o.key] || o.key)}</td><td>${o.pts || '-'}</td></tr>`).join('') +
      '</tbody></table></div>').join('');
    return page(`${s.name} — Race ${idx + 1}`,
      `<h1>${esc(race.track)} — Race ${idx + 1}</h1><div class="sub">${esc(s.name)}${race.laps ? ' — ' + race.laps + ' laps' : ''} — ${esc(String(race.date || '').slice(0, 10))}${statsLine}</div>` +
      `<div class="wrap"><table><thead><tr><th>Pos</th><th>#</th><th>Driver</th><th>Pts</th><th>Stage Pts</th><th>Status</th><th>Led</th><th>Bonus</th><th>Start</th><th>Laps</th><th>Avg Run</th><th>Best Lap</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` +
      `<div class="stages">${stagesHtml}</div>`);
  }

  exportAll(id, outDir) {
    const s = this.get(id);
    fs.mkdirSync(path.join(outDir, 'Race Results'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'Season Standings.html'), this.standingsHtml(id), 'utf8');
    s.races.forEach((r, i) => {
      const f = String(i + 1).padStart(2, '0') + ' - ' + String(r.track || 'race').replace(/[\\/:*?"<>|]+/g, '_') + '.html';
      fs.writeFileSync(path.join(outDir, 'Race Results', f), this.raceHtml(id, r.id), 'utf8');
    });
    return outDir;
  }
}

function page(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(title)}</title><style>
body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f4f9;color:#222;margin:0;padding:20px}
h1{font-size:24px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px}.sub{color:#666;margin-bottom:16px}
.wrap{background:#fff;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.06);overflow-x:auto;padding:6px}
table{width:100%;border-collapse:collapse;font-size:14px}th{background:#111;color:#fff;text-align:left;padding:9px 8px;white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid #eee}tr:nth-child(even){background:#fafafa}tr.chase td:first-child{border-left:4px solid #d4a017}
.drv{font-weight:600}.tag{font-size:10px;background:#d4a017;color:#fff;border-radius:3px;padding:1px 5px;margin-left:6px}
.stages{display:flex;flex-wrap:wrap;gap:16px;margin-top:20px}.box{background:#fff;border-radius:8px;padding:10px 14px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
.box h3{margin:0 0 8px}.note{color:#777;font-size:12px;margin-top:12px}
</style></head><body>${inner}</body></html>`;
}

module.exports = { SeasonStore, fingerprint, slug };
