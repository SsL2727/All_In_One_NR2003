// RaceLab's allies and rivals, in the shape All In One NR2003 already uses for AIMOD's racing intensity & rivals, so they reach the same places:
// the TV director (rival battles worth more, the battle label, the driver's story line), the rivals card in the graphics window, and the
// Season Tracker (the race's feuds saved with a counted race).
//
// RaceLab keeps them in RaceLabV2Relationships.ini, one section per driver pair:
//   DriverA=alex_bowman  DriverB=kyle_larson  ScoreAToB=-52.000 (how A sees B)  ScoreBToA=12.000  SameTeam=0  PositiveEvents  NegativeEvents
// A driver id is the driver's name in lower case with '_' between words ("Ricky Stenhouse Jr." -> ricky_stenhouse_jr).
// Its thresholds (SpinMod.log [RivalrySystem]): ally >= 40, trusted >= 70, rival <= -40, contact <= -60, intense <= -80; the rival ones are
// RivalThreshold / ContactRivalThreshold / IntenseRivalThreshold in SpinMod.ini [RivalrySystem].
// Live events are in SpinMod.log: [RivalryEvent] scope=AI-AI event=CONTACT|SPIN|WRECK|BLOCK|DRAFT-HELP|TEAM-BETRAYAL actor=<id> target=<id> ...
'use strict';

const ALLY = 40, TRUSTED = 70;
const ONSCREEN_M = 30;               // AIMOD's ONSCREEN_M: the card shows only for a car this close to the TV car, with no car between them
const NEGATIVE = new Set(['CONTACT', 'SPIN', 'WRECK', 'BLOCK', 'TEAM-BETRAYAL']);

function driverId(first, last) {
  return (String(first || '') + ' ' + String(last || '')).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// RaceLabV2Relationships.ini -> [{ a, b, ab, ba, sameTeam, pos, neg }]
function parseRelationships(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';') continue;
    if (line[0] === '[') { cur = { a: '', b: '', ab: 0, ba: 0, sameTeam: false, pos: 0, neg: 0 }; out.push(cur); continue; }
    if (!cur) continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
    if (k === 'DriverA') cur.a = v.toLowerCase(); else if (k === 'DriverB') cur.b = v.toLowerCase();
    else if (k === 'ScoreAToB') cur.ab = Number(v) || 0; else if (k === 'ScoreBToA') cur.ba = Number(v) || 0;
    else if (k === 'SameTeam') cur.sameTeam = v === '1'; else if (k === 'PositiveEvents') cur.pos = Number(v) || 0; else if (k === 'NegativeEvents') cur.neg = Number(v) || 0;
  }
  return out.filter(p => p.a && p.b);
}

// SpinMod.log lines -> [{ event, actor, target, t }] (AI-AI relationship events)
function parseEvents(text) {
  const out = [];
  const rx = /^(\S+ \S+)\s+\[RivalryEvent\][^\n]*?event=([A-Z-]+)[^\n]*?actor=(\S+)[^\n]*?target=(\S+)/;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.indexOf('[RivalryEvent]') < 0) continue;
    const m = rx.exec(line);
    if (m) out.push({ t: m[1], event: m[2], actor: m[3].toLowerCase(), target: m[4].toLowerCase() });
  }
  return out;
}

// the rivalries / alliances among the cars of this race.
// cars: [{ num, first, last }]; th: { rival, contact, intense } (RaceLab's, negative)
// -> { rivals: [{ a, b, level 1-3, holder (car number holding a one-way grudge) | null, kind }], allies: [{ a, b, trusted, team }] }
function forField(pairs, cars, th) {
  const T = Object.assign({ rival: -40, contact: -60, intense: -80 }, th || {});
  const byId = new Map();
  for (const c of cars || []) { const id = driverId(c.first, c.last); if (id && c.num != null && !byId.has(id)) byId.set(id, Number(c.num)); }
  const rivals = [], allies = [];
  for (const p of pairs || []) {
    const A = byId.get(p.a), B = byId.get(p.b);
    if (A == null || B == null || A === B) continue;
    const low = Math.min(p.ab, p.ba);
    if (low <= T.rival) {
      const level = low <= T.intense ? 3 : low <= T.contact ? 2 : 1;
      const aBad = p.ab <= T.rival, bBad = p.ba <= T.rival;
      const holder = aBad && !bBad ? A : bBad && !aBad ? B : null;        // only one of them sees the other as a rival: a grudge
      rivals.push({ a: A, b: B, level, holder, kind: level >= 2 ? 'feud' : holder != null ? 'grudge' : 'rival' });
    } else if (p.ab >= ALLY && p.ba >= ALLY) {
      allies.push({ a: A, b: B, trusted: Math.min(p.ab, p.ba) >= TRUSTED, team: !!p.sameTeam });
    }
  }
  return { rivals, allies };
}

// the race's feuds for the Season Tracker, in AIMOD's race_rivals form: [{ a, b, level, runins, settled, retaliate, holder, listed }]
// events: parseEvents of this race (run-ins = negative events between the two drivers)
function raceRivals(rel, cars, events) {
  const idOf = new Map();
  for (const c of cars || []) idOf.set(Number(c.num), driverId(c.first, c.last));
  const runins = new Map();
  for (const e of events || []) {
    if (!NEGATIVE.has(e.event)) continue;
    const k = [e.actor, e.target].sort().join('|');
    runins.set(k, (runins.get(k) || 0) + 1);
  }
  return (rel.rivals || []).map(r => ({
    a: r.a, b: r.b, level: r.level, holder: r.holder, settled: 0, listed: false,
    runins: runins.get([idOf.get(r.a), idOf.get(r.b)].sort().join('|')) || 0,
    retaliate: false,
  }));
}

// AIMOD's close_enough_for_screen: within ONSCREEN_M of the TV car and no other car nearer to both of them than they are to each other
function closeEnough(me, other, cars) {
  if (!Number.isFinite(me.x) || !Number.isFinite(other.x)) return false;
  const d = Math.hypot(me.x - other.x, me.y - other.y);
  if (d > ONSCREEN_M) return false;
  for (const o of cars) {
    if (o === me || o === other || o.pace || !Number.isFinite(o.x)) continue;
    if (Math.hypot(o.x - me.x, o.y - me.y) < d && Math.hypot(o.x - other.x, o.y - other.y) < d) return false;
  }
  return true;
}

// the rivals card: the car on TV and a RaceLab rival racing right with him, else a TRUSTED ally (score >= 70 both ways; plain allies
// are left out: RaceLab makes most drafting partners allies) -> { car, rival, kind: feud|grudge|rival|ally, level } | null
function onScreen(rel, cars, tvSlot) {
  if (tvSlot == null || tvSlot < 0 || !cars) return null;
  const me = cars.find(c => c.slot === tvSlot && !c.pace);
  if (!me) return null;
  const num = Number(me.num);
  const pick = (list, kindOf) => {
    let best = null;
    for (const r of list) {
      const other = r.a === num ? r.b : r.b === num ? r.a : null;
      if (other == null) continue;
      const oc = cars.find(c => Number(c.num) === other && !c.pace);
      if (!oc || !closeEnough(me, oc, cars)) continue;
      const lvl = r.level || 0;
      if (!best || lvl > best.level) best = { car: String(num), rival: String(other), kind: kindOf(r), level: lvl };
    }
    return best;
  };
  return pick(rel.rivals || [], r => r.kind) || pick((rel.allies || []).filter(a => a.trusted), () => 'ally');
}

module.exports = { ALLY, TRUSTED, ONSCREEN_M, driverId, parseRelationships, parseEvents, forField, raceRivals, onScreen, closeEnough };
