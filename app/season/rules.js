// Season scoring rulesets (data only).
//
// The default (and what every season made before the points-system catalog has) reproduces the 2026 NASCAR format as used by
// AutoStages v4: 55 for a win, 35 for 2nd then one less per place (minimum 1), stage points 10..1, +1 fastest lap, and "The Chase"
// (top N after the regular season reset to 2100 / 2075 / 2065 then -5 per seed, no eliminations).
//
// SYSTEMS is the catalog of official points systems (NASCAR Cup / national series, IndyCar, Formula One) by era, from the
// governing bodies' published tables (as listed on Wikipedia's "List of NASCAR / American Championship car racing / Formula One
// points scoring systems", 2026-11). A ruleset is plain JSON - a season keeps a snapshot of its own and the manager can edit it:
//   finish: { table: [pts for 1st, 2nd, ...], beyond: pts past the table }   or the formula { win, second, step, floor }
//   stage: [10, 9 ... 1]          top N of every stage but the last (NASCAR 2017+)
//   fastestLapBonus, fastestLapTopN (0 = anyone; F1 2019-2024: only a top-10 finisher)
//   lapLedBonus, mostLapsLedBonus, poleBonus (+ poleExcept: track regex with no pole bonus - the Indy 500 has its own)
//   doublePoints: { tracks: regex, finale: true/false, multiplier: 2 }   finish points x multiplier (bonuses are not doubled)
//   qualPoints: { tracks: regex, table: [...] }   points by starting position at those tracks (Indy 500 qualifying)
//   dropScores: null | { best: N } | { split: [[first n races, best k], [rest, best k]] }   (F1 until 1990)
//   chase: { enabled, field, resetSeeds, resetStep }
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PSFSeasonRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BASE = {
    system: 'nascar-2026',
    finish: { win: 55, second: 35, step: 1, floor: 1 },
    stage: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    fastestLapBonus: 1, fastestLapTopN: 0,
    lapLedBonus: 0, mostLapsLedBonus: 0, poleBonus: 0, poleExcept: '',
    doublePoints: null, qualPoints: null, dropScores: null,
    chase: { enabled: true, resetSeeds: [2100, 2075, 2065], resetStep: 5 },
    tiebreak: 'nascar',        // points, then wins, then best-finish histogram (F1's countback is the same)
  };

  const SERIES = {
    cup:     { id: 'cup',     name: 'NASCAR Cup Series',                  regularSeasonRaces: 26, chaseRaces: 10, chaseField: 16, family: 'nascar' },
    oaps:    { id: 'oaps',    name: "NASCAR O'Reilly Auto Parts Series",  regularSeasonRaces: 24, chaseRaces: 9,  chaseField: 12, family: 'nascar' },
    truck:   { id: 'truck',   name: 'NASCAR Craftsman Truck Series',      regularSeasonRaces: 18, chaseRaces: 7,  chaseField: 10, family: 'nascar' },
    indycar: { id: 'indycar', name: 'NTT IndyCar Series',                 regularSeasonRaces: 17, chaseRaces: 0,  chaseField: 0,  family: 'indycar' },
    f1:      { id: 'f1',      name: 'Formula One World Championship',     regularSeasonRaces: 24, chaseRaces: 0,  chaseField: 0,  family: 'f1' },
  };

  const range = (a, b, step = -1) => { const o = []; for (let v = a; step < 0 ? v >= b : v <= b; v += step) o.push(v); return o; };
  const fill = (v, n) => new Array(n).fill(v);
  // NASCAR 1975-2003 (Bob Latford): 175, 170 ... -5 to 6th, -4 to 11th, -3 to 43rd (and on, 54 places in the published table)
  const LATFORD = [175, 170, 165, 160, 155, 150, 146, 142, 138, 134, 130].concat(range(127, 28, -3), [25, 20, 15, 10, 8, 6, 4, 2, 1]);
  const NASCAR_2017 = [40].concat(range(35, 2), fill(1, 5));             // 40, 35, 34 ... 2 (35th), 1 for 36th-40th
  const STAGES = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const INDY_2013 = [50, 40, 35, 32, 30, 28, 26, 24, 22, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6].concat(fill(5, 9));
  const INDY_500 = 'indianap|\\bindy';
  const nascarChase = { enabled: true, resetSeeds: [2100, 2075, 2065], resetStep: 5 };
  const noChase = { enabled: false, resetSeeds: [2100, 2075, 2065], resetStep: 5 };
  const fmt = (f) => ({ enabled: true, format: f, resetSeeds: [2100, 2075, 2065], resetStep: 5 });     // a 2004-2025 format (playoffs.js)

  // id -> { family, name, era, rules }  (rules: the scoring part; buildRuleset adds the season structure)
  const SYSTEMS = {};
  const sys = (id, family, name, era, rules, note) => { SYSTEMS[id] = { id, family, name, era, note: note || '', rules }; };

  // ── NASCAR (Cup; the national series used the same tables in these years) ─────────────────────────────────────────
  sys('nascar-1975', 'nascar', 'NASCAR 1975–2003 (Latford)', '1975–2003',
    { finish: { table: LATFORD, beyond: 0 }, stage: [], fastestLapBonus: 0, lapLedBonus: 5, mostLapsLedBonus: 5, chase: noChase },
    'Win 175; +5 for leading a lap, +5 more for leading the most laps.');
  sys('nascar-2004', 'nascar', 'NASCAR 2004–2006', '2004–2006',
    { finish: { table: [180].concat(LATFORD.slice(1)), beyond: 0 }, stage: [], fastestLapBonus: 0, lapLedBonus: 5, mostLapsLedBonus: 5, chase: fmt('2004') },
    'The Latford table with the win raised to 180. The Chase: after 26 races the top 10 and anyone within 400 points of the leader, reset to 5050 for the leader then 5 less per place; 10 races, no cuts.');
  sys('nascar-2007', 'nascar', 'NASCAR 2007–2010', '2007–2010',
    { finish: { table: [185].concat(LATFORD.slice(1)), beyond: 0 }, stage: [], fastestLapBonus: 0, lapLedBonus: 5, mostLapsLedBonus: 5, chase: fmt('2007') },
    'The Latford table with the win raised to 185. The Chase: the top 12 after 26 races, reset to 5000 + 10 per win; 10 races, no cuts.');
  sys('nascar-2011', 'nascar', 'NASCAR 2011–2013', '2011–2013',
    { finish: { table: [46].concat(range(42, 1)), beyond: 0 }, stage: [], fastestLapBonus: 0, lapLedBonus: 1, mostLapsLedBonus: 1, chase: fmt('2011') },
    '43 for 1st down to 1 for 43rd, +3 for the win; +1 for leading a lap, +1 for leading the most laps. The Chase: the top 10 + 2 wild cards (11th-20th with the most wins), reset to 2000 + 3 per win (wild cards 2000); 10 races, no cuts.');
  sys('nascar-2014', 'nascar', 'NASCAR 2014–2015', '2014–2015',
    { finish: { table: [46].concat(range(42, 1)), beyond: 0 }, stage: [], fastestLapBonus: 0, lapLedBonus: 1, mostLapsLedBonus: 1, chase: fmt('2014') },
    'The 2011 table. The Chase with eliminations: 16 (winners in the top 30, then points), reset to 2000 + 3 per win; cut to 12, 8 and 4 after 3, 6 and 9 races (a win advances), reset 3000 / 4000 / 5000; the best finisher of the final four in the last race is champion.');
  sys('nascar-2016', 'nascar', 'NASCAR 2016', '2016',
    { finish: { table: [43].concat(range(39, 1)), beyond: 0 }, stage: [], fastestLapBonus: 0, lapLedBonus: 1, mostLapsLedBonus: 1, chase: fmt('2014') },
    '40 for 1st down to 1 for 40th, +3 for the win; +1 for leading a lap, +1 for leading the most laps. The 2014 Chase with eliminations.');
  sys('nascar-2017', 'nascar', 'NASCAR 2017–2024 (stages)', '2017–2024',
    { finish: { table: NASCAR_2017, beyond: 1 }, stage: STAGES, fastestLapBonus: 0, chase: fmt('2017') },
    'Win 40, 2nd 35 then one less per place, 1 for 36th-40th; stage points 10-1. The playoffs: 16 (winners, then points), 2000 + playoff points (5 a win, 1 a stage win, regular-season top 10 15-10-8...), cut to 12 / 8 / 4 after 3 / 6 / 9 races, reset 3000 / 4000 + playoff points, 5000 for the final four; the best finisher of the four in the last race is champion.');
  sys('nascar-2025', 'nascar', 'NASCAR 2025', '2025',
    { finish: { table: NASCAR_2017, beyond: 1 }, stage: STAGES, fastestLapBonus: 1, chase: fmt('2017') },
    'As 2017-2024 (with the playoffs), plus 1 point for the fastest lap.');
  sys('nascar-2026', 'nascar', 'NASCAR 2026 (The Chase)', '2026–',
    { finish: { win: 55, second: 35, step: 1, floor: 1 }, stage: STAGES, fastestLapBonus: 1, chase: nascarChase },
    'Win 55, 2nd 35 then one less per place; stage points 10-1; +1 fastest lap; the Chase: top N reset to 2100 / 2075 / 2065, -5 per seed, no eliminations.');

  // ── IndyCar Series (IRL / IndyCar) ───────────────────────────────────────────────────────────────────────────────
  sys('indycar-1996', 'indycar', 'IRL 1996–1997', '1996–1997',
    { finish: { table: [35, 33].concat(range(32, 1), [1]), beyond: 0 }, stage: [], fastestLapBonus: 0, mostLapsLedBonus: 1, poleBonus: 2, chase: noChase },
    '35, 33, 32 ... 1; +1 most laps led, +2 pole (the 1997 bonuses).');
  sys('indycar-1998', 'indycar', 'IRL 1998–2000', '1998–2000',
    { finish: { table: [50, 40, 35, 32, 30, 28, 26, 24, 22, 20].concat(range(19, 1), fill(1, 4)), beyond: 0 }, stage: [], fastestLapBonus: 0, mostLapsLedBonus: 2, poleBonus: 3, chase: noChase },
    '50, 40, 35, 32, 30 ... 1; +2 most laps led, +3 pole (the published table gives 3 / 2 / 1 for the top three qualifiers; the pole is used).');
  sys('indycar-2001', 'indycar', 'IRL 2001–2003', '2001–2003',
    { finish: { table: [50, 40, 35, 32, 30, 28, 26, 24, 22, 20].concat(range(19, 1), fill(1, 4)), beyond: 0 }, stage: [], fastestLapBonus: 0, mostLapsLedBonus: 2, chase: noChase },
    '50, 40, 35, 32, 30 ... 1; +2 most laps led.');
  sys('indycar-2004', 'indycar', 'IndyCar 2004–2008', '2004–2008',
    { finish: { table: [50, 40, 35, 32, 30, 28, 26, 24, 22, 20, 19, 18, 17, 16, 15, 14, 13].concat(fill(12, 7), fill(10, 9)), beyond: 10 }, stage: [], fastestLapBonus: 0, mostLapsLedBonus: 3, chase: noChase },
    '50, 40, 35 ... 13 (17th), 12 for 18th-24th, 10 for 25th-33rd; +3 most laps led.');
  sys('indycar-2009', 'indycar', 'IndyCar 2009–2012', '2009–2012',
    { finish: { table: [50, 40, 35, 32, 30, 28, 26, 24, 22, 20, 19, 18, 17, 16, 15, 14, 13].concat(fill(12, 7), fill(10, 9)), beyond: 10 }, stage: [], fastestLapBonus: 0, mostLapsLedBonus: 2, poleBonus: 1, poleExcept: INDY_500,
      qualPoints: { tracks: INDY_500, table: [15, 13, 12, 11, 10, 9, 8, 7, 6].concat(fill(4, 15), fill(3, 9)) }, chase: noChase },
    '+2 most laps led, +1 pole; Indy 500 qualifying points (2010-2013 table) by starting position.');
  sys('indycar-2013', 'indycar', 'IndyCar 2013', '2013',
    { finish: { table: INDY_2013, beyond: 5 }, stage: [], fastestLapBonus: 0, lapLedBonus: 1, mostLapsLedBonus: 2, poleBonus: 1, poleExcept: INDY_500,
      qualPoints: { tracks: INDY_500, table: [15, 13, 12, 11, 10, 9, 8, 7, 6].concat(fill(4, 15), fill(3, 9)) }, chase: noChase },
    'The current table (50, 40, 35 ... 6, then 5 for 25th-33rd); +1 lap led, +2 most laps led, +1 pole; Indy 500 qualifying points.');
  sys('indycar-2014', 'indycar', 'IndyCar 2014', '2014',
    { finish: { table: INDY_2013, beyond: 5 }, stage: [], fastestLapBonus: 0, lapLedBonus: 1, mostLapsLedBonus: 2, poleBonus: 1, poleExcept: INDY_500,
      doublePoints: { tracks: INDY_500 + '|pocono|fontana|california|auto ?club', finale: false, multiplier: 2 },
      qualPoints: { tracks: INDY_500, table: [42, 40, 38, 36, 34, 32, 30, 28, 26].concat(range(24, 1)) }, chase: noChase },
    'Double points for the 500-mile races (Indianapolis, Pocono, Fontana); Indy 500 qualifying points (Saturday 33-1 plus the Fast Nine 9-1).');
  sys('indycar-2015', 'indycar', 'IndyCar 2015–2019', '2015–2019',
    { finish: { table: INDY_2013, beyond: 5 }, stage: [], fastestLapBonus: 0, lapLedBonus: 1, mostLapsLedBonus: 2, poleBonus: 1, poleExcept: INDY_500,
      doublePoints: { tracks: INDY_500, finale: true, multiplier: 2 },
      qualPoints: { tracks: INDY_500, table: [42, 40, 38, 36, 34, 32, 30, 28, 26].concat(range(24, 1)) }, chase: noChase },
    'Double points at the Indy 500 and the season finale; Indy 500 qualifying points (the 2016-2017 combined table: 42, 40, 38 ... 1; 2015 had none, 2018-2019 used 9-1 for the Fast Nine).');
  sys('indycar-2020', 'indycar', 'IndyCar 2020–2021', '2020–2021',
    { finish: { table: INDY_2013, beyond: 5 }, stage: [], fastestLapBonus: 0, lapLedBonus: 1, mostLapsLedBonus: 2, poleBonus: 1, poleExcept: INDY_500,
      doublePoints: { tracks: INDY_500, finale: false, multiplier: 2 },
      qualPoints: { tracks: INDY_500, table: [9, 8, 7, 6, 5, 4, 3, 2, 1] }, chase: noChase },
    'Double points at the Indy 500; Indy 500 qualifying points 9-1 for the Fast Nine.');
  sys('indycar-2022', 'indycar', 'IndyCar 2022', '2022',
    { finish: { table: INDY_2013, beyond: 5 }, stage: [], fastestLapBonus: 0, lapLedBonus: 1, mostLapsLedBonus: 2, poleBonus: 1, poleExcept: INDY_500,
      doublePoints: { tracks: INDY_500, finale: false, multiplier: 2 },
      qualPoints: { tracks: INDY_500, table: range(12, 1) }, chase: noChase },
    'Double points at the Indy 500; Indy 500 qualifying points 12-1 for the top twelve.');
  sys('indycar-2023', 'indycar', 'IndyCar 2023– (current)', '2023–',
    { finish: { table: INDY_2013, beyond: 5 }, stage: [], fastestLapBonus: 0, lapLedBonus: 1, mostLapsLedBonus: 2, poleBonus: 1, poleExcept: INDY_500,
      qualPoints: { tracks: INDY_500, table: range(12, 1) }, chase: noChase },
    '50, 40, 35, 32, 30, 28, 26, 24, 22, 20 ... 6, then 5 for 25th-33rd; +1 lap led, +2 most laps led, +1 pole (not at Indianapolis); Indy 500 qualifying points 12-1; no double points.');

  // ── Formula One ──────────────────────────────────────────────────────────────────────────────────────────────────
  const F1_50 = [8, 6, 4, 3, 2], F1_60 = [8, 6, 4, 3, 2, 1], F1_61 = [9, 6, 4, 3, 2, 1], F1_91 = [10, 6, 4, 3, 2, 1], F1_03 = [10, 8, 6, 5, 4, 3, 2, 1];
  const F1_10 = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
  const f1 = (table, extra) => Object.assign({ finish: { table, beyond: 0 }, stage: [], fastestLapBonus: 0, chase: noChase }, extra || {});
  const split = (a, b, c, d) => ({ split: [[a, b], [c, d]] });
  sys('f1-1950', 'f1', 'F1 1950–1953', '1950–1953', f1(F1_50, { fastestLapBonus: 1, dropScores: { best: 4 } }), '8-6-4-3-2, +1 fastest lap (anyone); best 4 results count.');
  sys('f1-1954', 'f1', 'F1 1954–1957', '1954–1957', f1(F1_50, { fastestLapBonus: 1, dropScores: { best: 5 } }), '8-6-4-3-2, +1 fastest lap; best 5 results count.');
  sys('f1-1958', 'f1', 'F1 1958–1959', '1958–1959', f1(F1_50, { fastestLapBonus: 1, dropScores: { best: 6 } }), '8-6-4-3-2, +1 fastest lap; best 6 results count.');
  sys('f1-1960', 'f1', 'F1 1960', '1960', f1(F1_60, { dropScores: { best: 6 } }), '8-6-4-3-2-1; best 6 results count.');
  sys('f1-1961', 'f1', 'F1 1961–1962', '1961–1962', f1(F1_61, { dropScores: { best: 5 } }), '9-6-4-3-2-1; best 5 results count.');
  sys('f1-1963', 'f1', 'F1 1963–1965', '1963–1965', f1(F1_61, { dropScores: { best: 6 } }), '9-6-4-3-2-1; best 6 results count.');
  sys('f1-1966', 'f1', 'F1 1966', '1966', f1(F1_61, { dropScores: { best: 5 } }), '9-6-4-3-2-1; best 5 results count.');
  sys('f1-1967', 'f1', 'F1 1967, 1969, 1971', '1967 / 1969 / 1971', f1(F1_61, { dropScores: split(6, 5, 5, 4) }), '9-6-4-3-2-1; best 5 of the first 6 and best 4 of the last 5.');
  sys('f1-1968', 'f1', 'F1 1968, 1972', '1968 / 1972', f1(F1_61, { dropScores: split(6, 5, 6, 5) }), '9-6-4-3-2-1; best 5 of each half (6 + 6).');
  sys('f1-1970', 'f1', 'F1 1970', '1970', f1(F1_61, { dropScores: split(7, 6, 6, 5) }), '9-6-4-3-2-1; best 6 of the first 7, best 5 of the last 6.');
  sys('f1-1973', 'f1', 'F1 1973–1974', '1973–1974', f1(F1_61, { dropScores: split(8, 7, 7, 6) }), '9-6-4-3-2-1; best 7 of the first 8, best 6 of the last 7.');
  sys('f1-1975', 'f1', 'F1 1975', '1975', f1(F1_61, { dropScores: split(7, 6, 7, 6) }), '9-6-4-3-2-1; best 6 of each half (7 + 7).');
  sys('f1-1976', 'f1', 'F1 1976, 1978', '1976 / 1978', f1(F1_61, { dropScores: split(8, 7, 8, 7) }), '9-6-4-3-2-1; best 7 of each half (8 + 8).');
  sys('f1-1977', 'f1', 'F1 1977', '1977', f1(F1_61, { dropScores: split(9, 8, 8, 7) }), '9-6-4-3-2-1; best 8 of the first 9, best 7 of the last 8.');
  sys('f1-1979', 'f1', 'F1 1979', '1979', f1(F1_61, { dropScores: split(7, 4, 8, 4) }), '9-6-4-3-2-1; best 4 of the first 7, best 4 of the last 8.');
  sys('f1-1980', 'f1', 'F1 1980', '1980', f1(F1_61, { dropScores: split(7, 5, 7, 5) }), '9-6-4-3-2-1; best 5 of each half (7 + 7).');
  sys('f1-1981', 'f1', 'F1 1981–1990', '1981–1990', f1(F1_61, { dropScores: { best: 11 } }), '9-6-4-3-2-1; best 11 results count.');
  sys('f1-1991', 'f1', 'F1 1991–2002', '1991–2002', f1(F1_91), '10-6-4-3-2-1; every result counts.');
  sys('f1-2003', 'f1', 'F1 2003–2009', '2003–2009', f1(F1_03), '10-8-6-5-4-3-2-1.');
  sys('f1-2010', 'f1', 'F1 2010–2018', '2010–2018', f1(F1_10), '25-18-15-12-10-8-6-4-2-1.');
  sys('f1-2014', 'f1', 'F1 2014 (double-points finale)', '2014', f1(F1_10, { doublePoints: { tracks: '', finale: true, multiplier: 2 } }), '25-18-15-12-10-8-6-4-2-1; double points at the last race.');
  sys('f1-2019', 'f1', 'F1 2019–2024', '2019–2024', f1(F1_10, { fastestLapBonus: 1, fastestLapTopN: 10 }), '25-18-15-12-10-8-6-4-2-1, +1 fastest lap for a top-10 finisher.');
  sys('f1-2025', 'f1', 'F1 2025– (current)', '2025–', f1(F1_10), '25-18-15-12-10-8-6-4-2-1; no fastest-lap point.');

  const DEFAULT_SYSTEM = { nascar: 'nascar-2026', indycar: 'indycar-2023', f1: 'f1-2025' };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // seriesId: the season structure (cup / oaps / truck / indycar / f1); systemId: the points system (default: the series' current one)
  function buildRuleset(seriesId, systemId) {
    const s = SERIES[seriesId] || SERIES.cup;
    const sy = SYSTEMS[systemId] || SYSTEMS[DEFAULT_SYSTEM[s.family]] || SYSTEMS['nascar-2026'];
    const r = Object.assign(clone(BASE), clone(sy.rules));
    r.chase = Object.assign(clone(BASE.chase), clone(sy.rules.chase || BASE.chase));
    r.system = sy.id;
    r.id = sy.id + '-' + s.id;
    r.name = s.name + ' (' + sy.name + ')';
    r.series = s.id;
    r.regularSeasonRaces = s.regularSeasonRaces;
    r.chaseRaces = r.chase.enabled ? s.chaseRaces : 0;
    r.chase.field = s.chaseField;
    if (!r.chase.field) r.chase.enabled = false;
    return r;
  }

  // Fill in anything a user-edited (or older) ruleset left out. A ruleset from before the catalog keeps its own values: the new keys
  // default to "off" (no lap-led / pole bonus, no double / qualifying points, every result counts).
  function normalizeRuleset(r) {
    const series = (r && r.series) || 'cup';
    const base = buildRuleset(series, (r && r.system) || DEFAULT_SYSTEM[(SERIES[series] || SERIES.cup).family]);
    const out = Object.assign({}, base, r || {});
    const fin = (r && r.finish) || {};
    out.finish = Array.isArray(fin.table) ? { table: fin.table.slice(), beyond: Number(fin.beyond) || 0 } : Object.assign({}, base.finish.table ? { win: 55, second: 35, step: 1, floor: 1 } : base.finish, fin);
    out.chase = Object.assign({}, base.chase, (r && r.chase) || {});
    if (!Array.isArray(out.stage)) out.stage = base.stage.slice();
    if (!Array.isArray(out.chase.resetSeeds) || !out.chase.resetSeeds.length) out.chase.resetSeeds = BASE.chase.resetSeeds.slice();
    for (const k of ['fastestLapTopN', 'lapLedBonus', 'mostLapsLedBonus', 'poleBonus']) out[k] = Number(out[k]) || 0;
    out.poleExcept = String(out.poleExcept || '');
    if (r && !('system' in r)) { out.lapLedBonus = r.lapLedBonus || 0; out.mostLapsLedBonus = r.mostLapsLedBonus || 0; out.poleBonus = r.poleBonus || 0; out.doublePoints = r.doublePoints || null; out.qualPoints = r.qualPoints || null; out.dropScores = r.dropScores || null; }
    return out;
  }

  function systemsList() {
    return Object.values(SYSTEMS).map(s => ({ id: s.id, family: s.family, name: s.name, era: s.era, note: s.note }));
  }

  return { SERIES, BASE, SYSTEMS, DEFAULT_SYSTEM, buildRuleset, normalizeRuleset, systemsList };
});
