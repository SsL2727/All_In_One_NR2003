// Importers for AutoStages v4 output so existing seasons can carry over.
//   parseAutoStagesRaceHtml — one "<track> Results mm-dd hhmmAM.html" file → raw race
//   parseAutoStagesSeasonXml — SeasonInfo.xml → aggregate baseline (no per-race detail)
// Nothing here reads or touches the AutoStages executable; only its text output.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.PSFSeasonImport = factory(root.PSFSeasonEngine);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  function decode(s) {
    return String(s)
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function cells(rowHtml) {
    const out = [];
    const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m;
    while ((m = re.exec(rowHtml))) out.push(decode(m[1]));
    return out;
  }
  function rows(tableHtml) {
    const out = [];
    const re = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = re.exec(tableHtml))) out.push(cells(m[1]));
    return out;
  }
  function num(v) { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; }

  function parseAutoStagesRaceHtml(html, hint) {
    hint = hint || {};
    const titleM = /<title>([\s\S]*?)<\/title>/i.exec(html);
    const title = titleM ? decode(titleM[1]) : '';
    const lapsM = /Laps:\s*(\d+)/i.exec(decode(html.replace(/<style[\s\S]*?<\/style>/gi, '')));
    const seriesM = /(NASCAR [^<]*?) - Race Results/i.exec(html);
    const track = title.replace(/\s*Results\s*$/i, '').trim() || hint.track || 'Unknown track';

    // main results table = first <table> after the header; stage tables follow
    const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    if (!tables.length) throw new Error('No results table found in HTML.');
    const main = rows(tables[0]);
    const head = main[0].map(h => h.toLowerCase());
    const col = name => head.indexOf(name);
    const iPos = col('pos'), iNum = col('#'), iDrv = col('driver'), iPts = col('pts'), iStg = col('stage pts');
    const iStatus = col('status'), iLed = col('led'), iBest = col('best lap'), iGfp = col('gfp'), iQp = col('qp');
    if (iPos < 0 || iDrv < 0) throw new Error('Unrecognised results table (no Pos/Driver columns).');

    const entries = [];
    for (const r of main.slice(1)) {
      if (r.length < 3) continue;
      const name = Engine.normName(r[iDrv]);
      const finish = parseInt(r[iPos], 10);
      if (!name || !(finish > 0)) continue;
      const pts = iPts >= 0 ? num(r[iPts]) : null;
      const stagePts = iStg >= 0 ? num(r[iStg]) : 0;
      entries.push({
        key: Engine.keyOf(name), name, number: r[iNum] != null ? r[iNum] : '',
        finish,
        status: iStatus >= 0 ? r[iStatus] : '',
        ledLaps: iLed >= 0 ? num(r[iLed]) : 0,
        bestLap: iBest >= 0 ? num(r[iBest]) : 0,
        gfp: iGfp >= 0 ? num(r[iGfp]) : 0,
        qp: iQp >= 0 ? num(r[iQp]) : 0,
        _srcPts: pts, _srcStagePts: stagePts,
      });
    }

    // stage tables: <div class='stage-header'>Stage N Results</div> then a table
    const stages = [];
    const stRe = /Stage\s+(\d+)\s+Results<\/div>\s*(<table[\s\S]*?<\/table>)/gi;
    let m;
    while ((m = stRe.exec(html))) {
      const order = rows(m[2]).slice(1)
        .map(r => ({ name: Engine.normName(r[1]), pos: parseInt(r[0], 10) }))
        .filter(o => o.name && o.pos > 0)
        .map(o => ({ key: Engine.keyOf(o.name), pos: o.pos }));
      stages.push({ stage: parseInt(m[1], 10), order });
    }

    // Fastest-lap bonus isn't marked in the table: it is the 1pt discrepancy
    // between "Pts" and finish + stage points.
    let fastestKey = null;
    for (const e of entries) {
      if (e._srcPts == null) continue;
      const finishPts = e.finish === 1 ? 55 : Math.max(1, 35 - (e.finish - 2));
      if (e._srcPts - finishPts - e._srcStagePts === 1) { fastestKey = e.key; break; }
    }

    return {
      track, laps: lapsM ? parseInt(lapsM[1], 10) : 0,
      seriesName: seriesM ? seriesM[1] : '',
      entries, stages, fastestKey, source: 'autostages-html',
    };
  }

  function tag(block, name) {
    const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
    return m ? decode(m[1]) : '';
  }

  function parseAutoStagesSeasonXml(xml) {
    const racesRun = parseInt(tag(xml, 'RacesRun'), 10) || 0;
    const races = [];
    const rRe = /<Race>([\s\S]*?)<\/Race>/gi;
    let m;
    while ((m = rRe.exec(xml))) races.push({ track: tag(m[1], 'Track'), winner: tag(m[1], 'Winner') });
    const drivers = {};
    const dRe = /<Driver>([\s\S]*?)<\/Driver>/gi;
    while ((m = dRe.exec(xml))) {
      const b = m[1];
      const name = Engine.normName(tag(b, 'Name'));
      if (!name) continue;
      drivers[Engine.keyOf(name)] = {
        name, number: tag(b, 'Number'),
        points: num(tag(b, 'Points')), wins: num(tag(b, 'Wins')), stageWins: num(tag(b, 'StageWins')),
        top5s: num(tag(b, 'Top5s')), top10s: num(tag(b, 'Top10s')), races: num(tag(b, 'RacesRun')),
        lapsLed: num(tag(b, 'LapsLed')), fastestLaps: num(tag(b, 'FastestLaps')),
        gfp: num(tag(b, 'GFP')), qp: num(tag(b, 'QP')),
        totalPositions: num(tag(b, 'TotalPositions')), incidents: num(tag(b, 'Incidents')),
      };
    }
    return { racesRun, races, drivers, source: 'autostages-xml' };
  }

  return { parseAutoStagesRaceHtml, parseAutoStagesSeasonXml };
});
