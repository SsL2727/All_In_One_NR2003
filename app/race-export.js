// Builds a race-results page in the same layout as NR2003's own
// "EXPORTED STANDINGS" HTML (CRLF line endings, Latin-1, TD-per-cell tables).
//
// Not reproduced because the game data doesn't expose it: weather, pitstop
// frequency, AI strength, penalties, and NR2003's "#@#Signature" checksum.

const CRLF = '\r\n';
const BG   = '#CEDAEB';
const NAVY = '#173D54';

// Escape for HTML and for a Latin-1 file: anything above U+00FF becomes &#N;
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[^\u0000-\u00ff]/g, ch => '&#' + ch.codePointAt(0) + ';');
}

function fmtPts(n) {
  n = Number(n) || 0;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

const cell = (t) => `<TD style="background : ${BG}">${CRLF}\t${esc(t)}${CRLF}</TD>${CRLF}`;
const row  = (cells) => `<TR\tstyle="color : black">${CRLF}${cells.map(cell).join('')}`;
const h3   = (t) => `<H3 style="color : ${NAVY}">${CRLF}\t${esc(t)}${CRLF}</H3>${CRLF}`;
const BR   = `<BR>${CRLF}`;

function table(headers, rows) {
  // NR2003 closes the header row but leaves data rows open (valid HTML 4) — kept as is.
  let s = `<TABLE border="2"${CRLF}\tstyle="background : ${NAVY}"${CRLF}\tcellpadding="3"${CRLF}\tcellspacing="2"${CRLF}\tsummary="">${CRLF}`;
  s += row(headers) + `</TR>${CRLF}`;
  s += rows.map(r => row(r)).join('');
  s += `</TABLE>${CRLF}`;
  return s;
}

/**
 * data = {
 *   track, date,                       // strings
 *   eventName,                         // optional, e.g. "Daytona 250" (written as an "Event:" line)
 *   qualifying: [{ pos, number, name, time }],
 *   rows: [{ finish, start, number, name, interval, laps, led, mostLed, points, status }],
 *   cautionFlags, cautionLaps, leadChanges, leadDrivers,   // numbers or null
 *   weatherQual, weather, pitFrequency, aiStrength,        // optional strings (only known for races imported from the game's own file)
 *   penalties,                                              // optional [{ lap, number, infraction, penalty }] (an empty array writes an empty table, like the game)
 * }
 * Returns a Buffer (Latin-1).
 */
function buildRaceHtml(data) {
  let s = '';
  s += `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0//EN"${CRLF}\t"http://www.w3.org/TR/REC-html40/strict.dtd">${CRLF}`;
  s += `<HTML>${CRLF}<HEAD>${CRLF}\t<TITLE>Race Standings</TITLE>${CRLF}`;
  s += `\t<META name="author" content="All In One NR2003">${CRLF}`;
  s += `\t<META http-equiv="Content-Type" content="text/html; charset=Latin-1">${CRLF}`;
  s += `\t<STYLE type="text/css">${CRLF}\t\tBODY {text-align: left}${CRLF}\t</STYLE>${CRLF}</HEAD>${CRLF}`;
  s += `<BODY style="background : white">${CRLF}`;
  s += `<H1 style="color : ${NAVY}">${CRLF}\tNASCAR Racing 2003 Season EXPORTED STANDINGS${CRLF}</H1>${CRLF}`;
  s += h3('Track: ' + (data.track || '').toUpperCase());
  s += h3('Date: ' + (data.date || ''));
  if (data.eventName) s += h3('Event: ' + data.eventName);
  s += BR;

  const q = data.qualifying || [];
  if (q.length) {
    s += h3('Session: Qualifying') + BR;
    s += table(['P', '#', 'DRIVER', 'TIME'], q.map(r => [r.pos, r.number, r.name, r.time || '--']));
    s += BR + BR;
    if (data.weatherQual) s += h3('Weather: ' + data.weatherQual) + BR + BR;
  }

  s += h3('Session: Race');
  s += h3('OFFICIAL STANDINGS') + BR;
  s += table(
    ['F', 'S', '#', 'DRIVER', 'INTERVAL', 'LAPS', 'LED', 'POINTS', 'STATUS'],
    (data.rows || []).map(r => [
      r.finish,
      r.start == null ? '--' : r.start,
      r.number,
      r.name,
      r.interval,
      r.laps,
      r.mostLed ? `${r.led}*` : `${r.led} `,
      fmtPts(r.points),
      r.status,
    ])
  );
  s += BR + BR;

  if (data.cautionFlags != null) {
    s += h3(`Caution Flags: ${data.cautionFlags} (${data.cautionLaps || 0} laps)`);
  }
  if (data.leadChanges != null) {
    s += h3(`Lead Changes: ${data.leadChanges} (${data.leadDrivers || 0} drivers)`);
  }
  if (data.weather)      s += h3('Weather: ' + data.weather);
  if (data.pitFrequency) s += h3('Pitstop Frequency: ' + data.pitFrequency);
  if (data.aiStrength)   s += h3('AI Strength: ' + data.aiStrength);
  if (Array.isArray(data.penalties)) {
    s += BR + h3('PENALTIES');
    s += table(['LAP', '#', 'INFRACTION', 'PENALTY'], data.penalties.map(p => [p.lap, p.number, p.infraction, p.penalty]));
    s += BR + BR;
  } else {
    s += BR + BR;
  }
  s += `</BODY>${CRLF}</HTML>${CRLF}`;
  return Buffer.from(s, 'latin1');
}

module.exports = { buildRaceHtml, fmtPts };
