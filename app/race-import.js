// Reads an NR2003 "EXPORTED STANDINGS" HTML file (the one the game writes) into
// a race record: qualifying, race results, caution/lead-change stats, weather,
// pit-stop frequency, AI strength and penalties.
//
// The files are HTML 4 with optional end tags (data rows have no </TR>) and
// Latin-1 text, so this is a small tolerant tokenizer rather than a DOM parse.

function decode(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&deg;/gi, '°').replace(/&copy;/gi, '©')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}
const clean = s => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseTable(tableHtml) {
  const rows = [];
  tableHtml.split(/<TR\b/i).slice(1).forEach(r => {
    const cells = [...r.matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>/gi)].map(m => clean(m[1]));
    if (cells.length) rows.push(cells);
  });
  return rows;
}

// "08/02/26" → ms (day/month/year; a year of 2 digits means 20xx). NR2003 writes the
// date in the PC's regional format, which for a Spanish PC is day-first.
function parseDate(str) {
  const m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(String(str || '').trim());
  if (!m) return null;
  let a = parseInt(m[1], 10), b = parseInt(m[2], 10), y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  let day = a, month = b;
  if (b > 12 && a <= 12) { day = b; month = a; }          // only possible as month/day
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(y, month - 1, day, 12, 0, 0);
}

const int = v => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };

/**
 * Returns { ok, error?, race } — race matches the season race record
 * (without id/at defaults, which the caller fills in).
 */
function parseRaceHtml(html) {
  const text = String(html || '');
  const re = /<H[1-4]\b[^>]*>([\s\S]*?)<\/H[1-4]>|<TABLE\b[\s\S]*?<\/TABLE>/gi;
  const race = {
    name: '', track: '', dateStr: '', at: null,
    qualifying: [], rows: [], penalties: null,
    cautionFlags: null, cautionLaps: null, leadChanges: null, leadDrivers: null,
    weatherQual: '', weather: '', pitFrequency: '', aiStrength: '',
  };
  let section = '';

  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) {                                  // heading
      const h = clean(m[1]);
      let g;
      if ((g = /^Track:\s*(.*)$/i.exec(h)))              race.track = g[1];
      else if ((g = /^Date:\s*(.*)$/i.exec(h)))          { race.dateStr = g[1]; race.at = parseDate(g[1]); }
      else if ((g = /^Event:\s*(.*)$/i.exec(h)))         race.name = g[1];
      else if ((g = /^Session:\s*(.*)$/i.exec(h)))       section = /qualif/i.test(g[1]) ? 'qual' : (/race/i.test(g[1]) ? 'race' : 'other');
      else if ((g = /^Weather:\s*(.*)$/i.exec(h)))       { if (section === 'qual') race.weatherQual = g[1]; else if (section === 'race') race.weather = g[1]; }
      else if ((g = /^Caution Flags:\s*(\d+)\s*(?:\((\d+)\s*laps?\))?/i.exec(h))) { race.cautionFlags = +g[1]; race.cautionLaps = g[2] != null ? +g[2] : null; }
      else if ((g = /^Lead Changes:\s*(\d+)\s*(?:\((\d+)\s*drivers?\))?/i.exec(h))) { race.leadChanges = +g[1]; race.leadDrivers = g[2] != null ? +g[2] : null; }
      else if ((g = /^Pitstop Frequency:\s*(.*)$/i.exec(h))) race.pitFrequency = g[1];
      else if ((g = /^AI Strength:\s*(.*)$/i.exec(h)))   race.aiStrength = g[1];
      continue;
    }

    const rows = parseTable(m[0]);
    if (!rows.length) continue;
    const head = rows[0].map(c => c.toUpperCase()).join('|');

    if (head === 'P|#|DRIVER|TIME') {
      if (section === 'qual' || !race.qualifying.length) {
        race.qualifying = rows.slice(1).filter(r => r.length >= 4)
          .map(r => ({ pos: int(r[0]), number: r[1], name: r[2], time: r[3] || '--' }));
      }
    } else if (head.startsWith('F|S|#|DRIVER|INTERVAL|LAPS|LED|POINTS|STATUS')) {
      race.rows = rows.slice(1).filter(r => r.length >= 9).map(r => ({
        finish: int(r[0]), start: r[1] === '--' ? null : int(r[1]), number: r[2], name: r[3],
        interval: r[4], laps: int(r[5]) || 0, led: int(r[6]) || 0, mostLed: /\*/.test(r[6]),
        points: num(r[7]), status: r[8],
      }));
    } else if (head.startsWith('LAP|#|INFRACTION|PENALTY')) {
      race.penalties = rows.slice(1).filter(r => r.length >= 4)
        .map(r => ({ lap: r[0], number: r[1], infraction: r[2], penalty: r[3] }));
    }
  }

  if (!race.rows.length) {
    return { ok: false, error: 'No race results found in this file (it may be a practice or qualifying export).' };
  }
  return { ok: true, race };
}

module.exports = { parseRaceHtml, parseDate };
