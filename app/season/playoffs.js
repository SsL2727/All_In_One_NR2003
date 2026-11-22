// NASCAR's Chase / playoff formats 2004-2025 (the 2026 Chase is the engine's own reset-seeds path). rules.chase.format:
//   '2004'  top 10 plus anyone within 400 points of the leader after the regular season; leader 5050, then 5 less per place; no cuts
//   '2007'  top 12; 5000 + 10 per regular-season win; no cuts
//   '2011'  top 10 + 2 wild cards (11th-20th with the most wins); 2000 + 3 per win for the top 10 (wild cards 2000); no cuts
//   '2014'  16 (winners in the top 30 first, then points); 2000 + 3 per win; after 3, 6 and 9 races the field is cut to 12, 8, 4 (a
//           round winner advances; the rest on points), the survivors reset to 3000, 4000, 5000; the best finisher of the final four
//           in the last race is champion. Eliminated drivers keep their points and go on scoring.
//   '2017'  as 2014, with playoff points: 5 per win, 1 per stage win, regular-season top 10 15-10-8-7-6-5-4-3-2-1; added at the
//           start and at the round resets (not the final four); wins and stage wins in the playoffs (drivers still in) add to them.
// The O'Reilly / Truck series use smaller fields (12 / 10) with cuts after 3 and 6 races to 8 and 4.
'use strict';

const FORMATS = ['2004', '2007', '2011', '2014', '2017'];
const ELIM = new Set(['2014', '2017']);
const TOP10_PP = [15, 10, 8, 7, 6, 5, 4, 3, 2, 1];
// elimination structure by series: field, [races into the playoffs at each cut, field after the cut]
const ROUNDS = { cup: { field: 16, cuts: [[3, 12], [6, 8], [9, 4]] }, oaps: { field: 12, cuts: [[3, 8], [6, 4]] }, truck: { field: 10, cuts: [[3, 8], [6, 4]] } };

const isFormat = (f) => FORMATS.includes(String(f));

// ranked: drivers in regular-season order ({ key, wins, stageWins, regPoints }); -> the playoff state
function start(fmt, ranked, rules) {
  const series = ROUNDS[rules.series] || ROUNDS.cup;
  let field = [];
  const start = {}, pp = {};
  if (fmt === '2004') {
    const lead = ranked.length ? ranked[0].regPoints : 0;
    field = ranked.filter((d, i) => i < 10 || lead - d.regPoints <= 400);
    field.forEach((d, i) => { start[d.key] = 5050 - 5 * i; });
  } else if (fmt === '2007') {
    field = ranked.slice(0, 12);
    for (const d of field) start[d.key] = 5000 + 10 * d.wins;
  } else if (fmt === '2011') {
    const top = ranked.slice(0, 10);
    const wild = ranked.slice(10, 20).filter(d => d.wins > 0).sort((a, b) => b.wins - a.wins || ranked.indexOf(a) - ranked.indexOf(b)).slice(0, 2);
    field = top.concat(wild);
    for (const d of top) start[d.key] = 2000 + 3 * d.wins;
    for (const d of wild) start[d.key] = 2000;
  } else {
    const size = Math.min(series.field, ranked.length);
    const winners = ranked.filter((d, i) => d.wins > 0 && (fmt === '2017' || i < 30)).sort((a, b) => b.wins - a.wins || ranked.indexOf(a) - ranked.indexOf(b)).slice(0, size);
    const rest = ranked.filter(d => !winners.includes(d)).slice(0, size - winners.length);
    field = winners.concat(rest).sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
    ranked.forEach((d, i) => { if (fmt === '2017') pp[d.key] = 5 * d.wins + d.stageWins + (TOP10_PP[i] || 0); });
    for (const d of field) start[d.key] = 2000 + (fmt === '2017' ? pp[d.key] : 3 * d.wins);
  }
  const seeds = {};
  field.forEach((d, i) => { seeds[d.key] = { seed: i + 1, start: start[d.key] }; });
  return {
    format: fmt, field: field.map(d => d.key), seeds, base: Object.assign({}, start), since: {}, alive: new Set(field.map(d => d.key)),
    pp, roundWins: new Set(), eliminated: [], cuts: ELIM.has(fmt) ? series.cuts.slice() : [], round: 0, champion: null, finalOrder: null,
  };
}

// after playoff race k (1-based) with its scored entries; last: the final race of the season
function afterRace(ch, entries, k, last) {
  for (const e of entries) ch.since[e.key] = (ch.since[e.key] || 0) + e.total;
  if (!ELIM.has(ch.format)) return;
  for (const e of entries) {
    if (!ch.alive.has(e.key)) continue;
    if (e.finish === 1) ch.roundWins.add(e.key);
    if (ch.format === '2017' && !last && ch.alive.size > 4) ch.pp[e.key] = (ch.pp[e.key] || 0) + (e.finish === 1 ? 5 : 0) + (e.stageWins || 0);
  }
  const cut = ch.cuts.find(c => c[0] === k);
  if (cut) {
    const keep = cut[1];
    const cur = (key) => ch.base[key] + (ch.since[key] || 0);
    const alive = [...ch.alive];
    const winners = alive.filter(key => ch.roundWins.has(key)).slice(0, keep);
    const others = alive.filter(key => !winners.includes(key)).sort((a, b) => cur(b) - cur(a));
    const advance = winners.concat(others.slice(0, keep - winners.length));
    const out = others.slice(keep - winners.length);
    ch.round++;
    for (const key of out) { ch.base[key] = cur(key); ch.since[key] = 0; ch.eliminated.push({ key, round: ch.round }); ch.alive.delete(key); }
    const reset = keep === 4 ? 5000 : 2000 + 1000 * ch.round;           // the final four start level at 5000 in every series
    for (const key of advance) { ch.base[key] = reset + (ch.format === '2017' && keep > 4 ? (ch.pp[key] || 0) : 0); ch.since[key] = 0; }
    ch.roundWins = new Set();
  }
  if (last && ch.alive.size) {
    const fin = new Map(entries.map(e => [e.key, e.finish]));
    ch.finalOrder = [...ch.alive].sort((a, b) => (fin.get(a) || 999) - (fin.get(b) || 999));
    ch.champion = ch.finalOrder[0];
  }
}

const pointsOf = (ch, key) => ch.base[key] + (ch.since[key] || 0);

// the standings order: the final four by their finish in the last race (when it's been run), the drivers still in by points, the
// eliminated by the round they went out in (later first) and points, then everyone else (by fallback order)
function order(ch, all, fallback) {
  const byPts = (a, b) => pointsOf(ch, b.key) - pointsOf(ch, a.key) || fallback(a, b);
  const inField = new Set(ch.field);
  const rest = all.filter(d => !inField.has(d.key)).sort(fallback);
  if (!ELIM.has(ch.format)) return all.filter(d => inField.has(d.key)).sort(byPts).concat(rest);
  const final = ch.finalOrder ? ch.finalOrder.map(k => all.find(d => d.key === k)).filter(Boolean) : [];
  const alive = all.filter(d => ch.alive.has(d.key) && !final.includes(d)).sort(byPts);
  const roundOf = new Map(ch.eliminated.map(x => [x.key, x.round]));
  const out = all.filter(d => roundOf.has(d.key)).sort((a, b) => roundOf.get(b.key) - roundOf.get(a.key) || byPts(a, b));
  return final.concat(alive, out, rest);
}

module.exports = { FORMATS, ROUNDS, TOP10_PP, isFormat, start, afterRace, pointsOf, order };
