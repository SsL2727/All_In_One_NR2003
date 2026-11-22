// Shared by every overlay that has the "As they run" points panel (Points Table hotkey).
// The phone's Championship tab saves { drivers: ['12','24',...] (max 7), metric } per series; this keeps a live copy
// and gives the panels three helpers:
//   PPV.pick(rows, defN)  -> which rows to show (chosen drivers, or the top defN when none are chosen)
//   PPV.val(r, dflt)      -> the text of the value column for the chosen metric (dflt = what the ticker shows today)
//   PPV.onChange(cb)      -> called when the phone changes the choice
// metric: '' = gap to the leader (as before), 'points' = projected points, 'champPos' = championship place, 'racePos' = race place sorted by race place, 'racePosChamp' = race place with the rows kept in championship order, 'gapCutoff' = points gap to the cutoff line (only while it is on), 'posCutoff' = same drivers / separator as gapCutoff but showing the current race (track) position
(function () {
  const MAX = 7, METRICS = ['', 'points', 'champPos', 'racePos', 'racePosChamp', 'gapCutoff', 'posCutoff'];
  const state = { drivers: [], metric: '', cut: { enabled: false, pos: 0, text: 'CUTOFF LINE', color: '#e8232a', textColor: '#ffffff' } };
  // 'gapCutoff' (Cutoff Line (points)) and 'posCutoff' (Cutoff Line (position)) only work while the cutoff line is on in the Championship screen; otherwise the panel keeps its original look
  const isCutM = m => m === 'gapCutoff' || m === 'posCutoff';
  const eff = () => (isCutM(state.metric) && !(state.cut.enabled && state.cut.pos > 0)) ? '' : state.metric;
  const subs = [];
  const num = n => String(n == null ? '' : n).trim();
  const fmt = v => Math.round((Number(v) || 0) * 100) / 100;

  function clean(v) {
    const o = (v && typeof v === 'object') ? v : {};
    const seen = new Set(), drivers = [];
    (Array.isArray(o.drivers) ? o.drivers : []).forEach(n => {
      const k = num(n);
      if (/^\d{1,4}$/.test(k) && !seen.has(k) && drivers.length < MAX) { seen.add(k); drivers.push(k); }
    });
    const c = (o.cut && typeof o.cut === 'object') ? o.cut : {};
    const cpos = parseInt(c.pos, 10) || 0;
    const hex = (v, d) => /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v).toLowerCase() : d;
    return { drivers, metric: METRICS.includes(o.metric) ? o.metric : '', cut: { enabled: c.enabled === true && cpos >= 1, pos: cpos,
      text: c.text == null ? 'CUTOFF LINE' : String(c.text).slice(0, 40), color: hex(c.color, '#e8232a'), textColor: hex(c.textColor, '#ffffff') } };
  }
  function set(v) {
    const c = clean(v);
    const same = c.metric === state.metric && c.drivers.join(',') === state.drivers.join(',') && JSON.stringify(c.cut) === JSON.stringify(state.cut);
    state.drivers = c.drivers; state.metric = c.metric; state.cut = c.cut;
    if (!same) subs.forEach(f => { try { f(); } catch (e) {} });
  }

  // rows: every championship driver sorted by (projected) points, each with { number, total, rpos? }
  function pick(rows, defN) {
    rows = Array.isArray(rows) ? rows : [];
    const leadTotal = rows.length ? rows[0].total : 0;
    rows.forEach((r, i) => { r.cpos = i + 1; r.lead = leadTotal; });
    // gap to the cutoff line (same rule as the Championship overlay): above the line = points ahead of the first car below it,
    // below the line = points behind the last car above it
    const cp = state.cut.enabled ? state.cut.pos : 0;
    rows.forEach((r, i) => { r.cutGap = (cp > 0 && cp < rows.length) ? (i < cp ? r.total - rows[cp].total : r.total - rows[cp - 1].total) : null; });
    let out = null;
    if (state.drivers.length) {
      const want = new Set(state.drivers);
      out = rows.filter(r => want.has(num(r.number))).slice(0, MAX);
      if (!out.length) out = null;                       // none of the chosen drivers is in this championship: fall back to automatic
    }
    if (!out && isCutM(eff()) && state.cut.pos > 0 && state.cut.pos < rows.length) {
      const cp = state.cut.pos;                          // automatic choice for the cutoff gap: the 3 drivers above the line and the 3 below it
      out = rows.slice(Math.max(0, cp - 3), cp + 3);
    }
    if (!out) out = rows.slice(0, Math.max(1, defN || 5));
    else out = out.slice();
    if (eff() === 'racePos') out.sort((a, b) => ((a.rpos > 0 ? a.rpos : 9999) - (b.rpos > 0 ? b.rpos : 9999)) || (a.cpos - b.cpos));
    return out;
  }
  // The small separator between the drivers inside and outside the cutoff line (only with the cutoff gap on): index of the last row
  // inside the line + the name / colours given in the Championship screen. null when all the rows are on the same side.
  function cutBand(rows) {
    if (!isCutM(eff()) || !Array.isArray(rows)) return null;
    let after = -1;
    rows.forEach((r, i) => { if (r.cpos > 0 && r.cpos <= state.cut.pos) after = i; });
    if (after < 0 || after >= rows.length - 1) return null;
    return { after, text: state.cut.text, color: state.cut.color, textColor: state.cut.textColor };
  }
  // number in the position column: the championship place while the cutoff gap is shown, otherwise the row number the overlay would use
  function pos(r, dflt) { return isCutM(eff()) && r.cpos > 0 ? r.cpos : dflt; }
  function val(r, dflt) {
    switch (eff()) {
      case 'gapCutoff': { const v = r.cutGap; if (v == null) return dflt; return v > 0 ? '+' + fmt(v) : v < 0 ? '-' + fmt(-v) : '0'; }
      case 'posCutoff': return r.rpos > 0 ? 'P' + r.rpos : '\u2014';   // race (track) position; rows stay in championship order
      case 'points':   return String(fmt(r.total));
      case 'champPos': return 'P' + r.cpos;
      case 'racePos':
      case 'racePosChamp': return r.rpos > 0 ? 'P' + r.rpos : '\u2014';   // racePosChamp: same value, but the rows stay in championship order
      default:         return dflt;
    }
  }
  window.PPV = {
    MAX,
    metric: () => eff(),
    isDefault: () => eff() === '',
    key: () => eff() + '#' + state.drivers.join(',') + '#' + (state.cut.enabled ? state.cut.pos + state.cut.text + state.cut.color + state.cut.textColor : 0),
    set, pick, val, pos, cutBand,
    onChange: cb => { if (typeof cb === 'function') subs.push(cb); },
  };
  const shl = window.shl;
  try { if (shl && shl.getPointsView) Promise.resolve(shl.getPointsView()).then(set).catch(() => {}); } catch (e) {}
  try { if (shl && shl.onPointsViewChanged) shl.onPointsViewChanged(set); } catch (e) {}
})();
