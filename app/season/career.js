// Careers across every season (merged drivers included): totals, championships, records, and two drivers head to head.
'use strict';
const Engine = require('./engine');

const add = (o, k, v) => { o[k] = (o[k] || 0) + (Number(v) || 0); };

// store: SeasonStore. -> { drivers: [...], records: [...], seasons: n }
function career(store) {
  const list = store.list();
  const drivers = {};
  const best = {};          // record name -> { value, name, season }
  const rec = (what, value, d, season, lowerIsBetter) => {
    if (value == null || !Number.isFinite(value)) return;
    const b = best[what];
    if (!b || (lowerIsBetter ? value < b.value : value > b.value)) best[what] = { what, value, name: d.name, season };
  };
  for (const meta of list) {
    const s = store.get(meta.id);
    if (!s) continue;
    let st; try { st = Engine.computeSeason(s); } catch (e) { continue; }
    for (const r of st.rows) {
      const c = drivers[r.key] || (drivers[r.key] = { key: r.key, name: r.name, seasons: 0, titles: 0, races: 0, wins: 0, top5s: 0, top10s: 0, poles: 0, lapsLed: 0, stageWins: 0, dnfs: 0, finishSum: 0, bestRank: 0, numbers: new Set(), seasonList: [] });
      c.name = r.name; c.seasons++; if (r.number) c.numbers.add(String(r.number));
      for (const k of ['races', 'wins', 'top5s', 'top10s', 'poles', 'lapsLed', 'stageWins', 'dnfs']) add(c, k, r[k]);
      c.finishSum += (r.afp || 0) * (r.races || 0);
      c.bestRank = c.bestRank ? Math.min(c.bestRank, r.rank) : r.rank;
      const champion = st.champion && st.champion.key === r.key;
      if (champion) c.titles++;
      c.seasonList.push({ season: s.name, rank: r.rank, points: r.points, wins: r.wins, races: r.races, champion: !!champion, complete: st.phase === 'complete' });
      rec('Most wins in a season', r.wins, r, s.name);
      rec('Most poles in a season', r.poles, r, s.name);
      rec('Most laps led in a season', r.lapsLed, r, s.name);
      rec('Most top 5s in a season', r.top5s, r, s.name);
      if (r.races >= 5) rec('Best average finish in a season (5+ races)', r.afp, r, s.name, true);
      if (r.races >= 5 && r.avgRun != null) rec('Best average running position in a season (5+ races)', r.avgRun, r, s.name, true);
    }
  }
  const out = Object.values(drivers).map(c => Object.assign({}, c, { numbers: [...c.numbers], afp: c.races ? Math.round(c.finishSum / c.races * 10) / 10 : 0,
    winPct: c.races ? Math.round(c.wins / c.races * 1000) / 10 : 0 })).map(c => { delete c.finishSum; return c; })
    .sort((a, b) => b.titles - a.titles || b.wins - a.wins || b.top5s - a.top5s || a.name.localeCompare(b.name));
  for (const c of out) { rec('Most career wins', c.wins, c, ''); rec('Most championships', c.titles, c, ''); rec('Most career starts', c.races, c, ''); rec('Most career laps led', c.lapsLed, c, ''); }
  return { drivers: out, records: Object.values(best).filter(r => r.value > 0 || /average/.test(r.what)), seasons: list.length };
}

// every race (all seasons) both drivers ran: who finished ahead, wins, average finish
function headToHead(store, a, b) {
  const ka = Engine.keyOf(a), kb = Engine.keyOf(b);
  const out = { a: { key: ka, name: a, ahead: 0, wins: 0, finishSum: 0, lapsLed: 0 }, b: { key: kb, name: b, ahead: 0, wins: 0, finishSum: 0, lapsLed: 0 }, races: 0, list: [] };
  for (const meta of store.list()) {
    const s = store.get(meta.id);
    if (!s) continue;
    for (const raw of s.races || []) {
      const race = Engine.applyAliases(raw, s.aliases);
      const ea = race.entries.find(e => (e.key || Engine.keyOf(e.name)) === ka), eb = race.entries.find(e => (e.key || Engine.keyOf(e.name)) === kb);
      if (!ea || !eb) continue;
      out.races++;
      out.a.name = ea.name; out.b.name = eb.name;
      for (const [x, e, o] of [[out.a, ea, eb], [out.b, eb, ea]]) { if (e.finish < o.finish) x.ahead++; if (e.finish === 1) x.wins++; x.finishSum += e.finish; x.lapsLed += e.ledLaps || 0; }
      out.list.push({ season: s.name, track: race.track, date: race.date, a: ea.finish, b: eb.finish });
    }
  }
  for (const x of [out.a, out.b]) { x.afp = out.races ? Math.round(x.finishSum / out.races * 10) / 10 : null; delete x.finishSum; }
  return out;
}

module.exports = { career, headToHead };
