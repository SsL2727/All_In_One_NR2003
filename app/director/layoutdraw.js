// RaceVision 2.0 overlay layouts, drawn on a canvas: a port of racevision_layout.cpp's drawing (LayVal / LayExpand / LayShow /
// LayColor / LayElement / LayDraw). A layout is JSON: { title, panel, w, h, when, accent, rowGap, elements: [...] }, each element
// bound to live data ({car.last}, {race.lap}, {rc.tele.mph}, ...). It runs in the overlay window (tvoverlay.html) and in the
// hidden window that draws the editor's previews; the data comes as one snapshot built by director/layouts.js (snapshot()).
// Works in a browser page (window.RVLayout) and in node (module.exports) for the tests.
(function (root) {
  'use strict';

  // GDI+ colours RaceVision draws with (tv_director.cpp)
  const ACCENT = [255, 196, 0, 255], WHITE = [255, 255, 255, 255], GREY = [170, 176, 190, 255], RED = [235, 70, 60, 255],
    GREEN = [60, 200, 110, 255], BG = [14, 16, 22, 215 / 255], DASHBG = [10, 12, 16, 235 / 255], DIM = [52, 56, 64, 255];
  const NO_CAR = -100000;
  // RaceVision's sample field (the editor's preview, a panel with no live car)
  const SMP = [[24, 'Jeff', 'Gordon', 0x2a5db0], [48, 'Jimmie', 'Johnson', 0x1e90d6], [88, 'Dale', 'Jarrett', 0xd8a010],
    [8, 'Dale', 'Earnhardt Jr.', 0xc82828], [20, 'Tony', 'Stewart', 0x3cb44a], [17, 'Matt', 'Kenseth', 0x8a8a8a],
    [6, 'Mark', 'Martin', 0xe0e0e0], [99, 'Carl', 'Edwards', 0xd04010], [9, 'Kasey', 'Kahne', 0x40a0ff],
    [18, 'Bobby', 'Labonte', 0x30c030], [12, 'Ryan', 'Newman', 0xc0c0ff], [31, 'Jeff', 'Burton', 0xd0d000]];
  const RC_SAMPLE = {"feed_version":1,"session":"qualifying","qual":{"active":true,"show":true,"header":"ROUND 2  -  4:12","pole_num":"54","pole_name":"GIBBS","pole_time":"26.414","car_num":"24","car_name":"GORDON","car_pos":"3","right":"-0.041","right_mode":2,"projected":"26.402","faster":true},
    "tele":{"active":true,"show":true,"track":"INDIANAPOLIS","session":"QUALIFYING","num":"24","first":"JEFF","last":"GORDON","tele_ok":true,"mph":182,"rpm":8275,"rpm_top":9000,"throttle":0.85,"brake":0,"brake_known":true,"gear":4,"lap_no":2,"laps_total":3,"current":"13.202","last_lap":"26.502","best_lap":"26.414","faster":true,"show_order":true,
    "order":[{"pos":"1","num":"54","first":"CHASE","last":"GIBBS","time":"26.414","kind":"f"},{"pos":"2","num":"48","first":"JIMMIE","last":"JOHNSON","time":"26.455","kind":"f"},{"pos":"","num":"24","first":"JEFF","last":"GORDON","time":"13.202","kind":"l"}]},
    "cone":{"active":true,"show":true,"title":"DOUBLE FILE - 4 CARS","cars":4,"done":false,"version":7,
    "inside":[{"row":1,"lane":1,"num":"24","first":"JEFF","last":"GORDON","from":3,"to":1,"gained":2,"player":false},{"row":2,"lane":1,"num":"01","first":"JOHN","last":"DOE","from":4,"to":3,"gained":1,"player":false}],
    "outside":[{"row":1,"lane":2,"num":"48","first":"JIMMIE","last":"JOHNSON","from":2,"to":2,"gained":0,"player":false},{"row":2,"lane":2,"num":"00","first":"SAM","last":"NOUGHT","from":1,"to":4,"gained":0,"player":true}]}};

  const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'TH' : n % 10 === 1 ? 'ST' : n % 10 === 2 ? 'ND' : n % 10 === 3 ? 'RD' : 'TH');
  const lapStr = (ms) => (ms <= 0 ? '--' : ms >= 60000 ? Math.floor(ms / 60000) + ':' + ((ms % 60000) / 1000).toFixed(3).padStart(6, '0') : (ms / 1000).toFixed(3));
  const numLabel = (v) => {
    if (v === 100) return '00';
    if (v >= 2000) { const d = Math.floor(v / 1000), n = v % 1000; if (d >= 2 && d <= 3 && n < (d === 2 ? 100 : 1000)) return String(n).padStart(d, '0'); }
    return String(v);
  };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const fmtFixed = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : 'nan');

  // ---------------------------------------------------------------- the data
  // snap: { sample, car, other, top, bottom, battle, slide, cars: { slot: {...} }, order: [slots], race: {lap, lapsTotal, flag, session},
  //   track, trackLen, shotSub, story: { label, parts: [[text, colour]] } | null, battleKind, gap, metres, hi, replay, rc (feed | null),
  //   colors: { num: '#rrggbb' }, dash: { accent, accent2, artColors }, picUrl(file) -> url, numberArt(num) -> url, headshot(num) -> url }
  function who(cx, w) {
    const S = cx.snap;
    const pick = (slot, sidx, splace) => {
      if (cx.sample) return { sidx: ((sidx % 12) + 12) % 12, splace, ok: true, slot: -1 };
      if (slot != null && slot >= 0 && S.cars && S.cars[slot]) return { slot, ok: true };
      return { ok: false };
    };
    const order = S.order || [];
    const rel = (k) => { const i = order.indexOf(cx.car); if (i < 0) return -1; const at = i + k; return at >= 0 && at < order.length ? order[at] : -1; };
    if (w === 'car') return pick(cx.car, 0, 3);
    if (w === 'other') return pick(cx.other, 1, 2);
    if (w === 'top') return pick(cx.battle ? cx.top : cx.other, 1, 2);
    if (w === 'bottom') return pick(cx.battle ? cx.bottom : cx.car, 0, 3);
    if (w === 'leader') return pick(order.length ? order[0] : -1, 2, 1);
    if (w === 'ahead') return pick(rel(-1), 1, 2);
    if (w === 'behind') return pick(rel(1), 3, 4);
    const m = /^p(\d+)$/.exec(w);
    if (m) { const n = +m[1]; if (n >= 1 && n <= 99) return pick(n <= order.length ? order[n - 1] : -1, n + 1, n); }
    return { ok: false };
  }
  const isWho = (w) => /^(car|other|top|bottom|leader|ahead|behind|p\d+)$/.test(w);
  const V = { num: (n, d) => ({ s: d == null ? fmtFixed(n, 0) : fmtFixed(n, d), n, isNum: true, truth: n !== 0 }),
    str: (s) => ({ s: String(s == null ? '' : s), n: 0, truth: String(s == null ? '' : s) !== '' }),
    bool: (v, yes = 'YES', no = '') => ({ s: v ? yes : no, n: v ? 1 : 0, truth: !!v }) };
  const strN = (s, n) => Object.assign(V.str(s), { n });

  function carField(cx, d, f) {
    const S = cx.snap, live = d.slot >= 0, c = live ? S.cars[d.slot] : null, sm = SMP[d.sidx >= 0 ? d.sidx : 0];
    const number = live ? c.number : sm[0];
    const place = () => (live ? (c.pos || 0) : d.splace);
    const mph = () => { const v = !live ? 182 : (c.speed || 0) * 2.23694; return v < 0 || v > 400 || !Number.isFinite(v) ? 0 : v; };
    const rpm = () => (!live ? 8275 : c.rpm || 0);
    const thr = () => (!live ? 0.85 : clamp01(c.thr || 0));
    const brk = () => (!live ? 0 : clamp01(c.brk || 0));
    const gear = () => (!live ? 4 : c.gear == null ? -9 : c.gear);
    const steer = () => (!live ? -12 : c.steer || 0);
    switch (f) {
      case 'place': return V.num(place());
      case 'place_p': return strN('P' + place(), place());
      case 'place_ord': return strN(ordinal(place()), place());
      case 'number': return strN(numLabel(number), number);
      case 'first': return V.str(live ? c.first : sm[1]);
      case 'last': return V.str(live ? c.last : sm[2]);
      case 'full': return V.str(live ? (c.first + ' ' + c.last).trim() : sm[1] + ' ' + sm[2]);
      case 'short': return V.str(live ? (c.last || c.first) : sm[2]);
      case 'speed_mph': return V.num(mph());
      case 'speed_kph': return V.num(mph() * 1.609344);
      case 'rpm': return V.num(rpm());
      case 'rpm_10k': return V.num(clamp01(rpm() / 10000), 3);
      case 'rpm_frac': {
        const key = live ? d.slot : -1 - d.sidx, tops = cx.rpmTop || (cx.rpmTop = {});
        tops[key] = Math.max(tops[key] || 0, rpm(), 8000);
        return V.num(clamp01(rpm() / tops[key]), 3);
      }
      case 'gear': { const g = gear(); return strN(g === -9 ? '-' : g < 0 ? 'R' : g === 0 ? 'N' : String(g), g); }
      case 'in_gear': return V.bool(gear() > 0);
      case 'throttle': return V.num(thr(), 3);
      case 'brake': return V.num(brk(), 3);
      case 'throttle_pct': return V.num(thr() * 100);
      case 'brake_pct': return V.num(brk() * 100);
      case 'steer': return V.num(steer(), 1);
      case 'steer_abs': return V.num(Math.abs(steer()), 1);
      case 'laps': return V.num(live ? c.laps : 112);
      case 'laps_led': return V.num(live ? c.lapsLed || 0 : 31);
      case 'pits': return V.num(live ? c.pits || 0 : 2);
      case 'start_pos': return V.num(live ? c.startPos || 0 : 14);
      case 'places_gained': {
        const from = live ? c.startPos || 0 : 14, now = place();
        if (from <= 0) return V.str('');
        const dl = from - now;
        return { s: dl > 0 ? '+' + dl : dl < 0 ? '-' + (-dl) : 'EVEN', n: dl, truth: true };
      }
      case 'last_lap': { const ms = live ? c.lapLastMs || 0 : 48217; return { s: lapStr(ms), n: ms / 1000, truth: ms > 0 }; }
      case 'best_lap': { const ms = live ? c.lapBestMs || 0 : 47984; return { s: lapStr(ms), n: ms / 1000, truth: ms > 0 }; }
      case 'interval': case 'gap_leader': {
        if (!live) return V.str(f === 'interval' ? '+0.31' : '+3.84');
        const order = S.order || [], idx = order.indexOf(d.slot);
        if (idx <= 0) return V.str(idx === 0 ? 'LEADER' : '');
        const ref = S.cars[f === 'interval' ? order[idx - 1] : order[0]];
        if (!ref) return V.str('');
        const lapsDown = Math.floor((ref.progress - c.progress) / Math.max(S.trackLen || 0, 400) + 0.02);
        if (lapsDown >= 1) return strN('+' + lapsDown + (lapsDown >= 2 ? ' LAPS' : ' LAP'), lapsDown);
        const sec = Math.max(0, ref.progress - c.progress) / Math.max(c.speed || 0, 10);
        return strN('+' + sec.toFixed(sec >= 10 ? 1 : 2), sec);
      }
      case 'pit': return V.bool(live && !!c.pit);
      case 'color': return V.bool(live ? !!colorOf(S, number) : true);
      case 'has_card': return V.bool(!!(S.numberArt && S.numberArt(number)));
      case 'valid': return V.bool(true);
    }
    return null;
  }
  const colorOf = (S, num) => (S.colors && (S.colors[numLabel(num)] || S.colors[String(num)])) || null;

  // RaceControl's feed: rc.qual.*, rc.tele.*, rc.cone.*, lists count from 1
  function rcWalk(rootObj, path) {
    let cur = rootObj;
    for (const seg of path.split('.')) {
      if (!seg) return undefined;
      if (Array.isArray(cur)) { const k = parseInt(seg, 10); cur = k >= 1 && k <= cur.length ? cur[k - 1] : undefined; }
      else if (cur && typeof cur === 'object') cur = cur[seg];
      else return undefined;
      if (cur === undefined) return undefined;
    }
    return cur;
  }
  function rcVal(cx, path) {
    if (path === 'live') return V.bool(cx.sample || !!cx.snap.rc);
    const feed = cx.sample ? RC_SAMPLE : cx.snap.rc;
    if (!feed) return null;
    if (path === 'tele.rpm_frac') {
      const r = rcWalk(feed, 'tele.rpm'), t = rcWalk(feed, 'tele.rpm_top');
      if (typeof r !== 'number' || typeof t !== 'number') return { unknown: true };
      return V.num(t > 0 ? clamp01(r / t) : 0, 3);
    }
    const v = rcWalk(feed, path);
    if (v === undefined) return { unknown: true };
    if (typeof v === 'string') return strN(v, parseFloat(v) || 0);
    if (typeof v === 'number') return V.num(v, v === Math.floor(v) ? 0 : 3);
    if (typeof v === 'boolean') return V.bool(v);
    if (Array.isArray(v)) return V.num(v.length);
    return V.str('');
  }
  function rcWhen(cx, tok) {
    let path = tok.slice(3);
    if (path.indexOf('.') < 0 && path !== 'live') path += '.show';
    const v = rcVal({ snap: cx.snap, sample: false }, path);
    return !!(v && !v.unknown && v.truth);
  }

  // -> value object, or null (no such car: the text stays off), or { unknown: true } (no such field: shows ?)
  function val(name, cx) {
    const S = cx.snap, dot = name.indexOf('.');
    if (dot < 0) { if (name === 'replay') return V.bool(!!S.replay); return { unknown: true }; }
    const a = name.slice(0, dot), f = name.slice(dot + 1);
    if (a === 'rc') return rcVal(cx, f);
    if (isWho(a)) {
      const d = who(cx, a);
      if (!d.ok) return null;
      return carField(cx, d, f) || { unknown: true };
    }
    if (a === 'shot' && f === 'sub') return V.str(cx.sample ? 'in battle with Johnson for 3rd' : S.shotSub || '');
    if (a === 'story') {
      const st = cx.sample ? { label: 'LAP 112', parts: [['RUNNING ', '#ffc400'], ['3RD  -  0.31s behind Johnson', '#aab0be']] } : S.story;
      if (f === 'any') return V.bool(!!st);
      if (f === 'label') return V.str(st ? st.label : '');
    }
    if (a === 'battle') {
      const hi = cx.sample ? 2 : S.hi || 0, pass = !cx.sample && S.battleKind === 'pass';
      if (f === 'title') return V.str((pass ? 'PASS FOR P' : 'BATTLE FOR P') + hi);
      if (f === 'title_ord') return V.str((pass ? 'PASS FOR ' : 'BATTLE FOR ') + ordinal(hi));
      if (f === 'place') return V.num(hi);
      if (f === 'gap') return V.num(cx.sample ? 0.31 : S.gap || 0, 2);
      if (f === 'metres') return V.num(cx.sample ? 24 : S.metres || 0);
    }
    if (a === 'race') {
      const R = S.race || {}, lap = cx.sample ? 112 : R.lap || 0, tot = cx.sample ? 200 : R.lapsTotal || 0;
      if (f === 'lap') return V.num(lap);
      if (f === 'laps_total') return V.num(tot);
      if (f === 'progress') return V.num(cx.sample ? 0.56 : tot > 0 ? Math.min(1, lap / tot) : 0, 3);
      if (f === 'laps_to_go') return V.num(cx.sample ? 88 : Math.max(0, tot - lap));
      if (f === 'green') return V.bool(cx.sample || R.flag === 7);
      if (f === 'flag') return V.str(cx.sample || R.flag === 7 ? 'GREEN' : R.flag === 5 ? 'ONE TO GO' : R.flag === 0 || R.flag == null ? '' : 'CAUTION');
    }
    if (a === 'track' && f === 'name') return V.str(cx.sample ? 'Talladega' : S.track || '');
    return { unknown: true };
  }

  // "{car.last}", "{car.speed_mph:0}" (digits = decimals); null = a car is not there (the whole text stays off)
  function expand(tpl, cx) {
    let out = '', missing = false;
    const s = String(tpl == null ? '' : tpl);
    for (let i = 0; i < s.length;) {
      if (s[i] === '{') {
        const e = s.indexOf('}', i);
        if (e < 0) { out += s.slice(i); break; }
        let tok = s.slice(i + 1, e), fmt = '';
        const c = tok.indexOf(':');
        if (c >= 0) { fmt = tok.slice(c + 1); tok = tok.slice(0, c); }
        const v = val(tok, cx);
        if (v && !v.unknown) out += v.isNum && fmt && /^\d/.test(fmt) ? fmtFixed(v.n, Math.min(6, parseInt(fmt, 10))) : v.s;
        else if (v && v.unknown) out += '?';
        else missing = true;
        i = e + 1;
      } else {
        let e = s.indexOf('{', i); if (e < 0) e = s.length;
        out += s.slice(i, e); i = e;
      }
    }
    return missing ? null : out;
  }
  function show(rule, cx) {
    for (const raw of String(rule || '').split(/[ ,]+/)) {
      if (!raw) continue;
      const neg = raw[0] === '!', tok = neg ? raw.slice(1) : raw;
      const v = val(tok, cx), t = !!(v && !v.unknown && v.truth);
      if (t === neg) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- colours ([r, g, b, a 0-1])
  const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1]; };
  function paint(cx, w) {
    const d = who(cx, w);
    if (!d.ok) return { c: ACCENT.slice(0, 3).concat(1), has: false };
    if (d.slot < 0) { const r = SMP[d.sidx][3]; return { c: [(r >> 16) & 255, (r >> 8) & 255, r & 255, 1], has: true }; }
    const h = hexRgb(colorOf(cx.snap, cx.snap.cars[d.slot].number));
    return h ? { c: h, has: true } : { c: [255, 196, 0, 1], has: false };
  }
  const numberOf = (cx, w) => { const d = who(cx, w); return !d.ok ? NO_CAR : d.slot >= 0 ? cx.snap.cars[d.slot].number : SMP[d.sidx][0]; };
  const mixWhite = (c, minLum) => { const l = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255; if (l >= minLum) return c; const t = (minLum - l) / Math.max(0.01, 1 - l); return [0, 1, 2].map(i => Math.round(c[i] + (255 - c[i]) * t)).concat(1); };
  const darker = (c, k) => [Math.floor(c[0] * k), Math.floor(c[1] * k), Math.floor(c[2] * k), 1];
  function color(spec, cx, opacity) {
    let col = [255, 255, 255, 1];
    spec = String(spec == null ? '' : spec);
    if (spec[0] === '#') {
      const hex = spec.slice(1);
      const v = parseInt(hex.slice(0, 8), 16) >>> 0;
      if (hex.length >= 8) col = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, (v & 255) / 255];
      else { const w = parseInt(hex.slice(0, 6), 16); col = [(w >> 16) & 255, (w >> 8) & 255, w & 255, 1]; }
    } else if (spec[0] === '@') {
      let name = spec.slice(1), wh = '';
      const c = name.indexOf(':'); if (c >= 0) { wh = name.slice(c + 1); name = name.slice(0, c); }
      const g = (a) => [a[0], a[1], a[2], a[3] > 1 ? a[3] / 255 : a[3]];
      if (name === 'gold') col = g(ACCENT); else if (name === 'white') col = g(WHITE); else if (name === 'grey') col = g(GREY);
      else if (name === 'red') col = g(RED); else if (name === 'green') col = g(GREEN); else if (name === 'bg') col = BG.slice();
      else if (name === 'dashbg') col = DASHBG.slice(); else if (name === 'dim') col = g(DIM);
      else if (['car', 'other', 'top', 'bottom', 'leader'].includes(name)) col = paint(cx, name).c;
      else if (name === 'dash' || name === 'dashfrom' || name === 'dashto') {
        const D = cx.snap.dash || {}, base = hexRgb(D.accent) || [232, 200, 74, 1], to0 = hexRgb(D.accent2) || [20, 90, 96, 1];
        const num = numberOf(cx, wh || cx.accent || 'car');
        let art = null;
        if (D.artColors && num !== NO_CAR) art = cx.sample ? null : hexRgb(colorOf(cx.snap, num));
        const dashAcc = art ? mixWhite(art, 0.42) : base;
        let from = dashAcc, to = to0;
        if (art) { from = mixWhite(art, 0.12); to = darker(from, 0.35); }
        col = name === 'dash' ? dashAcc : name === 'dashfrom' ? from : to;
      }
    }
    if (opacity < 1) col = [col[0], col[1], col[2], col[3] * Math.max(0, opacity)];
    return col;
  }
  const css = (c) => `rgba(${c[0]},${c[1]},${c[2]},${+(c[3]).toFixed(4)})`;

  // ---------------------------------------------------------------- drawing
  // fonts: "" / ui = Segoe UI, dash = the condensed TV face (Bahnschrift), else a family by name (layouts\fonts are loaded as faces)
  const fam = (name) => (!name || name === 'ui' ? '"Segoe UI"' : name === 'dash' ? '"Bahnschrift SemiBold Condensed","Bahnschrift Condensed","Bahnschrift","Segoe UI"' : `"${name}","Segoe UI"`);
  const fontCss = (family, size, bold, italic) => `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${size}px ${fam(family)}`;
  // text never runs past its room and never wraps: condensed sideways first (to 72%), then smaller as well (FitText)
  function drawSqueezed(g, s, font, fill, x, y, size, sx, sy) {
    g.save(); g.font = font; g.fillStyle = fill; g.textBaseline = 'top'; g.textAlign = 'left';
    g.translate(x, y + size * 0.6 * (1 - sy) + size * 0.06); g.scale(sx, sy); g.fillText(s, 0, 0); g.restore();
  }
  function fitText(g, s, family, size, bold, italic, col, x, y, align, w) {
    const font = fontCss(family, size, bold, italic);
    g.font = font;
    const pad = size / 6, room = w - 2 * pad, ink = g.measureText(s).width;
    if (!(w > 0) || room <= 0) { drawSqueezed(g, s, font, css(col), x, y, size, 1, 1); return; }
    const k = ink > room ? room / ink : 1, sx = k, sy = Math.min(1, k / 0.72), used = ink * k;
    const left = align === 'center' ? x + (w - used) / 2 : align === 'right' ? x + w - pad - used : x + pad;
    drawSqueezed(g, s, font, css(col), left, y, size, sx, sy);
  }
  function drawRun(g, run, family, size, bold, italic, x, y, maxW) {
    const font = fontCss(family, size, bold, italic);
    g.font = font;
    const adv = run.map(p => g.measureText(p[0]).width);
    const total = adv.reduce((a, b) => a + b, 0);
    const k = total > maxW && total > 0 ? Math.max(0, maxW) / total : 1, sx = k, sy = Math.min(1, k / 0.72);
    for (let i = 0; i < run.length; i++) { drawSqueezed(g, run[i][0], font, css(run[i][1]), x, y, size, sx, sy); x += adv[i] * k; }
  }
  function pathRect(g, x, y, w, h, r, slant) {
    g.beginPath();
    if (slant) { g.moveTo(x, y); g.lineTo(x + w, y); g.lineTo(x + w - slant, y + h); g.lineTo(x, y + h); g.closePath(); }
    else if (r > 0) {
      r = Math.min(r, Math.min(w, h) / 2);
      g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
    } else g.rect(x, y, w, h);
  }
  const imgOk = (im) => im && im.complete !== false && (im.naturalWidth || im.width) > 0;
  const iw = (im) => im.naturalWidth || im.width, ih = (im) => im.naturalHeight || im.height;
  function drawFit(g, im, x, y, w, h, right) {
    if (!imgOk(im)) return 0;
    const k = Math.min(w / iw(im), h / ih(im)), dw = iw(im) * k, dh = ih(im) * k;
    g.drawImage(im, right ? x + w - dw : x, y + (h - dh) / 2, dw, dh);
    return dw;
  }

  function ordinalEl(g, n, x, y, size, under, family, col) {
    const ord = ordinal(n), cut = ord.length - 2;
    fitText(g, ord.slice(0, cut), family, size, true, true, col, x, y, 'left', 0);
    g.font = fontCss(family, size, true, true);
    const wDig = g.measureText(ord.slice(0, cut)).width;
    fitText(g, ord.slice(cut), family, size * 0.44, true, true, col, x + wDig + size * 0.24, y + size * 0.12, 'left', 0);
    if (under) fitText(g, under, family, size * 0.41, true, true, col, x + 2, y + size * 1.06, 'left', 0);
  }
  function portrait(g, e, cx, number, x, y, w, h, fill, dashFont, img) {
    const tab = e.tab !== false, offset = tab ? num(e.offset, 8) : 0;
    let zoom = e.zoom != null ? +e.zoom : num(cx.snap.headshotZoom, 1.35); if (zoom < 0.5) zoom = 0.5;
    if (e.back) { g.fillStyle = css(color(e.back, cx, 1)); g.fillRect(x, y, w, h); }
    const head = img(cx.snap.headshot ? cx.snap.headshot(number) : null);
    if (imgOk(head)) {
      const W = iw(head), H = ih(head), aspect = w / h, sw = Math.min(W, H * aspect) / zoom, sh = sw / aspect;
      const sx = (W - sw) / 2, sy = Math.min(H * num(e.top, 0.03), Math.max(0, H - sh));
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.drawImage(head, sx, sy, sw, sh, x, y, w, h); g.restore();
    }
    if (!tab) return;
    const ph = h * 0.30, py = y + h - ph;
    g.fillStyle = css(fill); g.fillRect(x - offset, py, w + offset, ph);
    const card = img(cx.snap.numberArt ? cx.snap.numberArt(number) : null);
    if (imgOk(card)) drawFit(g, card, x - offset + 4, py + 2, w + offset - 8, ph - 4);
    else if (dashFont) fitText(g, numLabel(number), 'dash', ph, true, true, [255, 196, 0, 1], x - offset, py - 2, 'center', w + offset);
    else fitText(g, '#' + numLabel(number), '', ph * 0.8, true, false, [255, 196, 0, 1], x - offset, py + 1, 'center', w + offset);
  }
  const num = (v, d) => (v == null || v === '' || !Number.isFinite(+v) ? d : +v);

  function element(g, e, cx, dy, img) {
    if (e.show && !show(e.show, cx)) return;
    if (e.hidden) return;
    const type = e.type || '';
    let x = num(e.x, 0), y = num(e.y, 0) + dy, w = num(e.w, 0), h = num(e.h, 0);
    const size = num(e.size, 20), op = e.opacity != null ? num(e.opacity, 1) : 1;
    const col = (k, d) => color(e[k] != null ? e[k] : d, cx, op);
    const dashFont = e.font === 'dash';
    const bold = e.bold !== false, italic = e.italic != null ? !!e.italic : dashFont;
    if (type === 'rect') {
      const sw = num(e.strokeW, 0);
      pathRect(g, x, y, w, h, num(e.radius, 0), num(e.slant, 0));
      if (e.fill != null) {
        if (e.fill2 != null) { const gr = g.createLinearGradient(x, y, x + w, y + h); gr.addColorStop(0, css(col('fill', '#ffffff'))); gr.addColorStop(1, css(col('fill2', '#000000'))); g.fillStyle = gr; }
        else g.fillStyle = css(col('fill', '#ffffff'));
        g.fill();
      }
      if (e.stroke != null && sw > 0) {
        pathRect(g, x + sw / 2, y + sw / 2, w - sw, h - sw, Math.max(0, num(e.radius, 0) - sw / 2), 0);
        g.strokeStyle = css(col('stroke', '#ffffff')); g.lineWidth = sw; g.stroke();
      }
    } else if (type === 'text') {
      let s = expand(e.text, cx);
      if (s == null) return;
      if (e.upper) s = s.toUpperCase();
      if (!s) return;
      fitText(g, s, e.font || '', size, bold, italic, col('color', '#ffffff'), x, y, e.align || 'left', w);
    } else if (type === 'run') {
      const run = [];
      for (const p of e.parts || []) {
        if (p.story) {
          const st = cx.sample ? { parts: [['RUNNING ', '#ffc400'], ['3RD  -  0.31s behind Johnson', '#aab0be']] } : cx.snap.story;
          if (st) for (const q of st.parts || []) run.push([q[0], color(q[1], cx, op)]);
        } else { const t = expand(p.text, cx); if (t != null) run.push([t, color(p.color != null ? p.color : '#ffffff', cx, op)]); }
      }
      if (e.upper) run.forEach(p => { p[0] = p[0].toUpperCase(); });
      if (run.some(p => p[0].trim())) drawRun(g, run, e.font || '', size, bold, italic, x, y, w);
    } else if (type === 'ordinal') {
      const v = val(e.src || '', cx);
      if (!v || v.unknown || !v.isNum) return;
      ordinalEl(g, Math.round(v.n), x, y, size, expand(e.under, cx) || '', e.font || 'dash', col('color', '#ffffff'));
    } else if (type === 'image') {
      if (e.art) {
        const d = who(cx, e.who || 'car');
        if (!d.ok) return;
        const n = d.slot >= 0 ? cx.snap.cars[d.slot].number : SMP[d.sidx][0];
        const im = img(e.art === 'headshot' ? (cx.snap.headshot && cx.snap.headshot(n)) : (cx.snap.numberArt && cx.snap.numberArt(n)));
        if (imgOk(im)) drawFit(g, im, x, y, w, h, !!e.alignRight);
      } else {
        const im = img(cx.snap.picUrl ? cx.snap.picUrl(e.file) : null);
        if (!imgOk(im)) return;
        if (w <= 0) w = iw(im); if (h <= 0) h = ih(im);
        g.save(); g.globalAlpha = Math.max(0, Math.min(1, op));
        if (e.fit === 'contain') { const k = Math.min(w / iw(im), h / ih(im)), dw = iw(im) * k, dh = ih(im) * k; g.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); }
        else g.drawImage(im, x, y, w, h);
        g.restore();
      }
    } else if (type === 'portrait') {
      const d = who(cx, e.who || 'car');
      if (!d.ok) return;
      const n = d.slot >= 0 ? cx.snap.cars[d.slot].number : SMP[d.sidx][0];
      portrait(g, e, cx, n, x, y, w, h, color(e.fill != null ? e.fill : '#0a0c10eb', cx, op), dashFont, img);
    } else if (['bar', 'segbar', 'arc', 'dial', 'needle'].includes(type)) {
      const v = val(e.src || '', cx);
      if (!v || v.unknown || !v.isNum) return;
      const mn = num(e.min, 0), mx = num(e.max, 1), frac = clamp01((v.n - mn) / (mx - mn !== 0 ? mx - mn : 1));
      const fill = col('color', '#ffc400'), track = col('track', '#343840');
      if (type === 'needle') {
        const im = img(cx.snap.picUrl ? cx.snap.picUrl(e.file) : null);
        if (!imgOk(im)) return;
        const ang = num(e.from, -120) + num(e.sweep, 240) * frac, pw = w > 0 ? w : iw(im), ph = h > 0 ? h : ih(im);
        const px = num(e.pivotX, 0.5) * pw, py = num(e.pivotY, 0.5) * ph;
        g.save(); g.globalAlpha = Math.max(0, Math.min(1, op)); g.translate(x + px, y + py); g.rotate(ang * Math.PI / 180); g.drawImage(im, -px, -py, pw, ph); g.restore();
      } else if ((type === 'bar' || type === 'dial') && (e.fillFile || e.trackFile)) {
        const tr = img(cx.snap.picUrl ? cx.snap.picUrl(e.trackFile) : null), fl = img(cx.snap.picUrl ? cx.snap.picUrl(e.fillFile) : null);
        g.save(); g.globalAlpha = Math.max(0, Math.min(1, op));
        if (imgOk(tr)) g.drawImage(tr, x, y, w, h);
        if (imgOk(fl) && frac > 0) {
          g.save(); g.beginPath();
          if (type === 'dial') {
            const from = num(e.from, -90), sweep = num(e.sweep, 360) * frac, cx0 = x + num(e.pivotX, 0.5) * w, cy0 = y + num(e.pivotY, 0.5) * h, R = Math.max(w, h) * 2;
            g.moveTo(cx0, cy0); g.arc(cx0, cy0, R, from * Math.PI / 180, (from + sweep) * Math.PI / 180, sweep < 0); g.closePath();
          } else {
            const dir = e.dir || 'right';
            if (dir === 'left') g.rect(x + w * (1 - frac), y, w * frac, h); else if (dir === 'up') g.rect(x, y + h * (1 - frac), w, h * frac);
            else if (dir === 'down') g.rect(x, y, w, h * frac); else g.rect(x, y, w * frac, h);
          }
          g.clip(); g.drawImage(fl, x, y, w, h); g.restore();
        }
        g.restore();
      } else if (type === 'bar') {
        g.fillStyle = css(track); g.fillRect(x, y, w, h); g.fillStyle = css(fill);
        if (e.vertical) g.fillRect(x, y + h * (1 - frac), w, h * frac); else g.fillRect(x, y, w * frac, h);
      } else if (type === 'segbar') {
        const segs = Math.min(80, Math.max(1, Math.floor(num(e.segs, 12)))), lit = Math.floor(frac * segs + 0.5), hot = Math.floor(num(e.hot, 0));
        const gap = num(e.gap, 1), pitch = (e.vertical ? h : w) / segs;
        const c2 = color(e.color2 != null ? e.color2 : (e.color != null ? e.color : '#ffc400'), cx, op), ch = col('hotColor', '#eb3c28');
        for (let k = 0; k < segs; k++) {
          const t = segs > 1 ? k / (segs - 1) : 0;
          const c = k >= lit ? track : k >= segs - hot ? ch : [Math.floor(fill[0] + (c2[0] - fill[0]) * t), Math.floor(fill[1] + (c2[1] - fill[1]) * t), Math.floor(fill[2] + (c2[2] - fill[2]) * t), fill[3]];
          g.fillStyle = css(c);
          if (e.vertical) g.fillRect(x, y + h - (k + 1) * pitch + gap, w, pitch - gap); else g.fillRect(x + k * pitch, y, pitch - gap, h);
        }
      } else {     // arc
        const from = num(e.from, 150), sweep = num(e.sweep, 240), thick = num(e.thick, 12), segs = Math.min(80, Math.max(1, Math.floor(num(e.segs, 24))));
        const ell = (a0, sw, c) => { g.save(); g.beginPath(); g.translate(x + w / 2, y + h / 2); g.scale(w / 2 || 1e-6, h / 2 || 1e-6); g.arc(0, 0, 1, a0 * Math.PI / 180, (a0 + sw) * Math.PI / 180); g.restore(); g.strokeStyle = css(c); g.lineWidth = thick; g.stroke(); };
        ell(from, sweep, track);
        const c2 = color(e.color2 != null ? e.color2 : (e.color != null ? e.color : '#ffc400'), cx, op);
        for (let k = 0; k < segs && k < Math.floor(frac * segs + 0.5); k++) {
          const t = segs > 1 ? k / (segs - 1) : 0;
          ell(from + sweep * k / segs, sweep / segs + 0.6, [Math.floor(fill[0] + (c2[0] - fill[0]) * t), Math.floor(fill[1] + (c2[1] - fill[1]) * t), Math.floor(fill[2] + (c2[2] - fill[2]) * t), fill[3]]);
        }
      }
    }
  }

  // ---------------------------------------------------------------- a whole layout
  // layout: the JSON; snap: the data; opts: { sample, panel (key), img(url) -> HTMLImageElement|null (cached, may still be loading) }
  // the drawing context: whose car is on screen, the battle pair, sample data or live
  function context(layout, snap, sample, rpmTop) {
    const cx = { snap: snap || {}, sample: !!sample, accent: (layout && layout.accent) || 'car', rpmTop };
    const S = cx.snap;
    cx.car = S.car == null ? -1 : S.car; cx.other = S.other == null ? -1 : S.other;
    if (((layout && layout.panel) || 'custom') === 'battle') {
      cx.battle = true;
      if (cx.sample || cx.other < 0 || cx.car < 0) cx.sample = true;
      else { cx.top = S.top == null ? cx.other : S.top; cx.bottom = S.bottom == null ? cx.car : S.bottom; }
    }
    if (cx.sample) { cx.car = -1; cx.other = -1; }
    return cx;
  }
  function draw(g, layout, snap, opts) {
    opts = opts || {};
    const cx = context(layout, snap, opts.sample, opts.rpmTop), S = cx.snap;
    const slide = cx.sample ? 1 : (S.slide == null ? 1 : S.slide);
    const ease = slide * slide * (3 - 2 * slide), off = (1 - ease) * num(layout.rowGap, 34);
    const img = opts.img || (() => null);
    for (const el of layout.elements || []) {
      try { element(g, el, cx, el.row === 'top' ? off : el.row === 'bottom' ? -off : 0, img); } catch (err) { /* one bad element never stops the rest */ }
    }
  }

  // every picture a layout may draw, so a render can load them first
  function pictures(layout, snap, sample) {
    const out = new Set(), S = snap || {};
    const add = (u) => { if (u) out.add(u); };
    const nums = new Set();
    if (sample) SMP.forEach(s => nums.add(s[0]));
    else for (const k of Object.keys(S.cars || {})) nums.add(S.cars[k].number);
    for (const e of layout.elements || []) {
      if (e.type === 'image' && !e.art && S.picUrl) add(S.picUrl(e.file));
      if ((e.type === 'needle' || e.type === 'bar' || e.type === 'dial') && S.picUrl) { add(S.picUrl(e.file)); add(S.picUrl(e.fillFile)); add(S.picUrl(e.trackFile)); }
      if ((e.type === 'image' && e.art) || e.type === 'portrait') for (const n of nums) { if (S.numberArt) add(S.numberArt(n)); if (S.headshot) add(S.headshot(n)); }
    }
    return [...out];
  }

  // a layout's "when": words that must all hold - always, race, green, onboard, offboard, battle, replay, rc.<group>[.<flag>]
  function when(layout, snap, o) {
    const S = snap || {};
    for (const t of String(layout.when || '').toLowerCase().split(/[ ,]+/)) {
      if (!t || t === 'always') continue;
      if (t.startsWith('rc.')) { if (!rcWhen({ snap: S }, t)) return false; continue; }
      const race = S.race && S.race.session === 'race';
      const ok = t === 'race' ? race : t === 'green' ? race && S.race.flag === 7 : t === 'onboard' ? !!o.onboard : t === 'offboard' ? !o.onboard
        : t === 'battle' ? !!o.battleShot : t === 'replay' ? !!S.replay : true;
      if (!ok) return false;
    }
    return true;
  }
  const rcShowing = (snap, group) => rcWhen({ snap }, 'rc.' + group);

  // the snapshot as it comes over IPC (plain data) made ready to draw: art / picture lookups from its maps
  function hydrate(snap, pics) {
    const S = snap || {};
    const art = S.art || {};
    S.numberArt = (n) => (art[n] && art[n].number) || '';
    S.headshot = (n) => (art[n] && art[n].head) || '';
    S.picUrl = (f) => (f && pics && pics[f]) || '';
    return S;
  }
  // fonts: one face per file (weight / style from the file name: Bold, Black, SemiBold, Italic)
  function fontFace(f) {
    const n = String(f.file || ''), w = /black|heavy/i.test(n) ? '900' : /extrabold/i.test(n) ? '800' : /semibold|demi/i.test(n) ? '600' : /bold/i.test(n) ? '700' : /medium/i.test(n) ? '500' : /light/i.test(n) ? '300' : '400';
    return { family: f.family, url: f.url, weight: w, style: /italic|oblique/i.test(n) ? 'italic' : 'normal' };
  }

  const api = { draw, pictures, hydrate, fontFace, when, rcShowing, expand: (t, snap, sample) => expand(t, context(null, snap, sample)), show: (r, snap, sample) => show(r, context(null, snap, sample)),
    color: (s, snap) => css(color(s, context(null, snap, false), 1)), ordinal, numLabel, lapStr, SMP, RC_SAMPLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RVLayout = api;
})(typeof window !== 'undefined' ? window : this);
