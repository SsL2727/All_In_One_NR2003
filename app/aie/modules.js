// The "Special Modes" of AI Enhanced that All In One NR2003 runs: Side Drafting, Tandem Drafting and Long Run Spread (plus MultiGroove, Awareness and Self Spins; Pit Adjustments is left to AIMOD). Each returns grip/power factors per car; the service multiplies the
// factors of every module together and scales the car's three driver-stat bytes by the result.
'use strict';
const { sideDraft } = require('./sidedraft');
const { Tandem } = require('./tandem');
const { LongRun } = require('./longrun');
const { MultiGroove } = require('./multigroove');
const { Awareness, DEFAULTS: AW_DEFAULTS, KEYS: AW_KEYS } = require('./awareness');
const { SelfSpins } = require('./selfspins');

const NCARS = 44;

// AI Enhanced's own defaults for each module's options
const DEFAULT_OPTS = {
  sideDraft: { lonWinBak: 4.7, latWin: 4, latWinBak: 2, rearLonWin: 6, engRight: 0.5, engLeft: 0.75, chsRight: 0.75, chsLeft: 0.9, chsBehind: 0.75, playerEngScale: 0.4, slideAmount: 1 },
  tandem: { ablonThr: 7, bclonThr: 10, latThr: 1, boostMult: 1.7, slowMult: 0, adBehindMin: 9, adBehindMax: 10, congestionLon: 40, congestionN: 6, optimizeIni: true },
  longRun: { maxChsChange: 0.04 },
};
const BOUNDS = ['minrace', 'maxrace', 'race'];
// AI Enhanced's own defaults: race (inner edge) .. minrace (outer edge) on a left-turning oval, the whole range used. pauseForPlayer is a
// All In One NR2003 option (AI Enhanced pauses for the pace car, not for you)
const MG_DEFAULT = { left: 'race', right: 'minrace', spaceCars: true, pauseForPlayer: false, spread: 1 };
DEFAULT_OPTS.awareness = AW_DEFAULTS; DEFAULT_OPTS.selfSpins = { chance: 20 };
const KEYS = { sideDraft: Object.keys(DEFAULT_OPTS.sideDraft), tandem: Object.keys(DEFAULT_OPTS.tandem), longRun: Object.keys(DEFAULT_OPTS.longRun), awareness: AW_KEYS, selfSpins: ['chance'] };
// AI Enhanced reads only these awareness_opts from a preset (FUN_004184f0); the numbers in the shipped presets are ignored by it (All In One NR2003's fine tuning)
const AW_PRESET_KEYS = ['slowCarsMoveOver', 'moveDirection', 'leaderBlocks', 'leaderBlocksMode', 'draftingTeamwork', 'sandbagging', 'brakeForWrecks'];

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

class Modules {
  constructor() { this.tandem = new Tandem(); this.longRun = new LongRun(); this.mg = new MultiGroove(); this.aw = new Awareness(); this.ss = new SelfSpins(); }
  reset() { this.tandem.reset(); this.longRun = new LongRun(); this.mg = new MultiGroove(); this.ss.reset(); this.aw.reset(); }

  // cfg: { sideDraft: { enabled, opts }, tandem: {...}, longRun: {...} }; cars[i] = { dlong, dlat, speed, laps, moving } | null
  // ctx: { trackLen, raceUnits } -> { f: [{f0,f1,f2}] x 44, active: ['side draft', ...] }
  step(cfg, cars, ctx) {
    const f = Array.from({ length: NCARS }, () => ({ f0: 1, f1: 1, f2: 1 }));
    const active = [];
    // ctx.caution (AI Enhanced's pace-car test): the grip / power modes keep running, the race-line modes (Awareness, Self Spins, MultiGroove)
    // are not called (their state is kept, as in AI Enhanced's tick)
    const dl = new Array(NCARS).fill(0), dt = new Array(NCARS).fill(0), laps = new Array(43).fill(0), moving = new Array(43).fill(false);
    for (let i = 0; i < NCARS; i++) { const c = cars[i]; if (!c) continue; dl[i] = c.dlong; dt[i] = c.dlat; if (i < 43) { laps[i] = c.laps || 0; moving[i] = !!c.moving; } }
    if (cfg.sideDraft && cfg.sideDraft.enabled) {
      active.push('side draft');
      const T = sideDraft(dl, dt, Object.assign({}, DEFAULT_OPTS.sideDraft, cfg.sideDraft.opts));
      T.forEach((x, i) => { f[i].f0 *= x.f0; f[i].f1 *= x.f1; f[i].f2 *= x.f2; });
    }
    if (cfg.tandem && cfg.tandem.enabled) {
      active.push('tandem');
      const F = this.tandem.step(dl, dt, laps, ctx.trackLen, Object.assign({}, DEFAULT_OPTS.tandem, cfg.tandem.opts));
      F.forEach((x, i) => { f[i].f0 *= x; });
    } else this.tandem.reset();
    if (cfg.longRun && cfg.longRun.enabled) {
      active.push('long run spread');
      const F = this.longRun.step(laps, moving, ctx.trackLen, ctx.raceUnits, num(cfg.longRun.opts && cfg.longRun.opts.maxChsChange, DEFAULT_OPTS.longRun.maxChsChange));
      F.forEach((x, i) => { f[i].f1 *= x; f[i].f2 *= x; });
    }
    // race-line tweaks: Awareness nudges (field 2 += delta) and Self Spins (field 2 = value)
    const nudges = [], sets = [], blends = [];
    let brake = null, bound = 'minrace';
    if (cfg.awareness && cfg.awareness.enabled && ctx.lines) {
      if (!ctx.caution) {
        active.push('awareness');
        const A = this.aw.step(cars, ctx.lines, cfg.awareness.opts, ctx);
        A.f0.forEach((x, i) => { f[i].f0 *= x; });
        nudges.push(...A.nudges); blends.push(...A.blends); brake = A.brake; bound = A.bound;
      }
    } else this.aw.reset();
    if (cfg.selfSpins && cfg.selfSpins.enabled && ctx.lines) {
      if (!ctx.caution) { active.push('self spins'); sets.push(...this.ss.step(cars, ctx.lines, cfg.selfSpins.opts || {}, ctx).sets); }
    } else this.ss.reset();
    let mg = null;
    if (cfg.multigroove && cfg.multigroove.enabled && ctx.lines && ctx.hasBounds) {
      if (!ctx.caution) { active.push('multigroove'); mg = this.mg.step(ctx.lines, cars, cars[NCARS - 1], cfg.multigroove); }
    } else this.mg = new MultiGroove();
    return { f, active, nudges, sets, blends, brake, bound, mg };
  }
}

// the module settings a preset carries: { sideDraft?: { enabled?, opts? }, ... } from its `special_modes` section
function fromPreset(p) {
  const m = p && p.special_modes && typeof p.special_modes === 'object' ? p.special_modes : {};      // a preset may carry multigroove without special_modes (the Michigan one does)
  const out = {};
  const pick = (activeKey, optsKey, name, keys = KEYS[name]) => {
    const e = {};
    if (typeof m[activeKey] === 'boolean') e.enabled = m[activeKey];
    const o = m[optsKey];
    if (o && typeof o === 'object') {
      const x = {};
      for (const k of keys) { if (typeof o[k] === 'number' && Number.isFinite(o[k])) x[k] = o[k]; else if (typeof o[k] === 'boolean' && typeof DEFAULT_OPTS[name][k] === 'boolean') x[k] = o[k]; }
      if (Object.keys(x).length) e.opts = x;
    }
    if (Object.keys(e).length) out[name] = e;
  };
  pick('side_draft_active', 'side_draft_opts', 'sideDraft');
  pick('tandem_active', 'tandem_opts', 'tandem');
  pick('long_run_spread_active', 'long_run_spread_opts', 'longRun');
  pick('awareness_active', 'awareness_opts', 'awareness', AW_PRESET_KEYS);
  pick('self_spins_active', 'self_spins_opts', 'selfSpins');
  const g = p && p.multigroove;
  if (g && typeof g === 'object') {
    const e = {};
    if (typeof g.enabled === 'boolean') e.enabled = g.enabled;
    if (BOUNDS.includes(g.left_bound)) e.left = g.left_bound;
    if (BOUNDS.includes(g.right_bound)) e.right = g.right_bound;
    if (typeof g.space_cars === 'boolean') e.spaceCars = g.space_cars;
    if (typeof g.pause_for_player === 'boolean') e.pauseForPlayer = g.pause_for_player;
    if (Object.keys(e).length) out.multigroove = e;
  } else if (p) {
    const e = {};
    if (typeof p.multigroove_enabled === 'boolean') e.enabled = p.multigroove_enabled;
    if (BOUNDS.includes(p.multigroove_left_bound)) e.left = p.multigroove_left_bound;
    if (BOUNDS.includes(p.multigroove_right_bound)) e.right = p.multigroove_right_bound;
    if (typeof p.multigroove_space_cars === 'boolean') e.spaceCars = p.multigroove_space_cars;
    if (Object.keys(e).length) out.multigroove = e;
  }
  return out;
}

module.exports = { Modules, DEFAULT_OPTS, KEYS, BOUNDS, MG_DEFAULT, fromPreset };
