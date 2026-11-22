// "More options" for RaceVision, added by All In One NR2003 on top of it: RaceVision's own director is untouched; these rules watch its
// state and drive it through its remote API, like a producer sitting next to it.
//   * Favourite drivers: when a favourite is in something worth showing (a battle, a pass, a pit stop, an incident) and RaceVision
//     is not showing them, put them on TV (RaceVision then holds that pick for manual_hold seconds and goes back to directing).
//     At most one favourite cut every `favGapSec` seconds, never while you picked a car yourself or the director is paused.
//   * Overlays only in the race: overlays on when a race starts, off when it ends (only on those changes, so a manual Ctrl+F9 sticks).
//   * Follow All In One NR2003's stages: RaceVision's stage_laps follow the stage plan, including a stage a caution ended early
//     (and are cleared when "Stages off" is on).
'use strict';
const { list } = require('./ini');

const DEFAULTS = Object.freeze({
  favorites: '',                 // car numbers, e.g. "24, 48, 5"
  favMode: 'off',                // 'off' | 'events'
  favGapSec: 40,
  overlaysOnlyRace: false,
  syncStages: false,             // opt-in: it overwrites RaceVision's own stage_laps setting
});

const EVENT_KIND = /battle|pass|crash|stop|incident|pit|spin/i;

class Extras {
  // opts: { getConfig() -> extras config, api, getStageEnds() -> [laps]|null, log, now() }
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());
    this.reset();
  }

  reset() { this.lastFavAt = -Infinity; this.lastRace = null; this.lastStages = null; this.stageErr = false; }

  cfg() { return Object.assign({}, DEFAULTS, this.opts.getConfig() || {}); }

  async tick(S) {
    if (!S || !S.attached) return;
    const c = this.cfg();
    try {
      await this._overlays(S, c);
      await this._stages(S, c);
      await this._favorites(S, c);
    } catch (e) { this.log('[racevision] extras: ' + (e && e.message)); }
  }

  async _favorites(S, c) {
    if (c.favMode !== 'events' || !S.race || S.paused || (S.on && S.on.manual)) return;
    const favs = new Set(list(c.favorites).map(s => s.replace(/^#/, '')));
    if (!favs.size) return;
    const t = this.now();
    if (t - this.lastFavAt < Math.max(5, Number(c.favGapSec) || 40) * 1000) return;
    const cands = (S.story || []).filter(k => k && favs.has(String(k.num).replace(/^#/, '')) && !k.tv && EVENT_KIND.test(String(k.kind || '')));
    if (!cands.length) return;
    cands.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (a.pos || 99) - (b.pos || 99));
    const k = cands[0];
    this.lastFavAt = t;
    await this.opts.api.focus(k.slot);
    this.log(`[racevision] favourite #${k.num} ${k.name || ''} on TV (${String(k.kind).toLowerCase()}${k.why ? ': ' + k.why : ''})`);
  }

  async _overlays(S, c) {
    const race = !!S.race;
    if (!c.overlaysOnlyRace) { this.lastRace = race; return; }
    if (this.lastRace !== null && race !== this.lastRace) {
      const want = race;
      if (!!S.overlays !== want) { await this.opts.api.set('overlays', want ? '1' : '0'); this.log(`[racevision] overlays ${want ? 'on (race started)' : 'off (race over)'}`); }
    }
    this.lastRace = race;
  }

  async _stages(S, c) {
    if (!c.syncStages || !this.opts.getStageEnds) return;
    const ends = this.opts.getStageEnds();
    const want = (ends || []).join(', ');
    if (this.lastStages === want) return;
    try {
      await this.opts.api.set('stage_laps', want);
      this.lastStages = want; this.stageErr = false;
      this.log(`[racevision] stage laps set to ${want || '(none)'}`);
    } catch (e) {
      if (!this.stageErr) { this.stageErr = true; this.log('[racevision] could not set stage_laps: ' + (e && e.message)); }
    }
  }
}

module.exports = { Extras, DEFAULTS, EVENT_KIND };
