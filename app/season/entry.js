// Guaranteed starters for season races: the old NASCAR rule that the top 35 in owner points are locked into the race (the count can be
// changed), and chartered cars (a list of car numbers for the whole season, or for one scheduled race) that start every race.
//
// Two places make the guarantee real:
//   - the roster NR2003 draws its AI field from (field/service.js): every guaranteed car stays in the pool and the pool is cut down to the
//     number of AI cars the race takes (NumAI, and the track's max_starters), the other places drawn at random as the game does. When the
//     track takes fewer cars than there are chartered cars, the pool is the chartered cars only and the game picks from them as usual;
//   - RaceControl's qualifying field cut (racecontrol/qualifying.js ApplyCut): a guaranteed car is never cut; the other places go to the
//     fastest of the rest. When more cars are guaranteed than there are places, the fastest of the guaranteed cars make it.
//
// Car numbers are compared the way the season's owner standings key them: a number by its value ("01" = "1"), anything else as written.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PSFSeasonEntry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_TOP = 35;

  function normNum(n) {
    const s = String(n == null ? '' : n).trim();
    if (!s) return '';
    return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s.toUpperCase();
  }
  // "1, 2 3;24" -> ['1', '2', '3', '24'] (normalized, no repeats, order kept)
  function parseNums(v) {
    const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;/]+/);
    const out = [];
    for (const x of list) { const n = normNum(x); if (n && !out.includes(n)) out.push(n); }
    return out;
  }

  // the season's settings: { lockTop, topN, charters: [nums] }
  function entryOf(season) {
    const e = (season && season.entry) || {};
    const topN = parseInt(e.topN, 10);
    return { lockTop: !!e.lockTop, topN: topN >= 1 ? Math.min(topN, 200) : DEFAULT_TOP, charters: parseNums(e.charters || []) };
  }

  // who is guaranteed for a race. event: the scheduled race (its own charters, when it has any, are used instead of the season's);
  // standings: Engine.computeSeason of the races run so far (null / no races: nobody is locked in on owner points yet)
  // -> { nums: [..], charters: [..], top: [..], topN, raceCharters: bool, any: bool }
  function guaranteed(season, event, standings) {
    const e = entryOf(season);
    const own = event ? parseNums(event.charters || []) : [];
    const charters = own.length ? own : e.charters;
    let top = [];
    if (e.lockTop && standings && Array.isArray(standings.owners) && (standings.racesRun || 0) > 0) {
      top = standings.owners.filter(o => o && o.key && o.key !== 'NaN').slice(0, e.topN).map(o => normNum(o.key));
    }
    const nums = [];
    for (const n of charters.concat(top)) if (!nums.includes(n)) nums.push(n);
    return { nums, charters, top, topN: e.topN, lockTop: e.lockTop, raceCharters: own.length > 0, any: nums.length > 0 };
  }

  // the roster: entries = parseLst(...).entries; numOf(file) -> car number | '' ; opts = { guaranteed: [nums], slots, rnd, skipNum }
  //   slots: AI cars the race takes; skipNum: your own car number (you always start; it takes no AI place)
  // -> { entries (new), report: { slots, pool, locked: [nums in the pool], missing: [guaranteed nums not in the roster], chartersOnly, dropped } }
  function planRoster(entries, numOf, opts) {
    const rnd = opts.rnd || Math.random, slots = Math.max(0, opts.slots | 0);
    const want = new Set(parseNums(opts.guaranteed || []));
    const skip = normNum(opts.skipNum);
    if (skip) want.delete(skip);
    const out = entries.map(e => Object.assign({}, e));
    const on = [], locked = [], others = [];
    out.forEach((e, i) => {
      if (e.file === undefined || !e.enabled) return;
      on.push(i);
      (want.has(normNum(numOf(e.file))) ? locked : others).push(i);
    });
    const seen = new Set(locked.map(i => normNum(numOf(out[i].file))));
    const report = { slots, pool: on.length, locked: [...seen], missing: [...want].filter(n => !seen.has(n)), chartersOnly: false, dropped: 0 };
    if (!slots || on.length <= slots || !locked.length) return { entries: out, report };     // everyone fits (or nothing to guarantee)
    let keep;
    if (locked.length >= slots) {
      keep = new Set(locked);                       // more guaranteed cars than places: the game picks among them only
      report.chartersOnly = true;
    } else {
      const pool = others.slice();
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      keep = new Set(locked.concat(pool.slice(0, slots - locked.length)));
    }
    for (const i of on) if (!keep.has(i)) { out[i].enabled = false; report.dropped++; }
    report.pool = on.length - report.dropped;
    return { entries: out, report };
  }

  // the qualifying cut: order = cars by qualifying result (best first), num(car) -> car number, cut = places, guaranteed = [nums]
  // -> { make: [cars], dnq: [cars], locked: [cars that made it on a guarantee only] }
  function cut(order, num, places, guaranteedNums) {
    const want = new Set(parseNums(guaranteedNums || []));
    if (!want.size || places >= order.length) return { make: order.slice(0, places), dnq: order.slice(places), locked: [] };
    const g = order.filter(c => want.has(normNum(num(c))));
    let make;
    if (g.length >= places) make = g.slice(0, places);                    // more guaranteed than places: the fastest of them
    else {
      const rest = order.filter(c => !want.has(normNum(num(c))));
      make = g.concat(rest.slice(0, places - g.length));
    }
    const inSet = new Set(make);
    const byPace = new Set(order.slice(0, places));
    return { make: order.filter(c => inSet.has(c)), dnq: order.filter(c => !inSet.has(c)), locked: order.filter(c => inSet.has(c) && !byPace.has(c)) };
  }

  // the track's max_starters (tracks\<dir>\track.ini); 43 when it can't be read
  function maxStarters(iniText) {
    const m = /^\s*max_starters\s*=\s*(\d+)/im.exec(String(iniText || ''));
    const n = m ? parseInt(m[1], 10) : NaN;
    return n >= 1 && n <= 43 ? n : 43;
  }

  return { DEFAULT_TOP, normNum, parseNums, entryOf, guaranteed, planRoster, cut, maxStarters };
});
