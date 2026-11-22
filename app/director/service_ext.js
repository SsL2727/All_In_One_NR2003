// DirectorService additions for RaceVision 1.1.0 beta 2: crash replays, the camera library's editor, and standing down while the player drives.
// Mixed into DirectorService.prototype by service.js.
'use strict';
const S = require('./settings');
const { FIRST_CUSTOM, LAST_CUSTOM } = require('./camlib');
const { gameSeconds } = require('./replay');
const RCA = require('../racecontrol/addr');
const { Highlights, finishClose } = require('./highlights');

const clean = (s, n) => String(s == null ? '' : s).replace(/[\r\n]/g, ' ').slice(0, n);
const tuneOf = (t) => (Array.isArray(t) ? t : []).map(Number).filter(Number.isFinite).map(v => Math.round(v * 100) / 100);

const ext = {
  // crashes, replays, the game's climb-out replay, and the player's own driving. -> true when the director must leave the view alone
  _replayTick(f) {
    const R = this.resolved();
    const g = gameSeconds(this.shadow);
    if (!this.highlights) this.highlights = new Highlights(() => this.resolved(), (m) => this.log(m));
    if (g > 0 && g < this._lastG - 5) { this.crashes.reset(); this.highlights.reset(); }            // a new session
    if (g > 0) {
      this._lastG = g; this.crashes.observe(f, g);
      // RaceVision 2.0: highlights besides crashes (passes, multi-passes, bump and runs, the finish)
      try { const ri = this.opts.raceInfo ? this.opts.raceInfo() : null; this.highlights.update(f, g, this.crashes, { lapsTotal: ri ? ri.lapsTotal : 0, inRace: !!(ri && ri.session === 'race') }); } catch (e) { /* never stops the director */ }
    }
    const inCar = this.cam.inCar();
    const qualRun = !!(this.opts.qualDrive && this.opts.qualDrive());
    if (qualRun && !this._qualWas && R.qual_player_cam > 0 && this.shadow.passthrough) {
      this.cam.set(R.qual_player_cam, RCA.PlayerIdx, { call: !!R.camera_call });
      this.log('your qualifying run: the TV goes to your cockpit');
    }
    this._qualWas = qualRun;
    if (this._wasInCar && !inCar && this.cam.replaying() && !this.replay.active && R.live_after_climb_out && this.shadow.passthrough) {
      this.log("the game started its climb-out replay: back to live");
      this.replay.stop().catch(() => {});
    }
    this._wasInCar = inCar;
    // the finish replays by itself once it is settled (replay_finish)
    const fin = !this.replay.active && this.highlights ? this.highlights.finishDue(this.crashes) : null;
    if (fin && this.shadow.passthrough && this.cam.hooked && !this.cam.foreign && !inCar) { this.log('REPLAY the finish: ' + fin.what); this._startReplay(fin, {}); }
    if (R.replay_auto && !this.replay.active && g > 0 && !(R.replay_caution_only && f.green)) {
      // say once per crash why it is not replayed, so a race without replays can be read back from tv.log
      const said = this._replaySaid || (this._replaySaid = new Set());
      const once = (c, why) => { if (!said.has(c.id)) { said.add(c.id); this.log(`replay: crash #${c.id} (score ${c.score.toFixed(1)}) not replayed - ${why}`); } };
      for (const c of this.crashes.crashes) if (c.over && c.replays === 0 && !this.crashes.worthy(c) && g - c.overAt >= R.replay_after) once(c, `under the "worth a replay from" score of ${R.replay_worthy}`);
      const x = this.crashes.crashes.find(c => c.over && g - c.overAt >= R.replay_after && c.replays === 0 && g - c.t0 <= R.replay_within && this.crashes.worthy(c));
      const late = this.crashes.crashes.find(c => c.over && c.replays === 0 && this.crashes.worthy(c) && g - c.t0 > R.replay_within);
      if (late) once(late, `the caution came more than ${R.replay_within} s after it ("replay within")`);
      if (x) {
        const why = !this.shadow.passthrough ? 'read-only test mode is on' : !this.cam.hooked ? 'the camera hook is not installed (is "camera_call" off?)'
          : this.cam.foreign ? 'another program\'s camera hook is in the game (RaceVision.exe?)' : inCar && !R.replay_drive ? 'you are driving and "replay while driving" is off'
          : qualRun ? 'your qualifying run' : '';
        if (why) once(x, why); else this._startReplay(x, {});
      }
    }
    return inCar || qualRun;       // the director leaves your view alone while you drive (qualifying puts you in your cockpit)
  },

  _replayCams(list) { const ok = (list || []).filter(c => this.lib.has(c)); return ok.length ? ok : [19]; },
  // each crash's angles at real speed; with smart slow motion, one more look at the hardest hit in slow motion (from the first replay camera,
  // last) - only when that single hit is replay_slow_impact or more (RaceVision 2.0: one slow look only, of the hardest hit). A highlight
  // (pass, multi-pass, bump and run, the finish) is one take on its car from highlight_preroll before the moment; only a photo finish slows.
  _plan(x, angles, reel) {
    const R = this.resolved();
    if (x.kind) {
      const m = x.cars.get(x.impactCar) || [...x.cars.values()][0] || { slot: x.impactCar, num: 0, name: '' };
      const pre = x.kind === 'finish' ? Math.max(R.highlight_preroll, 8) : R.highlight_preroll;
      const after = Math.max(3, x.last - x.impactAt + 2.5);
      return [{ slot: m.slot, num: m.num, name: m.name, hitAt: x.impactAt, start: x.impactAt - pre, cams: this._replayCams(R.cam_replay), len: pre + Math.min(after, R.replay_max),
        slow: !!R.replay_smart && finishClose(x), worth: x.score, kind: x.kind, wipe: 'HIGHLIGHT  -  ' + (x.what || x.kind).toUpperCase() }];
    }
    const plan = this.crashes.angles(x, angles).map((a, i) => ({
      slot: a.slot, num: a.num, name: a.name, hitAt: a.hitAt, start: a.start, cams: this._replayCams(i === 0 ? R.cam_replay : R.cam_replay_angles), len: i === 0 ? R.replay_max : R.replay_take,
    }));
    const top = [...x.cars.values()].sort((a, b) => b.hit - a.hit);
    const hardest = top[0];
    if (R.replay_smart && !reel && hardest && hardest.hit >= R.replay_slow_impact * 10) {
      plan.push({ slot: hardest.slot, num: hardest.num, name: hardest.name, hitAt: hardest.hitAt, start: hardest.hitAt - R.replay_preroll, cams: this._replayCams(R.cam_replay), len: R.replay_take, slow: true });
    }
    const who = top.slice(0, 2).map(m => '#' + m.num + ' ' + String(m.name || '').split(' ').pop().toUpperCase()).join(', ');
    plan.forEach((a, i) => { a.slow = !!a.slow; a.worth = x.score; if (i === 0) a.wipe = 'CRASH  -  ' + who; });
    return plan;
  },
  _startReplay(x, o) {
    if (this.replay.active) return false;
    if (!this.shadow.passthrough) { this.log('replay: would roll the replay of crash #' + x.id + ' (read-only test mode)'); x.replays++; return false; }
    if (!this.cam.hooked || this.cam.foreign) { this.log('replay: the camera hook is not installed'); return false; }
    const plan = this._plan(x, o.angles);
    const what = x.kind ? 'highlight #' + x.id + ' (' + (x.what || x.kind) + ')' : 'crash #' + x.id;
    this.log('REPLAY ' + what + ': ' + plan.map(a => '#' + a.num).join(' '));
    x.replays++;
    this.replay.play(o.label || (x.kind ? 'REPLAY - ' + String(x.what || x.kind).toUpperCase() : 'REPLAY - CRASH #' + x.id), plan, { crash: x.id, now: !!o.now })
      .then(ok => { if (!ok) this.log('REPLAY crash #' + x.id + ': no replay'); })
      .catch(e => this.log('replay: ' + (e && e.message || e)));
    return true;
  },
  // buttons: the crash most worth it / one from the list / every crash worth it in a reel / back to live
  replayNow() {
    const g = gameSeconds(this.shadow), within = this.resolved().replay_within;
    const worthy = this.crashes.crashes.filter(c => this.crashes.worthy(c));
    const x = worthy.sort((a, b) => ((g - a.t0 > within) - (g - b.t0 > within)) || b.score - a.score)[0] || this.crashes.crashes[this.crashes.crashes.length - 1];
    if (!x) { this.log('replay: no crash logged yet'); return false; }
    return this._startReplay(x, { now: true });
  },
  replayCrash(id) { const x = this.crashes.crashes.find(c => c.id === id); return x ? this._startReplay(x, { now: true }) : false; },
  reel() {
    if (this.replay.active) return false;
    const R = this.resolved();
    const xs = this.crashes.crashes.filter(c => this.crashes.worthy(c) || (c.kind && Number(R.reel_highlights) && Number(R.highlights))).sort((a, b) => a.t0 - b.t0);
    if (!xs.length) { this.log('replay: no crash or highlight worth a replay yet'); return false; }
    if (!this.shadow.passthrough || !this.cam.hooked || this.cam.foreign) { this.log('replay: the highlight reel needs the camera hook (and live mode)'); return false; }
    const plan = [];
    for (const x of xs) plan.push(...this._plan(x, R.reel_angles, true));
    this.log('REPLAY highlight reel: ' + xs.length + ' crash' + (xs.length === 1 ? '' : 'es'));
    this.replay.play('HIGHLIGHT REEL', plan, { now: true }).catch(e => this.log('replay: ' + (e && e.message || e)));
    return true;
  },
  replayLive() { this.replay.cancel(); if (this.tape.manual) this.tape.push('live'); return true; },

  // ── the tape transport, the replay wipe, other overlays out of the way (RaceVision 1.2.0) ──
  // can the transport start the tape from live? '' or why not
  _tapeReady() {
    if (!this.attached) return "NR2003 isn't running";
    if (!this.shadow.passthrough) return 'read-only test mode is on';
    if (!this.cam.hooked || this.cam.foreign) return this.cam.foreign ? "another program's camera hook is in the game" : 'no camera control';
    if (this.replay.active) return '';
    if (this.cam.inCar()) return "you're in your car";
    if (this.opts.qualDrive && this.opts.qualDrive()) return 'your qualifying run';
    return '';
  },
  tapeState() { return this.tape.state(this.attached); },
  tapeCtl(q) { return require('./tape').ctl(this.tape, q || {}); },
  // the wipe (opts.wipe({ kind, sub, ms, color }) resolves with its release function once the screen is covered); a wipe into a replay
  // first puts the other overlays out of the way
  async _wipe(kind, sub) {
    const R = this.resolved();
    if (kind !== 1) this._hideOthers(true);
    this._wipeBusy++;
    let release = null;
    try {
      const color = /^#?[0-9a-f]{6}$/i.test(String(R.replay_wipe_color).trim()) ? String(R.replay_wipe_color).trim() : R.dash_accent;
      release = await Promise.race([this.opts.wipe({ kind, sub: String(sub || '').slice(0, 95), ms: R.replay_transition_ms, color: color.startsWith('#') ? color : '#' + color }),
        new Promise(r => setTimeout(() => r(null), (R.replay_transition_ms || 1500) + 1500))]);
    } catch (e) { release = null; }
    let done = false;
    const end = () => { if (done) return; done = true; try { if (release) release(); } catch (e) { /* window gone */ } setTimeout(() => { this._wipeBusy = Math.max(0, this._wipeBusy - 1); }, (R.replay_transition_ms || 1500) * 0.4); };
    return end;
  },
  // hide_companion_overlays: the other overlays (All In One NR2003's own broadcast widgets, and other programs' topmost overlay windows) stay out
  // of sight for the whole replay and both wipes, and come back once it is over and the wipe back to live has been gone a moment
  _hideOthers(on) {
    const R = this.resolved();
    if (on && (!Number(R.hide_companion_overlays) || this._othersHidden)) return;
    if (!on && !this._othersHidden) return;
    this._othersHidden = on; this._othersOffAt = 0;
    let n = 0;
    try { n = this.opts.hideOverlays ? this.opts.hideOverlays(on, { apps: R.companion_apps, keep: R.companion_keep }) : 0; } catch (e) { n = 0; }
    this.log(on ? `other overlays hidden (${n} window${n === 1 ? '' : 's'})` : 'other overlays shown again');
  },
  _othersTick() {
    const R = this.resolved();
    const want = !!Number(R.hide_companion_overlays) && (this.replay.active || this.tape.manual || this.cam.replaying() || this._wipeBusy > 0);
    if (want) { this._othersOffAt = 0; this._hideOthers(true); }
    else if (this._othersHidden) {
      if (!this._othersOffAt) this._othersOffAt = Date.now();
      if (!Number(R.hide_companion_overlays) || Date.now() - this._othersOffAt > 500) this._hideOthers(false);
    }
  },

  // ── the camera editor: live adjust, save, new, delete, rename, order, hide ──
  camDescribe(cam) { return Object.assign(this.lib.describe(cam, this.cam.focusSlot()), { library: this.lib.list() }); },
  camAdjust(cam, tune) {                                       // show the camera with this tune on the car on TV, without saving
    const slot = this.cam.focusSlot();
    this.activeLibCam = cam;
    const real = this.lib.activate(cam, slot, tuneOf(tune));
    this._applyCameraFeatures(cam, this.resolved(), tuneOf(tune));
    this.cam.set(real, slot, { call: true });
    return true;
  },
  _tuneKey(cam) { return { 6: 'chase2_view', 7: 'far_chase2_view', 22: 'incar3_eye', 23: 'drone_height' }[cam] || 'cam_tune_' + cam; },
  camSave(cam, tune) {
    const t = tuneOf(tune);
    if (!t.length) return false;
    this.setConfig({ settings: { [this._tuneKey(cam)]: t.join(', ') } });
    return true;
  },
  camNew(base, name, tune) {
    const s = this.cfg().settings;
    let id = 0;
    for (let n = FIRST_CUSTOM; n <= LAST_CUSTOM; n++) if (!s['cam_new_' + n]) { id = n; break; }
    if (!id) return 0;
    const patch = { ['cam_new_' + id]: (parseInt(base, 10) || 4) + ', ' + (clean(name, 40) || 'Custom ' + id) };
    const t = tuneOf(tune);
    if (t.length) patch['cam_tune_' + id] = t.join(', ');
    this.setConfig({ settings: patch });
    return id;
  },
  camDelete(id) {
    if (!(id >= FIRST_CUSTOM && id <= LAST_CUSTOM)) return false;
    const c = this.cfg();
    const hidden = S.camList(c.settings.cam_hidden).filter(n => n !== id).join(', '), order = S.camList(c.settings.cam_order).filter(n => n !== id).join(', ');
    this.setConfig({ settings: { ['cam_new_' + id]: null, ['cam_tune_' + id]: null, ['cam_label_' + id]: null, cam_hidden: hidden, cam_order: order } });
    return true;
  },
  camLabel(id, name) { this.setConfig({ settings: { ['cam_label_' + id]: clean(name, 40) || null } }); return true; },
  camOrder(list) { this.setConfig({ settings: { cam_order: S.camList((Array.isArray(list) ? list : []).join(',')).join(', ') } }); return true; },
  camHide(id, on) {
    const cur = new Set(S.camList(this.cfg().settings.cam_hidden));
    if (on) cur.add(id); else cur.delete(id);
    this.setConfig({ settings: { cam_hidden: [...cur].sort((a, b) => a - b).join(', ') } });
    return true;
  },

  // presets: the shipped "RaceVision default" / "JT's Customs" setups as ini text -> settings
  presetNames() { return Object.keys(this.opts.presets ? this.opts.presets() : {}); },
  applyPreset(name) {
    const all = this.opts.presets ? this.opts.presets() : {};
    const text = all[name];
    if (text === undefined) return false;
    const c = this.cfg();
    const fresh = {};
    for (const line of String(text).split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith(';') && (m[1] in S.DEFAULTS || S.DYNAMIC_KEY.test(m[1]))) fresh[m[1]] = m[2];
    }
    // a preset replaces the director settings and the camera library; the remote's port and key stay yours
    const keep = {}; for (const k of ['remote', 'remote_port', 'remote_key']) if (k in c.settings) keep[k] = c.settings[k];
    c.settings = Object.assign(fresh, keep);
    this.opts.getConfig().director = c;
    this.opts.saveConfig();
    this.lib.restore();
    this.dir.setSettings(this.resolved());
    this.log('preset "' + name + '" loaded');
    return true;
  },
};

module.exports = { install(Cls) { Object.assign(Cls.prototype, ext); }, ext };
