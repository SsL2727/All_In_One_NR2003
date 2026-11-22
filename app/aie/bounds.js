// The game's "track bounds" table: one 64-byte row per lap-line point, holding the lane width and where minrace / maxrace sit relative to the
// race line (plus speed / curvature gradients across the lane). The AI works out its lateral limits from these rows, so when the race line
// is moved (MultiGroove) AI Enhanced rewrites every row from the moved line and the two bound lines each tick (FUN_0044d7e0: "Track bounds
// adjusted in game memory to match minrace/race/maxrace slider shifts"). Without that the limits move with the race line, which pushes the AI
// into the wall. The table is found like AI Enhanced does: value-scan for the width of row 10, the base is 10 rows (0x280) before it.
'use strict';

const ROW = 0x40;
const K1 = Math.fround(1.0049999952316284), K2 = Math.fround(0.005025125574320555), EPS = Math.fround(9.999999747378752e-06);
const fr = Math.fround;

// the 11 floats of a row for point i. race / mn / mx: { rec: Float32Array(count * 7) }; s: AI Enhanced's speed scale (1 at opponent strength 100)
function rowFor(race, mn, mx, i, s, out) {
  const R = i * 7;
  const width = fr(Math.abs(mx.rec[R + 3] - mn.rec[R + 3]));
  let relMin = fr((mn.rec[R + 3] - race.rec[R + 3]) / width), relMax = fr((mx.rec[R + 3] - race.rec[R + 3]) / width);
  if (!(relMin < 0)) relMin = 0;
  if (!(relMax > 0)) relMax = 0;
  const a0 = fr(-(K1 / (K2 - relMin))), a4 = fr(K1 / (relMax + K2));
  if (Math.abs(relMin) < EPS) relMin = -EPS;
  if (Math.abs(relMax) < EPS) relMax = EPS;
  let g = [0, 0, 0, 0, 0, 0];
  if (EPS < width) {
    const sq = (v) => (s * v) * (s * v);
    const r0 = sq(race.rec[R]);
    g = [(mn.rec[R + 1] - race.rec[R + 1]) / width, (mx.rec[R + 1] - race.rec[R + 1]) / width, (mn.rec[R + 2] - race.rec[R + 2]) / width,
      (mx.rec[R + 2] - race.rec[R + 2]) / width, (sq(mn.rec[R]) - r0) / width, (sq(mx.rec[R]) - r0) / width];
  }
  out[0] = width; out[1] = relMin; out[2] = a0; out[3] = relMax; out[4] = a4;
  for (let k = 0; k < 6; k++) out[5 + k] = g[k];
  return out;
}

// rows for all points -> Buffer(count * 64) with only the 11 floats filled in; merge over `base` (the rows as the game holds them)
function rowsInto(base, race, mn, mx, count, s) {
  const out = Buffer.from(base), tmp = new Float32Array(11);
  for (let i = 0; i < count; i++) {
    rowFor(race, mn, mx, i, s, tmp);
    for (let k = 0; k < 11; k++) out.writeFloatLE(tmp[k], i * ROW + k * 4);
  }
  return out;
}

// find the table: value-scan for row 10's width, check a few more rows, return { addr, count, orig: Buffer } or null
async function findBounds(mem, lines, s = 1, { yieldEvery = 8 } = {}) {
  const { race, minrace, maxrace } = lines;
  const n = Math.min(race.count, minrace.count, maxrace.count);
  if (n < 40) return null;
  const tmp = new Float32Array(11);
  rowFor({ rec: race.orig0 ? race.orig0.rec : race.rec }, minrace, maxrace, 10, s, tmp);
  const pat = Buffer.alloc(4); pat.writeFloatLE(tmp[0], 0);
  const cands = []; let chunks = 0; const CH = 0x100000;
  for (const r of mem.regions(0x10000, 0x7fff0000)) {
    for (let off = 0; off < r.size; off += CH) {
      const b = mem.readBytes(r.base + off, Math.min(CH + 3, r.size - off));
      if (b) for (let i = b.indexOf(pat); i >= 0; i = b.indexOf(pat, i + 1)) { if (i < CH && (r.base + off + i) % 4 === 0 && cands.length < 4000) cands.push(r.base + off + i - 10 * ROW); }
      if (++chunks % yieldEvery === 0) await new Promise(res => setImmediate(res));
    }
  }
  const base = { rec: race.orig0 ? race.orig0.rec : race.rec };
  for (const a of cands) {
    let ok = true;
    for (const i of [0, 1, 2, 10, 50, 200, Math.floor(n / 2), n - 2]) {
      if (i >= n) continue;
      const row = mem.readBytes(a + i * ROW, 12);
      if (!row) { ok = false; break; }
      rowFor(base, minrace, maxrace, i, s, tmp);
      const row3 = mem.readBytes(a + i * ROW + 12, 4);      // width, min and max positions (where minrace or maxrace lies on the race line the game's own row holds about +-0.005 where the AI Enhanced formula gives ~0); a0 / a4 differ a little between the game's own rows and AI Enhanced's formula
      if (!row3 || Math.abs(row.readFloatLE(0) - tmp[0]) > 1e-3 || Math.abs(row.readFloatLE(4) - tmp[1]) > 0.01 + 1e-3 * Math.abs(tmp[1]) || Math.abs(row3.readFloatLE(0) - tmp[3]) > 0.01 + 1e-3 * Math.abs(tmp[3])) { ok = false; break; }
    }
    if (!ok) continue;
    const orig = mem.readBytes(a, n * ROW);
    if (orig) return { addr: a, count: n, orig: Buffer.from(orig) };
  }
  return null;
}

// AI Enhanced's speed scale for the bound rows (FUN_00443330, first half): 1 at opponent strength 100
function scaleFor(strength, aux) {
  const a = Number.isFinite(aux) && aux > 0 ? aux : 1, st = Number.isFinite(strength) && strength >= 70 && strength <= 110 ? strength : 100;
  if (st === 100 && a === 1) return 1;
  const x = Math.max(0.01, a * (st / 100));
  if (x >= 0.5) {
    if (x <= 2) { const t = x - 1; return fr(fr(0.1188) * t * t + fr(0.6896) * t + 1); }
    return fr((x - 2) * fr(0.9272) + fr(1.8084));
  }
  return fr((x - 0.5) * fr(0.5708) + fr(0.6849));
}

// the 11 floats of every row, from the (moved) race line and the two bound lines -> Float32Array(count * 11)
function rows11(race, mn, mx, count, s) {
  const out = new Float32Array(count * 11), tmp = new Float32Array(11);
  for (let i = 0; i < count; i++) { rowFor(race, mn, mx, i, s, tmp); out.set(tmp, i * 11); }
  return out;
}

// put those floats into the game's table, keeping the bytes of each row that are not part of them (read, patch, write, like AI Enhanced does per row)
function writeRows11(mem, bounds, f11) {
  const cur = mem.readBytes(bounds.addr, bounds.count * ROW);
  const buf = cur ? Buffer.from(cur) : Buffer.from(bounds.orig);
  for (let i = 0; i < bounds.count; i++) for (let k = 0; k < 11; k++) buf.writeFloatLE(f11[i * 11 + k], i * ROW + k * 4);
  mem.writeBytes(bounds.addr, buf);
}

// AI Enhanced stores the scaled drafting distance at +0x2C of every 64-byte row. The
// papy_ai.ini float alone does not update the in-session lane width.
function writeDrafting(mem, bounds, value) {
  if (!bounds || !Number.isFinite(value)) return false;
  const n = bounds.count, bytes = n * ROW;
  const cur = mem.readBytes(bounds.addr, bytes);
  const buf = Buffer.from(cur || bounds.orig);
  const v = Math.fround(value * 5);
  for (let i = 0; i < n; i++) buf.writeFloatLE(v, i * ROW + 0x2C);
  return !!mem.writeBytes(bounds.addr, buf);
}

function restoreDrafting(mem, bounds) {
  if (!bounds || !bounds.orig) return false;
  const cur = mem.readBytes(bounds.addr, bounds.count * ROW);
  if (!cur) return false;
  const buf = Buffer.from(cur);
  for (let i = 0; i < bounds.count; i++) buf.writeFloatLE(bounds.orig.readFloatLE(i * ROW + 0x2C), i * ROW + 0x2C);
  return !!mem.writeBytes(bounds.addr, buf);
}

function restoreBounds(mem, bounds) { mem.writeBytes(bounds.addr, bounds.orig); }

module.exports = { ROW, rowFor, rowsInto, rows11, writeRows11, writeDrafting, restoreDrafting, restoreBounds, findBounds, scaleFor };
