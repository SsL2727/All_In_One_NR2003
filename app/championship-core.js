// Shared championship maths (used by the hidden race recorder to decide who is
// "in the chase"). Same code as the Championship overlay widget.
(function (root) {
let OFFICIAL_MODE = false;

const normNum = n => String(n == null ? '' : n).trim();

/**
 * cfg       : { pointsTable:number[], drivers:[{number,name,points}], visibleRows, pinPlayer }
 * standings : live race order (index 0 = P1)
 * project   : true → add the points each driver would earn if the race ended now
 * Returns rows sorted by (projected) championship rank.
 *
 * Tie-break: drivers level on points keep the order they had before the race
 * (higher base points first, then the order they were entered in the list).
 */
function computeChampionship(cfg, standings, project, led, stageMap) {
  led = led || {}; stageMap = stageMap || {};
  const table   = Array.isArray(cfg.pointsTable) ? cfg.pointsTable : [];
  const drivers = (Array.isArray(cfg.drivers) ? cfg.drivers : [])
    .map(d => ({ ...d, points: Number(d.points) || 0 }));

  // Pre-race order — this is what the +/- arrows are measured against
  const baseOrder = drivers
    .map((d, idx) => ({ d, idx }))
    .sort((a, b) => (b.d.points - a.d.points) || (a.idx - b.idx));
  const baseRank = new Map();
  baseOrder.forEach((o, i) => { if (!baseRank.has(normNum(o.d.number))) baseRank.set(normNum(o.d.number), i + 1); });

  // First entry wins if a number is listed twice
  const byNum = new Map();
  drivers.forEach(d => { const k = normNum(d.number); if (!byNum.has(k)) byNum.set(k, d); });

  // Race position of every listed driver — position counts ALL cars on track,
  // including ones that aren't in the championship list.
  // (always collected, so the overlay can show where each driver is even when
  //  no points are being projected; points are only added when `project` is true)
  const race = new Map();
  (standings || []).forEach((s, i) => {
    const k = normNum(s.number);
    if (!byNum.has(k) || race.has(k)) return;
    const st = String(s.status || 'running').toLowerCase();
    race.set(k, { pos: i + 1, carIdx: s.carIdx, liveName: s.name || '', out: st !== 'running' && st !== '' });
  });

  // Bonuses (NASCAR 2003: +5 for leading a lap, +5 for leading the most laps).
  // "Most laps" is decided among ALL cars, listed in the championship or not;
  // drivers tied for the most laps each get it.
  const bLed = Number(cfg.bonusLedLap) || 0, bMost = Number(cfg.bonusMostLed) || 0;
  let maxLed = 0;
  Object.keys(led).forEach(k => { if (led[k] > maxLed) maxLed = led[k]; });

  const rows = [];
  byNum.forEach((d, k) => {
    const r      = race.get(k);
    const posPt  = (project && r) ? (Number(table[r.pos - 1]) || 0) : 0;
    const ledN   = led[k] || 0;
    const bonus  = project ? ((ledN > 0 ? bLed : 0) + (ledN > 0 && ledN === maxLed ? bMost : 0)) : 0;
    const stagePt = project ? (stageMap[k] || 0) : 0;
    const racePt = posPt + bonus + stagePt;
    rows.push({
      number:   k,
      name:     (d.name && String(d.name).trim()) || (r && r.liveName) || '',
      base:     d.points,
      racePts:  racePt,
      bonus,
      stagePts: stagePt,
      ledLaps:  ledN,
      out:      !!(r && r.out),
      total:    d.points + racePt,
      baseRank: baseRank.get(k) || 9999,
      pos:      r ? r.pos : null,
      carIdx:   r ? r.carIdx : null,
    });
  });

  rows.sort((a, b) => (b.total - a.total) || (a.baseRank - b.baseRank));
  rows.forEach((r, i) => { r.rank = i + 1; r.delta = r.baseRank - r.rank; });
  return rows;
}


// If this race's points were already added to the totals (and its session is
// still on screen), take them back out so the live projection isn't counted twice.
function effectiveConfig(cfg, key) {
  const la = cfg && cfg.lastApplied;
  if (!la || !la.live || la.key !== key || !Array.isArray(la.deltas) || !la.deltas.length) return cfg;
  const sub = new Map(la.deltas.map(d => [String(d.number).trim(), Number(d.pts) || 0]));
  return { ...cfg, drivers: (cfg.drivers || []).map(d => {
    const k = String(d.number).trim();
    return sub.has(k) ? { ...d, points: (Number(d.points) || 0) - sub.get(k) } : d;
  }) };
}

// Same source-selection chain the tower/ticker use, so the championship order
// always matches the race order the viewer is looking at.
function pickStandings(d) {
  const state = (d.sessionState || '').toLowerCase();
  if (d.liveStandingsEnabled !== undefined) OFFICIAL_MODE = !d.liveStandingsEnabled;
  else if (d.isOnline !== undefined)        OFFICIAL_MODE = d.isOnline;

  const live = d.liveStandings || d.standings || [];
  if (state === 'cool down') return d.standings || [];
  if (state === 'checkered' && !OFFICIAL_MODE && Array.isArray(d.computedStandings) && d.computedStandings.length)
    return d.computedStandings;
  return OFFICIAL_MODE ? (d.standings || []) : live;
}

const PRE_RACE_STATES = ['get in car', 'warmup', 'parade laps', ''];
function getMode(d, standings) {
  const session = (d.session      || '').toLowerCase();
  const state   = (d.sessionState || '').toLowerCase();
  if (session !== 'race')                 return 'standings';
  if (!standings.length)                  return 'prerace';
  if (PRE_RACE_STATES.includes(state))    return 'prerace';
  if (state === 'checkered' || state === 'cool down') return 'final';
  return 'live';
}
const MODE_LABEL = { live: 'LIVE', final: 'FINAL', prerace: 'PRE-RACE', standings: 'STANDINGS' };



// Stage points earned so far this race, per car number: the bridge's stageWinners (stage, pos, carIdx)
// scored with the Championship window's stage table.
function stagePtsMap(d, cfg) {
  const t = (cfg && Array.isArray(cfg.stagePointsTable)) ? cfg.stagePointsTable : [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const m = {};
  if (!d || String(d.session || '').toLowerCase() !== 'race' || !Array.isArray(d.stageWinners)) return m;
  const srcs = [d.liveStandings, d.standings, d.drivers], done = new Set();
  d.stageWinners.forEach(w => {
    if (!w || !(w.pos >= 1)) return;
    const key = w.stage + ':' + w.pos; if (done.has(key)) return; done.add(key);
    let e = null;
    for (const s of srcs) { if (Array.isArray(s)) { e = s.find(x => x && x.carIdx === w.carIdx); if (e) break; } }
    if (!e) return;
    const k = String(e.number == null ? '' : e.number).trim();
    m[k] = (m[k] || 0) + (Number(t[w.pos - 1]) || 0);
  });
  return m;
}

const api = { normNum, stagePtsMap, computeChampionship, effectiveConfig, pickStandings, getMode };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ChampCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
