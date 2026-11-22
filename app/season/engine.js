// Season scoring engine — pure functions, no I/O. Used by the main process
// (persistence/HTTP) and, being UMD, loadable in a browser for tests.
//
// A season stores RAW race data (finish order, stage orders, fastest-lap car,
// laps led). Points are always derived from the season's ruleset, so editing the
// ruleset, deleting a race or re-importing one simply recomputes everything.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules'), require('./playoffs'));
  else root.PSFSeasonEngine = factory(root.PSFSeasonRules, root.PSFSeasonPlayoffs || { isFormat: () => false });
})(typeof self !== 'undefined' ? self : this, function (Rules, Playoffs) {
  'use strict';

  // ── Names ────────────────────────────────────────────────────────────────
  function normName(n) {
    return String(n == null ? '' : n)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')   // AutoStages pads names with NULs
      .replace(/\s+/g, ' ')
      .replace(/\s*[-–]\s*R$/i, '')   // "Zilisch - R" rookie suffix
      .replace(/\s*\(R\)$/i, '')
      .trim();
  }
  function keyOf(name) { return normName(name).toLowerCase(); }

  // ── Point tables ─────────────────────────────────────────────────────────
  function finishPoints(pos, rules) {
    if (!(pos >= 1)) return 0;
    const f = rules.finish;
    if (Array.isArray(f.table)) return pos <= f.table.length ? (Number(f.table[pos - 1]) || 0) : (Number(f.beyond) || 0);
    if (pos === 1) return f.win;
    return Math.max(f.floor, f.second - (pos - 2) * f.step);
  }
  const trackMatch = (re, race) => {
    if (!re) return false;
    try { return new RegExp(re, 'i').test(String(race.track || '') + ' ' + String(race.trackShort || '')); } catch (e) { return false; }
  };
  // the finish-points multiplier of a race: the race's own (set in the Races tab), else the ruleset's double-points races
  function raceMultiplier(race, rules, ctx) {
    if (race.pointsMultiplier != null && race.pointsMultiplier !== '' && Number.isFinite(Number(race.pointsMultiplier))) return Number(race.pointsMultiplier);
    const dp = rules.doublePoints;
    if (!dp) return 1;
    const finale = dp.finale && ctx && ctx.raceNo > 0 && ctx.totalRaces > 0 && ctx.raceNo === ctx.totalRaces;
    return finale || trackMatch(dp.tracks, race) ? (Number(dp.multiplier) || 2) : 1;
  }
  // the counted results under a drop-score rule: { kept: Set of result indexes } (results: [{ i: race order, pts }])
  function keptResults(results, drop) {
    const all = new Set(results.map((r, k) => k));
    if (!drop) return all;
    const best = (list, n) => list.slice().sort((a, b) => b.r.pts - a.r.pts || a.r.i - b.r.i).slice(0, Math.max(0, n)).map(x => x.k);
    const indexed = results.map((r, k) => ({ r, k }));
    if (drop.best > 0) return new Set(best(indexed, drop.best));
    if (Array.isArray(drop.split) && drop.split.length) {
      const out = new Set();
      let from = 0;
      drop.split.forEach(([n, k], si) => {
        const last = si === drop.split.length - 1;
        const part = indexed.filter(x => x.r.i >= from && (last || x.r.i < from + n));
        for (const kk of best(part, k)) out.add(kk);
        from += n;
      });
      return out;
    }
    return all;
  }
  function stagePoints(pos, rules) {
    return (pos >= 1 && rules.stage[pos - 1]) || 0;
  }
  function chaseSeedPoints(seed, rules) {
    const seeds = rules.chase.resetSeeds;
    if (seed <= seeds.length) return seeds[seed - 1];
    return seeds[seeds.length - 1] - (seed - seeds.length) * rules.chase.resetStep;
  }

  // ── Scoring one race ─────────────────────────────────────────────────────
  // race: { entries:[{key,name,number,finish?,status?,ledLaps?,gfp?,qp?,incidents?}],
  //         stages:[{stage, order:[{key}|key,...]}], fastestKey? }
  // returns entries enriched with finishPts/stagePts/total, in finishing order.
  // ctx: { raceNo, totalRaces } (for a double-points finale)
  function scoreRace(race, rules, ctx) {
    const entries = (race.entries || []).map((e, i) => Object.assign({}, e, {
      key: e.key || keyOf(e.name),
      finish: e.finish > 0 ? e.finish : i + 1,
    }));
    entries.sort((a, b) => a.finish - b.finish);

    const stageResults = (race.stages || []).map(st => ({
      stage: st.stage,
      order: (st.order || []).map((o, idx) => {
        const key = typeof o === 'string' ? o : (o.key || keyOf(o.name));
        const pos = (typeof o === 'object' && o.pos > 0) ? o.pos : idx + 1;
        return { key, pos, pts: stagePoints(pos, rules) };
      }).sort((a, b) => a.pos - b.pos),
    }));

    const stagePtsByKey = {};
    const stageWinsByKey = {};
    for (const sr of stageResults) {
      for (const o of sr.order) {
        stagePtsByKey[o.key] = (stagePtsByKey[o.key] || 0) + o.pts;
        if (o.pos === 1) stageWinsByKey[o.key] = (stageWinsByKey[o.key] || 0) + 1;
      }
    }

    const mult = raceMultiplier(race, rules, ctx);
    const mostLed = entries.reduce((m, e) => Math.max(m, e.ledLaps || 0), 0);
    const poleOk = rules.poleBonus && !trackMatch(rules.poleExcept, race);
    const qual = rules.qualPoints && trackMatch(rules.qualPoints.tracks, race) ? rules.qualPoints.table || [] : null;
    const stageTop10ByKey = {};
    for (const sr of stageResults) for (const o of sr.order) if (o.pos <= 10) stageTop10ByKey[o.key] = (stageTop10ByKey[o.key] || 0) + 1;
    const scored = entries.map(e => {
      const finishPts = finishPoints(e.finish, rules) * mult;
      const stagePts = stagePtsByKey[e.key] || 0;
      const fastest = !!(race.fastestKey && race.fastestKey === e.key);
      const fastestPts = fastest && (!rules.fastestLapTopN || e.finish <= rules.fastestLapTopN) ? (rules.fastestLapBonus || 0) : 0;
      const ledPts = (e.ledLaps || 0) > 0 ? (rules.lapLedBonus || 0) : 0;
      const mostLedPts = mostLed > 0 && (e.ledLaps || 0) === mostLed ? (rules.mostLapsLedBonus || 0) : 0;
      const polePts = poleOk && e.startPos === 1 ? rules.poleBonus : 0;
      const qualPts = qual && e.startPos >= 1 ? (Number(qual[e.startPos - 1]) || 0) : 0;
      const bonusPts = fastestPts + ledPts + mostLedPts + polePts + qualPts;
      return Object.assign(e, {
        finishPts, stagePts, fastestPts, ledPts, mostLedPts, polePts, qualPts, bonusPts, multiplier: mult,
        total: finishPts + stagePts + bonusPts,
        stageWins: stageWinsByKey[e.key] || 0,
        stageTop10s: stageTop10ByKey[e.key] || 0,
        mostLed: mostLed > 0 && (e.ledLaps || 0) === mostLed,
        fastest,
      });
    });
    return { entries: scored, stageResults, multiplier: mult };
  }

  // ── Season computation ───────────────────────────────────────────────────
  function newDriver(key, name, number) {
    return {
      key, name, number: number == null ? '' : number,
      points: 0, regPoints: 0, chasePoints: 0,
      races: 0, wins: 0, stageWins: 0, top5s: 0, top10s: 0,
      lapsLed: 0, fastestLaps: 0, gfp: 0, qp: 0, incidents: 0,
      totalPositions: 0, bestFinish: 0, fin: {}, lastFinish: 0, lastPoints: 0,
      // more statistics (races tracked by All In One NR2003: imported races have no start / laps data)
      poles: 0, starts: 0, startSum: 0, runSum: 0, runRaces: 0, dnfs: 0, lapsCompleted: 0, racesLed: 0, mostLed: 0,
      leadLap: 0, leadLapRaces: 0, top15s: 0, top20s: 0, stageTop10s: 0, gained: 0, gainedRaces: 0, worstFinish: 0, bonusPts: 0,
      top15Laps: 0, results: [], dropped: 0, damage: 0, contacts: 0, cautionsCaused: 0, incidentRaces: 0,
    };
  }

  function compareDrivers(a, b, pa, pb) {
    if (pb !== pa) return pb - pa;
    if (b.wins !== a.wins) return b.wins - a.wins;
    for (let p = 1; p <= 43; p++) {
      const d = (b.fin[p] || 0) - (a.fin[p] || 0);
      if (d) return d;
    }
    return a.name.localeCompare(b.name);
  }

  function applyBaseline(drivers, baseline) {
    if (!baseline || !baseline.drivers) return;
    for (const k of Object.keys(baseline.drivers)) {
      const b = baseline.drivers[k];
      const key = keyOf(b.name || k);
      const d = drivers[key] || (drivers[key] = newDriver(key, normName(b.name || k), b.number));
      d.number = b.number != null ? b.number : d.number;
      d.points += b.points || 0;
      d.regPoints += b.points || 0;
      d.races += b.races || 0;
      d.wins += b.wins || 0;
      d.stageWins += b.stageWins || 0;
      d.top5s += b.top5s || 0;
      d.top10s += b.top10s || 0;
      d.lapsLed += b.lapsLed || 0;
      d.fastestLaps += b.fastestLaps || 0;
      d.gfp += b.gfp || 0;
      d.qp += b.qp || 0;
      d.incidents += b.incidents || 0;
      d.totalPositions += b.totalPositions || 0;
    }
  }
  const isDnf = (status) => { const s = String(status == null ? '' : status).toLowerCase(); return !!s && s !== 'running' && s !== 'run' && s !== 'finished'; };

  // merged drivers (a renamed driver): aliases = { old key: { to: new key, name } }; races are mapped on the way in, the stored data
  // is never changed (removing the alias undoes it)
  function applyAliases(race, aliases) {
    if (!aliases || !race || !Object.keys(aliases).length) return race;
    const to = (k) => (aliases[k] ? aliases[k].to : k);
    const out = Object.assign({}, race);
    out.entries = (race.entries || []).map(e => {
      const k = e.key || keyOf(e.name);
      return aliases[k] ? Object.assign({}, e, { key: aliases[k].to, name: aliases[k].name || e.name }) : e;
    });
    out.stages = (race.stages || []).map(st => Object.assign({}, st, { order: (st.order || []).map(o => (typeof o === 'string' ? to(o) : Object.assign({}, o, { key: to(o.key || keyOf(o.name)) }))) }));
    if (race.fastestKey) out.fastestKey = to(race.fastestKey);
    return out;
  }

  // opts.extraRace — an unsaved/live race appended to the season (projection)
  function computeSeason(season, opts) {
    opts = opts || {};
    const rules = Rules.normalizeRuleset(season.ruleset);
    const baseline = season.baseline || null;
    const baseRaces = baseline ? (baseline.racesRun || 0) : 0;
    const aliases = opts.aliases || season.aliases || null;
    const raceList = (season.races || []).map(r => applyAliases(r, aliases));
    if (opts.extraRace) raceList.push(applyAliases(opts.extraRace, aliases));
    const drivers = {};
    applyBaseline(drivers, baseline);
    // the other championships: owners (by car number), manufacturers (each make's best car scores its finish points), teams (F1
    // constructors: the team's cars' points added up), rookies (drivers marked rookie)
    const owners = {}, makes = {}, teams = {}, rookieKeys = new Set();
    const champ = (map, k, label) => map[k] || (map[k] = { key: k, name: label, points: 0, wins: 0, races: 0, top5s: 0, top10s: 0, lapsLed: 0, best: 0, drivers: new Set() });

    const regRaces = rules.regularSeasonRaces;
    const chaseOn = !!rules.chase.enabled && rules.chaseRaces > 0;
    let chase = null;               // { field:[keys], seeds:{key:{seed,start}} }
    let regularRows = null;

    function rankRegular() {
      return Object.values(drivers).sort((a, b) => compareDrivers(a, b, a.regPoints, b.regPoints));
    }

    raceList.forEach((race, i) => {
      const raceNo = baseRaces + i + 1;
      const isChase = chaseOn && raceNo > regRaces;
      if (isChase && !chase) {
        // regular season complete — seed the Chase field from points
        const ranked = rankRegular();
        if (Playoffs.isFormat(rules.chase.format)) {
          chase = Playoffs.start(String(rules.chase.format), ranked, rules);       // 2004-2025 formats (playoffs.js)
          chase.afterRace = regRaces;
        } else {
          const field = ranked.slice(0, rules.chase.field);
          chase = { field: field.map(d => d.key), seeds: {}, afterRace: regRaces };
          field.forEach((d, idx) => {
            chase.seeds[d.key] = { seed: idx + 1, start: chaseSeedPoints(idx + 1, rules) };
          });
        }
        regularRows = ranked.map((d, idx) => ({ rank: idx + 1, key: d.key, name: d.name, number: d.number, points: d.regPoints }));
      }
      const { entries } = scoreRace(race, rules, { raceNo, totalRaces: rules.regularSeasonRaces + (chaseOn ? rules.chaseRaces : 0) });
      const winnerLaps = entries.length ? entries[0].lapsCompleted : undefined;
      for (const e of entries) {
        const d = drivers[e.key] || (drivers[e.key] = newDriver(e.key, normName(e.name), e.number));
        if (e.number != null && e.number !== '') d.number = e.number;
        if (e.name) d.name = normName(e.name);
        d.races += 1;
        d.points += e.total;
        if (isChase) d.chasePoints += e.total; else d.regPoints += e.total;
        d.totalPositions += e.finish;
        d.fin[e.finish] = (d.fin[e.finish] || 0) + 1;
        if (e.finish === 1) d.wins += 1;
        if (e.finish <= 5) d.top5s += 1;
        if (e.finish <= 10) d.top10s += 1;
        d.stageWins += e.stageWins;
        if (e.fastest) d.fastestLaps += 1;
        d.lapsLed += e.ledLaps || 0;
        d.gfp += e.gfp || 0;
        d.qp += e.qp || 0;
        d.incidents += e.incidents || 0;
        d.bestFinish = d.bestFinish ? Math.min(d.bestFinish, e.finish) : e.finish;
        d.worstFinish = Math.max(d.worstFinish, e.finish);
        d.lastFinish = e.finish;
        d.lastPoints = e.total;
        d.results.push({ i, pts: e.total });
        if (e.finish <= 15) d.top15s += 1;
        if (e.finish <= 20) d.top20s += 1;
        d.stageTop10s += e.stageTop10s || 0;
        d.bonusPts += e.bonusPts || 0;
        if ((e.ledLaps || 0) > 0) d.racesLed += 1;
        if (e.mostLed) d.mostLed += 1;
        if (e.startPos >= 1) { d.starts += 1; d.startSum += e.startPos; if (e.startPos === 1) d.poles += 1; d.gained += e.startPos - e.finish; d.gainedRaces += 1; }
        if (e.avgRun > 0) { d.runSum += e.avgRun; d.runRaces += 1; }
        if (e.lapsTop15 > 0) d.top15Laps += e.lapsTop15;
        if (e.damage != null) { d.damage = Math.round((d.damage + (Number(e.damage) || 0)) * 1000) / 1000; d.contacts += e.contacts || 0; d.cautionsCaused += e.cautionsCaused || 0; d.incidentRaces += 1; }
        if (isDnf(e.status)) d.dnfs += 1;
        if (e.lapsCompleted >= 0) {
          d.lapsCompleted += e.lapsCompleted;
          d.leadLapRaces += 1;
          if ((e.lapsDown != null && e.lapsDown <= 0) || (e.lapsDown == null && winnerLaps >= 0 && e.lapsCompleted >= winnerLaps)) d.leadLap += 1;
        }
      }
      if (isChase && chase && chase.format) Playoffs.afterRace(chase, entries, raceNo - regRaces, raceNo === regRaces + rules.chaseRaces);
      // owners / manufacturers / teams / rookies
      const bestOfMake = {}, teamRace = {};
      for (const e of entries) {
        if (e.rookie) rookieKeys.add(e.key);
        const num = String(e.number == null ? '' : e.number).trim();
        if (num) {
          const o = champ(owners, String(parseInt(num, 10)), '#' + num);
          o.points += e.total; o.races++; if (e.finish === 1) o.wins++; if (e.finish <= 5) o.top5s++; if (e.finish <= 10) o.top10s++; o.lapsLed += e.ledLaps || 0;
          o.best = o.best ? Math.min(o.best, e.finish) : e.finish; o.drivers.add(e.name);
        }
        const mk = String(e.make || '').trim();
        if (mk && (!bestOfMake[mk.toLowerCase()] || e.finish < bestOfMake[mk.toLowerCase()].finish)) bestOfMake[mk.toLowerCase()] = e;
        const tm = String(e.team || '').trim();
        if (tm) (teamRace[tm.toLowerCase()] = teamRace[tm.toLowerCase()] || []).push(e);
      }
      for (const [k, e] of Object.entries(bestOfMake)) {
        const m = champ(makes, k, String(e.make).trim());
        m.points += e.finishPts; m.races++; if (e.finish === 1) m.wins++; if (e.finish <= 5) m.top5s++; if (e.finish <= 10) m.top10s++;
        m.best = m.best ? Math.min(m.best, e.finish) : e.finish; m.drivers.add(e.name);
      }
      for (const [k, list] of Object.entries(teamRace)) {
        const t = champ(teams, k, String(list[0].team).trim());
        t.races++;
        for (const e of list) { t.points += e.total; if (e.finish === 1) t.wins++; if (e.finish <= 5) t.top5s++; if (e.finish <= 10) t.top10s++; t.lapsLed += e.ledLaps || 0; t.best = t.best ? Math.min(t.best, e.finish) : e.finish; t.drivers.add(e.name); }
      }
      // drivers who skipped this race have no "last race"
      const ran = new Set(entries.map(e => e.key));
      for (const d of Object.values(drivers)) if (!ran.has(d.key)) { d.lastFinish = 0; d.lastPoints = 0; }
    });

    // ── drop scores (F1 until 1990): only the best results count ──
    if (rules.dropScores && !chase) {
      for (const d of Object.values(drivers)) {
        const keep = keptResults(d.results, rules.dropScores);
        let dropped = 0;
        d.results.forEach((r, k) => { if (!keep.has(k)) dropped += r.pts; });
        d.dropped = dropped;
        d.points -= dropped; d.regPoints -= dropped;
      }
    }
    // ── build standings rows ──
    const all = Object.values(drivers);
    let ordered;
    let pointsOf;
    if (chase && chase.format) {
      const inField = new Set(chase.field);
      pointsOf = d => inField.has(d.key) ? Playoffs.pointsOf(chase, d.key) : d.points;
      ordered = Playoffs.order(chase, all, (a, b) => compareDrivers(a, b, a.points, b.points));
    } else if (chase) {
      const inField = new Set(chase.field);
      pointsOf = d => inField.has(d.key) ? chase.seeds[d.key].start + d.chasePoints : d.points;
      const fieldRows = all.filter(d => inField.has(d.key)).sort((a, b) => compareDrivers(a, b, pointsOf(a), pointsOf(b)));
      const rest = all.filter(d => !inField.has(d.key)).sort((a, b) => compareDrivers(a, b, pointsOf(a), pointsOf(b)));
      ordered = fieldRows.concat(rest);
    } else {
      pointsOf = d => d.points;
      ordered = all.sort((a, b) => compareDrivers(a, b, pointsOf(a), pointsOf(b)));
    }

    const leaderPts = ordered.length ? pointsOf(ordered[0]) : 0;
    const cutIdx = rules.chase.field - 1;
    const cutPoints = !chase && chaseOn && ordered.length > cutIdx ? pointsOf(ordered[cutIdx]) : null;
    const rows = ordered.map((d, idx) => {
      const pts = pointsOf(d);
      const row = {
        rank: idx + 1, key: d.key, name: d.name, number: d.number,
        points: pts, behind: idx === 0 ? 0 : pts - leaderPts,
        behindNext: idx === 0 ? 0 : pts - pointsOf(ordered[idx - 1]),
        seasonPoints: d.points, regularPoints: d.regPoints,
        inChase: chase ? chase.field.includes(d.key) : null,
        seed: chase && chase.seeds[d.key] ? chase.seeds[d.key].seed : null,
        alive: chase && chase.alive ? chase.alive.has(d.key) : null,
        playoffPoints: chase && chase.pp && chase.format === '2017' && chase.field.includes(d.key) ? chase.pp[d.key] || 0 : null,
        races: d.races, wins: d.wins, stageWins: d.stageWins, top5s: d.top5s, top10s: d.top10s,
        lapsLed: d.lapsLed, fastestLaps: d.fastestLaps, gfp: d.gfp, qp: d.qp, incidents: d.incidents,
        afp: d.races ? Math.round((d.totalPositions / d.races) * 10) / 10 : 0,
        bestFinish: d.bestFinish, lastFinish: d.lastFinish, lastPoints: d.lastPoints,
        toCut: cutPoints == null ? null : pts - cutPoints,
        // more statistics
        poles: d.poles, avgStart: d.starts ? Math.round(d.startSum / d.starts * 10) / 10 : null,
        avgRun: d.runRaces ? Math.round(d.runSum / d.runRaces * 10) / 10 : null,
        dnfs: d.dnfs, lapsCompleted: d.lapsCompleted, racesLed: d.racesLed, mostLed: d.mostLed,
        leadLap: d.leadLapRaces ? d.leadLap : null, top15s: d.top15s, top20s: d.top20s, stageTop10s: d.stageTop10s,
        gained: d.gainedRaces ? d.gained : null, worstFinish: d.worstFinish, bonusPts: d.bonusPts, top15Laps: d.top15Laps,
        winPct: d.races ? Math.round(d.wins / d.races * 1000) / 10 : 0,
        ptsPerRace: d.races ? Math.round(d.points / d.races * 10) / 10 : 0,
        dropped: d.dropped || 0,
        damage: d.incidentRaces ? d.damage : null, contacts: d.incidentRaces ? d.contacts : null, cautionsCaused: d.incidentRaces ? d.cautionsCaused : null,
      };
      return row;
    });

    const racesRun = baseRaces + (season.races || []).length;
    const totalRaces = rules.regularSeasonRaces + (chaseOn ? rules.chaseRaces : 0);
    const allRun = baseRaces + raceList.length;
    const phase = allRun >= totalRaces ? 'complete' : (chaseOn && allRun >= regRaces ? 'chase' : 'regular');

    const table = (map) => Object.values(map).map(x => Object.assign({}, x, { drivers: [...x.drivers] }))
      .sort((a, b) => b.points - a.points || b.wins - a.wins || (a.best || 99) - (b.best || 99) || a.name.localeCompare(b.name))
      .map((x, i, arr) => Object.assign(x, { rank: i + 1, behind: i ? x.points - arr[0].points : 0 }));
    const rookies = rows.filter(r => rookieKeys.has(r.key)).map((r, i, arr) => ({ rank: i + 1, key: r.key, name: r.name, number: r.number, points: r.seasonPoints, behind: i ? r.seasonPoints - arr[0].seasonPoints : 0, wins: r.wins, top5s: r.top5s, top10s: r.top10s, races: r.races, afp: r.afp }))
      .sort((a, b) => b.points - a.points).map((r, i, arr) => Object.assign(r, { rank: i + 1, behind: i ? r.points - arr[0].points : 0 }));
    const result = {
      rulesetId: rules.id, phase, racesRun: allRun, savedRacesRun: racesRun,
      owners: table(owners), makes: table(makes), teams: table(teams), rookies,
      regularRaces: rules.regularSeasonRaces, chaseRaces: chaseOn ? rules.chaseRaces : 0,
      totalRaces, nextRace: Math.min(allRun + 1, totalRaces),
      chaseField: rules.chase.field,
      chase: chase ? { field: chase.field, seeds: chase.seeds, afterRace: chase.afterRace, format: chase.format || '2026', alive: chase.alive ? [...chase.alive] : null, round: chase.round || 0,
        eliminated: chase.eliminated || [], champion: chase.champion || null } : null,
      cutPoints, rows, regularRows,
      leader: rows[0] || null,
      champion: phase === 'complete' && rows[0] ? (chase && chase.champion ? rows.find(r => r.key === chase.champion) || rows[0] : rows[0]) : null,
    };

    // rank movement vs. the standings before the most recent race
    if (!opts.noDelta && raceList.length > 0) {
      const prev = computeSeason(
        { ruleset: season.ruleset, baseline: season.baseline, races: raceList.slice(0, -1).filter(r => r !== opts.extraRace) },
        { noDelta: true, aliases: null }
      );
      const prevRank = {};
      prev.rows.forEach(r => { prevRank[r.key] = r.rank; });
      for (const r of result.rows) r.delta = prevRank[r.key] ? prevRank[r.key] - r.rank : 0;
    }
    return result;
  }

  // Live projection: standings as if the race ended now (stage points already
  // earned + current running order). `live` has the same shape as a raw race.
  function projectLive(season, live) {
    if (!live || !live.entries || !live.entries.length) return computeSeason(season);
    const extra = Object.assign({ id: '__live__' }, live);
    return computeSeason(season, { extraRace: extra });
  }

  function validateRace(race) {
    const problems = [];
    if (!race || !Array.isArray(race.entries) || race.entries.length < 2) problems.push('Fewer than two cars in the results.');
    const seen = new Set();
    for (const e of (race && race.entries) || []) {
      const k = e.key || keyOf(e.name);
      if (!k) problems.push('A result has no driver name.');
      if (seen.has(k)) problems.push('Duplicate driver in results: ' + e.name);
      seen.add(k);
    }
    return problems;
  }

  return {
    normName, keyOf, finishPoints, stagePoints, chaseSeedPoints, raceMultiplier, keptResults, isDnf, applyAliases,
    scoreRace, computeSeason, projectLive, validateRace,
  };
});
