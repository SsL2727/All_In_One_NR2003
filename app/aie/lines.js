// The AI lap lines (race.lp / minrace.lp / maxrace.lp) as NR2003 holds them in memory.
//
// Disk file: int16 3, int16 1, int32 count, then `count` x 6 floats (f0, f1, lateral, 0, step, 0).
// In memory the game keeps 7 floats per point (f0, f1, curvature, lateral, f4, f5, cumulative distance), preceded by a float with the
// line's length. AI Enhanced finds them by value-scanning the process; this does the same, matching on the lateral column of the
// files in the loaded track's folder (found by value, so it works wherever the game allocated them). The number of points is the
// game's own rule: read until the cumulative distance passes the line's length.
'use strict';
const fs = require('fs');
const path = require('path');

const REC = 28;
const NAMES = ['race', 'minrace', 'maxrace'];

function parseLapFile(buf) {
  if (!buf || buf.length < 8) return null;
  const count = buf.readInt32LE(4);
  if (!(count > 20 && count < 20000) || buf.length < 8 + count * 24) return null;
  const lat = new Float32Array(count), f0 = new Float32Array(count), f1 = new Float32Array(count);
  for (let i = 0; i < count; i++) { f0[i] = buf.readFloatLE(8 + i * 24); f1[i] = buf.readFloatLE(8 + i * 24 + 4); lat[i] = buf.readFloatLE(8 + i * 24 + 8); }
  return { count, lat, f0, f1 };
}

function buildLapFile(line) {
  if (!line || !Number.isInteger(line.count) || line.count < 21 || !line.rec || line.rec.length !== line.count * 7) throw new Error('Invalid in-memory lap line.');
  const out = Buffer.alloc(8 + line.count * 24);
  out.writeInt16LE(3, 0); out.writeInt16LE(1, 2); out.writeInt32LE(line.count, 4);
  for (let i = 0; i < line.count; i++) {
    const src = i * 7, dst = 8 + i * 24;
    out.writeFloatLE(line.rec[src], dst); out.writeFloatLE(line.rec[src + 1], dst + 4);
    out.writeFloatLE(line.rec[src + 3], dst + 8); out.writeFloatLE(0, dst + 12);
    out.writeFloatLE(line.rec[src + 4], dst + 16); out.writeFloatLE(0, dst + 20);
  }
  return out;
}

function readDisk(dir) {
  const out = {};
  for (const n of NAMES) {
    try { out[n] = parseLapFile(fs.readFileSync(path.join(dir, n + '.lp'))); } catch (e) { out[n] = null; }
    if (!out[n]) return null;
  }
  return out;
}

// read the in-memory line starting at `addr`; null when it does not look like a line
function readLine(mem, addr) {
  const len = mem.readF32(addr - 4);
  if (!(len > 50 && len < 100000)) return null;
  // read as much as there is: a line allocated near the end of a memory region has less than 4000 records after it, and one failed
  // read of a fixed size lost it (Kansas: minrace and maxrace sit last in their region, race before them was fine)
  let buf = null;
  for (let c = 12000; c >= 40 && !buf; c = Math.floor(c * 0.85)) buf = mem.readBytes(addr, c * REC);
  if (!buf) return null;
  const n = Math.floor(buf.length / REC);
  let cnt = 0;
  for (; cnt < n; cnt++) { if (buf.readFloatLE(cnt * REC + 24) > len) { cnt++; break; } }
  if (cnt < 20 || cnt >= n) return null;
  const lat = new Float32Array(cnt), w = new Float32Array(cnt), rec = new Float32Array(cnt * 7);
  for (let i = 0; i < cnt; i++) { w[i] = Math.abs(buf.readFloatLE(i * REC + 8)); lat[i] = buf.readFloatLE(i * REC + 12); for (let k = 0; k < 7; k++) rec[i * 7 + k] = buf.readFloatLE(i * REC + k * 4); }
  return { addr, count: cnt, len, lat, w, rec, orig: Buffer.from(buf.subarray(0, cnt * REC)) };
}

function sameLat(mem, addr, disk, allowBad = 0) {
  let bad = 0;
  for (const r of [0, 1, 2, 7, 50, 200, Math.floor(disk.count / 2), disk.count - 2]) {
    if (r < 0 || r >= disk.count) continue;
    const v = mem.readF32(addr + r * REC + 12);
    if (v === null || Math.abs(v - disk.lat[r]) > 1e-4) { if (++bad > allowBad) return false; }
  }
  return true;
}

// { race, minrace, maxrace } read from the game, or { error }. One pass over the process for all three lines, yielding between chunks
// so a busy app stays responsive. `extra` = { race: [{ count, lat }], ... }: what we painted into those lines earlier (a preset's lines), so
// lines still carrying our paint from a previous session in the same memory are found too, not only the track's own.
async function findLines(mem, trackDir, { start = 0x10000, end = 0x7fff0000, yieldEvery = 8, extra = null } = {}) {
  const disk = readDisk(trackDir);
  if (!disk) return { error: `race.lp / minrace.lp / maxrace.lp not found in ${trackDir}` };
  const CH = 0x100000;
  const variants = NAMES.map((n) => [disk[n], ...((extra && extra[n]) || []).filter(v => v && v.count === disk[n].count && v.lat && v.lat.length === v.count)]);
  // each variant is searched by several of its points (a line is painted at some points only); they must not all be the same value
  const probe = (d) => [10, 120, 400, 700].filter(p => p < d.count);
  const pats = NAMES.map((n, k) => variants[k].map((d, v) => probe(d).map(p => { const b = Buffer.alloc(4); b.writeFloatLE(d.lat[p], 0); return { b, p, v }; })).flat());
  const cands = NAMES.map(() => []);
  let chunks = 0;
  for (const r of mem.regions(start, end)) {
    for (let off = 0; off < r.size; off += CH) {
      const n = Math.min(CH + 3, r.size - off);
      const b = mem.readBytes(r.base + off, n);
      if (b) {
        for (let k = 0; k < NAMES.length; k++) {
          for (const { b: pat, p, v } of pats[k]) {
            for (let i = b.indexOf(pat); i >= 0; i = b.indexOf(pat, i + 1)) {
              const hit = r.base + off + i;
              if (i < CH && hit % 4 === 0 && cands[k].length < 20000) cands[k].push({ a: hit - (p * REC + 12), v });
            }
          }
        }
      }
      if (++chunks % yieldEvery === 0) await new Promise(res => setImmediate(res));
    }
  }
  const out = {}, used = new Set();
  for (let k = 0; k < NAMES.length; k++) {
    const name = NAMES[k], d = disk[name];
    let found = null;
    const seen = new Set();
    for (const { a, v } of cands[k]) {
      if (used.has(a) || seen.has(a * 8 + v)) continue;
      seen.add(a * 8 + v);
      // the race line is painted every tick, so a few of its points may differ; a bound line we painted may differ a little more
      if (!sameLat(mem, a, variants[k][v], name === 'race' ? 3 : 1)) continue;
      const ln = readLine(mem, a);
      if (!ln || Math.abs(ln.count - d.count) > 2) continue;
      found = ln; break;
    }
    if (!found) return { error: `the game's ${name}.lp was not found in memory` };
    used.add(found.addr);
    out[name] = found;
  }
  return out;
}

// ── AI Enhanced's lap-line arithmetic ────────────────────────────────────────────────────────────────────────────────────────
const fr = Math.fround;
// the opponent-strength curve (piecewise quadratic of FUN_00443330)
function strengthCurve(v) {
  if (v >= 0.5) {
    if (v <= 2) { const t = fr(v - 1); return fr(fr(fr(t * fr(0.1188)) * t) + fr(t * fr(0.6896)) + 1); }
    return fr(fr(fr(v - 2) * fr(0.9272)) + fr(1.8084));
  }
  return fr(fr(fr(v - 0.5) * fr(0.5708)) + fr(0.6849));
}
// FUN_00443330({strength %, ai_line_modifier}) -> { x: speed (field 0) scale, y: field 4 / 5 scale }; (1, 1) at 100 % and modifier 1
function lineScale(strength, modifier) {
  const st = Number.isFinite(strength) && strength > 0 ? strength : 100, s = fr(st / 100);
  const m = Number.isFinite(modifier) && modifier > 0 ? fr(modifier) : 1;
  if (st === 100 && m === 1) return { x: 1, y: 1 };
  const x = strengthCurve(Math.max(fr(0.01), fr(m * s))), sc = strengthCurve(Math.max(fr(0.01), s));
  let mc;
  if (m > 0.5) mc = m > 1 ? (m > 2 ? fr(fr(fr(m - 2) * 0.25) + fr(1.2124)) : fr(fr(fr(m - 1) * fr(0.2124)) + 1)) : fr(fr(fr(fr(m - 0.5) * fr(0.3276)) * 2) + fr(0.6724));
  else mc = fr(fr(fr(m - 0.5) * fr(0.6552)) + fr(0.6724));
  return { x, y: fr(Math.max(fr(0.05), mc) * sc) };
}
// FUN_00443730: a line from canonical (strength 100, modifier 1) to the game's scale, or back (divide). rec: Float32Array of n x 7, changed in place
function scaleRec(rec, n, sc, divide = false) {
  if (!sc || (sc.x === 1 && sc.y === 1) || !n) return rec;
  const f5 = rec[5];
  for (let i = 0; i < n; i++) {
    const o = i * 7;
    if (divide) { rec[o] = rec[o] / sc.x; rec[o + 4] = rec[o + 4] / sc.y; rec[o + 5] = fr(fr(rec[o + 5] - f5) * sc.y) + f5; }
    else { rec[o] = rec[o] * sc.x; rec[o + 4] = sc.y * rec[o + 4]; rec[o + 5] = fr(fr(rec[o + 5] - f5) / sc.y) + f5; }
  }
  return rec;
}
// FUN_004452b0: the two of min / race / max (index 0 / 1 / 2, sorted by lateral) whose laterals bracket t, with t's weights (not clamped)
function bracket(t, L) {
  const s = [0, 1, 2];
  for (let i = 1; i < 3; i++) { const v = s[i]; let j = i - 1; while (j >= 0 && L[s[j]] > L[v]) { s[j + 1] = s[j]; j--; } s[j + 1] = v; }
  let lo = s[1], hi = s[2];
  if (L[s[1]] >= t) { lo = s[0]; hi = s[1]; }
  const w = fr(L[hi] - L[lo]);
  if (!(w > 1e-5)) return { a: s[1], b: s[1], wa: 1, wb: 0 };
  const wb = fr(fr(t - L[lo]) / w);
  return { a: lo, b: hi, wa: fr(1 - wb), wb };
}
const FUZZY_FIELDS = [0, 1, 2, 4, 5, 6];
// FUN_0044c220 "fuzzy-adjusted lap file with weighted bounds": the target's lateral; every other field from the two base lines that bracket
// it at that point (base: { minrace, race, maxrace } canonical Float32Arrays); field 1 = the lateral's slope per 3 m after the first point.
// -> canonical Float32Array(n * 7)
function fuzzyRec(lat, base, n) {
  const out = new Float32Array(n * 7), B = [base.minrace, base.race, base.maxrace];
  for (let p = 0; p < n; p++) {
    const o = p * 7, L = [B[0][o + 3], B[1][o + 3], B[2][o + 3]], k = bracket(lat[p], L);
    for (const f of FUZZY_FIELDS) out[o + f] = fr(fr(k.wa * B[k.a][o + f]) + fr(k.wb * B[k.b][o + f]));
    if (p > 0) out[o + 1] = fr(fr(lat[p] - lat[p - 1]) / 3);
    out[o + 3] = lat[p];
  }
  return out;
}

// Put lap lines into the game the way AI Enhanced does: recs = { race?, minrace?, maxrace? } Float32Arrays at the game's scale (already through
// fuzzyRec + scaleRec). Only the points are written, never the line's length float (AI Enhanced writes from the first point). The first
// time, the game's bytes are kept (orig0) so they can be put back. -> list of what was done
function applyGameRecs(lines, recs) {
  const done = [];
  for (const n of NAMES) {
    const rec = recs && recs[n], ln = lines && lines[n];
    if (!rec || !ln) continue;
    if (rec.length !== ln.count * 7) { done.push(`${n}: ${rec.length / 7} points, the game ${ln.count} - not applied`); continue; }
    if (!ln.orig0) ln.orig0 = { orig: Buffer.from(ln.orig), len: ln.len, rec: ln.rec, lat: ln.lat };
    const buf = Buffer.from(Float32Array.from(rec).buffer);
    ln.rec = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    ln.orig = buf; ln.applied = true;
    ln.lat = Float32Array.from({ length: ln.count }, (_, i) => ln.rec[i * 7 + 3]);
    done.push(n);
  }
  return done;
}

// Put a preset's lap lines into the game as they are (All In One NR2003's earlier way; kept for tools and tests). Only a line with the game's own point
// count is written; the first time, the game's bytes are kept (orig0) so they can be put back. -> list of what was done
function applyLapLines(mem, lines, ll, { clampBounds = true } = {}) {
  const done = [];
  for (const n of NAMES) {
    const src = ll && ll[n], ln = lines && lines[n];
    if (!src || !ln) continue;
    if (ln.len > 0 && Math.abs(src.length - ln.len) / ln.len > 0.15) { done.push(`${n}: the preset is for a track of another length - not applied`); continue; }
    if (src.count !== ln.count) { done.push(`${n}: preset has ${src.count} points, the game ${ln.count} - not applied`); continue; }
    if (!ln.orig0) ln.orig0 = { orig: Buffer.from(ln.orig), len: ln.len, rec: ln.rec, lat: ln.lat };
    const buf = Buffer.from(src.rec.buffer.slice(src.rec.byteOffset, src.rec.byteOffset + src.count * REC));
    // A preset's bound lines can lie outside the track's own (the Michigan preset's minrace is up to 7 m further out in turns 1-2 and 3-4,
    // which is where the wall is): the AI takes these lines as its limits and MultiGroove paints towards them. The lateral position of
    // minrace / maxrace is kept inside what the game itself had.
    if (clampBounds && (n === 'minrace' || n === 'maxrace')) {
      const o = ln.orig0.rec;
      for (let i = 0; i < src.count; i++) {
        const a = buf.readFloatLE(i * REC + 12), b = o[i * 7 + 3];
        const v = n === 'minrace' ? Math.max(a, b) : Math.min(a, b);
        if (v !== a) { buf.writeFloatLE(v, i * REC + 12); done.clamped = (done.clamped || 0) + 1; }
      }
    }
    ln.rec = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    ln.orig = buf; ln.len = src.length; ln.applied = true;
    ln.lat = Float32Array.from({ length: ln.count }, (_, i) => ln.rec[i * 7 + 3]);
    done.push(n);
  }
  return done;
}

// write the applied lines to the game; withLength also writes the length float (All In One NR2003's earlier way: AI Enhanced leaves the game's length)
function writeLapLines(mem, lines, { withLength = false } = {}) {
  for (const n of NAMES) {
    const ln = lines && lines[n];
    if (!ln || !ln.applied) continue;
    mem.writeBytes(ln.addr, ln.orig);
    if (withLength) { const l = Buffer.alloc(4); l.writeFloatLE(ln.len, 0); mem.writeBytes(ln.addr - 4, l); }
  }
}

// put the game's own lines back
function restoreLapLines(mem, lines) {
  for (const n of NAMES) {
    const ln = lines && lines[n];
    if (!ln || !ln.orig0) continue;
    mem.writeBytes(ln.addr, ln.orig0.orig);
    const l = Buffer.alloc(4); l.writeFloatLE(ln.orig0.len, 0); mem.writeBytes(ln.addr - 4, l);
    ln.orig = ln.orig0.orig; ln.rec = ln.orig0.rec; ln.lat = ln.orig0.lat; ln.len = ln.orig0.len; ln.applied = false; ln.orig0 = null;
  }
}

module.exports = { applyLapLines, applyGameRecs, writeLapLines, restoreLapLines, parseLapFile, buildLapFile, readDisk, readLine, findLines, NAMES, lineScale, scaleRec, bracket, fuzzyRec };
